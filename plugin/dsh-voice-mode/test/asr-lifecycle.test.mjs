/**
 * Issue #15 R3 OQ1 行为测试：startRecorder 世代守卫与 worklet catch 回退路径。
 * 运行：node test/asr-lifecycle.test.mjs（npm test 串联）
 *
 * 背景（src 已落定但无任何测试驱动这些异步窗口）：
 *  I2 复检链：getUserMedia 返回后 / resume 后 / addModule 后三处复检
 *     （stopRequested || mySeq !== startSeq）——stop() 落入启动异步窗口时被吞会导致
 *     麦道常开 + 幽灵上行；addModule **reject** 会跳过 await 后的复检，故 catch 内
 *     补同一复检（Important-3 R2）后才回退 ScriptProcessor。
 *  Important-3（R2）：worklet 节点先存局部、connect 成功后才赋模块级——catch 只断
 *     **本启动创建**的节点。旧实现断模块级 workletNode：A 的 addModule 慢失败期间
 *     B 已完整启动 → A 的 catch 断掉 B 的节点 → B 永久聋。
 *  观察项 3（批 8）：stop() 收尾跨新 start() 完成时不踩新会话状态（myStopSeq 锁）。
 *
 * 实现策略（wake-flow 同款最小台架）：假浏览器（AudioContext/AudioWorkletNode/
 * getUserMedia 均可编程——addModule 逐调用挂起/放行/拒绝、connect 可定点抛错、
 * stream tracks 与 ctx.close 带 spy、节点 disconnect 带 spy）+ 可控假时钟，
 * esbuild 真编译 src/asr.ts 驱动真引擎。不变量：只读 src/，不改任何源码。
 *
 * 覆盖：
 *  ① A 的 addModule 迟到失败（stop→start 已发生）→ 新会话状态不被踩 idle（mySeq 锁）；
 *  ② 同序列 → catch 不断 B 的 workletNode（spy：B 节点 disconnect=0）且 B 仍在收音；
 *  ③ 同序列 → A 不走 ScriptProcessor 回退置 active=true（createScriptProcessor=0）；
 *  ④ 对照（证明 ③ 非恒真）：无抢占时 addModule 失败 → 走 ScriptProcessor 回退，
 *     处理器建成、帧经 onaudioprocess 正常上行（回退路径本身是活的）。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-lifecycle-'))

// ---------------------------------------------------------------- 可控时钟
let NOW = 2_000_000
Date.now = () => NOW
globalThis.performance = { now: () => NOW }

// ---------------------------------------------------------------- 浏览器 API mock（可编程）
const SR = 16000
const FRAME = 1024 // 64ms

const spies = {
  streams: [], // { id, stops }
  ctxs: [], // { id, closes }
  nodes: [], // { id, disconnects }
  processorCreates: 0,
  processors: [], // { onaudioprocess }
}
let streamSeq = 0
let ctxSeq = 0
let nodeSeq = 0

/** addModule 逐调用控制队列：start 挂起，测试按索引 resolve/reject。 */
const addModuleQueue = []
/** connect 抛错调度：第 N 个节点的 connect 抛错（0 基，undefined=不抛）。 */
let connectThrowAt = undefined

function makeStream() {
  const id = ++streamSeq
  const rec = { id, stops: 0 }
  spies.streams.push(rec)
  const track = {
    getSettings: () => ({ echoCancellation: true }),
    stop: () => {
      rec.stops++
    },
  }
  return { id, getAudioTracks: () => [track], getTracks: () => [track] }
}

class FakeAudioWorkletNode {
  constructor(ctx) {
    this.id = ++nodeSeq
    this.disconnects = 0 // spy：节点自带计数器（断开次数）
    spies.nodes.push(this)
    this.port = { onmessage: null }
  }
  connect() {
    if (connectThrowAt !== undefined && this.id === connectThrowAt) {
      throw new Error('connect boom (programmable)')
    }
  }
  disconnect() {
    this.disconnects++
  }
}

