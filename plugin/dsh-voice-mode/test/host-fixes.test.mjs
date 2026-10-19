/**
 * Issue #15 host 侧修复回归（B1 之外的 Important/Minor 行为锁）：
 *  I2 错误响应一律 writeHead（gzip 包装器下隐式头会产出 ERR_CONTENT_DECODING_FAILED）；
 *  I4 限流键反代不塌缩（X-Forwarded-For 首段，仅回环来源采信）；
 *  M7 /toggle 缺 on 显式 400；M6 /correct enabled=false 返 403 + per-client 限流键；
 *  M11 /asr、/stream 补跨源校验；M13 /models/clean 删两个 kokoro 精度目录；
 *  M3 /models/retry 补 .catch；M14 collectBody 413 后 pause + flush 后断流。
 * 运行：node test/host-fixes.test.mjs（离线，无网络/无 dsh 依赖——纯源码契约断言）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const src = (f) => readFileSync(join(here, '..', 'src', f), 'utf8')
const indexSrc = src('index.ts')

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

console.log('I2 错误响应走 respondJson（writeHead 铁律）')
t('denyNonLoopback / denyCrossOrigin 无隐式头路径', () => {
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
t('preview / toggle / cancel 三处 429 与 /mode 400/500 全部 respondJson', () => {
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
t('clientKey：仅回环来源采信 X-Forwarded-For 首段', () => {
  const i = indexSrc.indexOf('const clientKey =')
  assert.ok(i > 0, '缺 clientKey 助手')
  const body = indexSrc.slice(i, indexSrc.indexOf('\n  }\n', i))
  assert.ok(/isLoopbackRequest\(req\)/.test(body), '未先校验回环——远端可伪造 XFF 绕过限流')
  assert.ok(/x-forwarded-for/.test(body), '未读 X-Forwarded-For')
  assert.ok(/split\(','\)\[0\]/.test(body), '未取首段（最左=原始客户端）')
  assert.ok(/remoteAddress/.test(body), '缺 remoteAddress 回退')
})
t('preview / correct 限流键都经 clientKey（不再裸 remoteAddress / 全局键）', () => {
  assert.ok(indexSrc.includes('preview:${clientKey(req)}'), 'preview 键未走 clientKey')
  assert.ok(indexSrc.includes('correct:${clientKey(req)}'), 'correct 键未走 clientKey')
  assert.ok(!/preview:\$\{req\.socket\.remoteAddress/.test(indexSrc), 'preview 仍裸用 remoteAddress')
  assert.ok(!/limiter\.hit\('correct'/.test(indexSrc), 'correct 仍是全局键（一人点满、全体回退原文）')
})

console.log('M6 /correct 语义分流')
t('enabled=false 返 403 voice_disabled（不再与限流 429 混谈）', () => {
  const i = indexSrc.indexOf('path: `${base}/correct`')
  const end = indexSrc.indexOf('ctx.effect(() =>', i + 10)
  const body = indexSrc.slice(i, end)
  assert.ok(body.includes("respondJson(res, 403, { code: 'voice_disabled'"), 'enabled=false 未返 403 voice_disabled')
  assert.ok(body.includes('normalizePromptLang(parsed.lang)'), 'lang 未走 prompts.ts 单一真源')
  assert.ok(!/parsed\.lang === 'en'/.test(body), 'lang 仍内联 === 判断（en-US/zh-CN 会被误判）')
})

console.log('M7 /toggle 缺 on 显式 400')
t('on 缺失显式 400，不静默落退出分支', () => {
  const i = indexSrc.indexOf('path: `${base}/toggle`')
  const end = indexSrc.indexOf('ctx.effect(() =>', i + 10)
  const body = indexSrc.slice(i, end)
  assert.ok(/if \(on === undefined\)/.test(body), '缺 on===undefined 分支')
  assert.ok(body.includes("respondJson(res, 400, { code: 'bad_request', error: 'on required' })"), 'on 缺失未显式 400')
  // 非布尔仍须 400（原守卫不能被上述分支吃掉）
  assert.ok(/if \(typeof on !== 'boolean'\)/.test(body), '缺 on 非布尔守卫')
})

console.log('M11 /asr 与 /stream 补跨源校验')
t('两个路由都在 denyNonLoopback 之后紧跟 denyCrossOrigin', () => {
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
t('kokoro 清理覆盖 int8 + fp32', () => {
  const i = indexSrc.indexOf('path: `${base}/models/clean`')
  const end = indexSrc.indexOf('ctx.effect(() =>', i + 10)
  const body = indexSrc.slice(i, end)
  assert.ok(body.includes("kokoroModelDir('int8')") && body.includes("kokoroModelDir('fp32')"), '未覆盖两个精度目录')
  // 去掉注释后再判：实现里不得再出现「只按当前精度取目录」（反引号内的说明文字不算）。
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.ok(!/kokoroModelDir\(vset\.kokoroModel\)/.test(code), '仍只删当前精度（另一精度旧模型永久占盘）')
})

console.log('M3 /models/retry 补 .catch')
t('retryModel 链带 .catch（对齐 download/clean）', () => {
  const i = indexSrc.indexOf('path: `${base}/models/retry`')
  const end = indexSrc.indexOf('ctx.effect(() =>', i + 10)
  const body = indexSrc.slice(i, end)
  assert.ok(/void asr\s*\.retryModel\(kind\)/.test(body), 'retryModel 调用形态被改坏')
  assert.ok(/\.catch\(\(e\) =>/.test(body), 'retryModel 缺 .catch——异常逃逸成未处理 rejection，HTTP 永不响应')
})

console.log('M14 collectBody 413 后止读断流')
t('413 分支 pause + flush 后 destroy', () => {
  const i = indexSrc.indexOf('function collectBody')
  const body = indexSrc.slice(i, indexSrc.indexOf('\n}\n', i))
  const over = body.indexOf("respondJson(res, 413")
  assert.ok(over > 0, '缺 413 分支')
  const tail = body.slice(over, over + 600)
  assert.ok(/req\.pause\(\)/.test(tail), '413 后未 pause——请求流继续读入累积内存')
  assert.ok(/res\.once\('finish', \(\) => req\.destroy\(\)\)/.test(tail), '413 后未断流（且不得在 flush 前 destroy，否则客户端收到截断响应）')
})

console.log('I3 + M7 zod 界（两层一致）')
t('Config 数值字段与 settings schema 同界', () => {
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
t('clearTurnState 同时清 turnStates 与 turnGen，三处收尾都走它', () => {
  assert.ok(/const clearTurnState = /.test(indexSrc), '缺 clearTurnState 助手')
  const uses = indexSrc.match(/clearTurnState\((?:sid|previous|sessionId)\)/g) ?? []
  assert.equal(uses.length, 3, `clearTurnState 应覆盖 退出/让出/被抢占 三处，实际 ${uses.length}`)
  // 三处旧写法（setTurn + turnStates.delete 成对）不得残留
  const leftovers = indexSrc.match(/turnStates\.delete\(/g) ?? []
  assert.equal(leftovers.length, 1, `turnStates.delete 应只在 clearTurnState 内出现一次，实际 ${leftovers.length}`)
})

console.log(`\nhost-fixes：${passed} 项通过`)
