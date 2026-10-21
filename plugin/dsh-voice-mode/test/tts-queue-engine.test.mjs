/**
 * B1（Issue #15 审查 Blocker）回归：TtsQueue.setEngine() 必须
 *  1) 不归零 seq——切换后新句 sentenceId 超过已广播水位（= client 拒绝线的来源，
 *     否则引擎热切换后新回复前 N 句被静默丢弃）；
 *  2) 停播孤儿泵——在途合成完成后不得再用旧引擎广播（双轨广播根因）。
 * M7②（R11）：close() 必须取消待触发的退避重启计时器——否则 close 后 pump 仍会跑，
 *   让本地引擎 ensureReady() 重新 fork 合成子进程（热重载泄漏）。
 * 运行：node test/tts-queue-engine.test.mjs（离线，无网络/无 dsh 依赖）。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TtsQueue } from '../src/tts-queue.ts'

const here = fileURLToPath(new URL('.', import.meta.url))

let passed = 0
const t = async (name, fn) => {
  await fn()
  passed++
  console.log('  ✓ ' + name)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等待帧数达到 n（轮询而非固定 sleep，防慢机误判）。 */
const waitFrames = async (frames, n, timeoutMs = 3000) => {
  const t0 = Date.now()
  while (frames.length < n && Date.now() - t0 < timeoutMs) await sleep(5)
  assert.equal(frames.length, n, `等待 ${n} 帧超时（实际 ${frames.length}：${JSON.stringify(frames.map((f) => f.sentenceId))}）`)
}

/**
 * 已广播的最大 sentenceId（-1 = 尚未广播过任何句）。seq 只在成功广播时自增
 * （tts-queue.ts:341），故该水位恒等于 client 拒绝线的上限——新句必须越过它。
 */
const broadcastHi = (frames) => frames.reduce((m, f) => Math.max(m, f.sentenceId), -1)

/**
 * 可控合成引擎桩：gate 为 Promise 时 synthesize 挂起（模拟在途合成），
 * 由测试放行；记录每次调用文本与 close 次数。
 */
const makeEngine = (tag, gate = null) => {
  const e = {
    tag,
    mime: 'audio/wav',
    calls: [],
    closed: 0,
    updateVoice() {},
    async synthesize(text) {
      e.calls.push(text)
      if (gate) await gate
      return Buffer.from(`RIFF-${tag}`)
    },
    async close() {
      e.closed++
    },
  }
  return e
}

await t('setEngine 不归零 seq：切换后新句越过已广播水位', async () => {
  const frames = []
  const q = new TtsQueue({ engine: makeEngine('a') })
  q.subscribe((f) => frames.push(f))
  q.enqueue('s1', '一')
  q.enqueue('s1', '二')
  q.enqueue('s1', '三')
  await waitFrames(frames, 6) // 3 句 × (data + final)
  assert.deepEqual(
    frames.map((f) => f.sentenceId),
    [0, 0, 1, 1, 2, 2],
    '基线：首回合 seq 从 0 起',
  )
  const hi = broadcastHi(frames)
  const next = makeEngine('b')
  q.setEngine(next)
  assert.equal(next.closed, 0, '新引擎不应被关闭')
  q.enqueue('s1', '四')
  q.enqueue('s1', '五')
  await waitFrames(frames, 10)
  assert.deepEqual(
    frames.slice(6).map((f) => f.sentenceId),
    [3, 3, 4, 4],
    '切换引擎后 seq 必须连续递增（归零即前 N 句全部 ≤ client 拒绝线被静默丢弃）',
  )
  assert.ok(broadcastHi(frames) > hi, '已广播水位必须继续抬升')
  assert.deepEqual(next.calls, ['四', '五'], '新句必须走新引擎')
  await q.close()
})

await t('setEngine 停播孤儿泵：在途合成完成后不广播旧引擎帧', async () => {
  const frames = []
  const q = new TtsQueue({ engine: makeEngine('a') })
  q.subscribe((f) => frames.push(f))
  // 先正常播两句，把已广播水位抬到 1（模拟 client 拒绝线 = 1）。
  q.enqueue('s1', '旧一')
  q.enqueue('s1', '旧二')
  await waitFrames(frames, 4)
  const hi = broadcastHi(frames)
  assert.equal(hi, 1, '前置条件：已广播到 sentenceId=1')

  // 切到带 gate 的引擎并入队一句：泵启动后卡在合成中（在途句）。
  let release
  const gate = new Promise((r) => {
    release = r
  })
  const inflightEngine = makeEngine('b', gate)
  q.setEngine(inflightEngine)
  q.enqueue('s1', '在途句')
  await sleep(30)
  assert.equal(inflightEngine.calls.length, 1, '前置条件：新引擎已开始合成在途句')

  // 在途合成未返回时再次切引擎 → 该句必须被作废。
  const finalEngine = makeEngine('c')
  q.setEngine(finalEngine)
  release() // 旧引擎合成完成——其结果必须被丢弃
  await sleep(60)
  assert.equal(frames.length, 4, '孤儿泵不得广播被作废的在途句（双轨广播根因）')
  assert.equal(inflightEngine.closed, 1, 'setEngine 必须关闭被替换的引擎')

  q.enqueue('s1', '新句')
  await waitFrames(frames, 6)
  assert.equal(frames.length, 6, '只应有新引擎一帧 data + 一帧 final')
  assert.ok(frames[4].sentenceId > hi, `新句 seq（${frames[4].sentenceId}）必须越过已广播水位 ${hi}`)
  assert.deepEqual(finalEngine.calls, ['新句'], '新句必须走最终引擎')
  await q.close()
})

