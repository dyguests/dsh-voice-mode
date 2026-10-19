/**
 * Issue #15 R1 I3 行为测试：partial / detect 上行门控时序（in-flight 不并发 + 节拍语义）。
 * 运行：node test/partial-gating.test.mjs（npm test 串联）
 *
 * 背景：轮询 tick 曾无条件推进 lastPollAt——一次超过 128ms 的往返会连吃后续整拍，
 * 把观测栅格量化到 RTT 向上取整的 128ms 倍数（实测停顿 449/758ms，实时字幕发得少）。
 * A 档修复：只有「真的发出去了」才推进节拍 + partialInFlight/detectInFlight 在途守卫
 * （verify-client.mjs:205-206 只锁了产物字符串，无行为覆盖）。本文件补行为锁：
 *  ① 请求在途期间连发多帧不得并发排第二轮（in-flight 守卫）；
 *  ② 请求一回来，下一帧（≤64ms）立即补发——不等满一个 100ms 节拍（节拍修复）。
 *
 * 实现策略：轮询 tick 的真实载体是 asr.ts 引擎帧回调（handleAudio 末尾节拍块，经
 * esbuild bundle 进 lib/client.js——「最接近的可测单元」），用 wake-flow 同款最小台架
 * （假浏览器 + 可编程延迟假 host + 可控假时钟）驱动真引擎。fetch mock 对 partial/detect
 * 注入 200ms 真实延迟，在途窗口内推帧观察派发计数。不变量：只读 src/，不改任何源码。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-gating-'))

// ---------------------------------------------------------------- 可控时钟
let NOW = 1_000_000
Date.now = () => NOW
globalThis.performance = { now: () => NOW }

// ---------------------------------------------------------------- 浏览器 API mock
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.location = { origin: 'http://127.0.0.1:3018' }

const SR = 16000
const FRAME = 1024 // 64ms
const SPEECH_AMP = 0.1 // >SPEECH_RMS(0.015) → 用户语音（走 partial 通道）
const SIL_AMP = 0.0005 // 静音（朗读期走 detect 通道）

let capturedNode = null
class FakeAudioWorkletNode {
  constructor(ctx) {
    if (!ctx) throw new TypeError('AudioWorkletNode: null AudioContext')
    this.port = { onmessage: null }
    capturedNode = this
  }
  connect() {}
  disconnect() {}
}
class FakeAudioContext {
  constructor() {
    this.sampleRate = SR
    this.destination = {}
    this.audioWorklet = { addModule: async () => {} }
  }
  createMediaStreamSource() {
    return { connect() {} }
  }
  createScriptProcessor() {
    return { connect() {}, disconnect() {}, onaudioprocess: null }
  }
  async resume() {}
  async close() {}
}
const fakeTrack = { getSettings: () => ({ echoCancellation: true }), stop() {} }
const fakeStream = { getAudioTracks: () => [fakeTrack], getTracks: () => [fakeTrack] }
globalThis.AudioContext = FakeAudioContext
globalThis.window = { AudioContext: FakeAudioContext }
Object.defineProperty(globalThis, 'navigator', {
  value: { mediaDevices: { getUserMedia: async () => fakeStream } },
  configurable: true,
  writable: true,
})
globalThis.AudioWorkletNode = FakeAudioWorkletNode

// ---------------------------------------------------------------- 假 host（可编程延迟）
const host = {
  partialCalls: 0,
  detectCalls: 0,
  /** 上行 RTT（真实毫秒）——0 = 立即 resolve。 */
  rttMs: 0,
  /** 在途峰值观测：fetch 已发起但未 resolve 的并发数。 */
  partialInFlightMax: 0,
  detectInFlightMax: 0,
  partialLive: 0,
  detectLive: 0,
}
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))
globalThis.fetch = async (url) => {
  const u = new URL(String(url))
  const p = u.searchParams
  if (p.get('reset') === '1') return new Response(JSON.stringify({ ok: true }), { status: 200 })
  if (p.get('vadOnly') === '1') {
    host.detectCalls++
    host.detectLive++
    host.detectInFlightMax = Math.max(host.detectInFlightMax, host.detectLive)
    try {
      if (host.rttMs > 0) await realSleep(host.rttMs)
      return new Response(JSON.stringify({ isSpeech: false }), { status: 200 })
    } finally {
      host.detectLive--
    }
  }
  if (p.get('final') === '1') return new Response(JSON.stringify({ text: '' }), { status: 200 })
  host.partialCalls++
  host.partialLive++
  host.partialInFlightMax = Math.max(host.partialInFlightMax, host.partialLive)
  try {
    if (host.rttMs > 0) await realSleep(host.rttMs)
    return new Response(JSON.stringify({ text: '', endpoint: false }), { status: 200 })
  } finally {
    host.partialLive--
  }
}

