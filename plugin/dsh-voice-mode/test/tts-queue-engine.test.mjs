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
// 只让第一次 ensureModelFile 挂起（制造模型校验窗），后续立即 true（spec.files 有多项）
writeFileSync(join(r14Tmp, 'models-stub.mjs'), `
let n = 0
let rel = null
globalThis.__r14m = { release: () => rel?.(true) }
export async function ensureModelFile() { if (n++ === 0) return new Promise((res) => { rel = res }); return true }
export async function ensureModelTree() { return true }
`)
writeFileSync(join(r14Tmp, 'cp-stub.mjs'), `
globalThis.__r14forks = 0
export function fork() { globalThis.__r14forks++; return { on: () => {}, send: () => {}, kill: () => {}, stderr: { on: () => {} } } }
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
const { createSherpaVitsEngine } = await import(pathToFileURL(r14Bundle).href)

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

console.log(`\ntts-queue-engine：${passed} 项通过`)
