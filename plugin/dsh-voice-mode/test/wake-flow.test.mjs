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
const AI_PHRASE = '我明白了'
const WAKE = '你好小李'
const COMMAND = '给我说一百个字'

let capturedNode = null
class FakeAudioWorkletNode {
  constructor() {
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
      if (amp > 0.2) ch = AI_PHRASE[st.aiIdx++ % AI_PHRASE.length]
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
      if (a >= 0.03 && a < 0.2) isSpeech = true
    }
    return new Response(JSON.stringify({ isSpeech }), { status: 200 })
  }
  if (final) {
    hostLog.finals++
    return new Response(JSON.stringify({ text: feed(epoch, offset, raw, true, 500) }), { status: 200 })
  }
  hostLog.partials++
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

function makeEngine({ wakeWord = WAKE, isPlaying = () => false, bargeInSalvage } = {}) {
  streams.clear()
  hostLog.partials = hostLog.resets = hostLog.detects = hostLog.finals = 0
  let state = 'idle'
  const segments = []
  const partials = []
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
    },
    'sess-test',
  )
  engine.onState((s) => {
    state = s
  })
  engine.onSegment((t) => segments.push(t))
  engine.onPartial((t) => partials.push(t))
  return {
    engine,
    segments,
    partials,
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

rmSync(tmp, { recursive: true, force: true })
console.log(`\nwake-flow：${passed} 项通过`)
