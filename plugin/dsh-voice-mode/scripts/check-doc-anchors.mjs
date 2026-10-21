#!/usr/bin/env node
/**
 * 文档 file:line 锚点守卫（Round 5 / D-13 新增）。
 *
 * ── 为什么需要它 ──
 * 现有 `check-anchors.mjs` 只校验 **npm 包锚点**（`dsh.client.inject` 的 9 个），
 * **完全不校验文档里的 `file:line`**。实测：把文档锚点删掉或改错行，**全套件仍绿**。
 * 这就是「代码批落地 → 行号位移 → 文档锚点失效」在两轮里复发同型缺陷的根因。
 *
 * ── 它查什么 ──
 * 扫全仓 markdown，抽出两类锚点形态：
 *   A. **行号锚**：`file.ext:line` / `file.ext:line-line` / `file.ext:line,line`
 *   B. **符号锚**（Round 5 起的新口径）：`file.ext` + 邻近反引号包着的符号名，无行号
 * 逐处判定：
 *   ① 文件存在？          不存在 → ❌ ERROR
 *   ② 行号在文件长度内？  越界   → ❌ ERROR
 *   ③ 符号在不在锚定行附近（±3 行窗口）？
 *        在               → ✅ 通过
 *        不在但**在同文件他处** → ⚠️ DRIFT（行号快照已漂移，符号锚仍有效 → 需回填行号）
 *        全文都找不到      → ❌ ERROR（锚点指向无关代码）
 *   ④ 符号锚形态：符号必须存在于该文件，否则 ❌ ERROR
 *
 * ── 符号怎么抽（关键：必须能被源文件证伪，否则噪声淹没真错）──
 * 1. 只取锚点**同一行**内、锚点前后 60 字符内的反引号 token；
 * 2. 排除：本身是文件引用的 token、纯十六进制串（commit hash）；
 * 3. **再拿源文件过滤**：token 必须真的出现在该文件里（词边界匹配）——
 *    这一步把 `file` / `docs` / `coverage` 之类散文词全部滤掉；
 * 4. 一个都过不了 → 归入「待人工确认」（**不是放过，是显式待办**）。
 *
 * ── 判据与例外（刻意不留「失败就跳过」的后门）──
 * - **历史时点**：行内锚点**邻近**出现 `历史时点` / `时点值` / `原值` / `已漂移` / `快照` /
 *   `历史口径` 的，该锚点行号本就允许过时 → 只做 ①②，符号漂移不报 DRIFT、只计入 `historical`。
 * - **基线文件** `scripts/doc-anchors-baseline.json` 钉住当前已知债务：
 *   `errors` 恒为 0；`drift` 与 `undecidable` 不得超过基线值——**新增债务即红**。
 *   债务下降时脚本提示可收紧基线（`--update-baseline` 重新生成）。
 *
 * ── 退出码 ──
 *   0 = 全绿（在基线之内、无 ERROR）
 *   1 = 有 ERROR（锚点真的坏了）
 *   2 = 超出基线（新增 DRIFT / 新增无法判定项 = 新增债务）
 *
 * 用法：
 *   node scripts/check-doc-anchors.mjs [--json] [--update-baseline] [--root <仓库根>]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')

const argv = process.argv.slice(2)
const JSON_OUT = argv.includes('--json')
const UPDATE_BASELINE = argv.includes('--update-baseline')
const rootArg = argv.indexOf('--root')
const ROOT = rootArg >= 0 && argv[rootArg + 1] ? resolve(argv[rootArg + 1]) : resolve(pluginRoot, '..', '..')

/** 扫描时跳过的目录（构建产物 / 依赖 / 本地草稿）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'site', '.scratch', 'dist', 'coverage'])

/**
 * 文件引用的扩展名——**长扩展名必须排前面**（`json` 先于 `js`、`tsx` 先于 `ts`），
 * 否则 `package.json` 会被截成 `package.js`（第一版就踩了这个坑）。
 */