class FakeAudioContext {
  constructor() {
    const rec = { id: ++ctxSeq, closes: 0 }
    spies.ctxs.push(rec)
    this._rec = rec
    this.sampleRate = SR
    this.destination = {}
    this.audioWorklet = {
      addModule: async () => {
        const d = deferred()
        addModuleQueue.push(d)
        return d.promise
      },
    }
  }
  createMediaStreamSource() {
    return { connect() {} }
  }
  createScriptProcessor() {
    spies.processorCreates++
    const p = { onaudioprocess: null, connect() {}, disconnect() {} }
    spies.processors.push(p)
    return p
  }
  async resume() {}
  async close() {
    this._rec.closes++
  }
}
const deferred = () => {
  let resolveFn
  let rejectFn
  const promise = new Promise((res, rej) => {
    resolveFn = res
    rejectFn = rej
  })
  return { promise, resolve: resolveFn, reject: rejectFn }
}

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.location = { origin: 'http://127.0.0.1:3018' }
globalThis.AudioContext = FakeAudioContext
globalThis.window = { AudioContext: FakeAudioContext }
Object.defineProperty(globalThis, 'navigator', {
  value: {
    mediaDevices: {
      getUserMedia: async () => {
        if (gumHangNext) {
          gumHangNext = false
          const d = deferred()
          gumQueue.push(d)
          return d.promise
        }
        return makeStream()
      },
    },
  },
  configurable: true,
  writable: true,
})
/** getUserMedia 挂起队列（myStartSeq 用例制造「A 启动途中 B 已启动」窗口）。 */
const gumQueue = []
let gumHangNext = false
globalThis.AudioWorkletNode = FakeAudioWorkletNode