await t('setEngine 弃积压：旧队列 pending 不得残留到新引擎', async () => {
  const frames = []
  let release
  const gate = new Promise((r) => {
    release = r
  })
  const old = makeEngine('a', gate)
  const q = new TtsQueue({ engine: old })
  q.subscribe((f) => frames.push(f))
  q.enqueue('s1', '句一') // 占用泵（卡 gate）
  q.enqueue('s1', '句二') // 积压
  q.enqueue('s1', '句三')
  await sleep(30)
  assert.equal(old.calls.length, 1, '前置条件：泵被首句占用，其余积压')
  const next = makeEngine('b')
  q.setEngine(next)
  release()
  await sleep(60)
  assert.equal(frames.length, 0, '旧积压句不得被播出')
  q.enqueue('s1', '新一句')
  await waitFrames(frames, 2)
  assert.deepEqual(next.calls, ['新一句'], '新引擎只应合成切换后入队的句子')
  assert.equal(frames[0].sentenceId, 0, '本队列从未广播过句子，首句 seq=0（水位未回归）')
  await q.close()
})

// ---------------------------------------------------------------------------
// M7②（Issue #15 R11）：close() 必须取消待触发的退避重启计时器。
// 泄漏链：pump 失败退避的 setTimeout 不持句柄 → close() 无从取消 → 计时器触发 pump →
// 若该会话仍有 pending 就调 engine.synthesize → 本地引擎 ensureReady() **重新 fork
// 合成子进程**——插件已卸载、引擎已 close，却留下孤儿子进程（热重载每代泄漏一个）。
// 可达路径说明：while 退出时 pending 已空，故 finally 里 pending>0 只可能来自外层
// catch（try 抛错时仍有积压）——而内层 for 已捕获 synthesize 错误，唯一能逃出去的就是
// onSkip 回调抛错。故本用例用抛错的 onSkip 构造该路径（与 M6 注释所述一致）。
// ---------------------------------------------------------------------------
await t('M7②：close() 取消退避重启计时器，close 后 pump 不得再跑', async () => {
  const calls = []
  const eng = {
    mime: 'audio/wav',
    updateVoice() {},
    async synthesize(text) {
      calls.push(text)
      throw new Error('ETIMEDOUT (stub)')
    },
    async close() {},
  }
  const q = new TtsQueue({
    engine: eng,
    onSkip: () => {
      throw new Error('onSkip boom (stub：模拟宿主回调抛错以触达外层 catch)')
    },
  })
  // 三句：前两句各耗尽 3 次重试后经外层 catch 排上退避 timer，第三句仍在 pending。
  q.enqueue('s1', 'A')
  q.enqueue('s1', 'B')
  q.enqueue('s1', 'C')
  // 轮询到 6 次调用（= 前两句各 3 次）而非固定 sleep，防慢机时序脆弱。
  const t0 = Date.now()
  while (calls.length < 6 && Date.now() - t0 < 15000) await sleep(20)
  assert.equal(calls.length, 6, `前置条件：前两句应各试 3 次（实际 ${calls.length}）`)
  await sleep(200) // 等外层 catch 的 finally 排上退避 timer（1s 后才触发，200ms 内必已排上）
  const before = calls.length
  // R14 Minor-2：不被入口门掩蔽的可观测面。删 backoffTimers 取消后，退避 timer 照常
  // 触发但被 pump 入口判序（closed）拦下——下方 calls 断言仍绿，抓不到「close 后残留
  // ref'd backoff timer 最长 8s 拖事件循环」这个漏后果。故在 close 前后对 ref'd
  // Timeout 计数取增量：close 内同步取消 → 两次采样间的差值只能来自取消动作本身
  // （中间无 macrotask 边界，环境 timer 无从触发/完成）。
  const timersBefore = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  await q.close()
  const timersAfterClose = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  assert.ok(
    timersAfterClose < timersBefore,
    `close 未取消退避 timer：ref'd Timeout 未减少（${timersBefore}→${timersAfterClose}）——泵虽被 closed 闸门拦住（synthesize 断言仍绿），残留 timer 仍拖住事件循环最长 8s`,
  )
  await sleep(2500) // 超过退避 1s——若 timer 未取消，这里会再起一轮 pump 合成第三句
  assert.equal(
    calls.length,
    before,
    `close 后仍有 ${calls.length - before} 次 synthesize——退避 timer 未取消，pump 在 close 后重启引擎（本地引擎会 fork 孤儿子进程）`,
  )
})