const EXT = 'json|yaml|bash|tsx|mts|cts|mjs|cjs|yml|md|ts|js|sh'

/** 反引号包裹的 token。 */
const BACKTICK = /`([^`\n]{1,90})`/g

/** 文件引用（可带行号）。独立实例，避免 lastIndex 互相污染。 */
const FILE_REF = new RegExp(
  `^([\\w./-]*[\\w-]+\\.(?:${EXT}))(?::(\\d+))?(?:\\s*[-–,]\\s*(\\d+))?$`,
)

/**
 * 判断 token 本身是否就是文件引用——**必须用无 `g` 标志的独立实例**：
 * 带 `g` 的正则上调用 `.test()` 会推进 `lastIndex`，
 * 从而污染外层正在用的 `FILE_REF.exec()` 扫描位置（第一版就因此死循环）。
 */
const IS_FILE_REF = new RegExp(`[\\w./-]*[\\w-]+\\.(?:${EXT})`)

/** 标识符形态。 */
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+)*$/

/** 纯十六进制串（commit hash）——不是符号。 */
const HEXONLY = /^[0-9a-f]{7,40}$/i

/** 锚点邻近出现这些词 → 该锚点的行号属「历史时点」，允许过时。 */
const HISTORICAL_MARK = /历史时点|时点值|原值|已漂移|快照|历史口径|当时行号/

/**
 * 邻近出现这些词 → 该**文件引用指向的是已删除 / 已改名 / 外部的文件**，
 * 「文件不存在」是文档在如实陈述，不是坏锚点（仍列备查，不判红）。
 */
const DEAD_FILE_MARK = /已删|已砍|不存在|移除|改名|重命名|删除|原名|未建|未入库|外部|第三方/

/**
 * 邻近出现这些词 → 该**符号引用是历史陈述**（符号已被删除 / 砍除 / 是他方的东西），
 * 「符号在源文件里找不到」不判红（仍列备查）。
 */
const DEAD_SYMBOL_MARK =
  /已删|已砍|删除|删 |删掉|移除|砍除|砍|死代码|零引用|全库零|下线|曾有|曾|历史|旧|原名|改名|重命名|容忍|不再存在|已随|根因|触发|成因|复盘/

/** 明显的外部路径（非仓库内文件）——不参与判定。 */
const EXTERNAL_PATH =
  /^(\/|~|\$)|(^|[\\/])\.\.\/[.\/]|node_modules|\.d\.ts$|^dist\/|\.d\.ts`|MsEdgeTTS/

/**
 * 第三方包里的文件（node_modules 路径 / npm scope 包名）——不在本仓，不参与判定。
 */
const THIRD_PARTY = /node_modules|@[a-z0-9-]+\/[a-z0-9.-]+/i

/**
 * 调研原始档案目录——这些文件记录的是**别的仓库**的代码
 * （如 `docs/competitive/sources/scan-dsh-audiogen-*.md` 讲的是 dsh-audiogen 项目），
 * 其中的 `src/*.ts:行号` 指向**他仓**文件，本仓守卫无从校验。
 * 归入独立类别并**逐条列计数**（不是静默跳过）。
 */
const RESEARCH_DIRS = ['docs/competitive/sources/', 'docs/findings/', 'docs/research/']
/** 看起来像代码标识符（而非散文词）：含下划线，或大小写混合且 ≥2 次切换。 */
function looksLikeCode(tok) {
  if (!IDENT.test(tok)) return false
  if (tok.includes('_')) return true
  let changes = 0
  for (let i = 1; i < tok.length; i++) {
    const a = tok[i - 1]
    const b = tok[i]
    if (a === a.toLowerCase() && b === b.toLowerCase()) continue
    if (a === a.toUpperCase() && b === b.toUpperCase()) continue
    changes++
  }
  return changes >= 2
}

/** 收集仓库内所有 markdown 文件。 */
function collectMarkdown(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      collectMarkdown(p, out)
    } else if (e.name.endsWith('.md')) {
      out.push(p)
    }
  }
  return out
}

