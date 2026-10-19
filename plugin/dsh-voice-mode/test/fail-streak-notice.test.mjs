/**
 * Issue #15 R1 I1 行为测试：识别/检测通道连败瞬态提示（partialFail / detectFail）。
 * 运行：node test/fail-streak-notice.test.mjs（npm test 串联）
 *
 * 背景（asr.ts Issue #15 批 7）：partial / detect 上行失败原本完全静默——host 挂起或
 * 断网时实时字幕与语音打断「无声死亡」，用户无从判断「它聋了」还是「没说话」。修复：
 * 连续失败 ≥3 次才经 onNotice 发射瞬态提示（前 2 次瞬时失败不噪，成功即清零，段边界
 * 重置计数防跨段累积误提示）。此前只有 silent-path-hints.test.mjs 的源码字符串锁，
 * 无行为覆盖——计数阈值/清零/段界重置三个语义各是本文件的台架用例。
 *
 * 台架（wake-flow 同款最小化）：假浏览器（AudioContext/AudioWorkletNode/getUserMedia）
 * + 假 host（fetch mock，partial/detect 可编程 reject）+ 可控假时钟（每帧 64ms），
 * esbuild 真编译 src/asr.ts 驱动真引擎。不变量：只读 src/，不改任何源码。
 *
 * 覆盖：
 *  ① partial 连败：前 2 次静默，第 3 次起每次失败都发 'partialFail'（notice 数 = 失败数 - 2）；
 *  ② partial 成功清零：2 败→1 成→3 败，只在第二段连败的第 3 次提示（共 1 次）；
 *  ③ partial 段界重置：discardSegment 后计数归零——新段首次失败不再提示（防跨段凑 3 误报）；
 *  ④ detect 连败同款：朗读期（isPlaying）喂静音帧走检测通道，前 2 次静默、第 3 次提示、
 *     成功清零后再 3 败才再提示。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-failstreak-'))

// ---------------------------------------------------------------- 可控时钟
let NOW = 1_000_000
Date.now = () => NOW
globalThis.performance = { now: () => NOW }

// ---------------------------------------------------------------- 浏览器 API mock
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.location = { origin: 'http://127.0.0.1:3018' }

const SR = 16000
const FRAME = 1024 // 64ms
const SPEECH_AMP = 0.1 // >SPEECH_RMS(0.015) → 用户语音
const SIL_AMP = 0.0005 // 静音

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

// ---------------------------------------------------------------- 假 host（可编程失败）
const host = {
  partialCalls: 0,
  detectCalls: 0,
  resetCalls: 0,
  finalCalls: 0,
  /** 'reject' = 网络失败（驱动连败计数）；'ok' = 200 空文本（成功清零）。 */
  partialMode: 'reject',
  detectMode: 'reject',
}
globalThis.fetch = async (url) => {
  const u = new URL(String(url))
  const p = u.searchParams
  if (p.get('reset') === '1') {
    host.resetCalls++
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  if (p.get('vadOnly') === '1') {
    host.detectCalls++
    if (host.detectMode === 'reject') throw new TypeError('fetch failed')
    return new Response(JSON.stringify({ isSpeech: false }), { status: 200 })
  }
  if (p.get('final') === '1') {
    host.finalCalls++
    return new Response(JSON.stringify({ text: '' }), { status: 200 })
  }
  host.partialCalls++
  if (host.partialMode === 'reject') throw new TypeError('fetch failed')
  return new Response(JSON.stringify({ text: '', endpoint: false }), { status: 200 })
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
/** 推帧直到 cond() 为真（超帽抛错——台架失配即红，不静默放行）。 */
async function driveUntil(cond, amp, maxFrames = 400) {
  for (let i = 0; i < maxFrames && !cond(); i++) await frame(amp)
  if (!cond()) throw new Error(`台架失配：${maxFrames} 帧内条件未达成`)
}

function makeEngine({ isPlaying = () => false, silenceMs = 1500 } = {}) {
  host.partialCalls = 0
  host.detectCalls = 0
  host.resetCalls = 0
  host.partialMode = 'reject'
  host.detectMode = 'reject'
  const notices = []
  const engine = createAsrEngine(
    {
      silenceMs,
      basePath: '/voice-mode',
      mode: 'toggle',
      bargeInMode: 'auto',
      wakeWord: '', // 无唤醒词 → 初始 listening（免待机分支干扰）
      isPlaying,
    },
    'sess-failstreak',
  )
  engine.onNotice((key) => notices.push(key))
  return { engine, notices }
}

let passed = 0
const t = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// ---------------------------------------------------------------- ① partial 连败 3 次阈
console.log('① partial 连败：前 2 次静默，第 3 次起每次失败都提示')

await t('连败 partial：notice 数 = 失败数 - 2（阈值精确为 3，不是 1/2/4）', async () => {
  const h = makeEngine()
  await h.engine.start()
  await driveUntil(() => host.partialCalls === 2, SPEECH_AMP)
  assert.deepEqual(h.notices, [], '前 2 次失败不得提示（防瞬时抖动噪报）')
  await driveUntil(() => host.partialCalls === 5, SPEECH_AMP)
  assert.equal(
    h.notices.length,
    3,
    `第 3/4/5 次失败应各提示一次（实际 ${h.notices.length} 次：${h.notices.join(',')}）`,
  )
  assert.ok(h.notices.every((k) => k === 'partialFail'), `提示键应为 partialFail（实际 ${h.notices.join(',')}）`)
  await h.engine.stop()
})

// ---------------------------------------------------------------- ② partial 成功清零
console.log('② partial 成功清零：2 败 → 1 成 → 3 败，第二段连败第 3 次才再提示')

await t('partial 成功后连败计数归零（瞬时失败不跨成功累积）', async () => {
  const h = makeEngine()
  await h.engine.start()
  await driveUntil(() => host.partialCalls === 2, SPEECH_AMP)
  host.partialMode = 'ok' // 成功一次
  await driveUntil(() => host.partialCalls === 3, SPEECH_AMP)
  assert.deepEqual(h.notices, [], '2 败 + 1 成不得提示（成功后计数已清零）')
  host.partialMode = 'reject'
  await driveUntil(() => host.partialCalls === 6, SPEECH_AMP)
  assert.deepEqual(h.notices, ['partialFail'], `重新连败应只在第 3 次提示一次（实际 ${h.notices.length} 次）`)
  await h.engine.stop()
})

// ---------------------------------------------------------------- ③ partial 段界重置
console.log('③ partial 段界重置：discardSegment 后计数归零（新段首次失败不提示）')

await t('段界重置：弃段后连败计数归零，新段首次失败不再提示（防跨段凑 3 误报）', async () => {
  const h = makeEngine()
  await h.engine.start()
  // 段 1：连败到提示已发生（计数 ≥3）
  await driveUntil(() => host.partialCalls === 5, SPEECH_AMP)
  assert.equal(h.notices.length, 3, '段 1 应已提示 3 次（失败 5 - 2）')
  // 段边界：弃段（resetFailStreaks：partial/detect 双计数归零）
  h.engine.discardSegment()
  const noticesAtBoundary = h.notices.length
  const callsAtBoundary = host.partialCalls
  // 段 2 首次失败：若计数未重置（段 1 残留 ≥3），本次就会误提示
  host.partialMode = 'reject'
  await driveUntil(() => host.partialCalls === callsAtBoundary + 1, SPEECH_AMP)
  assert.equal(
    h.notices.length,
    noticesAtBoundary,
    '弃段后新段首次失败不得提示——段界未重置计数会把上一段残留凑成 3 次误报',
  )
  // 段 2 继续连败到第 3 次：应重新提示（证明计数是「归零重计」而非「永久静默」）
  await driveUntil(() => host.partialCalls === callsAtBoundary + 3, SPEECH_AMP)
  assert.equal(h.notices.length, noticesAtBoundary + 1, '新段连败第 3 次应重新提示')
  await h.engine.stop()
})

// ---------------------------------------------------------------- ④ detect 连败同款
console.log('④ detect 连败同款（朗读期检测通道：3 次阈 + 成功清零）')

await t('detect 连败：前 2 次静默，第 3 次提示 detectFail；成功后归零重计', async () => {
  const h = makeEngine({ isPlaying: () => true })
  await h.engine.start()
  // 朗读期喂静音帧：poll 走检测通道（playingNow && !speechActive），partial 不发
  await driveUntil(() => host.detectCalls === 2, SIL_AMP)
  assert.deepEqual(h.notices, [], '检测通道前 2 次失败不得提示')
  assert.equal(host.partialCalls, 0, '朗读期静音帧不应触发 partial 上行（通道分流）')
  await driveUntil(() => host.detectCalls === 3, SIL_AMP)
  assert.deepEqual(h.notices, ['detectFail'], `第 3 次检测失败应提示 detectFail（实际 ${h.notices.join(',')}）`)
  host.detectMode = 'ok' // 成功一次 → 清零
  await driveUntil(() => host.detectCalls === 4, SIL_AMP)
  host.detectMode = 'reject'
  await driveUntil(() => host.detectCalls === 7, SIL_AMP)
  assert.deepEqual(h.notices, ['detectFail', 'detectFail'], `成功后应重新累计 3 次才再提示（实际 ${h.notices.length} 次）`)
  await h.engine.stop()
})

rmSync(tmp, { recursive: true, force: true })
console.log(`\nfail-streak-notice：${passed} 项通过`)
