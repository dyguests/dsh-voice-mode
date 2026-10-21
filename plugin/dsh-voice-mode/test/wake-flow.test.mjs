/**
 * 唤醒词流程端到端台架（issue #10 后续：唤醒词几乎无法触发）。
 * 运行：node test/wake-flow.test.mjs
 *
 * 目的：用「假浏览器 + 假 host」驱动 **真 src/asr.ts 引擎**（createAsrEngine），
 * 复现并锁定唤醒待机链路的两个流程缺陷：
 *   D1 朗读期无自聊守卫——AI 朗读时 state==='wake'，wake 分支不判 isPlaying，
 *      把 TTS 回声累积进待机段；朗读结束后的第一次 partial 会把「AI 的话 + 唤醒词」
 *      整段上传 → host 累计文本以 AI 的话开头 → 唤醒词头部锚定必然失配。
 *   D2 只入 rms 超门限帧——静音/弱起音被丢弃，上传音频被切成碎片；用户停口后
 *      不再有新帧 → 不再发 partial → host 拿不到尾随静音，流式解码器 flush 不出
 *      最后一个字 → 累计文本停在「你好」这类半截 → 匹配失败。
 *
 * 台架约定（可控、确定性）：
 *   - 时钟：Date.now / performance.now 走可控 NOW，每帧推进 64ms。
 *   - 帧：1024 样本 @16k，常数幅度编码角色 —— >0.2 = AI 朗读回声 /
 *     0.015~0.2 = 用户语音 / <0.015 = 静音（与 asr.ts SPEECH_RMS 门限一致）。
 *   - host：按 200ms 块把音频转成字符（回声块 → AI 短语，语音块 → 唤醒词；
 *     静音块不产字），并按 LAG_MS 模拟流式解码滞后（收到足量后续音频才吐出该字）。
 *
 * 不变量：本测试只读 src/，不改任何源码。
 *
 * Issue #15 批 1（2026-10-19，ADR-0012）扩展——打断语音抢救（修「打断吃句」）：
 *   播放期用户语音只进 detectChunks 检测通道、不进识别段（asr.ts:774/828-837）；
 *   hardBreak 后 /cancel asr.reset + discardSegment 双清场 → 打断前说的话全丢。
 *   修复：AEC 后墙钟预录环（PRE_ROLL_MS=2000）+ hardBreak 弃段时把「VAD 首真
 *   （detect 请求体起点口径，reqBodyStart=sentAt−请求体音频时长）-250ms」起的音频并入新识别段（absorbPreRoll）。
 *   本文件新增装置×4：vadOnly 响应可编程+detect 延迟 dial / hardBreak 序列注入 /
 *   reset 延迟档 / salvage 段纯 backchannel 弃段守卫（「嗯」不得作为消息发出）。
 *
 * Issue #15 批 8（2026-10-19）扩展——B1：wake 待机态一次 host 202 击穿唤醒门。
 *   待机期 partial 收 202 即 setState('loading-model')，而唤醒分支判据是
 *   state==='wake' → 门失效到下一段定稿，待机语音落入正常分段路径、唤醒词随语音
 *   泄漏进消息/草稿（issue #10 症状回归，无测试覆盖）。新增装置：partial 响应一次性
 *   202（armPartial202）；引擎 202 重试是真实 setTimeout(5000)，台架用 realSleep 真等。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-wakeflow-'))

// ---------------------------------------------------------------- 可控时钟
let NOW = 1_000_000
Date.now = () => NOW
globalThis.performance = { now: () => NOW }

// ---------------------------------------------------------------- 浏览器 API mock
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.location = { origin: 'http://127.0.0.1:3018' }

const SR = 16000
const FRAME = 1024 // 64ms
const SPEECH_RMS = 0.015 // 与 asr.ts 一致
let LAG_MS = 300 // host 流式解码滞后（尾字需要后续音频才 flush）；用例可调
const setLag = (ms) => { LAG_MS = ms }
const SYLLABLE_MS = 200
const ECHO_AMP = 0.3 // >0.2 → AI 朗读（回声）
const CMD_AMP = 0.1 // 0.08~0.2 → 命令语音（与唤醒词可区分）
const SPEECH_AMP = 0.06 // 唤醒词语音（超门限）
const SIL_AMP = 0.0005 // 静音（低于门限）
// Issue #15 批 1：backchannel 频段（0.03~0.05，夹在静音门限与命令/唤醒频段之间，
// 不影响既有幅度分工）——假 host 转写为「嗯」，供 salvage 段弃段守卫测试。
const BC_AMP = 0.04
const BC_CHAR = '嗯'
// Issue #15 批 1：两个延迟 dial（台架装置，可复零）。
//   detect 延迟：vadOnly 响应延迟（模拟检测通道 RTT，证 onset 锚请求体起点不受响应到达影响；
//   延迟期间伴音频推进保持墙钟/音频 timeline 同步）。
//   reset 延迟：reset=1 响应延迟（模拟 host 清场慢，证 absorb 同步 seed 无 offset 错位）。
let DETECT_DELAY_MS = 0
let RESET_DELAY_MS = 0
const setDetectDelay = (ms) => { DETECT_DELAY_MS = ms }
const setResetDelay = (ms) => { RESET_DELAY_MS = ms }
// B1 装置：partial 响应一次性返回 202（模拟 host 模型下载中；引擎 5s 后重试同一载荷）。
// 锁定「待机态一次 202 不得击穿唤醒门」——修复前 202 一到位就切 loading-model，
// 唤醒分支判据 state==='wake' 随即失效。
let PARTIAL_202_LEFT = 0
const armPartial202 = (n = 1) => { PARTIAL_202_LEFT = n }
// Issue #15 R15-5（Minor B）：partial 状态码序列装置（连败计数行为锁用）——逐请求取下一个
// 状态码（默认 200）；用尽后回到 200。用于构造「失败/成功交替」的非连续失败序列。
const PARTIAL_FAIL_PATTERN = []
const armPartialFailPattern = (codes) => {
  PARTIAL_FAIL_PATTERN.length = 0
  PARTIAL_FAIL_PATTERN.push(...codes)
}
// 观察项 2 装置（Issue #15 批 8）：AudioContext.close() 慢收尾 dial + close 计数 +
// addModule 慢 dial——复现「stop 收尾在途时新 start 装配新 ctx，被旧收尾置空」竞态。
// 真实浏览器 audioCtx.close() 可达数十 ms，而 getUserMedia/resume/addModule 在已授权
// 环境下是微任务级——旧收尾续体因此能插进新 start 链中段（置空后新 start 读 ctx 抛错）。
let CTX_CLOSE_DELAY_MS = 0
let ADD_MODULE_DELAY_MS = 0
let ctxCloseCount = 0
const setCtxCloseDelay = (ms) => { CTX_CLOSE_DELAY_MS = ms }
const setAddModuleDelay = (ms) => { ADD_MODULE_DELAY_MS = ms }
const AI_PHRASE = '我明白了'
const WAKE = '你好小李'
const COMMAND = '给我说一百个字'
// Issue #15 R15-5（回声门控台架）：AI 回声在 >0.2 频段（假 host 视其为纯回声、不触发 VAD）；
// 用户「真打断」的洪亮语音在 >LOUD_AMP_MIN 频段。此前假 host 的 VAD 只认 [0.03,0.2)，
// 无法表达真实的门控条件——门控放行要求「用户残差 > 回声地板 ×2（6dB）」，即用户音
// 必须显著盖过回声电平，而回声又必须 >0.2 才不被假 VAD 当成语音。LOUD_AMP_MIN 夹在
// 两者之间（0.3 回声 < 0.33 < 用户洪亮语音），两侧各留余量；既有用例的幅度 ≤0.3，不受影响。
const LOUD_AMP_MIN = 0.33
const LOUD_CHAR = '语' // 洪亮用户语音的转写标记（与回声/命令/唤醒字面量可区分）

let capturedNode = null
class FakeAudioWorkletNode {
  constructor(ctx) {
    // 观察项 2 装置：真实 API 在 ctx 为 null/已关闭时抛 TypeError——旧收尾把新 ctx 置空后，
    // 新 start 会在此抛错（台架复现「新 start 抛错」症状；正常路径 ctx 恒非空，不影响他例）。
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
    this.audioWorklet = { addModule: async () => {
      // 观察项 2 装置：addModule 慢 dial（把新 start 的链拉长到覆盖旧收尾续体）。
      if (ADD_MODULE_DELAY_MS > 0) await new Promise((r) => setTimeout(r, ADD_MODULE_DELAY_MS))
    } }
  }
  createMediaStreamSource() {
    return { connect() {} }
  }
  createScriptProcessor() {
    return { connect() {}, disconnect() {}, onaudioprocess: null }
  }
  async resume() {}
  async close() {
    ctxCloseCount++
    // 观察项 2 装置：慢收尾 dial（真实浏览器 close() 可达数十 ms）。
    if (CTX_CLOSE_DELAY_MS > 0) await new Promise((r) => setTimeout(r, CTX_CLOSE_DELAY_MS))
  }
}
const fakeTrack = { getSettings: () => ({ echoCancellation: true }), stop() {} }
const fakeStream = { getAudioTracks: () => [fakeTrack], getTracks: () => [fakeTrack] }
globalThis.AudioContext = FakeAudioContext
globalThis.window = { AudioContext: FakeAudioContext }
// Node 22 的 globalThis.navigator 是只读 getter，需 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  value: { mediaDevices: { getUserMedia: async () => fakeStream } },
  configurable: true,
  writable: true,
})
globalThis.AudioWorkletNode = FakeAudioWorkletNode

// ---------------------------------------------------------------- 假 host（流式 ASR 模拟）
const streams = new Map() // epoch -> stream state
const hostLog = { partials: 0, resets: 0, detects: 0, finals: 0 }

// Issue #15 批 1：带音频推进的延迟（detect dial 用）——推进墙钟的同时持续推送同频段
// 音频帧（RTT 期间用户持续发声的生产语义），保持墙钟与音频 timeline 同步。
const delayWithAudio = async (ms, amp) => {
  const frames = Math.max(1, Math.round(ms / 64))
  for (let i = 0; i < frames; i++) {
    NOW += (FRAME / SR) * 1000
    capturedNode?.port?.onmessage?.({ data: new Float32Array(FRAME).fill(amp) })
    await new Promise((r) => setImmediate(r))
  }
}

const meanAbs = (arr) => {
  let s = 0
  for (let i = 0; i < arr.length; i++) s += Math.abs(arr[i])
  return arr.length ? s / arr.length : 0
}

function newStream() {
  return { q: [], qLen: 0, fedPos: 0, recvMs: 0, pending: [], aiIdx: 0, wakeIdx: 0, cmdIdx: 0, echoSamples: 0, firstAmp: null }
}

/** 从队列取 n 个样本（不足返回 null）。 */
function pull(st, n) {
  if (st.qLen < n) return null
  const out = new Float32Array(n)
  let off = 0
  while (off < n) {
    const head = st.q[0]
    const take = Math.min(head.length, n - off)
    out.set(head.subarray(0, take), off)
    off += take
    if (take === head.length) st.q.shift()
    else st.q[0] = head.subarray(take)
    st.qLen -= take
  }
  return out
}