// ---------------------------------------------------------------------------
// I-1（Issue #15 R12，Important）：TtsQueue 缺 closed 闸门。
// 泄漏链（热重载常态路径，非异常路径）：close() 后仍有三条路触达 engine.synthesize——
//  1) enqueue 无守卫直接 void this.pump()；
//  2) pump while 在 await synthesize 期间不判 close，放行后继续取下一句；
//  3) finally 的 pending>0 分支走即时重启或新排 backoff timer（close 的 clear 之后再入集）。
// 后果：tts-local 的 close() 已把 child/childInit/ready 全置 null → ensureReady 首行
// `if (ready && child) return ready` 守卫失效 → 完整重走模型校验 + fork 新子进程——
// 插件已卸载却留下孤儿子进程。dispose 路径只 void queue.close() 不 cancel 不 prune，
// 故闸门必须自成闭环。
// 本用例复现 sweep 的场景：在途合成 + close + 放行 gate。
// ---------------------------------------------------------------------------
await t('I-1：close 闸门——在途合成放行后不广播、enqueue 不再起泵、无 synthesize@closed', async () => {
  let release = null
  let closed = false
  const calls = []
  const frames = []
  const eng = {
    mime: 'audio/wav',
    updateVoice() {},
    async synthesize(text) {
      calls.push(`${text}@closed=${closed}`)
      if (text === 'A') await new Promise((r) => { release = r }) // 首句挂在合成中
      return Buffer.from('RIFF')
    },
    async close() { closed = true },
  }
  const q = new TtsQueue({ engine: eng })
  q.subscribe((f) => frames.push(f))
  q.enqueue('s1', 'A') // 泵启动，首句合成在途
  await sleep(50)
  await q.close() // 在途合成期间 close（热重载/dispose 的真实时序）
  release() // 放行 gate：在途 synthesize 在此刻完成
  await sleep(120)
  // 在途那句允许完成（synthesize 已发出、无法取消），但其结果不得广播。
  assert.equal(frames.length, 0, 'close 后仍广播帧——客户端 SSE 已断，广播无接收方')
  assert.deepEqual(calls, ['A@closed=false'], 'close 后不得再有 synthesize 调用')
  // close 后再 enqueue：不得起泵、不得以 closed 状态调 synthesize。
  q.enqueue('s1', 'C')
  await sleep(200)
  assert.deepEqual(calls, ['A@closed=false'], 'close 后 enqueue 又起了泵——会以 closed 状态调 synthesize（本地引擎随之重走模型校验 + fork）')
  assert.equal(frames.length, 0, 'close 后 enqueue 仍产生广播')
  await q.close()
})

// ---------------------------------------------------------------------------
// R13（Issue #15 Important-1）：I-1 的 closed 闸门漏第 6 条路径——pump 内层重试
// sleep 不判 closed。5 处判序全在重试循环之外，for 每轮只判 epoch。
// 链条（真实时序，无需网络故障）：某句 synthesize reject（本地子进程退出被
// child.on('exit') 的 rejectAll 打回，或 Edge ETIMEDOUT）→ 进 400/800ms 重试 sleep
// → close 落进该窗口 → 睡醒 attempt+1 直接 synthesize 已 close 的引擎 →
// tts-local close() 已置空 child/childInit/ready → ensureReady 首行守卫失效 →
// 重走模型校验 + fork 孤儿子进程。
// 另：重试 sleep timer 无句柄、不进 backoffTimers、不被 close 取消——close 瞬间
// 残留 1 个 ref'd Timeout，拖住事件循环 ≤800ms（同型反模式家族第 5 处）。
// I-1/M7② 两个既有行为锁都够不到：前者只构造 synthesize resolve、后者只构造重试
// 耗尽走外层 catch。故本用例专测「重试途中 close」。
// ---------------------------------------------------------------------------
await t('R13：重试 sleep 期间 close → 不再 synthesize、无残留 ref\'d timer', async () => {
  let closed = false
  const calls = []
  const frames = []
  const eng = {
    mime: 'audio/wav',
    updateVoice() {},
    async synthesize(text) {
      calls.push(`${text}@closed=${closed}`)
      throw new Error('ETIMEDOUT (stub)') // 恒失败：制造重试 sleep 窗口
    },
    async close() { closed = true },
  }
  const q = new TtsQueue({ engine: eng })
  q.subscribe((f) => frames.push(f))
  q.enqueue('s1', 'A')
  await sleep(60) // 等第一次 synthesize 已 reject、进入 400ms 重试 sleep
  await q.close() // close 落进重试 sleep 窗口（真实时序：本地子进程退出打回在途合成）
  // close 瞬间采样：重试 sleep timer 必须已被取消（否则残留 ref'd Timeout ≤800ms）。
  const mid = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  await sleep(1400) // 覆盖 400ms + 800ms 两轮睡醒窗口
  assert.deepEqual(
    calls,
    ['A@closed=false'],
    '重试 sleep 期间 close 后仍发起了 synthesize——已 close 的本地引擎会重走模型校验 + fork 孤儿子进程',
  )
  assert.equal(frames.length, 0, 'close 后不得广播')
  assert.equal(mid, 0, `close 瞬间残留 ${mid} 个 ref'd Timeout——重试 sleep timer 未被 close 取消（拖住事件循环 ≤800ms）`)
  await q.close()
})