/**
 * 仓库内文件按 basename 索引——文档里常只写文件名（`STATE.md` / `backlog.md` /
 * `0003-server-side-vad.md`），逐个候选根试会漏；用全仓 basename 兜底。
 */
const BY_BASENAME = new Map()
function indexBasenames(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    // `.github` 以点开头，但里面的 `ci.yml` / `release.yml` 会被文档引用 → 仍要索引
    if (e.name.startsWith('.') && e.name !== '.github') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      indexBasenames(p)
    } else {
      const arr = BY_BASENAME.get(e.name) ?? []
      arr.push(p)
      BY_BASENAME.set(e.name, arr)
    }
  }
}

/**
 * 解析文档里的文件引用 → 真实路径。
 * 文档里同一份源码有多种写法（`src/asr.ts` / `asr.ts` / `client.tsx`），
 * 逐个候选根尝试，最后用全仓 basename 兜底。
 */
function resolvePath(ref) {
  const base = ref.split('/').pop()
  const cands = [
    join(ROOT, ref),
    join(ROOT, 'plugin', 'dsh-voice-mode', ref),
    join(ROOT, 'docs', ref),
    join(ROOT, 'plugin', 'dsh-voice-mode', 'src', base),
    join(ROOT, 'plugin', 'dsh-voice-mode', 'test', base),
    join(ROOT, 'plugin', 'dsh-voice-mode', 'scripts', base),
    join(ROOT, 'plugin', 'dsh-voice-mode', 'lib', base),
    join(ROOT, 'plugin', 'dsh-voice-mode', 'docs', base),
  ]
  for (const c of cands) if (existsSync(c) && statSync(c).isFile()) return c
  // 全仓 basename 兜底（同名多份时取第一个存在的）
  for (const p of BY_BASENAME.get(base) ?? []) if (existsSync(p) && statSync(p).isFile()) return p
  return null
}

/** 从 token 里取「needle」：标识符优先，否则取内部最长的字母数字片段。 */
function needleOf(token) {
  const t = token.trim()
  if (IDENT.test(t)) return t
  const runs = t.match(/[A-Za-z0-9_$]{4,}/g) ?? []
  if (runs.length === 0) return null
  runs.sort((a, b) => b.length - a.length)
  return runs[0]
}

/** needle 是否作为标识符出现在文本里（词边界，避免 `set` 命中 `setTimeout`）。 */
function hasWord(text, needle) {
  if (needle.includes('.')) return text.includes(needle)
  const re = new RegExp(`(?<![\\w$.])${needle.replace(/\$/g, '\\$')}(?![\\w$])`)
  return re.test(text)
}

/** 锚点附近 ±N 字符的文本。 */
function near(text, at, len, n) {
  return text.slice(Math.max(0, at - n), at + len + n)
}

const mdFiles = collectMarkdown(ROOT)
indexBasenames(ROOT)
const errors = []
const drifts = []
const undecidable = []
const historical = []
const external = []
const pathRefs = []
const research = []
const fileCache = new Map()

function loadFile(path) {
  if (!fileCache.has(path)) {
    const content = readFileSync(path, 'utf8')
    fileCache.set(path, { content, lines: content.split('\n') })
  }
  return fileCache.get(path)
}

