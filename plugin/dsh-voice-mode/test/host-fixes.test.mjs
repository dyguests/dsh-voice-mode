/**
 * Issue #15 host 侧修复回归（B1 之外的 Important/Minor）：混合定位——**合同级快速锁
 * **（源码形态/正则断言，毫秒级、不依赖时序）+ **行为级实证**（真编译 asr-host.ts /
 * tts-queue.ts 驱动，分钟级）。行为级用例共 3 条（文末两段 sweep + listEdgeVoices）：
 *  I2 错误响应一律 writeHead（gzip 包装器下隐式头会产出 ERR_CONTENT_DECODING_FAILED）；
 *  I4 限流键反代不塌缩（X-Forwarded-For 首段，仅回环来源采信；src/index.ts:619 读 for）；
 *  M7 /toggle 缺 on 显式 400；M6 /correct enabled=false 返 403 + per-client 限流键；
 *  M11 /asr、/stream 补跨源校验；M13 /models/clean 删两个 kokoro 精度目录；
 *  M3 /models/retry 补 .catch；M14 collectBody 413 后 pause + flush 后断流。
 *  R2 验真轮：M1 sweep 孤立 sid 扫描漏判 finalizing 在途定稿 → resetGen 代际可复用 →
 *    陈旧定稿文本写入新会话缓存（Important 回归）——loop2（resetGen 扫描）行为级实证。
 *  R3 验真轮：loop1（finalized 扫描）守卫行为级零锁 → 两段式用例补上（先产缓存再
 *    在途定稿+sweep；与 loop2 毒链用例互为独立变异锁定，只废其一另一个仍绿）。
 *    I-1 修复口径（R3 实修、R5 复核）：t 改 async 后**全部 16 个 await 站点**——13 个既有
 *    同步用例转换 + 2 个 R2 异步用例（毒链/listEdgeVoices）+ 1 个 R3 新增（loop1 两段式）。
 *    （历史 commit message 写的「15 个调用点」不实，以本头注为准。）
 * 运行：node test/host-fixes.test.mjs（离线，无网络/无 dsh 依赖）。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const src = (f) => readFileSync(join(here, '..', 'src', f), 'utf8')
const indexSrc = src('index.ts')

let passed = 0
const t = async (name, fn) => {
  await fn()
  passed++
  console.log('  ✓ ' + name)
}

console.log('I2 错误响应走 respondJson（writeHead 铁律）')
await t('denyNonLoopback / denyCrossOrigin 无隐式头路径', () => {
  // 隐式头 = statusCode 赋值 + setHeader + end 三段式；gzip 包装器只拦 writeHead。
  for (const guard of ['denyNonLoopback', 'denyCrossOrigin']) {
    const i = indexSrc.indexOf(`const ${guard} =`)
    assert.ok(i > 0, `缺 ${guard} 定义`)
    const body = indexSrc.slice(i, indexSrc.indexOf('\n  }\n', i))
    assert.ok(!/res\.statusCode\s*=/.test(body), `${guard} 仍走隐式头（gzip 下 ERR_CONTENT_DECODING_FAILED）`)
    assert.ok(!/res\.setHeader/.test(body), `${guard} 仍用 setHeader`)
    assert.ok(/respondJson\(res, 403/.test(body), `${guard} 未走 respondJson`)
  }
})
await t('preview / toggle / cancel 三处 429 与 /mode 400/500 全部 respondJson', () => {
  // 路由体内不得再出现隐式头三段式（405 Allow 头是合法的非 JSON 响应，排除）。
  const implicit = [...indexSrc.matchAll(/res\.statusCode\s*=\s*(\d+)[\s\S]{0,200}?res\.setHeader\('content-type'/g)]
  assert.equal(implicit.length, 0, `仍有 ${implicit.length} 处隐式头 JSON 响应（gzip 包装器下断链）`)
  for (const [path, status] of [
    ['preview', 429],
    ['toggle', 429],
    ['cancel', 429],
    ['mode', 400],
  ]) {
    const i = indexSrc.indexOf(`path: \`\${base}/${path}\``)
    assert.ok(i > 0, `缺 /${path} 路由`)
    const end = indexSrc.indexOf('ctx.effect(() =>', i + 10)
    const body = indexSrc.slice(i, end > i ? end : i + 2000)
    assert.ok(body.includes(`respondJson(res, ${status}`), `/${path} 缺 respondJson ${status}`)
    assert.ok(!/res\.statusCode\s*=/.test(body), `/${path} 仍有隐式头路径`)
  }
})

console.log('I4 限流键反代不塌缩')
await t('clientKey：仅回环来源采信 X-Forwarded-For 首段', () => {
  const i = indexSrc.indexOf('const clientKey =')
  assert.ok(i > 0, '缺 clientKey 助手')
  const body = indexSrc.slice(i, indexSrc.indexOf('\n  }\n', i))
  assert.ok(/isLoopbackRequest\(req\)/.test(body), '未先校验回环——远端可伪造 XFF 绕过限流')
  assert.ok(/x-forwarded-for/.test(body), '未读 X-Forwarded-For')
  assert.ok(/split\(','\)\[0\]/.test(body), '未取首段（最左=原始客户端）')
  assert.ok(/remoteAddress/.test(body), '缺 remoteAddress 回退')
})
await t('preview / correct 限流键都经 clientKey（不再裸 remoteAddress / 全局键）', () => {
  assert.ok(indexSrc.includes('preview:${clientKey(req)}'), 'preview 键未走 clientKey')
  assert.ok(indexSrc.includes('correct:${clientKey(req)}'), 'correct 键未走 clientKey')
  assert.ok(!/preview:\$\{req\.socket\.remoteAddress/.test(indexSrc), 'preview 仍裸用 remoteAddress')
  assert.ok(!/limiter\.hit\('correct'/.test(indexSrc), 'correct 仍是全局键（一人点满、全体回退原文）')
})

console.log('M6 /correct 语义分流')
await t('enabled=false 返 403 voice_disabled（不再与限流 429 混谈）', () => {
  const i = indexSrc.indexOf('path: `${base}/correct`')
  const end = indexSrc.indexOf('ctx.effect(() =>', i + 10)
  const body = indexSrc.slice(i, end)
  assert.ok(body.includes("respondJson(res, 403, { code: 'voice_disabled'"), 'enabled=false 未返 403 voice_disabled')
  assert.ok(body.includes('normalizePromptLang(parsed.lang)'), 'lang 未走 prompts.ts 单一真源')
  assert.ok(!/parsed\.lang === 'en'/.test(body), 'lang 仍内联 === 判断（en-US/zh-CN 会被误判）')
})

console.log('M7 /toggle 缺 on 显式 400')
await t('on 缺失显式 400，不静默落退出分支', () => {
  const i = indexSrc.indexOf('path: `${base}/toggle`')
  const end = indexSrc.indexOf('ctx.effect(() =>', i + 10)
  const body = indexSrc.slice(i, end)
  assert.ok(/if \(on === undefined\)/.test(body), '缺 on===undefined 分支')
  assert.ok(body.includes("respondJson(res, 400, { code: 'bad_request', error: 'on required' })"), 'on 缺失未显式 400')
  // 非布尔仍须 400（原守卫不能被上述分支吃掉）
  assert.ok(/if \(typeof on !== 'boolean'\)/.test(body), '缺 on 非布尔守卫')
})

console.log('M11 /asr 与 /stream 补跨源校验')
await t('两个路由都在 denyNonLoopback 之后紧跟 denyCrossOrigin', () => {
  for (const p of ['asr', 'stream']) {
    const i = indexSrc.indexOf(`path: \`\${base}/${p}\``)
    assert.ok(i > 0, `缺 /${p} 路由`)
    const body = indexSrc.slice(i, i + 400)
    const nb = body.indexOf('denyNonLoopback(req, res)')
    const co = body.indexOf('denyCrossOrigin(req, res)')
    assert.ok(nb > 0 && co > nb, `/${p} 未在回环校验后补跨源校验`)
  }
})

console.log('M13 /models/clean 删两个 kokoro 精度目录')
await t('kokoro 清理覆盖 int8 + fp32', () => {
  const i = indexSrc.indexOf('path: `${base}/models/clean`')
  const end = indexSrc.indexOf('ctx.effect(() =>', i + 10)
  const body = indexSrc.slice(i, end)
  assert.ok(body.includes("kokoroModelDir('int8')") && body.includes("kokoroModelDir('fp32')"), '未覆盖两个精度目录')
  // 去掉注释后再判：实现里不得再出现「只按当前精度取目录」（反引号内的说明文字不算）。
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.ok(!/kokoroModelDir\(vset\.kokoroModel\)/.test(code), '仍只删当前精度（另一精度旧模型永久占盘）')
})

console.log('M3 /models/retry 补 .catch')
await t('retryModel 链带 .catch（对齐 download/clean）', () => {
  const i = indexSrc.indexOf('path: `${base}/models/retry`')
  const end = indexSrc.indexOf('ctx.effect(() =>', i + 10)
  const body = indexSrc.slice(i, end)
  assert.ok(/void asr\s*\.retryModel\(kind\)/.test(body), 'retryModel 调用形态被改坏')
  assert.ok(/\.catch\(\(e\) =>/.test(body), 'retryModel 缺 .catch——异常逃逸成未处理 rejection，HTTP 永不响应')
})

console.log('M14 collectBody 413 后止读断流')
await t('413 分支 pause + flush 后 destroy', () => {
  const i = indexSrc.indexOf('function collectBody')
  const body = indexSrc.slice(i, indexSrc.indexOf('\n}\n', i))
  const over = body.indexOf("respondJson(res, 413")
  assert.ok(over > 0, '缺 413 分支')
  const tail = body.slice(over, over + 600)
  assert.ok(/req\.pause\(\)/.test(tail), '413 后未 pause——请求流继续读入累积内存')
  assert.ok(/res\.once\('finish', \(\) => req\.destroy\(\)\)/.test(tail), '413 后未断流（且不得在 flush 前 destroy，否则客户端收到截断响应）')
})

console.log('I3 + M7 zod 界（两层一致）')
await t('Config 数值字段与 settings schema 同界', () => {
  const cfg = indexSrc.slice(indexSrc.indexOf('export const Config:'), indexSrc.indexOf('/**\n * 0.1.7+ 路径 B'))
  const expect = [
    ['rate', 0.5, 2],
    ['silenceMs', 500, 30000],
    ['idleTimeoutMinutes', 1, 120],
    ['echoGateDb', 3, 12],
    ['yieldMs', 500, 3000],
  ]
  for (const [field, min, max] of expect) {
    // 形如 `rate: z.number().min(0.5).max(2).default(1.1)`——链上可能还有 .description(...)
    const m = new RegExp(`${field}: z\\.number\\(\\)((?:\\.(?:min|max)\\([^)]*\\))*)\\.default`).exec(cfg)
    assert.ok(m, `Config.${field} 不是 z.number().min().max().default 形态`)
    assert.ok(m[1].includes(`.min(${min})`), `Config.${field} 缺 .min(${min})`)
    assert.ok(m[1].includes(`.max(${max})`), `Config.${field} 缺 .max(${max})`)
  }
})

console.log('M15 turnGen 随回合表一并清理')
await t('clearTurnState 同时清 turnStates 与 turnGen，三处收尾都走它', () => {
  assert.ok(/const clearTurnState = /.test(indexSrc), '缺 clearTurnState 助手')
  const uses = indexSrc.match(/clearTurnState\((?:sid|previous|sessionId)\)/g) ?? []
  assert.equal(uses.length, 3, `clearTurnState 应覆盖 退出/让出/被抢占 三处，实际 ${uses.length}`)
  // 三处旧写法（setTurn + turnStates.delete 成对）不得残留
  const leftovers = indexSrc.match(/turnStates\.delete\(/g) ?? []
  assert.equal(leftovers.length, 1, `turnStates.delete 应只在 clearTurnState 内出现一次，实际 ${leftovers.length}`)
})

console.log('R2：sweep 孤立 sid 扫描必须排除 finalizing 在途定稿（快速契约锁）')
await t('两个扫描循环的 continue 条件都含 finalizing.has(sid)', () => {
  const asrSrc = src('asr-host.ts')
  // M1 引入的回归：只判 segments.has(sid) 会在 senseP 窗口内误删 resetGen → 代际可复用
  // → 陈旧定稿文本写入新会话缓存（Important）。行为级实证两条（文末，耗时长）：
  //   loop2（resetGen 扫描）= R2 毒链用例；loop1（finalized 扫描）= R3 两段式用例。
  // 本快速锁不依赖时序，但单独不足以定位到具体循环——变异实证：只废 loop1 守卫时
  // 本锁对 loop1 的失守不可见（两条循环同形），行为级用例才分得开。
  const guards = [...asrSrc.matchAll(/if \(segments\.has\(sid\)[^\n]*continue/g)]
  assert.equal(guards.length, 2, `sweep 应有 2 处孤立 sid 扫描循环，实际 ${guards.length}`)
  for (const [full] of guards) {
    assert.ok(full.includes('finalizing.has(sid)'), `扫描循环漏判 finalizing 在途定稿：${full.trim()}`)
  }
})

// ---------------------------------------------------------------------------
// R2 验真轮：M1 sweep 孤立 sid 扫描漏判 finalizing 在途定稿（Important 回归）
//
// 毒链（实测复现，非推理）：
//   进模式 reset(gen=1) → 首句 final 在途（senseP 挂起，段已同步摘除）→
//   30s sweep 只判 segments.has(sid)=false → resetGen.delete(sid) →
//   barge-in reset() 令 gen 回到 1（计数器被复用）→ 旧定稿 .then 的代际守卫
//   1===1 通过 → 陈旧文本写入新会话 epoch 0 缓存 → 下一句 final 缓存命中返回旧文本
//   （autoSend 默认开，错文本可能直接发出）。
// 修法判定：sweep 两个扫描循环都必须同时排除 finalizing.has(sid)——finalize 入口
// 摘段与 finalizing 登记是同一同步块，故 senseP 窗口内 segments 恒无该 sid 而
// finalizing 恒有，是精确的在途信号。
//
// 本用例为行为级实证：真编译 asr-host.ts，桩掉 sherpa-onnx / models / sense-worker
// （decode 可控挂起），按真实 30s sweep 间隔走完整毒链。耗时 ~32s（sweep 间隔
// 30s 无法压缩），是为 Important 回归付的必要成本。
// ---------------------------------------------------------------------------
console.log('R2：sweep 不得在定稿在途时回收 resetGen（代际复用毒链）')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 固定目录（不删除）：asr-host.ts 里 new Worker('./sense-worker.mjs') 的路径由 bundle 的
// import.meta.url 推导，worker 线程可能晚于测试结束才排空/报错——若目录被 rmSync 掉，
// 该线程会抛 MODULE_NOT_FOUND 污染测试输出。占位文件仅数 KB，留在 tmpdir 由 OS 回收。
const sweepTmp = join(tmpdir(), 'dsh-vm-sweep-fix')
mkdirSync(sweepTmp, { recursive: true })
// sherpa-onnx 桩：recognizer 的 getResult 恒返回空串，使定稿文本完全由 sense 桩决定
// （zipformer 分支空 → 回落 sense 文本，便于区分「陈旧」与「新鲜」）。
writeFileSync(
  join(sweepTmp, 'sherpa-stub.mjs'),
  `
export function createOnlineRecognizer() {
  return {
    createStream: () => ({ acceptWaveform: () => {}, clear: () => {}, free: () => {} }),
    isReady: () => false,
    decode: () => {},
    getResult: () => ({ text: '' }),
    free: () => {},
    config: { featConfig: { sampleRate: 16000 } },
  }
}
export function createVad() {
  return {
    acceptWaveform: () => {}, isDetected: () => false, isEmpty: () => true,
    front: () => ({ samples: new Float32Array(0), start: 0 }), pop: () => {},
    clear: () => {}, free: () => {},
  }
}
export default { createOnlineRecognizer, createVad }
`,
)
// models 桩：ensureModelFile/ensureModelTree 恒 true（跳过 SHA256 与下载）
writeFileSync(
  join(sweepTmp, 'models-stub.mjs'),
  `
export const HOST_PRIMARY = 'https://huggingface.co'
export function validateModelHost(h, _a) { return h || HOST_PRIMARY }
export async function ensureModelFile() { return true }
export async function ensureModelTree() { return true }
`,
)
// sense-worker 桩：decode 可控——默认 0 号挂起等放行（旧毒链用例依赖），其余经
// __senseHang(idx) 显式挂起（R3 两段式 loop1 用例用）；未挂起的调用立即返回
// textFor(idx)（0→STALE-TEXT，其余→FRESH-TEXT）。这样「缓存命中」与「重新定稿」
// 在返回值上可区分。terminate 真终止 worker 线程并暴露可 await 的完成句柄，
// 让测试收尾确定性等待（不靠魔法 sleep）。
const senseStub = join(sweepTmp, 'sense-stub.mjs')
writeFileSync(
  senseStub,
  `
const releases = []
const hang = new Set([0])
let calls = 0
let realWorker = null
let terminateDone = Promise.resolve()
const textFor = (idx) => (idx === 0 ? 'STALE-TEXT' : 'FRESH-TEXT')
globalThis.__senseCalls = () => calls
globalThis.__senseHang = (idx) => hang.add(idx)
globalThis.__senseRelease = (idx, text) => releases[idx]?.(text)
globalThis.__senseReleaseFirst = (text) => releases[0]?.(text)
globalThis.__senseAwaitTerminate = () => terminateDone
export function createSenseWorkerClient(w) {
  realWorker = w
  return {
    request: async (op) => {
      if (op === 'create') return true
      const idx = calls++
      if (hang.has(idx)) return new Promise((resolve) => { releases[idx] = resolve })
      return textFor(idx)
    },
    onDeath: () => {},
    terminate: async () => {
      // asr-host 的 dispose 只 fire-and-forget 调 terminate，故此处自行串行化并
      // 对外暴露句柄；真终止底层 worker 线程，避免测试进程被悬挂线程拖住不退出。
      terminateDone = (async () => {
        try { await realWorker?.terminate() } catch { /* 已退出则忽略 */ }
      })()
      await terminateDone
    },
  }
}
`,
)
// asr-host.ts 里 new Worker(workerPath) 需要真实存在的文件；空模块的 worker 线程
// 事件循环随即排空、自然退出，不会悬挂拖住测试进程。
writeFileSync(join(sweepTmp, 'sense-worker.mjs'), '// 桩占位：本测试的 sense 客户端由 sense-stub.mjs 提供\n')

const sweepBundle = join(sweepTmp, 'asr-host.bundle.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'asr-host.ts')],
  outfile: sweepBundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: { 'sherpa-onnx': join(sweepTmp, 'sherpa-stub.mjs') },
  plugins: [
    { name: 'stub-models', setup(b) { b.onResolve({ filter: /\.\.?\/models\.ts$/ }, () => ({ path: join(sweepTmp, 'models-stub.mjs') })) } },
    { name: 'stub-sense', setup(b) { b.onResolve({ filter: /\.\.?\/sense-worker\.ts$/ }, () => ({ path: senseStub })) } },
  ],
  logLevel: 'silent',
})
const { createAsrRuntime } = await import(pathToFileURL(sweepBundle).href)

await t('定稿在途时 sweep 不回收 resetGen：barge-in 后旧定稿不得写入新会话缓存', async () => {
  const SID = 's-sweep'
  const samples = new Float32Array(1600).fill(0.1)
  const rt = createAsrRuntime({
    cacheDir: sweepTmp,
    modelHost: () => 'huggingface.co',
    senseVoice: () => true, // 开：走 senseP 竞速路径（本用例的关键窗口）
    silenceMs: () => 1500,
    senseITN: () => true,
    allowCustomHost: false,
    broadcast: () => {},
    bargeInMode: () => 'auto',
  })
  try {
    // T≈0：进模式 → reset 令 gen=1（毒链起点：必须先有代际，删除才会造成「复用」）
    rt.reset(SID)
    // 等到 sweep 间隔（30s）临近再发起定稿，使 sweep 必然落在 senseP 窗口内。
    await sleep(29000)
    // T≈29s：首句 final —— 段被同步摘除（segments 无 sid），finalizing 登记，
    // senseP 挂在桩的 decode 上（≤20s 超时前由本测试放行）。
    const first = rt.feed(SID, samples, true, 0, 0, true)
    await sleep(400) // 等 finalizing 登记完成（feed 内有 await getRecognizer）
    // T≈30s：sweep 触发。有 bug 时 resetGen[sid] 被删；修复后 finalizing.has(sid) 拦下。
    await sleep(2200)
    // barge-in：reset() 再递增代际。有 bug 时计数器已删 → gen 回到 1（复用）；
    // 修复后 gen=2，旧定稿的守卫 2!==1 必然拦下写回。
    rt.reset(SID)
    // 放行在途定稿（陈旧文本）。修复后其 .then 因代际不匹配放弃写缓存。
    globalThis.__senseReleaseFirst('STALE-TEXT')
    await first
    await sleep(100)
    // 下一句 final（新会话 epoch 0）：缓存命中=旧文本被投毒；未命中=重新定稿得新文本。
    const second = await rt.feed(SID, samples, true, 0, 0, true)
    assert.equal(
      second.text,
      'FRESH-TEXT',
      '毒链复现：sweep 在定稿在途时回收了 resetGen → 代际复用 → 陈旧文本写入新会话缓存（autoSend 默认开会直接发出错文本）',
    )
    assert.equal(globalThis.__senseCalls(), 2, '第二次 final 应重新定稿（缓存未被陈旧文本污染）')
  } finally {
    // 生命周期依赖（R2 验真轮崩溃根因，勿改回「随手 rmSync 临时目录」）：
    //  1) rt.dispose() 必须调用——它清 sweep 的 setInterval(30s)，否则测试进程被
    //     该 timer 拖住永不退出；
    //  2) dispose 内部只 fire-and-forget 调 senseWorker.terminate()，故此处再
    //     await 桩暴露的句柄，确定性等 worker 线程终止（不靠魔法 sleep）；
    //  3) sweepTmp 用**固定目录且不删除**——asr-host.ts 的 new Worker('./sense-worker.mjs')
    //     路径由 bundle 的 import.meta.url 推导，worker 线程可能在测试结束后才排空/
    //     加载入口模块；若目录被 rmSync 掉，该线程抛 MODULE_NOT_FOUND 污染输出
    //     （两个 teammate 实测复现）。占位文件仅数 KB，留 tmpdir 由 OS 回收。
    rt.dispose()
    await globalThis.__senseAwaitTerminate()
  }
})

// ---------------------------------------------------------------------------
// R3 验真轮：sweep loop1（finalized 扫描循环）的 finalizing 守卫零有效锁——
// 现有毒链用例首句在途时 finalized 为空（reset 会清 finalized，见 runtime.reset），
// loop1 的 finalized.keys() 迭代结构上够不到；上方「快速契约锁」虽两条循环都扫，
// 但行为级只覆盖了 loop2（resetGen 扫描）。
//
// 两段式（关键：全程不插 reset——reset 会清 finalized，缓存存活本身即是判据）：
//   阶段 1：epoch0 定稿成功 → finalized[SID][0]='FIRST-OK'（loop1 的扫描对象）；
//   阶段 2：等到 30s sweep 临近 → epoch1 定稿在途（senseP 挂起、段已摘除）→
//           sweep 落入窗口：loop1 见 finalized 非空 + finalizing 在途；
//           修复 → continue（缓存与代际都存活）；bug → 删 finalized+resetGen；
//   阶段 3：第三句 final（epoch0）→ 修复：命中阶段 1 缓存原样返回（不重新定稿）；
//           bug：缓存被删 → 重新定稿得 FRESH-TEXT（且 sense 调用数 +1）。
// 耗时 ~31s（sweep 间隔 30s 无法压缩）。
// ---------------------------------------------------------------------------
console.log('R3：sweep loop1（finalized 扫描）不得在定稿在途时删缓存')

await t('sweep loop1 finalizing 守卫：定稿缓存存在时在途定稿不回收（缓存存活+不重定稿）', async () => {
  const SID = 's-sweep-loop1'
  const samples = new Float32Array(1600).fill(0.1)
  const base = globalThis.__senseCalls()
  const rt = createAsrRuntime({
    cacheDir: sweepTmp,
    modelHost: () => 'huggingface.co',
    senseVoice: () => true,
    silenceMs: () => 1500,
    senseITN: () => true,
    allowCustomHost: false,
    broadcast: () => {},
    bargeInMode: () => 'auto',
  })
  try {
    rt.reset(SID) // gen=1
    // ── 阶段 1：epoch0 定稿成功 → 产生 finalized 缓存
    const i1 = globalThis.__senseCalls()
    globalThis.__senseHang(i1)
    const first = rt.feed(SID, samples, true, 0, 0, true)
    await sleep(300)
    globalThis.__senseRelease(i1, 'FIRST-OK')
    await first
    await sleep(100)
    // ── 阶段 2：逼近 30s sweep 间隔 → epoch1 定稿在途（senseP 挂起制造窗口）
    // 注意 feed 实参顺序是 (sessionId, samples, final, offset, epoch, manualPressed)：
    // 阶段 2 必须用**不同 epoch**（1），否则会命中阶段 1 的 epoch0 缓存而直接返回，
    // 根本不会产生在途定稿——那样 sweep 见 finalizing 无该 sid 而删缓存是**正确**行为，
    // 用例会假红（实测阶段 2 返回 'FIRST-OK'、senseCalls 不增即此因）。
    await sleep(29200)
    const i2 = globalThis.__senseCalls()
    globalThis.__senseHang(i2)
    const second = rt.feed(SID, samples, true, 0, 1, true)
    await sleep(400) // 等 finalizing 登记完成（feed 内有 await getRecognizer）
    // T≈30s：sweep 触发。loop1 见 finalized.has(SID)（阶段 1 产出）+ finalizing.has(SID)
    //   → 修复 continue；bug（守卫废）删 finalized+resetGen。
    await sleep(2200)
    // 放行在途定稿（无 reset → 代际不变，写回守卫 1===1 两条路径都放行；
    // 差别只在缓存是否被 sweep 删过：bug 路径 finalized 被删后由写回重建为 {1:…}，
    // 阶段 1 的 epoch0 条目已丢失）。
    globalThis.__senseRelease(i2, 'STALE-TEXT-1')
    await second
    await sleep(100)
    // ── 阶段 3：第三句 final（epoch0）：修复命中阶段 1 缓存；bug 缓存缺席重新定稿
    const third = await rt.feed(SID, samples, true, 0, 0, true)
    assert.equal(
      third.text,
      'FIRST-OK',
      'loop1 守卫失效：sweep 在定稿在途时删了 finalized 缓存——客户端重试同 epoch final 将丢缓存重定稿（loop1 行为级零锁）',
    )
    assert.equal(globalThis.__senseCalls(), base + 2, '第三句应命中阶段 1 缓存（未重新定稿）')
  } finally {
    // 生命周期依赖同上方毒链用例（勿改回随手 rmSync）：dispose 清 sweep timer +
    // 确定性等 worker 终止；sweepTmp 固定目录不删除（worker 入口模块延迟加载）。
    rt.dispose()
    await globalThis.__senseAwaitTerminate()
  }
})

// ---------------------------------------------------------------------------
// R2 验真轮：listEdgeVoices 的超时 timer 成功后必须 clear（与 asr-host senseP 的
// M2 同一反模式）。早年只 unref——race 落定后 timer 仍走完，/voices 每次调用留一个
// 30s 悬挂 timer；设置面板反复拉取音色即累积。unref 至少保证不拖住进程退出，故
// 「只 unref 不 clear」这一中间态在外部不可观测（getActiveResourcesInfo 不报 unref'd
// timer），本用例锁的是「clear 到位」：清掉后进程无悬挂 Timeout。
// 实现策略同 asr-host 行为测试：esbuild 真编译 tts-queue.ts，桩掉 msedge-tts。
// ---------------------------------------------------------------------------
console.log('R2：listEdgeVoices 超时 timer 落定即 clear')

const ttsqTmp = join(tmpdir(), 'dsh-vm-ttsq-fix')
mkdirSync(ttsqTmp, { recursive: true })
writeFileSync(
  join(ttsqTmp, 'msedge-stub.mjs'),
  `