// ---------------------------------------------------------------------------
// R14（Issue #15 Minor-1）：锁A（重试循环 closed 判序）的**可达窗口**补锁。
// R13 用例的不可达根因：synthesize 恒即时 reject → close 取消重试 timer 后 sleep
// promise 永悬挂 → 泵卡在 await 永远到不了循环顶判序（删判序全套件绿）。
// 真实竞态窗口（源码注释自述）：泵挂在 await synthesize 时 close 落进来 → 在途合成被
// engine.close() 的 kill→rejectAll 打回 → catch 在 close 的 clear **之后**才跑。
// fix-host 的修复形态（retrySleep closed 早返）+ 循环顶判序（锁A）共同封死该窗口：
//   ① 无 post-close synthesize（删锁A :423 即红——第二句会被合成）；
//   ② close 后无新 retry timer 入集（删 retrySleep 早返即红——会建一个 ≤800ms
//      ref'd Timeout，违背 close() 自述的「clear 之后不得再有新 timer 入集」）。
// 两条断言各抓各的判序，互为补充。
// ---------------------------------------------------------------------------
await t("R14：close 落在在途 synthesize（被 reject）→ 无 post-close synthesize、无新 retry timer", async () => {
  let closed = false
  let rejectInflight = null
  const calls = []
  const eng = {
    mime: 'audio/wav',
    updateVoice() {},
    async synthesize(text) {
      calls.push(`${text}@closed=${closed}`)
      // 在途挂起：直到 close 将其打回（真实时序：child.on('exit') 的 rejectAll）
      return new Promise((_res, rej) => {
        rejectInflight = () => rej(new Error('engine closed (stub rejectAll)'))
      })
    },
    async close() {
      closed = true
      rejectInflight?.() // 在途合成被打回 → pump 的 catch 在 close 的 clear 之后才跑
    },
  }
  const q = new TtsQueue({ engine: eng })
  q.enqueue('s1', 'A') // 第一句：制造在途 synthesize
  q.enqueue('s1', 'B') // 第二句：留在 pending——删锁A 时它会被 post-close 合成
  await sleep(60) // 等 A 的 synthesize 已挂起
  assert.deepEqual(calls, ['A@closed=false'], '前置条件：A 应在途（未 resolve/reject）')
  const timersBefore = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  await q.close() // close 期间在途合成被 reject → catch → retrySleep（修复后早返不建 timer）→ 循环顶判序 break
  const timersAfterClose = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  assert.equal(
    timersAfterClose,
    timersBefore,
    `close 后新入了 ${timersAfterClose - timersBefore} 个 ref'd retry timer——retrySleep 的 closed 早返失效（残留 ≤800ms 拖事件循环，违背 close 的「clear 之后不得入集」不变式）`,
  )
  await sleep(1400) // 覆盖 400/800ms 两轮睡醒窗口（修复后无 timer；删锁A 时 B 会在此合成）
  assert.deepEqual(
    calls,
    ['A@closed=false'],
    'close 后在途合成被打回后仍发起了 synthesize——重试循环 closed 判序（锁A）失效，post-close synthesize 会让已 close 的本地引擎重走模型校验 + fork 孤儿子进程',
  )
  await q.close()
})

// Minor-8（Issue #15 R13，纵深防御）：公开方法 prepare/synthesize 的 closed 判序。
// 现实调用方（设置面板）在插件卸载后不可达，非现实缺陷；补早返使公开面自成闭环。
await t('Minor-8：close 后 prepare 早返、synthesize reject（不触达已 close 的引擎）', async () => {
  const eng = {
    mime: 'audio/wav',
    updateVoice() {},
    prepareCalls: 0,
    synthCalls: 0,
    async synthesize() { eng.synthCalls++; return Buffer.from('RIFF') },
    async prepare() { eng.prepareCalls++ },
    async close() {},
  }
  const q = new TtsQueue({ engine: eng })
  await q.prepare()
  assert.equal(eng.prepareCalls, 1, '前置条件：close 前 prepare 应生效')
  await q.close()
  await q.prepare() // 不得再触达引擎
  assert.equal(eng.prepareCalls, 1, 'close 后 prepare 仍触达引擎——会走 ensureReady 重走模型校验 + fork')
  let rejected = false
  try {
    await q.synthesize('x')
  } catch (e) {
    rejected = e instanceof Error && /closed/.test(e.message)
  }
  assert.ok(rejected, 'close 后 synthesize 未 reject——会触达已 close 的引擎')
  assert.equal(eng.synthCalls, 0, 'close 后 synthesize 仍调用了引擎')
})

// ---------------------------------------------------------------------------
// R14（Issue #15 Important-1，引擎级 closed 闸门——第 7 道门）：
// TtsQueue 侧 8 处判序全在 `await this.engine.synthesize()` 的调用前/返回后，而 fork
// 发生在 synthesize **内部**——tts-local ensureReady 的 async IIFE 在 await 之后不判
// 任何 close 状态（close() 只置空 child/childInit/ready，首行守卫 `if (ready && child)`
// 失效，IIFE 续跑 `if (!child) fork(...)`）。
// 时序：冷引擎首句合成进入模型校验/下载窗（100-310MB 校验秒级、下载分钟级）→
// queue.close()（=dispose 路径 index.ts void queue.close()）→ engine.close() 返回后
// IIFE 续跑 fork → 孤儿子进程携带完整模型、无人再 close。
// setEngine 路径（void old.close()）与试听 synthesize() 同窗口同型暴露。
//
// 探针 A 竞态（Important-1 的附带实证）：pump 挂在 await synthesize 时 close，在途合成被
// engine.close() 的 kill→rejectAll 打回，catch 在 clear **之后**才跑 → 新建 retrySleep
// timer，违背 tts-queue.ts close() 自述不变式「clear 之后不得再有新 timer 入集」。
// 修法：retrySleep 助手内判 closed 不入集（直接 resolve，让循环顶部判序立即 break）。
//
// 台架：esbuild 真编译 tts-local.ts，桩掉 models（ensureModelFile 可控挂起，制造
// 「冷引擎模型校验窗」）、child_process（fork 可计数，不真起进程）、tts-runtime、emotion。
// ---------------------------------------------------------------------------
console.log('R14：tts-local 引擎级 closed 闸门（post-close fork）+ 探针 A 竞态')