// ---------------------------------------------------------------- 假 host（partial 计数）
const host = { partials: 0, resets: 0 }
globalThis.fetch = async (url) => {
  const u = new URL(String(url))
  const p = u.searchParams
  if (p.get('reset') === '1') {
    host.resets++
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  if (p.get('vadOnly') === '1') return new Response(JSON.stringify({ isSpeech: false }), { status: 200 })
  if (p.get('final') === '1') return new Response(JSON.stringify({ text: '' }), { status: 200 })
  host.partials++
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
/** 推 n 个 microtask/宏任务节拍，让引擎异步链走到目标挂起点。 */
const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await tick()
}

function makeEngine() {
  return createAsrEngine(
    {
      silenceMs: 1500,
      basePath: '/voice-mode',
      mode: 'toggle',
      bargeInMode: 'auto',
      wakeWord: '', // 无唤醒词 → listening
      isPlaying: () => false,
    },
    'sess-lifecycle',
  )
}

/** 经某节点的 port 推语音帧（假时钟 64ms/帧），触发 partial 上行。 */
async function speakVia(node, frames = 8) {
  for (let i = 0; i < frames; i++) {
    NOW += (FRAME / SR) * 1000
    node.port.onmessage({ data: new Float32Array(FRAME).fill(0.1) })
    await tick()
  }
}

function resetSpies() {
  spies.streams.length = 0
  spies.ctxs.length = 0
  spies.nodes.length = 0
  spies.processorCreates = 0
  spies.processors.length = 0
  addModuleQueue.length = 0
  gumQueue.length = 0
  gumHangNext = false
  connectThrowAt = undefined
  host.partials = 0
}

let passed = 0
const t = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

/**
 * 标准序列：A 启动（addModule #0 挂起）→ stop → B 启动（addModule #1 挂起）→
 * 放行 B（B 完整启动：active=true + workletNode=B 节点）→ A 的 addModule #0 拒绝
 * （迟到失败，catch 复检 mySeq!==startSeq → abandonStart）。
 * 返回 { eng, pA, pB, streamA, ctxA, nodeB }。
 */
async function runLateFailureSequence() {
  resetSpies()
  const eng = makeEngine()
  const pA = eng.start()
  await settle() // A 走到 addModule #0 挂起
  assert.equal(addModuleQueue.length, 1, 'A 应已挂到 addModule #0')
  await eng.stop() // stopRequested + startSeq++（A 的 mySeq 落后）
  const pB = eng.start()
  await settle() // B 走到 addModule #1 挂起
  assert.equal(addModuleQueue.length, 2, 'B 应已挂到 addModule #1')
  addModuleQueue[1].resolve() // 放行 B
  await settle()
  await pB // B 完整启动
  assert.equal(eng.state, 'listening', 'B 启动后应 listening（前置条件）')
  // A 迟到失败
  addModuleQueue[0].reject(new Error('worklet boom (late)'))
  await settle()
  await pA
  await settle()
  const streamA = spies.streams[0]
  const ctxA = spies.ctxs[0]
  const nodeB = spies.nodes[0] // A 未建节点（addModule 拒绝先于建节点）→ 唯一节点是 B 的
  assert.equal(spies.nodes.length, 1, '序列中应只有 B 建过一个节点')
  return { eng, streamA, ctxA, nodeB }
}

// ---------------------------------------------------------------- ① 新会话状态不被踩 idle
console.log('① mySeq 锁：A 迟到失败不把新会话踩 idle')

await t('myStopSeq 锁：stop（active 中）收尾窗内同步发生 start → 新会话不被踩 idle', async () => {
  // 锁点：stop() 末尾 `if (startSeq === myStopSeq) setState('idle')`（观察项 3，批 8）。
  // 时序要点：eng.stop() 后**不 await 直接** eng.start()——B 的同步段（setState('listening')
  // + startSeq++）先于 A 收尾续体（微任务）跑，守卫才可观测（中间插 await 会让 A 收尾
  // 先跑完，守卫恒真）。
  resetSpies()
  const eng = makeEngine()
  const pA = eng.start()
  await settle()
  addModuleQueue[0].resolve() // A 完整启动（active=true）
  await settle()
  await pA
  assert.equal(eng.state, 'listening', 'A 启动后应 listening（前置条件）')
  const pStop = eng.stop() // 同步段（stopRequested/startSeq++/active=false）后停在 stopRecorder 的 await
  const pB = eng.start() // 同步段立即跑：setState('listening') + startSeq++（守卫可见的世代差）
  await settle()
  // 队列是「每次 addModule 调用入队、不摘除」：#0=A 的已消费项，#1=B 的在途项
  assert.equal(addModuleQueue.length, 2, 'B 应已挂到 addModule（队列：#0=A 已消费、#1=B 在途）')
  addModuleQueue[addModuleQueue.length - 1].resolve() // 放行 B（#1）
  await settle()
  await pB
  await pStop // A 的收尾续体（myStopSeq 守卫在此发挥作用）
  await settle()
  assert.equal(eng.state, 'listening', 'A 的旧收尾把新会话状态踩成 idle 了（myStopSeq 守卫失效）')
  const before = host.partials
  await speakVia(spies.nodes[0])
  assert.ok(host.partials > before, 'B 应仍在收音')
  await eng.stop()
})

await t('myStartSeq 锁：startRecorder 抛错（getUserMedia reject）时新启动已发生 → 不踩 idle', async () => {
  // 锁点：start() 的 `if (startSeq === myStartSeq) setState('idle')`（Important-2 R2）——
  // startRecorder 抛错时若期间已发生过新启动（stop→start 快速重进），不得把新会话的
  // 'listening' 踩成 'idle'（状态条误显退出但新会话在收音）。驱动点选 getUserMedia
  // reject（startRecorder 最早的抛错点，无内层复检遮挡，确定性可达外层 catch）。
  resetSpies()
  const eng = makeEngine()
  gumHangNext = true
  // 立即挂 catch：start() 的 catch 落守卫后会重抛，pA 会在 settle 的微任务检查点
  // reject——若那时还没挂 handler，Node 直接以未处理 rejection 杀进程。
  let lateStartErr = null
  const pA = eng.start().catch((e) => {
    lateStartErr = e
  }) // A：getUserMedia #0 挂起
  await settle()
  assert.equal(gumQueue.length, 1, 'A 应已挂在 getUserMedia #0')
  const pB = eng.start() // B：同步段 setState('listening') + startSeq++（先于 A 的 reject 微任务）
  await settle()
  addModuleQueue[addModuleQueue.length - 1].resolve() // 放行 B 的 addModule
  await settle()
  await pB
  assert.equal(eng.state, 'listening', 'B 启动后应 listening（前置条件）')
  gumQueue[0].reject(new Error('mic denied (late)')) // A 的 getUserMedia 迟到失败
  await settle()
  await pA
  assert.ok(lateStartErr, 'A 的启动应失败（start() catch 落守卫后重抛——生产语义）')
  await settle()
  assert.equal(eng.state, 'listening', 'A 的迟到抛错把新会话状态踩成 idle 了（myStartSeq 守卫失效）')
  const before = host.partials
  await speakVia(spies.nodes[0])
  assert.ok(host.partials > before, 'B 应仍在收音')
  await eng.stop()
})

// ---------------------------------------------------------------- ② catch 不断 B 的节点
console.log('② catch 只断本启动节点：B 的 workletNode 不被 disconnect 且仍在收音')

await t('A 迟到失败 → B 节点 disconnect=0 + B 仍收音（partial 上行）', async () => {
  const { eng, nodeB } = await runLateFailureSequence()
  assert.equal(eng.state, 'listening', 'A 迟到失败后新会话状态应保持 listening')
  assert.equal(nodeB.disconnects, 0, 'A 的 catch 断了 B 的节点（Important-3 R2 回归：B 永久聋）')
  const before = host.partials
  await speakVia(nodeB) // 经 B 的节点推语音帧
  assert.ok(host.partials > before, `B 应仍在收音（partial 未上行，before=${before} after=${host.partials}）`)
  await eng.stop()
})

// ---------------------------------------------------------------- ③ 不走 ScriptProcessor 回退
console.log('③ catch 复检：抢占后 A 不走 ScriptProcessor 回退')

await t('A 迟到失败 → createScriptProcessor=0（不置 active=true 的幽灵回退）', async () => {
  const { eng } = await runLateFailureSequence()
  assert.equal(eng.state, 'listening', 'A 迟到失败后新会话状态应保持 listening')
  assert.equal(spies.processorCreates, 0, '抢占后 A 走了 ScriptProcessor 回退（catch 复检缺失 → 幽灵 active）')
  await eng.stop()
})

// ---------------------------------------------------------------- ④ 对照：无抢占时回退路径是活的
console.log('④ 对照：无抢占时 addModule 失败 → ScriptProcessor 回退生效（证明 ③ 非恒真）')

await t('无抢占 addModule 失败 → 建 ScriptProcessor + 帧经 onaudioprocess 上行', async () => {
  resetSpies()
  const eng = makeEngine()
  const p = eng.start()
  await settle()
  assert.equal(addModuleQueue.length, 1, '应挂到 addModule #0')
  addModuleQueue[0].reject(new Error('worklet unsupported')) // 无抢占的诚实失败
  await settle()
  await p
  await settle()
  assert.equal(spies.processorCreates, 1, '无抢占时应走 ScriptProcessor 回退（跨浏览器兜底）')
  assert.equal(eng.state, 'listening')
  // 帧经 processor.onaudioprocess 上行
  const before = host.partials
  const proc = spies.processors[0]
  for (let i = 0; i < 8; i++) {
    NOW += (FRAME / SR) * 1000
    proc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(FRAME).fill(0.1) } })
    await tick()
  }
  assert.ok(host.partials > before, `回退处理器应正常收音（before=${before} after=${host.partials}）`)
  await eng.stop()
})

rmSync(tmp, { recursive: true, force: true })
console.log(`\nasr-lifecycle：${passed} 项通过`)
process.exit(0)
