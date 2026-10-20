/**
 * Issue #15 R1 I6 行为测试：host HTTP 面安全守卫（回环 / 跨源 / 体量 / 限流 / 入参校验）。
 * 运行：node test/host-security-behavior.test.mjs（npm test 串联；无参、不依赖模型缓存）
 *
 * 背景：安全守卫此前只有 integration-fork.mjs（参数化手动脚本，需 200MB+ 模型缓存，
 * CI 干净环境不跑）与零散字符串锁，无行为覆盖。本文件把**不依赖模型缓存的守卫层**
 * 拆为可登记 npm test 的行为测试；试听合成全链路保留在 integration-fork.mjs 手动跑。
 *
 * 实现策略（preview-error + integration-fork 杂交）：
 *  - esbuild 真编译 src/index.ts；security.ts（isLoopbackRequest/sameOriginRequest/
 *    RateLimiter）**不桩化**——它正是被测对象；引擎面（asr-host/tts-queue/tts-local/
 *    segmenter/settings-store/models）吸收式桩（modelStatus ready=false → warmup
 *    门控跳过，不触发任何模型加载/下载）；
 *  - 假 Context（integration-fork 同款：webServer.register 收路由 + sessions 服务桩），
 *    apply() 后以假 req/res 驱动真路由 handler，断言状态码与错误体。
 *
 * 覆盖：
 *  ① 回环层：loopback 放行（200）/ 非回环 403（两条路由）；
 *  ② 跨源层：跨站 Origin POST 403 / 同源放行（穿透到入参校验层）；
 *  ③ 体量层：超 MAX_JSON_BODY(16KB) → 413（常量值源码锁）；
 *  ④ 入参层：缺 sessionId / 缺 on / on 非布尔 → 400（M7：不得静默落退出分支）；
 *  ⑤ 会话层：未知会话 403（第 0 层）；
 *  ⑥ 限流层：同会话 2 次/2s 阈——第 3 次 429（阈值源码锁）。
 *
 * 不变量：本测试只读 src/，不改任何源码。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '..')
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-sec-'))

let passed = 0
const t = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// ---------------------------------------------------------------- 桩（security.ts 不桩——被测对象）
const stub = (name, body) => {
  const p = join(tmp, name)
  writeFileSync(p, body)
  return p
}
// asr-host 富桩：modelStatus ready=false → warmupAsrIfCached 门控跳过（不加载/下载模型）。
const asrHostStub = stub('asr-host.mjs', `
export function createAsrRuntime() {
  return {
    warmup: () => {},
    warmupSense: async () => {},
    markStale: () => {},
    modelStatus: () => ({ asr: { ready: false }, vad: { ready: false }, sense: { enabled: false, ready: false } }),
    dispose: () => {},
    feed: async () => ({ text: '' }),
    detect: async () => ({ isSpeech: false }),
    reset: () => {},
    retryModel: async () => false,
  }
}
export async function handleAsrRequest() { return {} }
`)
// 吸收桩：任意属性/方法链调用均返回吸收代理（'then' 显式 undefined 防被当 thenable await）。
const absorbBody = `
const absorb = () => new Proxy(function stub() {}, {
  get(_t, p) {
    if (p === 'then') return undefined
    return () => absorb()
  },
  apply() { return absorb() },
  construct() { return absorb() },
})
`
const ttsQueueStub = stub('tts-queue.mjs', absorbBody + `
export class EdgeTtsEngine { constructor() { return absorb() } }
export class TtsQueue { constructor() { return absorb() } }
export function listEdgeVoices() { return [] }
`)
const ttsLocalStub = stub('tts-local.mjs', absorbBody + `
export function createSherpaVitsEngine() { return absorb() }
export function createSherpaKokoroEngine() { return absorb() }
export const TTS_MODEL_REPO = ''
export function kokoroModelDir() { return '' }
`)
const segmenterStub = stub('segmenter.mjs', `export class SentenceSegmenter {}\n`)
const modelsStub = stub('models.mjs', `
export const HOST_PRIMARY = 'https://huggingface.co'
export function validateModelHost(h) { return h || HOST_PRIMARY }
`)
const settingsStoreStub = stub('settings-store.mjs', `
export function pickKnownKeys(o) { return o ?? {} }
export function readLegacyVoiceSettings() { return {} }
export function readOverrides() { return { values: {} } }
export function settingsFilePath() { return '' }
export function unknownKeys() { return [] }
export function writeOverrides() {}
`)
const stringsStub = stub('strings.mjs', `export const en = new Proxy({}, { get: () => '' })\n`)
const llmCorrectStub = stub('llm-correct.mjs', `export async function correctText(_ctx, text) { return text }\n`)
const promptsStub = stub('prompts.mjs', `
export function normalizePromptLang() { return 'zh' }
export function previewSample() { return '你好' }
export function spokenPrompt() { return '' }
`)

// ---------------------------------------------------------------- bundle src/index.ts
const indexBundle = join(tmp, 'index.bundle.mjs')
await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile: indexBundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  external: ['node:path', 'node:os', 'node:fs', 'node:fs/promises', 'node:http'],
  plugins: [
    {
      name: 'stub-internal',
      setup(b) {
        b.onResolve({ filter: /\.\.?\/asr-host\.ts$/ }, () => ({ path: asrHostStub }))
        b.onResolve({ filter: /\.\.?\/tts-queue\.ts$/ }, () => ({ path: ttsQueueStub }))
        b.onResolve({ filter: /\.\.?\/tts-local\.ts$/ }, () => ({ path: ttsLocalStub }))
        b.onResolve({ filter: /\.\.?\/segmenter\.ts$/ }, () => ({ path: segmenterStub }))
        b.onResolve({ filter: /\.\.?\/models\.ts$/ }, () => ({ path: modelsStub }))
        b.onResolve({ filter: /\.\.?\/settings-store\.ts$/ }, () => ({ path: settingsStoreStub }))
        b.onResolve({ filter: /\.\.?\/strings\.ts$/ }, () => ({ path: stringsStub }))
        b.onResolve({ filter: /\.\.?\/llm-correct\.ts$/ }, () => ({ path: llmCorrectStub }))
        b.onResolve({ filter: /\.\.?\/prompts\.ts$/ }, () => ({ path: promptsStub }))
      },
    },
  ],
  logLevel: 'silent',
})
const { apply } = await import(pathToFileURL(indexBundle).href)

// ---------------------------------------------------------------- 假 Context（integration-fork 同款）
const routes = new Map()
const settingsValue = {
  ttsEngine: 'edge',
  voice: 'xiaoxiao',
  rate: 1.0,
  interruptLevel: 0,
  silenceMs: 2000,
  idleTimeoutMinutes: 10,
  modelHost: 'https://huggingface.co',
  autoSend: true,
  mode: 'toggle',
  wakeWord: '',
  spokenFormat: false,
}
let settingsWatcher = null
const fakeCtx = {
  effect(fn) {
    const d = fn()
    return () => {
      if (typeof d === 'function') d()
    }
  },
  on() {
    return () => {}
  },
  get(name) {
    if (name === 'sessions') {
      return { get: (id) => (id === 'live-1' ? { id } : undefined) }
    }
    return undefined
  },
  settings: {
    register() {
      return {
        get: () => settingsValue,
        watch(fn) {
          settingsWatcher = fn
          return () => {
            settingsWatcher = null
          }
        },
      }
    },
  },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
}

apply(fakeCtx, {
  enabled: true,
  cacheDir: tmp,
  modelHost: 'https://huggingface.co',
  ttsEngine: 'edge',
  allowLan: false,
  allowCustomModelHost: false,
  voice: 'xiaoxiao',
  rate: 1.0,
  interruptLevel: 0,
  silenceMs: 2000,
  idleTimeoutMinutes: 10,
})
assert.ok(routes.has('/voice-mode/toggle'), '路由未注册——apply 失败？')
assert.ok(routes.has('/voice-mode'), 'config 路由未注册')

// ---------------------------------------------------------------- 假 req / res（integration-fork 同款）
function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(k, v) {
      this.headers[k] = v
    },
    writeHead(s, h) {
      this.statusCode = s
      Object.assign(this.headers, h ?? {})
    },
    write() {},
    end(b) {
      if (this.statusCode === 0) this.statusCode = 200
      if (b !== undefined) this.body = b
      res._done()
      // collectBody 的 413 路径挂 res.once('finish', …req.destroy())——补 finish 事件
      for (const cb of res._finishCbs ?? []) cb()
    },
    on() {},
    once(ev, cb) {
      ;(res._finishCbs ||= []).push(cb)
    },
  }
  res._donePromise = new Promise((r) => {
    res._done = r
  })
  return res
}

function makeReq({ remoteAddress = '127.0.0.1', origin, host = '127.0.0.1:3080', method = 'POST', url = '/voice-mode/toggle', body }) {
  const listeners = {}
  const req = {
    socket: { remoteAddress },
    headers: { host, ...(origin ? { origin } : {}) },
    method,
    url,
    on(ev, cb) {
      ;(listeners[ev] ||= []).push(cb)
      return req
    },
    // collectBody 413 路径的流控/断流（M14）：pause 止读、finish 后 destroy
    pause() {},
    resume() {},
    destroy() {},
  }
  if (body !== undefined) {
    queueMicrotask(() => {
      for (const cb of listeners.data ?? []) cb(Buffer.from(body))
      for (const cb of listeners.end ?? []) cb()
    })
  }
  return req
}

const get = (path, req) => {
  const res = makeRes()
  routes.get(path)(req, res)
  return res
}
async function awaitRes(res, ms = 2000) {
  await Promise.race([res._donePromise, new Promise((r) => setTimeout(r, ms))])
  return res
}
const bodyCode = (res) => {
  try {
    return JSON.parse(res.body)?.code
  } catch {
    return undefined
  }
}
const bodyError = (res) => {
  try {
    return JSON.parse(res.body)?.error
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- ① 回环层
console.log('① 回环层（allowLan=false：仅回环放行）')

await t('loopback GET /voice-mode → 200（配置输出）', async () => {
  const res = await awaitRes(get('/voice-mode', makeReq({ method: 'GET', body: undefined })))
  assert.equal(res.statusCode, 200, `status=${res.statusCode}`)
})

await t('非回环 GET /voice-mode → 403 forbidden（第 2 层）', async () => {
  const res = await awaitRes(get('/voice-mode', makeReq({ method: 'GET', body: undefined, remoteAddress: '192.168.1.5' })))
  assert.equal(res.statusCode, 403, `status=${res.statusCode}`)
  assert.equal(bodyCode(res), 'forbidden')
})

await t('非回环 POST /voice-mode/toggle → 403 forbidden（第二条路由同防线）', async () => {
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ remoteAddress: '10.0.0.2', body: JSON.stringify({ sessionId: 'live-1', on: true }) })))
  assert.equal(res.statusCode, 403, `status=${res.statusCode}`)
  assert.equal(bodyCode(res), 'forbidden')
})

// ---------------------------------------------------------------- ② 跨源层
console.log('② 跨源层（Origin 与请求目标不同源 → 403）')

await t('跨站 Origin POST /voice-mode/toggle → 403 cross-origin denied', async () => {
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ origin: 'http://evil.example', body: JSON.stringify({ sessionId: 'live-1', on: true }) })))
  assert.equal(res.statusCode, 403, `status=${res.statusCode}`)
  assert.equal(bodyCode(res), 'forbidden')
})

await t('同源 Origin POST → 穿透跨源层（落入入参校验 400，非 403）', async () => {
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ origin: 'http://127.0.0.1:3080', body: JSON.stringify({}) })))
  assert.equal(res.statusCode, 400, `同源不应被跨源层拒（status=${res.statusCode}）`)
})

await t('无 Origin（非浏览器客户端）→ 跨源层放行（回环层兜底）', async () => {
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ body: JSON.stringify({}) })))
  assert.equal(res.statusCode, 400, `无 Origin 应放行到入参层（status=${res.statusCode}）`)
})

// ---------------------------------------------------------------- ③ 体量层
console.log('③ 体量层（MAX_JSON_BODY=16KB：超限 413）')

await t('超限 body（20KB）POST /voice-mode/toggle → 413', async () => {
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ body: 'x'.repeat(20 * 1024) })))
  assert.equal(res.statusCode, 413, `status=${res.statusCode}`)
})

await t('MAX_JSON_BODY 常量锁：src/index.ts 为 16*1024（16KB）', () => {
  const indexSrc = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  assert.ok(/const MAX_JSON_BODY = 16 \* 1024\b/.test(indexSrc), 'MAX_JSON_BODY 不是 16*1024——413 阈值与测试载荷需同步复核')
})

// ---------------------------------------------------------------- ④ 入参层
console.log('④ 入参层（/toggle：缺 sessionId / 缺 on / on 非布尔 → 400）')

await t('缺 sessionId → 400（不得静默落退出分支）', async () => {
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ body: JSON.stringify({ on: true }) })))
  assert.equal(res.statusCode, 400, `status=${res.statusCode}`)
  assert.equal(bodyCode(res), 'bad_request')
})

await t('缺 on → 400 on required（M7：旧客户端漏字段不得把活跃用户踢出模式）', async () => {
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ body: JSON.stringify({ sessionId: 'live-1' }) })))
  assert.equal(res.statusCode, 400, `status=${res.statusCode}`)
  // error 串精确锁：缺 on 必须报 'on required'——只被类型校验兜住（报 'invalid on'）
  // 时调用方无法区分「漏字段」与「字段类型错」，排障失据（k6 变异实证）。
  assert.equal(bodyError(res), 'on required', `缺 on 的错误串应为 on required（实际 ${bodyError(res)}）`)
})

await t('on 非布尔 → 400 invalid on（防误落退出分支）', async () => {
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ body: JSON.stringify({ sessionId: 'live-1', on: 'yes' }) })))
  assert.equal(res.statusCode, 400, `status=${res.statusCode}`)
  assert.equal(bodyError(res), 'invalid on', `on 类型错的错误串应为 invalid on（实际 ${bodyError(res)}）`)
})

// ---------------------------------------------------------------- ⑤ 会话层 + ⑥ 限流层
console.log('⑤ 会话层（未知会话 403）+ ⑥ 限流层（同会话 2 次/2s，第 3 次 429）')

await t('未知会话 → 403（第 0 层：只接受真实存在的会话）', async () => {
  // 独立 sessionId（ghost-session）：不与其他用例共享限流桶——⑤⑥ 解耦，
  // 重排/增删用例互不影响（R2 验真轮 Minor：旧实现与 ⑥ 共享 ghost-limiter 桶，
  // ⑥ 隐式依赖 ⑤ 先消耗 1 次配额，删 ⑤ 会误导性红）。
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ body: JSON.stringify({ sessionId: 'ghost-session', on: true }) })))
  assert.equal(res.statusCode, 403, `status=${res.statusCode}`)
})

await t('限流阈锁：src/index.ts toggle 限流为 2 次/2000ms', () => {
  const indexSrc = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  assert.ok(indexSrc.includes('limiter.hit(`toggle:${sessionId}`, 2, 2000)'), 'toggle 限流阈值不是 2 次/2s——429 行为与阈值锁需同步复核')
})

await t('限流行为（独立桶自建配额）：同会话第 1/2 次放行到会话层 403，第 3 次 → 429', async () => {
  // 自建配额（ghost-rate 桶仅本用例使用）：#1 消耗 1/2 → 403 未知会话；#2 消耗 2/2 → 403；
  // #3 桶满 → 429。三次请求在同一用例内连续完成，不依赖其他用例的消耗顺序。
  // 时序依赖（无法避免，如实登记）：RateLimiter 用真实 Date.now() 滑动窗（2s）——
  // 若机器在三次请求间卡顿 >2s，窗口过期会使 #3 落 403 误导性红；正常执行路径
  // 三次请求间隔为毫秒级（假 req/res，无真实 IO）。卡顿误判时重跑即可。
  const sid = 'ghost-rate'
  const r1 = await awaitRes(get('/voice-mode/toggle', makeReq({ body: JSON.stringify({ sessionId: sid, on: true }) })))
  assert.equal(r1.statusCode, 403, `第 1 次应放过限流层落到会话层（status=${r1.statusCode}）`)
  const r2 = await awaitRes(get('/voice-mode/toggle', makeReq({ body: JSON.stringify({ sessionId: sid, on: true }) })))
  assert.equal(r2.statusCode, 403, `第 2 次应仍放过限流层（status=${r2.statusCode}）`)
  const r3 = await awaitRes(get('/voice-mode/toggle', makeReq({ body: JSON.stringify({ sessionId: sid, on: true }) })))
  assert.equal(r3.statusCode, 429, `第 3 次应被限流（status=${r3.statusCode}）`)
  assert.equal(bodyCode(r3), 'rate_limited')
})

await t('不同会话独立桶（ghost-other 不受 ghost-rate 限流影响）', async () => {
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ body: JSON.stringify({ sessionId: 'ghost-other', on: true }) })))
  assert.equal(res.statusCode, 403, `独立桶应放行到会话层（status=${res.statusCode}）`)
})

// ---------------------------------------------------------------- ⑦ /focus + SSE 去重/上限（PR #16 移植）
console.log('⑦ /focus 焦点上报 + SSE 同标签页去重 / 连接上限')

function sseRes() {
  const r = makeRes()
  r.chunks = []
  r.ended = false
  r.write = (c) => {
    r.chunks.push(String(c))
    return true
  }
  const end0 = r.end.bind(r)
  r.end = (b) => {
    r.ended = true
    end0(b)
  }
  r.events = () => r.chunks.filter((c) => c.startsWith('event: ')).map((c) => c.split('\n')[0].slice(7))
  return r
}
const openStream = (tabId) => {
  const res = sseRes()
  routes.get('/voice-mode/stream')(makeReq({ method: 'GET', url: `/voice-mode/stream?tabId=${tabId}` }), res)
  return res
}
const postFocus = (payload, extra = {}) =>
  awaitRes(get('/voice-mode/focus', makeReq({ url: '/voice-mode/focus', body: JSON.stringify(payload), ...extra })))
const focusOf = (res) => JSON.parse(res.body)

const watcher = openStream('tab-W')
await t('SSE 上线即下发 mode + focus（新标签页立刻知道焦点归属）', () => {
  assert.equal(watcher.statusCode, 200)
  assert.deepEqual(watcher.events().slice(0, 2), ['mode', 'focus'])
})

await t('/focus 入参：缺 tabId / sessionId 非字符串非 null → 400', async () => {
  assert.equal((await postFocus({ sessionId: 's1' })).statusCode, 400)
  assert.equal((await postFocus({ sessionId: 42, tabId: 'A' })).statusCode, 400)
  assert.equal((await postFocus({ sessionId: 'x'.repeat(129), tabId: 'A' })).statusCode, 400)
})

await t('/focus 跨站 Origin → 403', async () => {
  const r = await postFocus({ sessionId: 's1', tabId: 'A' }, { origin: 'http://evil.example' })
  assert.equal(r.statusCode, 403)
})

await t('/focus：上报即成为焦点并广播', async () => {
  const before = watcher.events().length
  const r = await postFocus({ sessionId: 's1', tabId: 'A' })
  assert.equal(r.statusCode, 200)
  assert.deepEqual(focusOf(r), { ok: true, sessionId: 's1', tabId: 'A' })
  assert.ok(watcher.events().slice(before).includes('focus'), '焦点变化未广播')
})

await t('/focus：别的标签页离开会话（null）不清掉当前焦点', async () => {
  const r = await postFocus({ sessionId: null, tabId: 'B' })
  assert.deepEqual(focusOf(r), { ok: true, sessionId: 's1', tabId: 'A' })
})

await t('/focus：焦点标签页自己离开 → 清空', async () => {
  const r = await postFocus({ sessionId: null, tabId: 'A' })
  assert.deepEqual(focusOf(r), { ok: true, sessionId: null, tabId: null })
})

await t('SSE 同 tabId 重连：旧连接收到 replaced 并被关闭（不再互相顶替）', () => {
  const a1 = openStream('tab-A')
  const a2 = openStream('tab-A')
  assert.ok(a1.events().includes('replaced'), '旧连接没收到 replaced')
  assert.equal(a1.ended, true, '旧连接未关闭')
  assert.equal(a2.statusCode, 200)
  assert.equal(a2.ended, false)
})

await t('SSE 上限 8：第 9 个不同标签页 429；已有标签页重连不受上限影响', () => {
  // 现存：tab-W、tab-A（a2）→ 再开 6 个 = 8
  for (let i = 0; i < 6; i++) assert.equal(openStream(`tab-${i}`).statusCode, 200)
  const ninth = openStream('tab-overflow')
  assert.equal(ninth.statusCode, 429)
  assert.equal(bodyCode(ninth), 'too_many_streams')
  const again = openStream('tab-0')
  assert.equal(again.statusCode, 200, '同标签页重连应先去重再判上限')
})

rmSync(tmp, { recursive: true, force: true })
console.log(`\nhost-security-behavior：${passed} 项通过`)
process.exit(0)