const r14Tmp = join(tmpdir(), 'dsh-vm-r14-fix')
mkdirSync(r14Tmp, { recursive: true })
// 模型桩：默认「第一次 ensureModelFile 挂起」（= R14 用例的模型校验窗），后续立即 true
// （spec.files 有多项）。arm('tree') 切换到 Kokoro 的 espeak-ng-data 整树窗——R15 用例需要
// 独立控制「哪一次 ensure 挂起」，否则 Kokoro 分支永远等不到窗口（vits 不进该分支）。
writeFileSync(join(r14Tmp, 'models-stub.mjs'), `
let mode = 'file'
let n = 0
let rel = null
let entered = 0
globalThis.__r14m = {
  arm: (m) => { mode = m; n = 0; rel = null; entered = 0 },
  entered: () => entered,
  release: () => rel?.(true),
}
export async function ensureModelFile() { if (mode === 'file' && n++ === 0) { entered++; return new Promise((res) => { rel = res }) } return true }
export async function ensureModelTree() { if (mode === 'tree') { entered++; return new Promise((res) => { rel = res }) } return true }
`)
// 子进程桩：fork 可计数（泄漏的直接可观测量）。IPC 做成最小可用回路：
//   · send({type:'init'})  → 挂起不答（模拟 worker 加载模型的同步 CPU 阶段），由测试手动放行；
//   · send({type:'close'}) → 立即应答（否则 close() 会挂在无应答的 await 上，测不到后续断言）；
//   · kill()               → 只记账不派发 exit（真实 SIGTERM→exit 是异步的，会打回在途
//                            init 请求；桩里去掉该噪声，让「init 窗口内 close」可精确构造）。
//   · emitExit(i)          → 补发第 i 个子进程的 exit（M4 身份校验用例需要制造迟到的旧事件）。
writeFileSync(join(r14Tmp, 'cp-stub.mjs'), `
globalThis.__r14forks = 0
globalThis.__r14killed = []
globalThis.__r14kids = []
const parkedInit = []
export function fork() {
  const handlers = {}
  const kid = {
    id: globalThis.__r14kids.length + 1,
    on(ev, fn) { if (fn) handlers[ev] = fn },
    stderr: { on() {} },
    kill() { globalThis.__r14killed.push(kid.id) },
    send(msg) {
      if (msg.type === 'init') { parkedInit.push({ kid, id: msg.id }); return }
      if (msg.type === 'close') setTimeout(() => kid.fire('message', { id: msg.id, ok: true }), 0)
    },
    fire(ev, payload) { handlers[ev]?.(payload) },
  }
  globalThis.__r14forks++
  globalThis.__r14kids.push(kid)
  return kid
}
globalThis.__r14c = {
  initParked: () => parkedInit.length,
  releaseInit: (payload = { ok: true }) => {
    for (const p of parkedInit.splice(0)) p.kid.fire('message', { id: p.id, ...payload })
  },
  emitExit: (i, code = 0) => globalThis.__r14kids[i - 1].fire('exit', code),
  reset() { globalThis.__r14kids.length = 0; globalThis.__r14killed.length = 0; globalThis.__r14forks = 0; parkedInit.length = 0 },
}
`)
writeFileSync(join(r14Tmp, 'tts-runtime-stub.mjs'), `
export class NativeRuntimeUnavailableError extends Error {}
export function resolveNativeRuntime() { return { env: process.env } }
`)
writeFileSync(join(r14Tmp, 'emotion-stub.mjs'), `
export function parseEmotionTags(t) { return t ? [{ text: t, whisper: false }] : [] }
`)
writeFileSync(join(r14Tmp, 'tts-vits-worker.cjs'), '// 桩占位（fork 被桩掉，不会真加载）\n')
const r14Bundle = join(r14Tmp, 'tts-local.bundle.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'tts-local.ts')],
  outfile: r14Bundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  plugins: [
    { name: 'stub-models', setup(b) { b.onResolve({ filter: /models\.ts$/ }, () => ({ path: join(r14Tmp, 'models-stub.mjs') })) } },
    { name: 'stub-rt', setup(b) { b.onResolve({ filter: /tts-runtime\.ts$/ }, () => ({ path: join(r14Tmp, 'tts-runtime-stub.mjs') })) } },
    { name: 'stub-emotion', setup(b) { b.onResolve({ filter: /emotion\.ts$/ }, () => ({ path: join(r14Tmp, 'emotion-stub.mjs') })) } },
    { name: 'stub-cp', setup(b) { b.onResolve({ filter: /child_process$/ }, () => ({ path: join(r14Tmp, 'cp-stub.mjs') })) } },
  ],
  logLevel: 'silent',
})
const { createSherpaVitsEngine, createSherpaKokoroEngine } = await import(pathToFileURL(r14Bundle).href)

await t('R14：冷引擎模型校验窗内 close → 放行后不得 fork（无 post-close 孤儿子进程）', async () => {
  const eng = createSherpaVitsEngine({ kind: 'vits', cacheDir: r14Tmp, modelHost: () => '', allowCustomHost: false, broadcast: () => {} })
  let rejected = ''
  const p = eng.synthesize('第一句').then(
    () => {},
    (e) => { rejected = e instanceof Error ? e.message : String(e) },
  )
  await sleep(300) // 进入 ensureReady → 挂在模型校验窗（forks 仍为 0）
  assert.equal(globalThis.__r14forks, 0, '前置条件：模型校验窗内尚未 fork')
  await eng.close() // queue.close() 的真实路径：child 原为 null，只置空标志
  assert.equal(globalThis.__r14forks, 0, '前置条件：close 返回时不应有 fork')
  globalThis.__r14m.release() // 放行模型校验 → IIFE 续跑（修复前会走到 fork）
  await sleep(400)
  // 不无条件 await p：无 closed 判序时 synthesize 会越过 ensureReady 继续 call() 到桩
  // child（send 无响应）而永不 settle——那正是泄漏路径的一部分。故用 race 限时，
  // 并**先断言 forks**（泄漏的直接可观测量），再判 reject。
  await Promise.race([p, sleep(300)])
  assert.equal(
    globalThis.__r14forks,
    0,
    'post-close fork：模型校验窗内 close 后 IIFE 仍续跑到 fork——孤儿子进程携带完整模型、无人再 close（热重载每代泄漏一个）',
  )
  assert.ok(/closed/.test(rejected), `close 后 synthesize 应 reject（实际: ${JSON.stringify(rejected)}）`)
})