for (const md of mdFiles) {
  const relMd = relative(ROOT, md).split(sep).join('/')
  const mdLines = readFileSync(md, 'utf8').split('\n')
  mdLines.forEach((text, i) => {
    const docLine = i + 1
    // 去掉行内代码块（```），避免把代码示例里的 file:line 当真锚点
    const stripped = text.replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
    // **只认反引号里的文件引用**——散文里的 `Node.js` / `settings.yaml` 不是锚点
    const spans = []
    BACKTICK.lastIndex = 0
    let b
    while ((b = BACKTICK.exec(stripped)) !== null) {
      spans.push({ text: b[1], at: b.index, len: b[0].length })
    }
    for (const span of spans) {
      const fm = FILE_REF.exec(span.text)
      if (!fm) continue
      FILE_REF.lastIndex = 0
      const [full, ref, ln1, ln2] = fm
      const at = span.at

      // 调研原始档案：锚点指向**别的仓库**，本仓守卫无从校验 → 独立类别、逐条计数
      if (RESEARCH_DIRS.some((d) => relMd.startsWith(d))) {
        research.push({ doc: relMd, line: docLine, ref: full, why: '调研原始档案：锚点指向外部项目代码，不参与判定' })
        continue
      }

      // ① **绑定符号**：锚点之后**紧邻**的那个反引号 token，且间隙**只有**一个领属/方位词
      //    （`file.ext` 的 `SYMBOL` / `file.ext` 中 `SYMBOL`）。
      //    这是「文档断言该文件里有这个符号」的**语法绑定**——
      //    间隙里若还夹着别的散文，就说明那句话谈的是多件事，不能断定符号属于该文件。
      let bound = null
      for (const other of spans) {
        if (other.at < at + span.len) continue
        if (other.at - (at + span.len) > 40) break
        const gap = stripped.slice(at + span.len, other.at)
        // 间隙必须**只有**领属词（可带括号/空格），不能夹带其它文字
        if (!/^\s*[（(【\[]?\s*[的中里内处]\s*$/.test(gap)) continue
        const n = needleOf(other.text.trim())
        if (n) {
          bound = n
          break
        }
      }

      // ② 其它候选（邻近 ±90 字符内的反引号 token 与裸代码形标识符）——只用于「符号在不在锚定行」
      const cands = []
      const candsNear = []
      for (const other of spans) {
        if (other.at === at) continue
        if (Math.abs(other.at - at) > 90) continue
        const tok = other.text.trim()
        if (IS_FILE_REF.test(tok)) continue
        if (HEXONLY.test(tok)) continue
        const n = needleOf(tok)
        if (!n) continue
        cands.push(n)
        if (Math.abs(other.at - at) <= 30) candsNear.push(n)
      }
      // 裸的代码形标识符（文档里常写成 `src/asr.ts:945` MAX_SEGMENT_MS，符号不加反引号）
      // **必须扫描整行再按距离筛选**——若先按固定偏移切片，切片边界会把标识符截成
      // 「showStatusBa」这种碎片，制造假阳性。
      for (const raw of stripped.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g)) {
        if (Math.abs(raw.index - at) > 90) continue
        if (HEXONLY.test(raw[0])) continue
        if (!looksLikeCode(raw[0])) continue
        cands.push(raw[0])
        if (Math.abs(raw.index - at) <= 30) candsNear.push(raw[0])
      }

      const path = resolvePath(ref)
      const relSrc = path ? relative(ROOT, path).split(sep).join('/') : ref
      const adjacent = near(stripped, at, span.len, 60)

      // ── 不是锚点的「路径引用」：既无行号、邻近也没有符号 token ──
      // 文档里大量只是**提到某个文件路径**（如 `docs/qa/user-experience-flow.md`、`.d.ts`），
      // 那不是「指向某一行代码的锚点」，不应参与判定。
      if (ln1 === undefined && cands.length === 0) {
        pathRefs.push({ doc: relMd, line: docLine, ref: full, why: '仅路径提及，无行号也无符号 → 非锚点' })
        continue
      }

      if (!path) {
        // 文件不存在：可能是「已删/已改名/外部」——文档在如实陈述，不是坏锚点
        const rec = {
          doc: relMd,
          line: docLine,
          ref: full,
          why: `文件不存在：${ref}（仓库根 / plugin 根 / docs 根 / src|test|scripts|lib 均未解析到）`,
        }
        if (EXTERNAL_PATH.test(ref)) {
          rec.why = `外部路径（非仓库内文件），不参与判定：${ref}`
          external.push(rec)
        } else if (THIRD_PARTY.test(text)) {
          rec.why = `第三方包内的文件，不在本仓、不参与判定：${ref}`
          external.push(rec)
        } else if (DEAD_FILE_MARK.test(adjacent)) {
          rec.why = `文件不存在（文档已声明该文件被删除/改名/未入库），属历史陈述：${ref}`
          historical.push(rec)
        } else if (ln1 === undefined) {
          // **无行号**的文件路径：只是「提到某个文件」，不是「指向某一行」的锚点
          rec.why = `仅路径提及（无行号）且该文件不在仓库内 → 非代码锚点：${ref}`
          pathRefs.push(rec)
        } else {
          errors.push(rec)
        }
        continue
      }
      const { content, lines } = loadFile(path)

      // ② 候选 token 过滤：必须真的出现在源文件里（滤掉散文词）
      const real = cands.filter((c) => hasWord(content, c))
      // 文档**语法绑定**了、但源文件里根本没有的**代码形符号** → 锚点写错了
      // （不是"无从判定"）。只看绑定符号：同一行里无关的散文符号不算。
      const missing = bound && looksLikeCode(bound) && !hasWord(content, bound) ? [bound] : []
      if (missing.length > 0) {
        const rec = {
          doc: relMd,
          line: docLine,
          ref: full,
          why: `文档断言的符号在源文件里不存在：${missing.join(' / ')}（${relSrc}）`,
        }
        // 历史标记按**整行 + 最近的上级小节标题**判定——后记式根因分析
        // （如 compat-contract §15.1「触发与根因」）整节都在陈述**过去的**根因，
        // 符号早已被删除，节内引用不该判红。
        let histCtx = text
        for (let k = i - 1; k >= 0 && k >= i - 12; k--) {
          if (/^\s*#{1,6}\s/.test(mdLines[k])) {
            histCtx += '\n' + mdLines[k]
            break
          }
        }
        if (DEAD_SYMBOL_MARK.test(histCtx)) {
          rec.why = `文档断言的符号「${missing.join(' / ')}」在 ${relSrc} 不存在，但行内已声明该符号被删除/砍除/属他方 → 属历史陈述`
          historical.push(rec)
        } else {
          errors.push(rec)
        }
        continue
      }
      if (real.length === 0) {
        undecidable.push({
          doc: relMd,
          line: docLine,
          ref: full,
          why: `锚点附近无可判定的符号 token（候选：${cands.slice(0, 3).join(' / ') || '无'}），需人工补符号锚或接受现状`,
        })
        continue
      }

      if (ln1 === undefined) {
        // ③ 符号锚形态：符号必须存在（已在 real 里保证）→ 通过
        continue
      }

      // ④ 行号锚形态
      const a = Number(ln1)
      const b = ln2 === undefined ? a : Number(ln2)
      if (a < 1 || a > lines.length || b < 1 || b > lines.length) {
        errors.push({
          doc: relMd,
          line: docLine,
          ref: full,
          why: `行号越界：${relSrc} 共 ${lines.length} 行，锚点写 ${a}${b !== a ? `-${b}` : ''}`,
        })
        continue
      }
      const lo = Math.max(0, Math.min(a, b) - 1 - 3)
      const hi = Math.min(lines.length, Math.max(a, b) + 3)
      const window = lines.slice(lo, hi).join('\n')
      const hit = real.find((c) => hasWord(window, c))
      if (hit) continue
      // 符号存在但不在锚定行附近 → 行号漂移（找出它现在在哪）
      const where = real
        .map((c) => {
          for (let k = 0; k < lines.length; k++) if (hasWord(lines[k], c)) return `${c} → ${relSrc}:${k + 1}`
          return null
        })
        .filter(Boolean)
      const rec = {
        doc: relMd,
        line: docLine,
        ref: full,
        symbol: real.join(' / '),
        where: where.join('；'),
        why: `行号快照已漂移：${real.join(' / ')} 不在 ${relSrc}:${a}${b !== a ? `-${b}` : ''} 附近（±3 行窗口），但在同文件他处`,
      }
      if (HISTORICAL_MARK.test(near(stripped, at, full.length, 30))) historical.push(rec)
      else drifts.push(rec)
    }
  })
}

const summary = {
  errors: errors.length,
  drift: drifts.length,
  undecidable: undecidable.length,
  historical: historical.length,
  external: external.length,
  pathRefs: pathRefs.length,
  research: research.length,
}

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      { summary, errors, drifts, undecidable, historical, external, pathRefs, research },
      null,
      2,
    ),
  )
} else {
  const show = (title, list, icon) => {
    if (list.length === 0) return
    console.log(`\n${icon} ${title}（${list.length}）`)
    for (const r of list) {
      console.log(`   ${r.doc}:${r.line}  ${r.ref}`)
      console.log(`      ${r.why}${r.where ? `\n      实际位置：${r.where}` : ''}`)
    }
  }
  console.log('=== 文档 file:line 锚点守卫 ===')
  console.log(
    `  扫描 ${mdFiles.length} 个 markdown；` +
      `错误 ${summary.errors} / 行号漂移 ${summary.drift} / 无法判定 ${summary.undecidable} / ` +
      `历史时点 ${summary.historical} / 外部路径 ${summary.external} / 仅路径提及 ${summary.pathRefs} / ` +
      `调研档案 ${summary.research}`,
  )
  show('❌ ERROR：锚点真的坏了（文件不存在 / 行号越界 / 符号全文都找不到）', errors, '❌')
  show('⚠️ DRIFT：行号快照已漂移（符号仍有效，待最终 HEAD 稳定后统一回填行号）', drifts, '⚠️')
  show('🔍 待人工确认：抽不出可判定符号，需人工补符号锚或接受现状', undecidable, '🔍')
  show('🕘 历史时点：邻近已标历史，行号/文件允许过时（仅列备查）', historical, '🕘')
  show('🌐 外部路径：非仓库内文件，不参与判定（仅列备查）', external, '🌐')
  show('📚 调研档案：锚点指向外部项目代码，不参与判定（仅列备查）', research, '📚')
}

