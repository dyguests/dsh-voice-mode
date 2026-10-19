/**
 * Issue #15 Blocker-1：ECHO_TAIL 死代码修复的行为级验证。
 * 运行：node test/echo-tail.test.mjs（npm test 串联——R2 集成轮已登记入链）。
 *
 * 背景（只读审查结论）：client.tsx 把**原始 setUi 闭包**（Object.assign+notify，
 * 不记 playing 降沿）传给 createAudioEngine，而 playing 降沿只记录在 bus.setUi
 * （playingEndAt）→ 播放引擎自己写 playing:false 时降沿不记录 → playingEndAt
 * 恒 0 → playingTailUntil() 恒 false → ECHO_TAIL_MS=400ms 回声尾音宽限
 * （isPlaying 门，防句播完瞬间残响漏入 ASR 造成自聊）从未生效。
 *
 * 修复：提取命名 setUi（降沿记录 + assign + notify）作为唯一写入入口，
 * createAudioEngine 首参改传它——播放引擎与状态条/手势同源。
 *
 * 本测试（行为级，esbuild 真编译 + 浏览器全局 stub）：
 *  1) apply(mockCtx) 建 bus → bus.enter 认领会话 → 经 EventSource stub 派发
 *     SSE 'audio' 帧（data+final）→ 真实拼帧 → engine.push → drainPending →
 *     stub AudioContext decode → setUi({playing:true})（共享入口）；
 *  2) 触发 BufferSource.onended（一句播完）→ setUi({playing:false}) →
 *     **降沿必须被记录**：bus.playingTailUntil() 进入未来（≈now+400ms）；
 *  3) 反向：onended 之前 playingTailUntil() 在过去（playingEndAt=0）；
 *  4) 源码锁：产物里 createAudioEngine 首参是共享 setUi，旧裸闭包形态不存在。
 *
 * 不变量：仅 stub 浏览器全局 + mock fetch/ctx，不改 src/。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-echo-'))

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}
const flush = () => new Promise((r) => setTimeout(r, 0))

// --------------------------------------------------------------------------
// Stub：react / asr / aec / resample / fixture-recorder / settings-form / strings+i18n+error-text
// （与 yield-ms-wiring.test.mjs 同模式：client.tsx 的浏览器依赖全部外置）
// --------------------------------------------------------------------------
const reactStub = join(tmp, 'react-stub.mjs')
writeFileSync(
  reactStub,
  `
export const useEffect = () => {}
export const useRef = () => ({ current: null })
export const useState = () => [null, () => {}]
export const createElement = (Comp, props) => ({ Comp, props })
export const Fragment = 'fragment'
export const createContext = () => ({ Provider: () => null, Consumer: () => null })
export const memo = (x) => x
export const forwardRef = (x) => x
export default { useEffect, useRef, useState, createElement, Fragment, createContext, memo, forwardRef }
`,
)

const asrStub = join(tmp, 'asr-stub.mjs')
writeFileSync(
  asrStub,
  `
export function createAsrEngine() {
  return {
    state: 'idle',
    start: async () => {},
    stop: async () => {},
    forceSend: () => {},
    beginHeld: () => {},
    endHeld: () => {},
    holding: false,
    aboveEchoFloor: () => false,
    echoLevels: () => ({ floorRms: 0, residualRms: 0, peakRms: 0 }),
    discardSegment: async () => {},
    onSegment: () => () => {},
    onPartial: () => () => {},
    onState: () => () => {},
    onError: () => () => {},
    onNotice: () => () => {},
    onLevel: () => () => {},
    onTelemetry: () => () => {},
  }
}
`,
)
const aecStub = join(tmp, 'aec-stub.mjs')
writeFileSync(
  aecStub,
  `
export class NlmsAec {
  constructor() {}
  process(mic, ref) { return mic }
  windowAt(_t, n) { return new Float32Array(n) }
  setFrozen(_f) {}
}
export function estimateBulkDelay() { return 0 }
`,
)
const resampleStub = join(tmp, 'resample-stub.mjs')
writeFileSync(resampleStub, `export function resampleLinear(s, _fr, _to) { return s }`)
const fixtureStub = join(tmp, 'fixture-stub.mjs')
writeFileSync(
  fixtureStub,
  `
export const fixtureRecorder = { isActive: false, begin() {}, mark() {}, noteDetect() {}, save() {}, noteIsSpeech() {} }
`,
)
const settingsFormStub = join(tmp, 'settings-form-stub.mjs')
writeFileSync(settingsFormStub, `export const VoiceSettingsCard = () => null`)
const stringsStub = join(tmp, 'strings-stub.mjs')
writeFileSync(
  stringsStub,
  `export const t = (k) => k
export const tr = (k) => k
export const useT = () => ({ t: (k) => k, tr: (k) => k })
export const locale = () => 'zh'
export const setLocale = () => {}
export const FIELD_LABELS = {}
export const DESC_LABELS = {}
export const STATE_LABELS = {}
export const SECTION_LABELS = {}
export const TKey = {}
export const useLang = () => 'zh'
export const bindLocale = () => () => {}
export const activeLocale = () => 'zh'
export const lang = () => 'zh'
export const errorText = (_b, k) => k
`,
)

// --------------------------------------------------------------------------
// Bundle client.tsx
// --------------------------------------------------------------------------
const clientBundle = join(tmp, 'client.bundle.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'client.tsx')],
  outfile: clientBundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  external: ['sherpa-onnx'],
  define: {
    __BUILD_TAG__: JSON.stringify('test-echo-tail'),
    __AUDIO_WORKLET__: JSON.stringify('// stub worklet source for test'),
  },
  alias: { react: reactStub },
  plugins: [
    {
      name: 'stub-client-deps',
      setup(b) {
        const map = {
          '\\./asr\\.ts$': asrStub,
          '\\./aec\\.ts$': aecStub,
          '\\./resample\\.ts$': resampleStub,
          '\\./fixture-recorder\\.ts$': fixtureStub,
          '\\./settings-form\\.tsx$': settingsFormStub,
          '\\./strings\\.ts$': stringsStub,
          '\\./i18n\\.ts$': stringsStub,
          '\\./error-text\\.ts$': stringsStub,
        }
        b.onResolve({ filter: /\.\.?\/(asr|aec|resample|fixture-recorder|strings|i18n|error-text)\.ts$/ }, (args) => {
          for (const [pat, target] of Object.entries(map)) {
            if (new RegExp(pat).test(args.path)) return { path: target }
          }
        })
        b.onResolve({ filter: /\.\.?\/(settings-form)\.tsx$/ }, () => ({ path: settingsFormStub }))
      },
    },
  ],
  logLevel: 'silent',
})

const clientSrc = readFileSync(clientBundle, 'utf8')

// --------------------------------------------------------------------------
// 浏览器全局 stub（apply → createVoiceBus → connect/EventSource、createAudioEngine/new Audio、
// drainPending → window.AudioContext.decodeAudioData 链路）
// --------------------------------------------------------------------------
class StubGain {
  constructor() {
    this.gain = { value: 1, cancelScheduledValues() {}, setTargetAtTime() {} }
  }
  connect() {}
}
class StubSrc {
  constructor() {
    this.buffer = null
    this.onended = null
  }
  connect() {}
  start() {
    globalThis.__stubSrcs.push(this)
  }
  stop() {}
}
class StubAudioContext {
  constructor() {
    this.currentTime = 0
    this.outputLatency = 0
    this.destination = {}
  }
  resume() {
    return Promise.resolve()
  }
  createGain() {
    return new StubGain()
  }
  decodeAudioData() {
    return Promise.resolve({ duration: 0.1, getChannelData: () => new Float32Array(16) })
  }
  createBufferSource() {
    return new StubSrc()
  }
}
class StubAudio {
  constructor() {
    this.paused = true
    this.src = ''
  }
  pause() {}
  play() {
    return Promise.resolve()
  }
}
class StubEventSource {
  constructor(url) {
    this.url = url
    this.listeners = {}
    globalThis.__lastES = this
  }
  addEventListener(type, fn) {
    ;(this.listeners[type] ||= []).push(fn)
  }
  close() {}
}
globalThis.__stubSrcs = []
globalThis.Audio = StubAudio
globalThis.EventSource = StubEventSource
globalThis.window = { AudioContext: StubAudioContext }
globalThis.location = { origin: 'http://127.0.0.1:0' }
globalThis.document = { addEventListener() {}, head: { appendChild() {} } }

const SID = 'sess-echo-1'
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.includes('/toggle')) {
    return { ok: true, status: 200, json: async () => ({ active: SID }) }
  }
  return { ok: false, status: 404, json: async () => ({}) }
}

const clientMod = await import(pathToFileURL(clientBundle).href)

// apply(mockCtx)：经 slots.register 拿 bus（第一个注册位 = conversation.input.right）
const registered = []
const ctx = {
  effect: () => () => {},
  get: () => undefined,
  slots: {
    inject: (_name, fn) => fn(),
    register: (meta, Comp) => {
      registered.push({ meta, Comp })
      return {}
    },
  },
}
clientMod.apply(ctx)
assert.ok(registered.length >= 1, 'apply 未注册任何槽位')
const bus = registered[0].meta.inject().bus
assert.ok(bus && typeof bus.playingTailUntil === 'function', '未取到 VoiceBus')

// --------------------------------------------------------------------------
// 行为：enter → SSE 'audio' 帧 → engine.push → playing:true → onended → playing:false
// --------------------------------------------------------------------------
await bus.enter(SID)
assert.equal(bus.activeSessionId, SID, 'bus.enter 未认领会话（activeSessionId 不匹配）')

const es = globalThis.__lastES
assert.ok(es, 'bus 未建 EventSource')
const fire = (type, data) => (es.listeners[type] || []).forEach((fn) => fn({ data: JSON.stringify(data) }))

// WAV 头（RIFF）整句一字节流：data 帧 + final 帧（chunkId 校验：1 === 已收 1）
const wav = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0, 0, 0, 0])
fire('audio', { sessionId: SID, sentenceId: 1, chunkId: 0, final: false, audio: wav.toString('base64') })
fire('audio', { sessionId: SID, sentenceId: 1, chunkId: 1, final: true, text: '你好', audio: '', mime: 'audio/wav' })
await flush()
await flush()

t('播放引擎经共享 setUi 写 playing:true（拼帧→push→decode→调度链路通）', () => {
  assert.equal(bus.ui.playing, true, 'engine 未置 playing——音频链路断（测试前提不成立）')
  assert.equal(globalThis.__stubSrcs.length, 1, '未调度 BufferSource')
})

t('修复前形态：playingEndAt=0 → playingTailUntil() 在过去（无宽限）', () => {
  assert.ok(bus.playingTailUntil() <= Date.now(), 'onended 前尾音窗不应生效（playingEndAt 恒 0 是 bug 形态）')
})

// 一句播完：BufferSource.onended → setUi({playing:false, playingCaption:null})
globalThis.__stubSrcs[0].onended()

t('修复后：playing 降沿被记录 → playingTailUntil() 进入未来（≈now+400ms）', () => {
  assert.equal(bus.ui.playing, false, 'onended 后 playing 未复位')
  const until = bus.playingTailUntil()
  const delta = until - Date.now()
  assert.ok(delta > 300, `playingTailUntil delta=${delta}ms——降沿未记录（ECHO_TAIL 死代码复发）`)
  assert.ok(delta <= 500, `playingTailUntil delta=${delta}ms 超窗（ECHO_TAIL_MS=400 + 调用耗时）`)
})

t('尾音窗到期后回到过去（宽限是有界的，不永久屏蔽 ASR）', async () => {
  await new Promise((r) => setTimeout(r, 450))
  assert.ok(bus.playingTailUntil() <= Date.now(), '宽限未到期——永久屏蔽 ASR（比原 bug 更糟）')
})

// --------------------------------------------------------------------------
// 源码锁：createAudioEngine 首参 = 共享 setUi；旧裸闭包形态不存在
// --------------------------------------------------------------------------
t('源码锁：bundle 内 createAudioEngine 首参为共享 setUi（非裸闭包）', () => {
  assert.ok(clientSrc.includes('createAudioEngine(setUi'), 'bundle 缺 createAudioEngine(setUi, ...)——首参不是共享入口')
  assert.ok(
    !clientSrc.includes('createAudioEngine((patch)'),
    'bundle 仍含旧裸闭包传参——降沿记录被绕过（死代码复发）',
  )
})

t('源码锁：setUi 实现含 playing 降沿记录（playingEndAt = Date.now()）', () => {
  assert.ok(
    /(?:var|const|let) setUi = \(patch\) => \{[\s\S]*?playingEndAt = Date\.now\(\)/.test(clientSrc),
    'setUi 缺降沿记录',
  )
})

rmSync(tmp, { recursive: true, force: true })
console.log('\necho-tail：' + passed + ' 项通过')