// ---------------------------------------------------------------------------
// R15（Issue #15 Important-1，第 8 道门）：ensureReady IIFE 的 await 点逐点普查。
// 既有 R14 锁只够到 ensureModelFile 那一条：它用的是 vits 引擎，根本不进 kokoro 分支，
// 而 ensureModelTree（Kokoro 补 espeak-ng-data 整树约 355 个语音表，秒级到分钟级）是
// **排在 fork 之前的最后一段等待**，此处曾无 closed 判序 → close 落进该窗口后 IIFE 仍
// 续跑到 fork → 携完整模型（int8 109MB / fp32 311MB）的孤儿子进程，无人再 close。
// 台架复用上段 bundle：arm('tree') 把 ensureModelTree 变成可手动放行的等待窗。
// ---------------------------------------------------------------------------
console.log('R15 I-1：ensureModelTree 等待窗的 closed 判序（第 8 道门）')

await t('R15 I-1：Kokoro espeak-ng-data 整树窗内 close → 放行后不得 fork', async () => {
  globalThis.__r14c.reset()
  globalThis.__r14m.arm('tree')
  const eng = createSherpaKokoroEngine({ cacheDir: r14Tmp, modelHost: () => '', allowCustomHost: false, broadcast: () => {} })
  let rejected = ''
  const p = eng.synthesize('第一句').then(
    () => {},
    (e) => { rejected = e instanceof Error ? e.message : String(e) },
  )
  // 轮询进入整树窗（不靠固定 sleep，防慢机误判）：entered 是「确实挂住了」的反证量。
  const t0 = Date.now()
  while (globalThis.__r14m.entered() === 0 && Date.now() - t0 < 3000) await sleep(10)
  assert.equal(globalThis.__r14m.entered(), 1, '前置条件：应挂在 ensureModelTree 整树窗内')
  assert.equal(globalThis.__r14forks, 0, '前置条件：整树窗内尚未 fork')
  await eng.close() // queue.close() 的真实路径：child 原为 null，只置空标志
  assert.equal(globalThis.__r14forks, 0, '前置条件：close 返回时不应有 fork')
  globalThis.__r14m.release() // 放行整树补全 → IIFE 续跑（修复前会走到 fork）
  await Promise.race([p, sleep(400)])
  assert.equal(
    globalThis.__r14forks,
    0,
    'post-close fork：整树补全窗内 close 后 IIFE 仍续跑到 fork——孤儿子进程携带完整模型、无人再 close（Kokoro 首次使用即可能命中，热重载每代泄漏一个）',
  )
  assert.ok(/closed/.test(rejected), `close 后 synthesize 应 reject（实际: ${JSON.stringify(rejected)}）`)
  globalThis.__r14m.arm('file') // 还原默认档（后续用例若复用同一桩）
})

await t('R15 I-1：init 等待窗内 close → 不置 childInit、不广播 tts-ready（await 点普查第 2 条）', async () => {
  globalThis.__r14c.reset()
  globalThis.__r14m.arm('off') // 文件/整树都立即通过：把窗口精确挪到 call({type:'init'})
  const events = []
  const eng = createSherpaKokoroEngine({
    cacheDir: r14Tmp,
    modelHost: () => '',
    allowCustomHost: false,
    broadcast: (ev) => events.push(ev),
  })
  let rejected = ''
  const p = eng.synthesize('第一句').then(
    () => {},
    (e) => { rejected = e instanceof Error ? e.message : String(e) },
  )
  const t0 = Date.now()
  while (globalThis.__r14c.initParked() === 0 && Date.now() - t0 < 3000) await sleep(10)
  assert.equal(globalThis.__r14forks, 1, '前置条件：已进入 init 等待窗（fork 已发生）')
  assert.equal(globalThis.__r14c.initParked(), 1, '前置条件：init 请求已发出且未应答')
  await eng.close() // close 最早期置位 → 清 child/childInit/ready → kill
  globalThis.__r14c.releaseInit() // 放行 init 应答（桩 child 不派发 exit，避免打回在途请求）
  await Promise.race([p, sleep(300)])
  assert.ok(/closed/.test(rejected), `close 后 synthesize 应 reject（实际: ${JSON.stringify(rejected)}）`)
  // 无判序时：init 放行 → childInit 被重新置位（status().ready 对已 close 的引擎报就绪）
  // 且 tts-ready 被打到已无人接收的 SSE。
  assert.equal(
    eng.status().ready,
    false,
    'close 落进 init 等待窗后仍报 ready——childInit 被陈旧置位（status() 对已 close 的引擎谎报就绪）',
  )
  assert.equal(
    events.filter((e) => e === 'tts-ready').length,
    0,
    'close 落进 init 等待窗后仍广播 tts-ready——信号打到已无人接收的 SSE',
  )
  globalThis.__r14m.arm('file')
})