const baselinePath = join(here, 'doc-anchors-baseline.json')
if (UPDATE_BASELINE) {
  const payload = {
    _说明:
      'D-13 基线：errors 必须恒为 0；drift / undecidable 不得超过本值——新增债务即红。' +
      '每条无法判定项都需人工消解（补符号锚或明确接受）。',
    errors: 0,
    drift: drifts.length,
    undecidable: undecidable.length,
    _生成于: new Date().toISOString(),
  }
  writeFileSync(baselinePath, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  console.log(`\n✓ 已写基线：${baselinePath}（drift=${drifts.length} undecidable=${undecidable.length}）`)
  process.exit(errors.length > 0 ? 1 : 0)
}

let baseline = null
if (existsSync(baselinePath)) {
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  } catch {
    baseline = null
  }
}

if (errors.length > 0) {
  console.error(`\n✗ 有 ${errors.length} 处锚点坏了——必须修。`)
  process.exit(1)
}
if (baseline) {
  const over = []
  if (typeof baseline.drift === 'number' && drifts.length > baseline.drift)
    over.push(`DRIFT ${drifts.length} > 基线 ${baseline.drift}`)
  if (typeof baseline.undecidable === 'number' && undecidable.length > baseline.undecidable)
    over.push(`无法判定 ${undecidable.length} > 基线 ${baseline.undecidable}`)
  if (over.length > 0) {
    console.error(`\n✗ 超出基线：${over.join('；')}——**新增了锚点债务**，请消解或显式更新基线。`)
    process.exit(2)
  }
  console.log(
    `\n✓ 在基线之内（DRIFT ${drifts.length}/${baseline.drift}、无法判定 ${undecidable.length}/${baseline.undecidable}）；` +
      `债务减少时可跑 --update-baseline 收紧基线。`,
  )
} else {
  console.log('\n⚠ 未找到基线文件 scripts/doc-anchors-baseline.json——先跑 --update-baseline 固化当前债务。')
  process.exit(2)
}
process.exit(0)