export const OUTPUT_FORMAT = { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'audio-24khz-48kbitrate-mono-mp3' }
export class MsEdgeTTS {
  async setMetadata() {}
  async getVoices() {
    return [{ ShortName: 'zh-CN-XiaoxiaoNeural', Locale: 'zh-CN', Gender: 'Female', FriendlyName: 'X' }]
  }
  toStream() { return { audioStream: (async function* () {})() } }
  async close() {}
}
`,
)
const ttsqBundle = join(ttsqTmp, 'tts-queue.bundle.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'tts-queue.ts')],
  outfile: ttsqBundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: { 'msedge-tts': join(ttsqTmp, 'msedge-stub.mjs') },
  logLevel: 'silent',
})
const { listEdgeVoices } = await import(pathToFileURL(ttsqBundle).href)

await t('listEdgeVoices 返回后无新增悬挂 Timeout（30s 超时 timer 已 clear）', async () => {
  // 用增量而非绝对值：本文件前段的 sweep 行为测试可能留下其它 timer 句柄，
  // 绝对值断言会误红。关键是「调用前后不增加」。
  const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  const voices = await listEdgeVoices()
  assert.equal(voices.length, 1, '桩应返回 1 个音色')
  await sleep(60) // 让 microtask/IO 排空后再采样
  const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  assert.equal(after, before, `新增 ${after - before} 个悬挂 Timeout——超时 timer 未 clear（/voices 反复调用会累积）`)
})

console.log(`\nhost-fixes：${passed} 项通过`)