// M4：exit/error 回调无条件写闭包变量 `child`。respawnChild（interrupt 路径）置空 child
// 后若已 fork 出新子进程，旧子进程迟到的 exit 会把新子进程的引用清空 → 下次再 fork →
// 新子进程成为携完整模型、无人再 close 的孤儿（与 I-1 同一条泄漏链的另一入口）。
await t('R15 M4：旧子进程迟到的 exit 不得清空新子进程的引用（否则多余 fork 出孤儿）', async () => {
  globalThis.__r14c.reset()
  globalThis.__r14m.arm('off')
  const eng = createSherpaKokoroEngine({ cacheDir: r14Tmp, modelHost: () => '', allowCustomHost: false, broadcast: () => {} })
  // 合成请求在桩 child 里永不回包（send 忽略 synth），故一律 catch 掉，防止未处理拒绝。
  const synth = (txt) => { void eng.synthesize(txt).catch(() => {}) }
  const waitFor = async (pred, what) => {
    const t0 = Date.now()
    while (!pred() && Date.now() - t0 < 3000) await sleep(10)
    assert.ok(pred(), `前置条件：应${what}`)
  }
  synth('第一句')
  await waitFor(() => globalThis.__r14c.initParked() === 1, 'fork 出 1 号子进程并挂起 init')
  globalThis.__r14c.releaseInit() // 1 号 init 完成 → 引擎就绪
  await waitFor(() => eng.status().ready === true, '1 号子进程完成 init')

  eng.interrupt() // = respawnChild：kill 1 号、child 置空、ready/childInit 置空
  assert.deepEqual(globalThis.__r14killed, [1], '前置条件：interrupt 应杀掉 1 号子进程')
  synth('第二句')
  await waitFor(() => globalThis.__r14forks === 2, 'fork 出 2 号子进程')
  globalThis.__r14c.releaseInit()
  await waitFor(() => eng.status().ready === true, '2 号子进程完成 init')

  // 1 号子进程的 exit 迟到（真实 SIGTERM→exit 异步，落进新子进程已在役的窗口）。
  globalThis.__r14c.emitExit(1)
  await sleep(50)
  synth('第三句')
  await sleep(100)
  assert.equal(
    globalThis.__r14forks,
    2,
    `多余 fork 到 ${globalThis.__r14forks} 个：旧子进程迟到的 exit 清空了新子进程的引用——它将成为携完整模型、无人再 close 的孤儿`,
  )
  await eng.close()
  globalThis.__r14m.arm('file')
})

await t('R14 探针 A：在途合成被 close 打回后，catch 不得再建 retrySleep timer', async () => {
  // 复刻真实时序：pump 挂在 await synthesize → close → engine.close() 的 kill→rejectAll
  // 打回在途合成 → catch 在 close 的 clear **之后**才跑。
  let rejectSynth = null
  const eng = {
    mime: 'audio/wav',
    updateVoice() {},
    async synthesize(text) {
      if (text === 'A') await new Promise((_r, rej) => { rejectSynth = rej })
      return Buffer.from('RIFF')
    },
    async close() { rejectSynth?.(new Error('tts child exited (rejectAll)')) },
  }
  const q = new TtsQueue({ engine: eng })
  q.enqueue('s1', 'A')
  await sleep(60) // pump 进入 await synthesize
  // 增量断言：本文件前段用例可能留下其它 timer 句柄，绝对值会误红。
  const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  await q.close() // clear 发生；engine.close() 打回在途合成 → catch 在 clear 之后跑
  const mid = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  await sleep(1200) // 覆盖 400ms + 800ms 两轮睡醒窗口
  assert.equal(mid, before, `close 后新增 ${mid - before} 个 ref'd Timeout——catch 在 clear 之后又建了 retrySleep timer（违背 close() 自述不变式）`)
})

await t('PR #16 once：队列排空才 onIdle（每批一次）；isIdle 反映在途/积压', async () => {
  let release
  const gate = new Promise((r) => (release = r))
  const idles = []
  const q = new TtsQueue({ engine: makeEngine('a', gate), onIdle: (sid) => idles.push(sid) })
  const frames = []
  q.subscribe((f) => frames.push(f))
  assert.equal(q.isIdle('s1'), true, '从未入队的会话应视为空闲')
  q.enqueue('s1', '一')
  q.enqueue('s1', '二')
  assert.equal(q.isIdle('s1'), false, '有在途合成时不应空闲')
  release()
  await waitFrames(frames, 4)
  const t0 = Date.now()
  while (idles.length === 0 && Date.now() - t0 < 2000) await sleep(5)
  assert.deepEqual(idles, ['s1'], '两句播完只应 onIdle 一次')
  assert.equal(q.isIdle('s1'), true)
  await q.close()
})

// ---------------------------------------------------------------------------
// R15（Issue #15 Important-2）：tts-idle 在「回合之间的空档」也发 → mode:once 提前退出。
//
// 链路（逐行核对 8c0368a）：host 在**每一条** llm/stream 的 finally 都把 turn 打回
// listening（index.ts:1875，于是一条流结束 = 回合结束）；而 onIdle 原义「队列排空一次即发」。
// 带工具调用的 agent 在第一轮流结束与第二轮开始之间有秒级到分钟级的空档：第一段排空 →
// tts-idle → 客户端 ttsDrained=true → 播完 playing=false → mic-gesture.onceFinished 成立
// → 维持 ONCE_SETTLE_MS=1.2s 后 exitMode('manual') → /toggle off → queue.cancel；第二轮
// llm/stream 因 activeVoiceSession 已空不再被 tap（index.ts:957）→ 后半段回复永不朗读。
//
// 本用例把客户端 once 判定状态机（client.tsx checkOnce + mic-gesture.onceFinished）一并
// 建模：onIdle 真接到 ttsDrained 上，故「队列排空 → once 判定」这条因果链是被真实走过的，
// 而非只断言队列内部计数。
// ---------------------------------------------------------------------------
console.log('R15 I-2：tts-idle 的回合闸门（回合间空档不得发）')

const { onceFinished } = await import('../src/mic-gesture.ts')

