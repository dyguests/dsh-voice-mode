/**
 * B1（Issue #15 审查 Blocker）回归：TtsQueue.setEngine() 必须
 *  1) 不归零 seq——切换后新句 sentenceId 超过已广播水位（= client 拒绝线的来源，
 *     否则引擎热切换后新回复前 N 句被静默丢弃）；
 *  2) 停播孤儿泵——在途合成完成后不得再用旧引擎广播（双轨广播根因）。
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

console.log(`\ntts-queue-engine：${passed} 项通过`)
