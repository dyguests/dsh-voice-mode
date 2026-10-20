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
import { TtsQueue } from '../src/tts-queue.ts'

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
  await q.close()
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

console.log(`\ntts-queue-engine：${passed} 项通过`)