await t('R15 I-2：回合未确认结束时空档排空不发 tts-idle；noteTurnEnd 后才发', async () => {
  // 客户端 once 模式判定状态的最小模型。
  const ui = { turn: 'agent-speaking', ttsDrained: false, playing: false }
  const o = { sawRun: false }
  const idles = []
  const q = new TtsQueue({
    engine: makeEngine('a'),
    onIdle: (sid) => {
      idles.push(sid)
      if (!ui.ttsDrained) ui.ttsDrained = true // 镜像 client.tsx:1189-1190
    },
    awaitTurnEnd: true,
  })
  const frames = []
  q.subscribe((f) => frames.push(f))
  // 镜像 client.tsx:2260-2266 checkOnce 的判定（不模拟 1.2s 计时器本身，只判条件是否成立）。
  const onceReady = () => {
    const running = ui.turn === 'agent-speaking'
    if (running) o.sawRun = true
    return onceFinished(o, running, ui.ttsDrained, ui.playing)
  }

  // —— 第 1 轮（工具调用前）：一段文本 ——
  q.enqueue('s1', '第一段。')
  await waitFrames(frames, 2)
  assert.equal(onceReady(), false, '前置条件：正在作答，onceFinished 不应成立')
  ui.playing = false // 客户端播完
  ui.turn = 'listening' // host：每条 llm/stream 的 finally 都把 turn 打回 listening
  await sleep(80) // 等 pump finally 跑完（此刻队列已排空）
  assert.deepEqual(
    idles,
    [],
    '回合仍在进行（工具未返回）时排空就发 tts-idle —— 那是轮次间空档，不是朗读结束',
  )
  assert.equal(
    onceReady(),
    false,
    '回合间空档里 onceFinished 成立 —— mode:once 会在 1.2s 后 exitMode，第二轮回复永不朗读（v0.7.27 头号特性在工具型 agent 上失效）',
  )

  // —— 第 2 轮（工具返回后）：又一段文本 ——
  ui.turn = 'agent-speaking'
  ui.playing = true
  q.enqueue('s1', '第二段。')
  await waitFrames(frames, 4)
  ui.playing = false
  ui.turn = 'listening'
  await sleep(80)
  assert.deepEqual(idles, [], '第二轮排空同样不得发（回合仍未确认结束）')
  assert.equal(onceReady(), false)

  // —— 回合真正结束：host 在 agent/turn-stopping 调 noteTurnEnd ——
  q.noteTurnEnd('s1')
  assert.deepEqual(idles, ['s1'], '回合确认结束、队列已排空 → 必须补发一次 tts-idle')
  assert.equal(onceReady(), true, '回合结束 + 队列排空后 onceFinished 才成立')

  // —— 第 2 个回合：验证 enqueue 会重新打开闸门，且每回合至多发一次 ——
  ui.turn = 'agent-speaking'
  ui.ttsDrained = false
  q.enqueue('s1', '第三段。')
  await waitFrames(frames, 6)
  ui.turn = 'listening'
  await sleep(80)
  assert.deepEqual(idles, ['s1'], '新一轮排空又只是候选空闲——enqueue 未重新打开回合闸门')
  q.noteTurnEnd('s1')
  assert.deepEqual(idles, ['s1', 's1'], '第二个回合结束应再发一次（不能因上一回合已发过而漏发）')
  await q.close()
})

await t('R15 I-2：noteTurnEnd 落在在途合成上不抢发；close 后不再发；闸门缺省关闭=旧语义', async () => {
  const idles = []
  let release
  const gate = new Promise((r) => {
    release = r
  })
  const q = new TtsQueue({ engine: makeEngine('a', gate), onIdle: (sid) => idles.push(sid), awaitTurnEnd: true })
  const frames = []
  q.subscribe((f) => frames.push(f))
  q.enqueue('s1', '一')
  const t0 = Date.now()
  while (q.isIdle('s1') && Date.now() - t0 < 2000) await sleep(5)
  assert.equal(q.isIdle('s1'), false, '前置条件：合成在途')
  q.noteTurnEnd('s1')
  assert.deepEqual(idles, [], '仍有在途合成时抢发 tts-idle —— 客户端会误判朗读已结束')
  release()
  await waitFrames(frames, 2)
  const t1 = Date.now()
  while (idles.length === 0 && Date.now() - t1 < 2000) await sleep(5)
  assert.deepEqual(idles, ['s1'], '排空时由 pump finally 补发一次（不得两次）')
  await q.close()
  q.noteTurnEnd('s1')
  assert.deepEqual(idles, ['s1'], 'close 后 noteTurnEnd 仍在对外发信号')

  // 闸门缺省关闭（awaitTurnEnd 未传）：保持「排空即发」的旧语义，未接回合结束钩子的宿主
  // 零行为变化——既有 PR #16 用例亦覆盖 onIdle 本身，此处锁住 noteTurnEnd 自身不越权发信号。
  const legacyIdles = []
  const legacy = new TtsQueue({ engine: makeEngine('b'), onIdle: (sid) => legacyIdles.push(sid) })
  const legacyFrames = []
  legacy.subscribe((f) => legacyFrames.push(f))
  legacy.enqueue('s2', '甲')
  await waitFrames(legacyFrames, 2)
  const t2 = Date.now()
  while (legacyIdles.length === 0 && Date.now() - t2 < 2000) await sleep(5)
  assert.deepEqual(legacyIdles, ['s2'], '闸门缺省关闭时排空仍应发 tts-idle（旧语义不得被本改动破坏）')
  legacy.noteTurnEnd('s2')
  assert.deepEqual(legacyIdles, ['s2'], '闸门缺省关闭时 noteTurnEnd 不得额外发信号')
  await legacy.close()
})

console.log(`\ntts-queue-engine：${passed} 项通过`)
