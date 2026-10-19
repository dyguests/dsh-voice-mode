/**
 * Issue #15 批 5：autoSend 附加窗与 silenceMs 解耦单测。
 * 运行：node test/autosend-decouple.test.mjs（npm test 串联）。
 *
 * 背景（用户反馈问题⑦）：用户调低「静音判定时长」（silenceMs）后，自动发送的附加等待
 * 被连带压缩——原实现 scheduleAutoSend 直接用 bootNow().silenceMs 计时，断句后立刻发，
 * 长句在自然停顿处被切成多条。修复：附加窗改固定常量 AUTO_SEND_EXTRA_MS=1200；
 * 端点语义（多快算说完）仍由 silenceMs 独占（asr.ts/asr-host.ts 不动）。
 *
 * 覆盖：
 *  1) 常量值为 1200 且 scheduleAutoSend 的 setTimeout 用它；
 *  2) scheduleAutoSend 不再读 silenceMs 计时（删耦合）；
 *  3) silenceMs 端点语义不变（引擎侧引用仍在）；
 *  4) 反向变异锁：把 setTimeout 计时改回 bootNow().silenceMs → 红。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '..')
const read = (f) => readFileSync(join(root, f), 'utf8')

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

const clientSrc = read('src/client.tsx')
const asrSrc = read('src/asr.ts')

t('常量 AUTO_SEND_EXTRA_MS=1200 存在（模块级，与 ECHO_DELAY_MS 同区）', () => {
  const m = /const AUTO_SEND_EXTRA_MS = (\d+)/.exec(clientSrc)
  assert.ok(m, '缺 AUTO_SEND_EXTRA_MS 常量')
  assert.equal(m[1], '1200', `常量值应为 1200（实际 ${m[1]}）`)
})

t('解耦：scheduleAutoSend 的 setTimeout 用 AUTO_SEND_EXTRA_MS', () => {
  const idx = clientSrc.indexOf('const scheduleAutoSend =')
  assert.ok(idx >= 0, '缺 scheduleAutoSend')
  const win = clientSrc.slice(idx, idx + 900)
  assert.ok(win.includes('}, AUTO_SEND_EXTRA_MS)'), 'setTimeout 未用固定附加窗')
})

t('端点语义不变：asr.ts 端点判定仍比 config.silenceMs（精确形态锁，替代旧 n>=3 计数）', () => {
  // 旧实现 (asrSrc.match(/silenceMs/g) ?? []).length >= 3——实际 21 处，阈值无区分度
  // （删掉端点判定仍远大于 3）。改锁端点判定的精确形态：silenceMs > config.silenceMs。
  assert.ok(/silenceMs > config\.silenceMs/.test(asrSrc), 'asr.ts 端点判定（silenceMs > config.silenceMs）被删/改——端点语义被破坏')
})

t('端点权威在 host VAD：asr-host.ts 的 seg.vad 仍用 silenceMs()/1000（审查 Minor-3 补锁）', () => {
  const hostSrc = read('src/asr-host.ts')
  assert.ok(hostSrc.includes('silenceMs() / 1000'), 'host VAD 端点阈值被改成常量——端点语义被破坏')
  // 检测 VAD（打断）仍与断句解耦（0.5 固定 + detect 短阈值）
  assert.ok(/newVad\(vadPath, 0\.5, silenceMs\(\) \/ 1000\)/.test(hostSrc), 'seg.vad 构造形态被改')
})

t('解耦负向锁：scheduleAutoSend 窗口内无任何 silenceMs / delay 计时耦合', () => {
  // 合并旧三处负向检查（!bootNow().silenceMs / !const delay = / !silenceMs）——
  // !includes('silenceMs') 最强，任意含 silenceMs 的计时形态（旧变量名 or 新写法）都红。
  const idx = clientSrc.indexOf('const scheduleAutoSend =')
  const win = clientSrc.slice(idx, idx + 900)
  assert.ok(!win.includes('silenceMs'), 'scheduleAutoSend 窗口内出现 silenceMs——计时仍与断句阈值耦合')
})

t('门控保持：到点发射仍检查 speech/holding/playing/autoSend', () => {
  const idx = clientSrc.indexOf('const scheduleAutoSend =')
  const win = clientSrc.slice(idx, idx + 900)
  assert.ok(win.includes("eng.state === 'speech'"), '缺「用户仍在说」门')
  assert.ok(win.includes('eng.holding'), '缺 hold 门')
  assert.ok(win.includes('bus.ui.playing'), '缺播放门')
  assert.ok(win.includes("bootNow().autoSend === false"), '缺 autoSend 开关门')
})

console.log(`\nautosend-decouple：${passed} 项通过`)
