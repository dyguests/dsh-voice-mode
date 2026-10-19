/**
 * Issue #15 R9 OQ-2 行为测试：一级自动探测（bargeInMode='detect' → auto/manual）。
 * 运行：node test/barge-in-detect-behavior.test.mjs（npm test 串联）
 *
 * 背景：detect 模式下 runtimeBargeInMode 由**原生 AEC 实际状态**解析（asr.ts:1128 取
 * track.getSettings().echoCancellation，:1134-1136 落 auto/manual）——外放无原生 AEC
 * 时落 manual（防回声自打断），auto/manual 显式取值不探测。此前只有 barge-in-detect.test.mjs
 * 的镜像契约锁（resolveBargeInMode 重建），**无行为级覆盖**——ADR-0006 还曾据「未实现」
 * 写过假断言（fix-docs 已勘误）；本文件是真编译 asr.ts 驱动真引擎的行为锁。
 *
 * 可观测面（按 :1134-1136 与 :301-302 的实际表面）：asrUrl 在 runtimeBargeInMode===
 * 'manual' 时带 &manual=1（host 侧 asr-host.ts:1005 读它放行/拒收 feed）。故以假 host
 * 记录的请求 URL 是否含 manual=1 判定解析结果。注意 manual 模式下 handleAudio 入口
 * （:829）对非按压帧直接丢弃——manual 用例须先 beginHeld() 才有请求上行。
 *
 * 实现策略（partial-gating 同款台架）：假浏览器（AudioContext/AudioWorkletNode/
 * getUserMedia 的 echoCancellation 可编程）+ 假 host（记录 URL）+ 可控假时钟，
 * esbuild 真编译 src/asr.ts 驱动真引擎。不变量：只读 src/，不改任何源码。
 *
 * 覆盖：
 *  ① detect + aecOn=true → auto（URL 无 manual=1）；
 *  ② detect + aecOn=false → manual（URL 带 &manual=1）；
 *  ③ 显式 auto/manual 不被探测覆盖（auto+aecOff 仍 auto；manual+aecOn 仍 manual）。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-bidetect-'))

// ---------------------------------------------------------------- 可控时钟
let NOW = 3_000_000
Date.now = () => NOW
globalThis.performance = { now: () => NOW }

// ---------------------------------------------------------------- 浏览器 API mock（AEC 可编程）
const SR = 16000
const FRAME = 1024 // 64ms
const SPEECH_AMP = 0.1 // >SPEECH_RMS

/** 原生 AEC 开关：getUserMedia 返回的 track 的 echoCancellation（探测的唯一输入）。 */
let AEC_ON = true
const setAec = (v) => {
  AEC_ON = v
}

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
const fakeTrack = {
  getSettings: () => ({ echoCancellation: AEC_ON }),
  stop() {},
}
const fakeStream = { getAudioTracks: () => [fakeTrack], getTracks: () => [fakeTrack] }
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.location = { origin: 'http://127.0.0.1:3018' }
globalThis.AudioContext = FakeAudioContext
globalThis.window = { AudioContext: FakeAudioContext }
Object.defineProperty(globalThis, 'navigator', {
  value: { mediaDevices: { getUserMedia: async () => fakeStream } },
  configurable: true,
  writable: true,
})
globalThis.AudioWorkletNode = FakeAudioWorkletNode