// ---------------------------------------------------------------- bundle 真引擎
const sherpaStub = join(tmp, 'sherpa-stub.mjs')
writeFileSync(sherpaStub, `export function createOnlineRecognizer(){return {}}\nexport function createVad(){return {}}\nexport default {}\n`)
const modelsStub = join(tmp, 'models-stub.mjs')
writeFileSync(
  modelsStub,
  `export const HOST_PRIMARY='https://huggingface.co'\nexport function validateModelHost(h){return h||HOST_PRIMARY}\nexport async function ensureModelFile(){return true}\nexport async function ensureModelTree(){return true}\n`,
)
const bundle = join(tmp, 'asr.bundle.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'asr.ts')],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  external: ['sherpa-onnx'],
  define: { __AUDIO_WORKLET__: JSON.stringify('/* noop worklet */') },
  plugins: [
    { name: 'stub-models', setup(b) { b.onResolve({ filter: /\.\.?\/models\.ts$/ }, () => ({ path: modelsStub })) } },
  ],
  logLevel: 'silent',
})
const { createAsrEngine } = await import(pathToFileURL(bundle).href)

// ---------------------------------------------------------------- 驱动辅助
const tick = () => new Promise((r) => setImmediate(r))

async function frame(amp) {
  NOW += (FRAME / SR) * 1000
  capturedNode.port.onmessage({ data: new Float32Array(FRAME).fill(amp) })
  await tick()
}
async function driveUntil(cond, amp, maxFrames = 400) {
  for (let i = 0; i < maxFrames && !cond(); i++) await frame(amp)
  if (!cond()) throw new Error(`台架失配：${maxFrames} 帧内条件未达成`)
}

function makeEngine({ isPlaying = () => false } = {}) {
  host.partialCalls = 0
  host.detectCalls = 0
  host.partialInFlightMax = 0
  host.detectInFlightMax = 0
  host.partialLive = 0
  host.detectLive = 0
  const engine = createAsrEngine(
    {
      silenceMs: 1500,
      basePath: '/voice-mode',
      mode: 'toggle',
      bargeInMode: 'auto',
      wakeWord: '',
      isPlaying,
    },
    'sess-gating',
  )
  return engine
}

let passed = 0
const t = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// ---------------------------------------------------------------- ① partial 在途不并发
console.log('① partial 上行 RTT=200ms：在途期间连发 3 帧不得并发排第二轮')

await t('partial 在途守卫：10 帧内只发起 1 次 fetch（并发峰值 = 1）', async () => {
  const engine = makeEngine()
  await engine.start()
  host.rttMs = 200
  await driveUntil(() => host.partialCalls === 1, SPEECH_AMP)
  const callsAtDispatch = host.partialCalls
  // 在途窗口（200ms 真实时间；假时钟 10 帧 = 640ms）内连发 10 帧——
  // 帧数需足够：节拍偷推是「每满 100ms 偷推一次」，帧太少看不出量化。
  for (let i = 0; i < 10; i++) await frame(SPEECH_AMP)
  assert.equal(host.partialCalls, callsAtDispatch, `在途期间不得并发排第二轮（实际增至 ${host.partialCalls}）`)
  assert.equal(host.partialInFlightMax, 1, `partial 在途并发峰值应为 1（实际 ${host.partialInFlightMax}）`)
  await engine.stop()
})

// ---------------------------------------------------------------- ② resolve 后下一帧立即补发
console.log('② 节拍修复：请求一回来，下一帧立即补发（不等满 100ms）')

await t('resolve 后单帧即补发第 2 次（lastPollAt 未被在途帧偷推）', async () => {
  const engine = makeEngine()
  await engine.start()
  host.rttMs = 200
  await driveUntil(() => host.partialCalls === 1, SPEECH_AMP)
  for (let i = 0; i < 10; i++) await frame(SPEECH_AMP) // 在途帧（旧 bug 会在这里偷推节拍）
  await realSleep(260) // 等在途请求 resolve + 续体跑完
  await tick()
  assert.equal(host.partialCalls, 1, 'resolve 前不应补发')
  await frame(SPEECH_AMP) // resolve 后第一帧
  assert.equal(host.partialCalls, 2, 'resolve 后下一帧（≤64ms）应立即补发——节拍被在途帧偷推则少发一轮（旧 bug 形态）')
  await engine.stop()
})

// ---------------------------------------------------------------- ③ detect 通道同款
console.log('③ detect 上行同款（朗读期检测通道：在途守卫 + 补发）')

await t('detect 在途守卫 + resolve 后补发（与 partial 同口径）', async () => {
  const engine = makeEngine({ isPlaying: () => true })
  await engine.start()
  host.rttMs = 200
  await driveUntil(() => host.detectCalls === 1, SIL_AMP)
  for (let i = 0; i < 10; i++) await frame(SIL_AMP)
  assert.equal(host.detectCalls, 1, `detect 在途期间不得并发（实际 ${host.detectCalls}）`)
  assert.equal(host.detectInFlightMax, 1, `detect 在途并发峰值应为 1（实际 ${host.detectInFlightMax}）`)
  await realSleep(260)
  await tick()
  assert.equal(host.detectCalls, 1, 'resolve 前不应补发')
  await frame(SIL_AMP)
  assert.equal(host.detectCalls, 2, 'detect resolve 后下一帧应立即补发')
  await engine.stop()
})

rmSync(tmp, { recursive: true, force: true })
console.log(`\npartial-gating：${passed} 项通过`)