function feed(epoch, offset, samples, final, padMs = 0) {
  let st = streams.get(epoch)
  if (!st) {
    if (samples.length === 0 && final) return ''
    st = newStream()
    streams.set(epoch, st)
  }
  if (offset + samples.length > st.fedPos) {
    const skip = Math.max(st.fedPos - offset, 0)
    const inc = samples.subarray(skip)
    st.fedPos = offset + samples.length
    if (st.firstAmp === null && inc.length > 0) st.firstAmp = Math.abs(inc[0])
    st.q.push(inc)
    st.qLen += inc.length
    st.recvMs += (inc.length / SR) * 1000
    for (let i = 0; i < inc.length; i++) if (Math.abs(inc[i]) > 0.2) st.echoSamples++
    // 按 200ms 块「识别」：回声块 → AI 短语，语音块 → 唤醒词，静音块不产字
    const blockN = Math.round((SR * SYLLABLE_MS) / 1000)
    for (;;) {
      const block = pull(st, blockN)
      if (!block) break
      const endMs = (st.fedPos - st.qLen) / SR * 1000
      // 频段按**块均值**判定：小块需含足量某频段样本才产字（32ms 的相位小尾巴不产字——
      // max 判会让它产字污染唤醒词文本，D5 命令窗用例实测抓红）。Issue #15 批 1：backchannel
      // 频段加宽到 [0.015, 0.05)——静音→backchannel 混合块（如 100ms 嗯 + 100ms 静音，
      // 均值≈0.02）落本频段产「嗯」而非落唤醒频段产「你」杂字；纯静音（0.0005）不产字。
      const amp = meanAbs(block)
      let ch = ''
      if (amp > LOUD_AMP_MIN) ch = LOUD_CHAR
      else if (amp > 0.2) ch = AI_PHRASE[st.aiIdx++ % AI_PHRASE.length]
      else if (amp >= 0.08) ch = COMMAND[st.cmdIdx++ % COMMAND.length]
      else if (amp >= 0.015 && amp < 0.05) ch = BC_CHAR
      else if (amp >= SPEECH_RMS) ch = WAKE[st.wakeIdx++ % WAKE.length]
      st.pending.push({ endMs, ch })
    }
  }
  // 定稿尾垫（host 真实行为：final 时 acceptWaveform(0.5s 静音) + decode，让尾字 flush）
  if (padMs > 0) st.recvMs += padMs
  // 流式滞后：partial 时只有在该块之后又收到 LAG_MS 音频，该字才吐出来（flush 语义）；
  // final 时尾垫足以让所有待吐字落定（真实 host 会 decode 到 not-ready，模型同此）。
  let text = ''
  for (const p of st.pending) {
    const need = final ? p.endMs : p.endMs + LAG_MS
    if (p.ch && st.recvMs >= need) text += p.ch
  }
  st.lastText = text
  return text
}

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url))
  const p = u.searchParams
  const epoch = Number(p.get('epoch') ?? 0)
  const offset = Number(p.get('offset') ?? 0)
  const final = p.get('final') === '1'
  if (p.get('reset') === '1') {
    hostLog.resets++
    // Issue #15 批 1：reset 延迟 dial（模拟 host 清场慢）。sleep 入参是毫秒（内部按
    // 64ms/帧换算）——曾误传帧数（ceil(ms/64)）导致 1000ms 只推进 64ms，名义失真。
    // reset 窗口无 seek/锚点数学（seed 已同步完成），时钟推进即可，不需伴音频。
    if (RESET_DELAY_MS > 0) await sleep(RESET_DELAY_MS)
    streams.clear()
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  const raw = init.body ? new Float32Array(init.body) : new Float32Array(0)
  if (p.get('vadOnly') === '1') {
    hostLog.detects++
    // Issue #15 批 1：vadOnly 响应可编程 + detect 延迟 dial。忠实真机 fixture 语义：
    // Silero 检测 VAD 不被纯回声触发（0/937 帧，CONTEXT.md:59），故纯回声段（>0.2）回
    // false；用户语音段回 true。**子窗帧级近似**（任一 100ms 子窗均值落语音频段即 true）：
    // 整窗均值判会把「回声尾+语音」混合体误判为回声（RTT 劣化下混合体常见），帧级判才
    // 忠实「VAD 在窗内某处见到语音」。onset 由引擎锚请求体起点（不受本延迟影响）。
    // 延迟期间**持续推送同频段音频帧**（RTT 期间用户持续发声的生产语义）：纯 sleep 只推
    // 墙钟会让墙钟跑在音频 timeline 前面，salvage 的墙钟 seek/锚点数学失真（实测抓红）。
    if (DETECT_DELAY_MS > 0) await delayWithAudio(DETECT_DELAY_MS, meanAbs(raw))
    let isSpeech = false
    const sub = Math.round(SR * 0.1)
    for (let off = 0; off + sub <= raw.length && !isSpeech; off += sub) {
      const a = meanAbs(raw.subarray(off, off + sub))
      // 语音频段 [0.03,0.2)（回声频段 >0.2 不触发：Silero 不被纯回声触发，CONTEXT.md:59）
      // ∪ 洪亮语音频段（>LOUD_AMP_MIN，用户声音盖过回声地板时的真实形态）。
      if ((a >= 0.03 && a < 0.2) || a >= LOUD_AMP_MIN) isSpeech = true
    }
    return new Response(JSON.stringify({ isSpeech }), { status: 200 })
  }
  if (final) {
    hostLog.finals++
    return new Response(JSON.stringify({ text: feed(epoch, offset, raw, true, 500) }), { status: 200 })
  }
  if (PARTIAL_202_LEFT > 0) {
    // B1：模型下载中（引擎见 202 后 5s 重试同一载荷，见 asr.ts requestPartial）。
    PARTIAL_202_LEFT--
    return new Response(JSON.stringify({}), { status: 202 })
  }
  hostLog.partials++
  // Issue #15 R15-5（Minor B）：按装置返回失败状态码（连败计数行为锁）。
  if (PARTIAL_FAIL_PATTERN.length > 0) {
    const code = PARTIAL_FAIL_PATTERN.shift()
    if (code !== 200) return new Response(JSON.stringify({ error: 'boom' }), { status: code })
  }
  return new Response(JSON.stringify({ text: feed(epoch, offset, raw, false), endpoint: false }), {
    status: 200,
  })
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
const msToFrames = (ms) => Math.max(1, Math.round(ms / ((FRAME / SR) * 1000)))

async function frame(amp) {
  NOW += (FRAME / SR) * 1000
  capturedNode.port.onmessage({ data: new Float32Array(FRAME).fill(amp) })
  await tick()
}
async function say(amp, ms) {
  for (let i = 0; i < msToFrames(ms); i++) await frame(amp)
}
const sleep = async (ms) => {
  // 只推时钟 + 空转 microtask（不产音频帧）
  for (let i = 0; i < msToFrames(ms); i++) {
    NOW += (FRAME / SR) * 1000
    await tick()
  }
}
// 真实时间等待：引擎 202 重试用真实 setTimeout(5000)（台架假时钟推不动它），只能真等。
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeEngine({ wakeWord = WAKE, isPlaying = () => false, bargeInSalvage, onIsSpeech } = {}) {
  streams.clear()
  hostLog.partials = hostLog.resets = hostLog.detects = hostLog.finals = 0
  PARTIAL_202_LEFT = 0 // B1 装置不复用到下一用例（快照隔离）
  armPartialFailPattern([]) // Minor B 装置不复用到下一用例（快照隔离）
  CTX_CLOSE_DELAY_MS = 0 // 观察项 2 装置默认快收尾（不影响他例）
  ADD_MODULE_DELAY_MS = 0
  ctxCloseCount = 0
  let state = 'idle'
  const segments = []
  const partials = []
  const notices = []
  const engine = createAsrEngine(
    {
      silenceMs: 1500,
      basePath: '/voice-mode',
      mode: 'toggle',
      bargeInMode: 'auto',
      wakeWord,
      isPlaying,
      onIsPlaying: undefined,
      // Issue #15 批 1：bargeInSalvage 透传（不传 = 默认开，与 I10 豁免口径一致）。
      ...(bargeInSalvage !== undefined ? { bargeInSalvage } : {}),
      // Issue #15 R15-5：假客户端的 VAD 回调（复刻 client.tsx 的打断确认 + 回声门控）。
      ...(onIsSpeech ? { onIsSpeech } : {}),
    },
    'sess-test',
  )
  engine.onState((s) => {
    state = s
  })
  engine.onSegment((t) => segments.push(t))
  engine.onPartial((t) => partials.push(t))
  engine.onNotice((k) => notices.push(k))
  return {
    engine,
    segments,
    partials,
    notices,
    get state() {
      return state
    },
  }
}

const echoFed = () => [...streams.values()].reduce((n, s) => n + s.echoSamples, 0)
const firstFedAmp = () => {
  for (const st of streams.values()) if (st.firstAmp !== null) return st.firstAmp
  return null
}

let passed = 0
const t = async (name, fn) => {
  await fn()
  passed++
  console.log('  ✓ ' + name)
}

// ---------------------------------------------------------------- 场景 1：无朗读，正常说唤醒词（D2）
console.log('场景 1：待机态直接说唤醒词（应能触发）')
await t('说「你好小李」→ 进入 listening（静音帧也上传，尾字 flush 得出来）', async () => {
  const h = makeEngine()
  await h.engine.start()
  assert.equal(h.state, 'wake', '配置唤醒词后应进入 wake 待机态')
  await say(SPEECH_AMP, 200 * 4) // 你好小李 四字
  await say(SIL_AMP, 1500) // 停口：尾随静音（关键——不给就 flush 不出尾字）
  // 反向验证：修复前（wake 分支只入超门限帧）此处红——停口后无新帧上传，
  // host 累计文本停在「你好」（4 字唤醒词只剩 2 字，编辑距离 2 > 1 → 失配）。
  assert.equal(h.state, 'listening', `期望唤醒后进入 listening，实际 state=${h.state}`)
  await h.engine.stop()
})

console.log('场景 2：AI 朗读后说唤醒词（D1 + D2）')
await t('朗读期不得把 TTS 回声累积进待机段 + 唤醒词仍能触发', async () => {
  let playing = true
  const h = makeEngine({ isPlaying: () => playing })
  await h.engine.start()
  await say(ECHO_AMP, 1500) // AI 朗读中（回声）
  await sleep(400)
  playing = false
  await say(SIL_AMP, 300)
  await say(SPEECH_AMP, 200 * 4) // 说唤醒词
  await say(SIL_AMP, 1500)
  // 反向验证：修复前此处两条都红——echoFed()=23552（TTS 回声整段上传）、
  // host 累计文本以「我明白了我明白」开头（唤醒词被挤到段中，头部锚定失配）。
  assert.equal(echoFed(), 0, `朗读期回声不得进入 ASR 流（实际回声样本 ${echoFed()}）`)
  assert.equal(h.state, 'listening', `期望唤醒后进入 listening，实际 state=${h.state}`)
  await h.engine.stop()
})

await t('唤醒词弱起音被 prePad 补齐（起始音不被门限切掉）', async () => {
  const h = makeEngine({ wakeWord: '香蕉苹果' }) // 不命中：避免命中后清段清流把样本丢掉
  await h.engine.start()
  await say(SIL_AMP, 200) // 弱起音（低于 SPEECH_RMS 门限）
  await say(SPEECH_AMP, 200 * 4)
  await say(SIL_AMP, 1500)
  const amp = firstFedAmp()
  assert.ok(amp !== null, '应有音频上传给 ASR')
  assert.ok(amp <= SPEECH_RMS, `首个上传样本应是弱起音（实际幅度 ${amp}）——prePad 未生效`)
  await h.engine.stop()
})

await t('（现状语义）断句后回待机：下一条命令需重说唤醒词', async () => {
  const h = makeEngine()
  await h.engine.start()
  await say(SPEECH_AMP, 200 * 4) // 唤醒词
  await say(SIL_AMP, 1500)
  assert.equal(h.state, 'listening', '先说唤醒词应进入 listening')
  await say(SPEECH_AMP, 1000) // 命令（假 host 转写成唤醒词字符，此处不判内容）
  await say(SIL_AMP, 2500) // 静音断句 → 定稿
  await sleep(500)
  assert.equal(h.state, 'wake', `断句后应回待机（现状），实际 ${h.state}`)
  await h.engine.stop()
})

await t('连续说「唤醒词+命令」→ 定稿必须含完整命令（不得只剩尾部）', async () => {
  const h = makeEngine()
  await h.engine.start()
  await say(SPEECH_AMP, 200 * 4) // 你好小李
  await say(CMD_AMP, 200 * COMMAND.length) // 命令（与唤醒词连说、中间不停顿）
  await say(SIL_AMP, 2500) // 停口断句 → 定稿
  assert.equal(h.segments.length, 1, `应产出 1 条定稿（实际 ${h.segments.length} 条：${JSON.stringify(h.segments)}）`)
  assert.ok(
    h.segments[0].includes(COMMAND),
    `定稿应含完整命令「${COMMAND}」（实际 "${h.segments[0]}"）——唤醒命中时丢掉整段会吃掉命令前半句`,
  )
  assert.ok(
    !h.segments[0].includes(WAKE),
    `定稿不应把唤醒词发出去（实际 "${h.segments[0]}"）——定稿应剥掉词头`,
  )
  const lastPartial = h.partials[h.partials.length - 1] ?? ''
  assert.ok(
    !lastPartial.includes(WAKE),
    `唤醒后的实时字幕也应剥掉唤醒词（最后一条 "${lastPartial}"）——字幕与将发出的内容保持一致`,
  )
  await h.engine.stop()
})

await t('停顿分说（唤醒词 … 停顿 … 命令）→ 定稿同样只含命令', async () => {
  const h = makeEngine()
  await h.engine.start()
  await say(SPEECH_AMP, 200 * 4) // 你好小李
  await sleep(600) // 短停顿（不足 silenceMs，不触发弃段）
  await say(CMD_AMP, 200 * COMMAND.length)
  await say(SIL_AMP, 2500)
  assert.equal(h.segments.length, 1, `应产出 1 条定稿（实际 ${JSON.stringify(h.segments)}）`)
  assert.ok(h.segments[0].includes(COMMAND), `定稿应含完整命令（实际 "${h.segments[0]}"）`)
  assert.ok(!h.segments[0].includes(WAKE), `定稿不应含唤醒词（实际 "${h.segments[0]}"）`)
  await h.engine.stop()
})

await t('唤醒词在停口后才被识别 → 命令仍必须定稿送出（不得悬挂）', async () => {
  setLag(3000) // 大滞后：唤醒词直到用户停口后才出现在识别文本里
  try {
    const h = makeEngine()
    await h.engine.start()
    await say(SPEECH_AMP, 200 * 4)
    await say(CMD_AMP, 200 * COMMAND.length)
    await say(SIL_AMP, 3000)
    assert.equal(
      h.segments.length,
      1,
      `应产出 1 条定稿（实际 ${h.segments.length} 条：${JSON.stringify(h.segments)}）——命中后若 speechActive 未置位，尾随静音不会定稿，命令悬挂到下一句`,
    )
    assert.ok(h.segments[0].includes(COMMAND), `定稿应含完整命令（实际 "${h.segments[0]}"）`)
  } finally {
    setLag(300)
  }
  const h = makeEngine()
  await h.engine.stop()
})

await t('唤醒词…长停顿（> silenceMs）…命令 → 命令仍须被识别（命令窗口）', async () => {
  const h = makeEngine()
  await h.engine.start()
  await say(SPEECH_AMP, 200 * 4) // 你好小李
  await say(SIL_AMP, 2500) // 长停顿（只喊了唤醒词就停下想事情）
  await say(CMD_AMP, 200 * COMMAND.length) // 想好了再说命令
  await say(SIL_AMP, 2500)
  assert.equal(
    h.segments.length,
    1,
    `应产出 1 条定稿（实际 ${h.segments.length} 条：${JSON.stringify(h.segments)}）——只喊唤醒词后停顿不应把命令窗口关掉`,
  )
  assert.ok(h.segments[0].includes(COMMAND), `定稿应含完整命令（实际 "${h.segments[0]}"）`)
  await h.engine.stop()
})

console.log('回归不变量')
await t('待机段永不 finalize（standby 音频不得变成消息）', async () => {
  const h = makeEngine({ wakeWord: '香蕉苹果' }) // 假 host 只会转写出「你好小李」，故不命中
  await h.engine.start()
  await say(SPEECH_AMP, 1200) // 说了无关的话（未命中唤醒词）
  await say(SIL_AMP, 3000)
  assert.deepEqual(h.segments, [], `待机态不应产出定稿消息（实际 ${JSON.stringify(h.segments)}）`)
  await h.engine.stop()
})

await t('host 202（模型下载中）不得击穿唤醒门：待机语音不泄漏 + 唤醒词仍可匹配', async () => {
  const h = makeEngine()
  armPartial202() // 首个 partial 响应 = 202（引擎 5s 后重试同一载荷；须在 makeEngine 后武装）
  await h.engine.start()
  assert.equal(h.state, 'wake', '配置唤醒词后应进入 wake 待机态')
  await say(SPEECH_AMP, 200 * 4) // 说唤醒词（首个 partial 拿到 202）
  await say(SIL_AMP, 600) // 尾随静音（不足 silenceMs，不清待机段）
  // B1 回归锁：修复前 202 一到位就 setState('loading-model')，唤醒分支判据
  // state==='wake' 随即失效——待机语音落入正常分段路径，静音到点即定稿，唤醒词
  // 随语音泄漏进消息/草稿（issue #10 症状回归）。
  assert.equal(h.state, 'wake', `待机期 202 不得把 state 切出 wake（实际 ${h.state}）——唤醒门失效前兆`)
  await realSleep(5200) // 等引擎 5s 重试窗过（真实 setTimeout，假时钟推不动）
  await say(SIL_AMP, 300) // 重试落定后补几帧 → 下一拍 partial 上传完整段
  assert.equal(h.state, 'listening', `202 之后唤醒词仍须被匹配（实际 ${h.state}）——唤醒门被击穿`)
  await say(SIL_AMP, 2000) // 停口断句：门失效时这里会把「你好小李」作为消息定稿发出
  assert.deepEqual(
    h.segments,
    [],
    `待机态语音不得绕过唤醒门直接定稿发出（实际 ${JSON.stringify(h.segments)}）——唤醒词泄漏进消息`,
  )
  await h.engine.stop()
})

await t('stop 收尾与新 start 竞态：不置空新 ctx、不踩新会话状态（新 start 不抛错 + 新 ctx 不被泄漏）', async () => {
  const h = makeEngine()
  await h.engine.start()
  assert.equal(ctxCloseCount, 0, '起始不应有 ctx 关闭')
  // 慢收尾（close 1ms）+ 新 start 的 addModule 更慢（5ms）→ 旧收尾续体先跑，
  // 恰好插在新 start 链中段（真实浏览器同构：close 数十 ms vs 已授权后微任务级启动）。
  setCtxCloseDelay(1)
  setAddModuleDelay(5)
  const stopP = h.engine.stop() // 不 await——生产中 stop→start 可快速连续（重进语音模式）
  let startErr = null
  try {
    // 旧收尾在途时新启动（active 已被 stop 置 false，start 不被挡）。
    await h.engine.start()
  } catch (e) {
    startErr = e
  }
  await stopP // 旧收尾续体此刻才跑：修复前无条件 audioCtx=null 把新 ctx 置空
  assert.equal(
    startErr,
    null,
    `旧收尾置空新 ctx 会令新 start 读 audioCtx 抛错（${startErr?.message}）——麦道遗留 + 幽灵上行`,
  )
  // 观察项 3：旧 stop 收尾跨过新 start 完成——不得把新会话的 wake 踩成 idle。
  // 修复前末尾无条件 setState('idle')：状态条误显退出，但引擎 active=true 仍在收音。
  assert.equal(h.state, 'wake', `旧 stop 不得踩新会话状态（实际 ${h.state}）——状态条误显退出但引擎仍在收音`)
  await h.engine.stop()
  assert.equal(
    ctxCloseCount,
    2,
    `两个 AudioContext 都必须被 close（实际 ${ctxCloseCount}）——新 ctx 被置空后无人能 close 它（泄漏）`,
  )
  // 末次 stop 无新 start 抢先 → 守卫放行，正常落 idle（防守卫误伤正常停止路径）。
  assert.equal(h.state, 'idle', `无新 start 抢先时 stop 应落 idle（实际 ${h.state}）——世代守卫误伤正常路径`)
})

await t('朗读期检测通道仍工作（barge-in 不受自聊守卫影响）', async () => {
  const h = makeEngine({ isPlaying: () => true })
  await h.engine.start()
  await say(ECHO_AMP, 1000)
  assert.ok(hostLog.detects > 0, `朗读期应走 vadOnly 检测通道（实际 ${hostLog.detects} 次）`)
  await h.engine.stop()
})

// ---------------------------------------------------------------- Issue #15 批 1：打断语音抢救（ADR-0012）
console.log('Issue #15 批 1：打断语音抢救（preRoll + absorbPreRoll）')
const countOccur = (s, sub) => s.split(sub).length - 1

await t('打断吃句修复：朗读期开口说的话经抢救进入定稿（absorbPreRoll）', async () => {
  let playing = true
  const h = makeEngine({ wakeWord: '', isPlaying: () => playing, bargeInSalvage: true })
  await h.engine.start()
  await say(ECHO_AMP, 800) // AI 朗读中（回声）
  await say(CMD_AMP, 1000) // 用户开口打断（命令频段——打断生效前说的全在预录环里）
  await sleep(300) // 让 detect 轮询把 isSpeech 送上来（onset 记录）
  playing = false // hardBreak：停播
  await h.engine.discardSegment() // client.tsx hardBreak 时序的引擎侧等价（ salvage 在此发生）
  await say(SPEECH_AMP, 600) // 打断后把话说完（唤醒频段——与打断前可区分）
  await say(SIL_AMP, 2500) // 静音断句 → 定稿
  assert.equal(h.segments.length, 1, `应产出 1 条定稿（实际 ${h.segments.length} 条：${JSON.stringify(h.segments)}）`)
  assert.ok(
    h.segments[0].includes('给我说'),
    `定稿应含打断前说的话（实际 "${h.segments[0]}"）——absorbPreRoll 未生效即「打断吃句」回归`,
  )
  assert.ok(h.segments[0].includes('一百'), `定稿应含打断前全部命令（实际 "${h.segments[0]}"）——句首/中段被切`)
  assert.ok(h.segments[0].includes('你好'), `定稿应含打断后说的话（实际 "${h.segments[0]}"）`)
  await h.engine.stop()
})

await t('bargeInSalvage=false 逃生口：丢弃打断前语音（回退 issue 现状）', async () => {
  let playing = true
  const h = makeEngine({ wakeWord: '', isPlaying: () => playing, bargeInSalvage: false })
  await h.engine.start()
  await say(ECHO_AMP, 800)
  await say(CMD_AMP, 1000)
  await sleep(300)
  playing = false
  await h.engine.discardSegment()
  await say(SPEECH_AMP, 600)
  await say(SIL_AMP, 2500)
  assert.equal(h.segments.length, 1, `应产出 1 条定稿（实际 ${h.segments.length} 条）`)
  assert.ok(
    !h.segments[0].includes('给我说'),
    `关抢救应丢弃打断前语音（实际 "${h.segments[0]}"）——逃生口失效`,
  )
  await h.engine.stop()
})

await t('detect 响应劣化（RTT 800ms 压力档）不切句首（锚请求体起点，非 sentAt/响应到达）', async () => {
  setDetectDelay(800)
  try {
    let playing = true
    const h = makeEngine({ wakeWord: '', isPlaying: () => playing, bargeInSalvage: true })
    await h.engine.start()
    await say(ECHO_AMP, 800)
    await sleep(400) // 相位偏移：让 CMD 在 detect 请求在途时开始（生产常见相位）
    await say(CMD_AMP, 1000)
    await sleep(900) // detect 轮询 + 800ms 劣化 RTT
    playing = false
    await h.engine.discardSegment()
    await say(SPEECH_AMP, 600)
    await say(SIL_AMP, 2500)
    assert.equal(h.segments.length, 1, `应产出 1 条定稿（实际 ${h.segments.length} 条）`)
    // 判别式：剥前导 AI 尾音字后，前 3 字内必含命令首字「给」——句首不被切。若锚点退化为
    // sentAt-250（计划字面口径），RTT 劣化 cadence 下 sentAt 滞后语音起点多达一个窗长，
    // 首块「给」被切，前 3 字变「我说一」→ 红（本断言是锚点策略的区分度保证）。
    const head = h.segments[0].replace(/^[我明白了]+/, '').slice(0, 3)
    assert.ok(
      head.includes('给'),
      `RTT 延迟下句首不得被切（前 3 字 "${head}"，全段 "${h.segments[0]}"）——onset 误锚 sentAt/响应到达会切掉句首`,
    )
    await h.engine.stop()
  } finally {
    setDetectDelay(0)
  }
})

await t('reset 延迟档（host 清场慢 1s）下 absorb 不错位（无重复字符）', async () => {
  setResetDelay(1000)
  try {
    let playing = true
    const h = makeEngine({ wakeWord: '', isPlaying: () => playing, bargeInSalvage: true })
    await h.engine.start()
    await say(ECHO_AMP, 800)
    await say(CMD_AMP, 1000)
    await sleep(300)
    playing = false
    await h.engine.discardSegment() // reset=1 响应被延迟 1s（台架 dial）
    await say(SPEECH_AMP, 600)
    await say(SIL_AMP, 2500)
    assert.equal(h.segments.length, 1, `应产出 1 条定稿（实际 ${h.segments.length} 条）`)
    assert.ok(h.segments[0].includes('给我说'), `reset 延迟下抢救仍应生效（实际 "${h.segments[0]}"）`)
    assert.equal(
      countOccur(h.segments[0], '给我说'),
      1,
      `抢救内容不得重复上行（实际 "${h.segments[0]}"）——seed 与 host 清场次序错乱会重复`,
    )
    await h.engine.stop()
  } finally {
    setResetDelay(0)
  }
})

await t('salvage 段纯 backchannel（「嗯」）→ engine 侧弃段，不作为消息发出', async () => {
  let playing = true
  const h = makeEngine({ wakeWord: '', isPlaying: () => playing, bargeInSalvage: true })
  await h.engine.start()
  await say(ECHO_AMP, 800) // AI 朗读
  await say(SIL_AMP, 600) // 句间安静（种子锚点=请求体起点-250ms 落在这里——不拖 AI 尾音）
  await say(BC_AMP, 200) // 用户打断只说了「嗯」（backchannel 频段；≤2 个「嗯」必在词表内）
  await sleep(300)
  playing = false
  await h.engine.discardSegment() // 抢救「嗯」
  await say(SIL_AMP, 2500) // 静音 → 定稿（守卫失效则会发出「嗯嗯」）
  assert.deepEqual(
    h.segments,
    [],
    `纯 backchannel 抢救段不得作为消息发出（实际 ${JSON.stringify(h.segments)}）——修打断吃句不能顺带制造幽灵消息`,
  )
  await h.engine.stop()
})

await t('salvage 标记不泄漏：抢救段后立刻按住说话，hold 段内容必须正常发出（防误抑制）', async () => {
  let playing = true
  const h = makeEngine({ wakeWord: '', isPlaying: () => playing, bargeInSalvage: true })
  await h.engine.start()
  await say(ECHO_AMP, 800)
  await say(SIL_AMP, 600)
  await say(BC_AMP, 200) // 打断只说了「嗯」→ salvage 段（salvagedSegment=true）
  await sleep(300)
  playing = false
  await h.engine.discardSegment() // 抢救段已 seed（尚未定稿）
  // 用户紧接着按住 mic 说「嗯嗯」再松手——hold 段是全新段，不得继承 salvage 标记
  h.engine.beginHeld()
  await say(BC_AMP, 400)
  h.engine.endHeld()
  await sleep(500)
  assert.equal(
    h.segments.length,
    1,
    `hold 段内容必须正常发出（实际 ${h.segments.length} 条：${JSON.stringify(h.segments)}）——salvagedSegment 标记泄漏会把 hold 段的「嗯」误抑制`,
  )
  await h.engine.stop()
})

await t('跨播放窗：AI 播完→用户口述→AI 再开播→打断，抢救必须仍生效（环跨窗不错位）', async () => {
  let playing = true
  const h = makeEngine({ wakeWord: '', isPlaying: () => playing, bargeInSalvage: true })
  await h.engine.start()
  await say(ECHO_AMP, 800) // AI 回合 1 朗读
  playing = false // 回合 1 播完（环残留旧帧、原点冻结——B1 事故现场）
  await say(CMD_AMP, 1000) // 用户口述追问（非播放期，走正常识别路径）
  await say(SIL_AMP, 2500) // 静音断句 → 定稿发出
  h.segments.length = 0 // 只关心打断段
  playing = true // AI 回合 2 开播（上升沿：环应被清空重整，否则 seek 跨窗错位）
  await say(ECHO_AMP, 600)
  await say(CMD_AMP, 1000) // 用户在回合 2 播放期打断
  await sleep(300)
  playing = false
  await h.engine.discardSegment()
  await say(SPEECH_AMP, 600) // 打断后把话说完
  await say(SIL_AMP, 2500)
  assert.equal(h.segments.length, 1, `应产出 1 条打断定稿（实际 ${h.segments.length} 条：${JSON.stringify(h.segments)}）`)
  assert.ok(
    h.segments[0].includes('给我'),
    `跨窗抢救必须生效（实际 "${h.segments[0]}"）——环跨窗不错位（B1 修复锁定；未修则 seek 落空静默回退丢句）`,
  )
  await h.engine.stop()
})

await t('wake 启用 + reset 慢（> silenceMs）：打断后静默，抢救段不得被 clearWakeSegment 抹掉', async () => {
  setResetDelay(3000) // host 清场往返 3s > silenceMs 1500ms（I1 事故窗口）
  try {
    let playing = true
    const h = makeEngine({ wakeWord: WAKE, isPlaying: () => playing, bargeInSalvage: true })
    await h.engine.start() // wake 待机态
    await say(ECHO_AMP, 800)
    await say(SIL_AMP, 600)
    await say(CMD_AMP, 600) // 播放期打断（打断=engaged，不要求唤醒词）
    await sleep(300)
    playing = false
    // 不 await——音频线程不等 host 清场（生产语义：mic 在 reset 往返期间持续收音）。
    // 未修则 reset 窗口内 state 仍 'wake'，下面的静音帧会走 wake 分支抹掉抢救段。
    const discardP = h.engine.discardSegment()
    await say(SIL_AMP, 2500) // 打断后持续静默（reset 窗口内到达）
    await discardP
    assert.equal(
      h.segments.length,
      1,
      `抢救段不得在 reset 窗口被 clearWakeSegment 抹掉（实际 ${h.segments.length} 条：${JSON.stringify(h.segments)}）——I1 修复锁定`,
    )
    assert.ok(h.segments[0].includes('给'), `抢救段应含打断前的话（实际 "${h.segments[0]}"）`)
    await h.engine.stop()
  } finally {
    setResetDelay(0)
  }
})

// ---------------------------------------------------------------- Issue #15 R15-5：抢救种子感知回声门拒绝
console.log('Issue #15 R15-5：抢救种子必须感知回声门拒绝（被拒检测不得成为锚点）')
await t('被门控拒绝的检测 → 随后真打断：抢救段不得含被拒检测窗口的音频（不得夹带整环 AI 音频）', async () => {
  // 假客户端：复刻 client.tsx:2479-2530 的 onIsSpeech 分支——连续 confirmFrames 次 true
  // 才判打断，且**先过回声门控**（engine.aboveEchoFloor）：门控否决 = 放弃本次检测。
  const CONFIRM_FRAMES = 2 // 与 INT_CONFIRM_FRAMES[1]（interruptLevel 默认档）一致
  const BUZZ_AMP = 0.08 // 弱语音：VAD 判真（命令频段），但残差远低于回声地板 6dB → 门控否决
  const LOUD_AMP = 0.7 // 洪亮语音：残差盖过回声地板 6dB → 门控放行 → 真打断
  let playing = true
  let engine = null
  let trueCount = 0
  let falseRun = 0
  const gateClient = (speech) => {
    if (speech === true) {
      falseRun = 0
      trueCount++
      if (trueCount >= CONFIRM_FRAMES) {
        if (!engine.aboveEchoFloor(6)) {
          trueCount = 0 // 门控否决：放弃本次检测（计数归零）
          return
        }
        trueCount = 0
        playing = false // hardBreak：AI 停播
        void engine.discardSegment() // hardBreak 的引擎侧等价（抢救在此发生）
      }
    } else {
      falseRun++
      if (falseRun >= 2) {
        falseRun = 0
        trueCount = Math.max(0, trueCount - 1) // 迟滞衰减（同 client.tsx）
      }
    }
  }
  const h = makeEngine({ wakeWord: '', isPlaying: () => playing, bargeInSalvage: true, onIsSpeech: gateClient })
  engine = h.engine
  await h.engine.start()
  await say(ECHO_AMP, 4000) // AI 朗读（回声地板收敛；纯回声不触发 VAD）
  await say(BUZZ_AMP, 500) // 被门控拒绝的检测（VAD 判真、门控否决）
  await say(ECHO_AMP, 1500) // 空档：被拒检测的窗口若成了锚点，这段 AI 音频会被并入用户消息
  await say(LOUD_AMP, 600) // 真打断：门控放行 → hardBreak → 抢救
  await say(SIL_AMP, 2500) // 停口 → 定稿
  assert.equal(h.segments.length, 1, `应产出 1 条定稿（实际 ${h.segments.length} 条：${JSON.stringify(h.segments)}）`)
  const text = h.segments[0]
  assert.ok(text.includes(LOUD_CHAR), `抢救段应含真打断时说的话（实际 "${text}"）——抢救未生效`)
  // 判别式：被拒检测那次的语音（命令频段 → 「给」字）不得出现在定稿里。修复前该次检测
  // 锁定的种子成为锚点 → 种子被 Math.max 钳到环起点 → 整环 2s AI 音频并入用户消息。
  assert.ok(
    !text.includes('给'),
    `抢救段不得含被门控拒绝那次检测的窗口音频（实际 "${text}"）——R15-5：被拒检测的种子成了锚点 → 整环 AI 音频并入用户消息`,
  )
  await h.engine.stop()
})

// ---------------------------------------------------------------- Issue #15 R15-5：抢救种子的「客户端显式作废」旁路
console.log('Issue #15 R15-5：客户端放弃检测时须显式作废抢救种子（未达确认门槛的孤立判真）')
await t('未达确认门槛的孤立判真（客户端放弃）→ 随后真打断：抢救段不得含被放弃检测的音频', async () => {
  // 假客户端：复刻 client.tsx 的 onIsSpeech 分支，但确认门槛**故意抬到 5 拍**——
  // 本用例的被放弃检测不得达到门槛，否则它会走「门控否决」路径（引擎在门控询问点
  // 自动作废种子），掩盖本用例要验的「客户端显式作废」旁路。
  // 客户端侧接线（待主会话转派 client.tsx）：确认计数**归零**（迟滞衰减耗尽本次检测
  // 的证据）时调用 engine.invalidateSalvageSeed()。
  const CONFIRM_FRAMES = 5
  const BUZZ_AMP = 0.08 // 孤立判真（命令频段 → 「给」字）：只落在 1~2 个检测窗，从未达门槛
  const LOUD_AMP = 0.7 // 洪亮语音：盖过回声地板 6dB → 门控放行 → 真打断
  let playing = true
  let engine = null
  let trueCount = 0
  let falseRun = 0
  const client = (speech) => {
    if (speech === true) {
      falseRun = 0
      trueCount++
      if (trueCount >= CONFIRM_FRAMES) {
        if (!engine.aboveEchoFloor(6)) {
          trueCount = 0 // 门控否决
          return
        }
        trueCount = 0
        playing = false // hardBreak：AI 停播
        void engine.discardSegment() // hardBreak 的引擎侧等价（抢救在此发生）
      }
    } else {
      falseRun++
      if (falseRun >= 2) {
        falseRun = 0
        trueCount = Math.max(0, trueCount - 1) // 迟滞衰减（同 client.tsx）
        if (trueCount === 0) {
          // 确认计数归零 = 本次检测的证据耗尽 → 客户端放弃该检测 → 引擎作废抢救种子
          engine.invalidateSalvageSeed()
        }
      }
    }
  }
  const h = makeEngine({ wakeWord: '', isPlaying: () => playing, bargeInSalvage: true, onIsSpeech: client })
  engine = h.engine
  await h.engine.start()
  await say(ECHO_AMP, 3000) // AI 朗读（回声地板收敛；纯回声不触发 VAD）
  await say(BUZZ_AMP, 250) // 孤立判真：VAD 判真，但从没达到确认门槛 → 客户端放弃（计数归零）
  await say(ECHO_AMP, 1500) // 空档：被放弃检测的窗口若成了锚点，这段 AI 音频会被并入用户消息
  await say(LOUD_AMP, 1200) // 真打断：门控放行 → hardBreak → 抢救
  await say(SIL_AMP, 2500) // 停口 → 定稿
  assert.equal(h.segments.length, 1, `应产出 1 条定稿（实际 ${h.segments.length} 条：${JSON.stringify(h.segments)}）`)
  const text = h.segments[0]
  assert.ok(text.includes(LOUD_CHAR), `抢救段应含真打断时说的话（实际 "${text}"）——抢救未生效`)
  // 判别式：被放弃检测那次的语音（命令频段 → 「给」字）不得出现在定稿里。
  assert.ok(
    !text.includes('给'),
    `抢救段不得含被客户端放弃那次检测的窗口音频（实际 "${text}"）——R15-5：未达门槛的孤立判真留下陈旧种子 → 整环 AI 音频并入用户消息`,
  )
  await h.engine.stop()
})

// ---------------------------------------------------------------- Issue #15 R15-5（A-3）：门控询问作用域的限定与异常配对
console.log('Issue #15 R15-5（A-3）：门控询问作用域——限定条件 + 异常路径配对')
// 两个用例共用同一台架约定：确认门槛抬到 5 拍（被放弃的判真达不到门槛 → 引擎的「门控
// 询问点」从不触发），且**刻意不接** A-1 的显式作废旁路（否则客户端计数归零会先作废
// 种子，掩盖「本次是否作废种子」这一被测语义）。二者都守的是**引擎 API 契约**：
//   ① AsrEngine.aboveEchoFloor 是公开 API，作用域外被问到（将来新增第二个询问点：
//      诊断面板读数/UI 显示）返回 false 时，不得作废抢救种子；
//   ② 交付 VAD 结果的回调抛异常时，门控询问作用域必须已关闭（异常不得泄漏作用域），
//      否则异常之后的门控否决会静默失效（R15-5 的修复形同虚设）。
const A3_CONFIRM_FRAMES = 5
const A3_BUZZ_AMP = 0.08 // 判真但达不到门槛（命令频段 → 「给」字标记）
const A3_LOUD_AMP = 0.7 // 洪亮语音：盖过回声地板 6dB → 门控放行 → 真打断

/** 假客户端（不接 A-1 显式作废旁路）：连续确认帧数才判打断，门控否决即放弃。 */
const makeA3Client = () => {
  const state = { playing: true, trueCount: 0, falseRun: 0, engine: null }
  const client = (speech) => {
    if (speech === true) {
      state.falseRun = 0
      state.trueCount++
      if (state.trueCount >= A3_CONFIRM_FRAMES) {
        if (!state.engine.aboveEchoFloor(6)) {
          state.trueCount = 0
          return
        }
        state.trueCount = 0
        state.playing = false // hardBreak：AI 停播
        void state.engine.discardSegment() // hardBreak 的引擎侧等价（抢救在此发生）
      }
    } else {
      state.falseRun++
      if (state.falseRun >= 2) {
        state.falseRun = 0
        state.trueCount = Math.max(0, state.trueCount - 1) // 迟滞衰减（同 client.tsx）
      }
    }
  }
  return { state, client }
}

await t('作用域之外的回声门控询问（返回 false）不得作废抢救种子', async () => {
  const { state, client } = makeA3Client()
  const h = makeEngine({ wakeWord: '', isPlaying: () => state.playing, bargeInSalvage: true, onIsSpeech: client })
  state.engine = h.engine
  await h.engine.start()
  await say(ECHO_AMP, 3000) // AI 朗读（回声地板收敛；纯回声不触发 VAD）
  await say(A3_BUZZ_AMP, 250) // 判真 → 抢救种子锁定（达不到门槛 → 门控询问点不触发）
  // 探针：以「外部调用者」身份直接问门控（不在 onIsSpeech 交付作用域内）。这正是将来
  // 第二个询问点（诊断面板读数/UI 显示）的形态——公开 API 被非门控场景问到。
  assert.equal(state.engine.aboveEchoFloor(6), false, '探针前提：此刻门控应判否（残差未高于回声地板）')
  await say(ECHO_AMP, 1500) // 空档
  await say(A3_LOUD_AMP, 1200) // 真打断：门控放行 → hardBreak → 抢救
  await say(SIL_AMP, 2500) // 停口 → 定稿
  assert.equal(h.segments.length, 1, `应产出 1 条定稿（实际 ${h.segments.length} 条：${JSON.stringify(h.segments)}）`)
  const text = h.segments[0]
  assert.ok(text.includes(LOUD_CHAR), `抢救段应含真打断时说的话（实际 "${text}"）——抢救未生效`)
  // 判别式：作用域外的门控询问**不得**作废种子 → 种子仍指向那次判真 → 抢救段仍含该
  // 窗口的语音（「给」字）。删掉 aboveEchoFloor 里的 `&& gateQueryScope` 即抓红。
  assert.ok(
    text.includes('给'),
    `作用域外的门控询问不得作废抢救种子（实际 "${text}"）——将来新增第二个询问点（诊断面板/UI 读数）会误作废种子 → 整环 AI 音频并入用户消息`,
  )
  await h.engine.stop()
})

await t('onIsSpeech 抛异常时门控询问作用域必须已关闭（异常不得泄漏作用域）', async () => {
  let threw = false
  const { state, client } = makeA3Client()
  // 「判假」交付时抛异常（模拟客户端回调出错），之后恢复正常。两个细节决定本用例能否
  // 真正抓红（均由实测定位）：
  //  ① 抛在**判假**上（不是判真）：回调抛异常会中断 detect 处理器的收尾（detectSent
  //     水位未推进）→ 下一次请求重发同一批帧 → 若那次交付判真，会用**同一个请求体起点**
  //     把种子重新锁成完全相同的值 → 探针的作废效果被掩盖（用例失去区分度）。抛在判假
  //     上：后续重发仍判假（不锁种子）→ 作废效果可由抢救锚点观察到。
  //  ② 必须**武装后**才抛：AI 朗读期的每次交付都判假，若无脑抛，异常发生在朗读期
  //     （种子尚未锁定），探针落不到泄漏窗口内，用例恒绿。
  let armed = false
  const throwingClient = (speech) => {
    if (armed && speech === false && !threw) {
      threw = true
      throw new Error('客户端回调异常（台架注入）')
    }
    client(speech)
  }
  const h = makeEngine({ wakeWord: '', isPlaying: () => state.playing, bargeInSalvage: true, onIsSpeech: throwingClient })
  state.engine = h.engine
  await h.engine.start()
  await say(ECHO_AMP, 3000) // AI 朗读（回声地板收敛；纯回声不触发 VAD）
  await say(A3_BUZZ_AMP, 250) // 判真 → 抢救种子锁定（达不到门槛 → 门控询问点不触发）
  armed = true // 武装：此后首个「判假」交付抛异常
  // 逐帧推进到抛异常：探针必须**早于下一次交付**发出（若作用域泄漏，探针恰好落在
  // 泄漏窗口内 → 误作废种子）。每帧至多一次交付（轮询在 handleAudio 内，100ms 节拍）。
  for (let i = 0; i < 8 && !threw; i++) await frame(ECHO_AMP)
  assert.ok(threw, '假客户端应已抛异常——否则本用例无区分度')
  // 探针（作用域外）：此刻残差未高于回声地板 → 门控判否；作用域必须已关闭。
  assert.equal(state.engine.aboveEchoFloor(6), false, '探针前提：此刻门控应判否（残差未高于回声地板）')
  await say(ECHO_AMP, 1500) // 空档
  await say(A3_LOUD_AMP, 1200) // 真打断：门控放行 → hardBreak → 抢救
  await say(SIL_AMP, 2500) // 停口 → 定稿
  assert.equal(h.segments.length, 1, `应产出 1 条定稿（实际 ${h.segments.length} 条：${JSON.stringify(h.segments)}）`)
  const text = h.segments[0]
  assert.ok(text.includes(LOUD_CHAR), `抢救段应含真打断时说的话（实际 "${text}"）——抢救未生效`)
  // 判别式：异常后作用域必须已关闭 → 探针的 false 裁决不得作废种子 → 种子仍指向那次
  // 判真 → 抢救段仍含该窗口的语音（「给」字）。把 deliverIsSpeech 的 try/finally 改成
  // 顺序赋值即抓红（抛异常时作用域泄漏 → 探针落在泄漏窗口内 → 种子被误作废）。
  assert.ok(
    text.includes('给'),
    `onIsSpeech 抛异常时门控询问作用域必须已关闭（实际 "${text}"）——作用域泄漏 → 异常后的门控否决静默失效（R15-5 修复形同虚设）`,
  )
  await h.engine.stop()
})

// ---------------------------------------------------------------- Issue #15 R15-5（Minor B）：wake 待机态连败计数
console.log('Issue #15 R15-5（Minor B）：wake 待机态 partial 连败计数')
await t('待机态 partial 成功即清连败计数：失败/成功交替不得误触「识别通道持续断」', async () => {
  const h = makeEngine({ wakeWord: '香蕉苹果' }) // 不命中唤醒词 → 停在 wake 待机态
  // 失败/成功交替 ×3：修复前待机分支直接 return，绕过「成功即清零」→ 连败计数跨成功
  // 累积到 3 → 误发 partialFail 提示（通道其实活着）。
  armPartialFailPattern([500, 200, 500, 200, 500])
  await h.engine.start()
  await say(SPEECH_AMP, 1200) // 待机段累积（partial 上行需段长 ≥0.4s）
  await say(SIL_AMP, 600)
  await sleep(1200) // 让 partial 轮询走够几拍（失败/成功交替）
  assert.equal(h.state, 'wake', `应仍在 wake 待机态（实际 ${h.state}）——前提不成立则本用例无区分度`)
  assert.ok(
    !h.notices.includes('partialFail'),
    `非连续失败不得误触 partialFail 提示（实际 ${JSON.stringify(h.notices)}）——待机分支绕过了成功清零`,
  )
  await h.engine.stop()
})

rmSync(tmp, { recursive: true, force: true })
console.log(`\nwake-flow：${passed} 项通过`)