// ---------------------------------------------------------------- 假 host（记录 URL）
const host = { partialUrls: [], detectUrls: [], resets: 0 }
globalThis.fetch = async (url) => {
  const u = String(url)
  const p = new URL(u).searchParams
  if (p.get('reset') === '1') {
    host.resets++
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  if (p.get('vadOnly') === '1') {
    host.detectUrls.push(u)
    return new Response(JSON.stringify({ isSpeech: false }), { status: 200 })
  }
  if (p.get('final') === '1') return new Response(JSON.stringify({ text: '' }), { status: 200 })
  host.partialUrls.push(u)
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
const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await tick()
}

function makeEngine(bargeInMode) {
  host.partialUrls.length = 0
  host.detectUrls.length = 0
  capturedNode = null
  return createAsrEngine(
    {
      silenceMs: 1500,
      basePath: '/voice-mode',
      mode: 'toggle',
      bargeInMode,
      wakeWord: '', // 无唤醒词 → listening
      isPlaying: () => false,
    },
    'sess-bidetect',
  )
}

/** 经 worklet 节点推语音帧（假时钟 64ms/帧）直到至少一条 partial 上行。 */
async function speakUntilPartial(hold = false) {
  if (hold) capturedNode // noop（beginHeld 由调用方先调）
  for (let i = 0; i < 12 && host.partialUrls.length === 0; i++) {
    NOW += (FRAME / SR) * 1000
    capturedNode.port.onmessage({ data: new Float32Array(FRAME).fill(SPEECH_AMP) })
    await tick()
  }
  assert.ok(host.partialUrls.length > 0, '台架失配：12 帧内无 partial 上行（manual 未按压？）')
}

let passed = 0
const t = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// ---------------------------------------------------------------- ① detect + aecOn=true → auto
console.log('① detect + 原生 AEC 生效 → runtimeBargeInMode=auto')

await t('detect + aecOn=true → partial URL 无 manual=1（不误落 manual 自断）', async () => {
  setAec(true)
  const eng = makeEngine('detect')
  await eng.start()
  await settle()
  await speakUntilPartial()
  assert.ok(
    host.partialUrls.every((u) => !u.includes('manual=1')),
    `aecOn=true 应解析为 auto（URL 不应带 manual=1）：${host.partialUrls[0]}`,
  )
  await eng.stop()
})

// ---------------------------------------------------------------- ② detect + aecOn=false → manual
console.log('② detect + 原生 AEC 未生效 → runtimeBargeInMode=manual')

await t('detect + aecOn=false → partial URL 带 &manual=1（外放防回声自断）', async () => {
  setAec(false)
  const eng = makeEngine('detect')
  await eng.start()
  await settle()
  // manual 模式 handleAudio 入口丢非按压帧——先 beginHeld 才有请求上行
  eng.beginHeld()
  await speakUntilPartial(true)
  assert.ok(
    host.partialUrls.every((u) => u.includes('manual=1')),
    `aecOn=false 应解析为 manual（URL 应带 manual=1）：${host.partialUrls[0]}`,
  )
  await eng.stop()
})

// ---------------------------------------------------------------- ③ 显式值不被探测覆盖
console.log('③ 显式 auto/manual 不被探测覆盖')

await t('显式 auto + aecOn=false → 仍 auto（探测不降级显式值）', async () => {
  setAec(false)
  const eng = makeEngine('auto')
  await eng.start()
  await settle()
  await speakUntilPartial()
  assert.ok(
    host.partialUrls.every((u) => !u.includes('manual=1')),
    `显式 auto 不得被 aecOff 探测降级为 manual：${host.partialUrls[0]}`,
  )
  await eng.stop()
})

await t('显式 manual + aecOn=true → 仍 manual（探测不升级显式值）', async () => {
  setAec(true)
  const eng = makeEngine('manual')
  await eng.start()
  await settle()
  eng.beginHeld()
  await speakUntilPartial(true)
  assert.ok(
    host.partialUrls.every((u) => u.includes('manual=1')),
    `显式 manual 不得被 aecOn 探测升级为 auto：${host.partialUrls[0]}`,
  )
  await eng.stop()
})

// ---------------------------------------------------------------- 附：探测只读一次（start 时）
console.log('附：探测在 start 时解析一次（start 后改 AEC 不回头影响运行时）')

await t('detect 启动后 AEC 状态变化不影响 runtimeBargeInMode（解析一次性）', async () => {
  setAec(true)
  const eng = makeEngine('detect')
  await eng.start()
  await settle()
  setAec(false) // 启动后原生 AEC 状态变化（浏览器侧）——引擎不应回头重判
  await speakUntilPartial()
  assert.ok(
    host.partialUrls.every((u) => !u.includes('manual=1')),
    `start 时已解析 auto，启动后 AEC 变化不得把运行时改成 manual：${host.partialUrls[0]}`,
  )
  await eng.stop()
})

rmSync(tmp, { recursive: true, force: true })
console.log(`\nbarge-in-detect-behavior：${passed} 项通过`)
process.exit(0)
