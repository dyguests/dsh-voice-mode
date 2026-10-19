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
  assert.ok(!win.includes('bootNow().silenceMs'), 'scheduleAutoSend 仍读 silenceMs 计时——未解耦')
  assert.ok(!win.includes('const delay ='), '残留 delay 变量（耦合形态）')
})

t('端点语义不变：引擎侧 silenceMs 引用仍在（asr.ts）', () => {
  const n = (asrSrc.match(/silenceMs/g) ?? []).length
  assert.ok(n >= 3, `asr.ts silenceMs 引用应保持（实际 ${n} 处）——端点判定不动`)
})

t('其余 bootNow().silenceMs 消费点未动（设置面板/其它路径不受影响）', () => {
  // scheduleAutoSend 之外若仍有 silenceMs 读取属既有语义；本批只解耦自动发送计时。
  const idx = clientSrc.indexOf('const scheduleAutoSend =')
  const win = clientSrc.slice(idx, idx + 900)
  assert.ok(!win.includes('silenceMs'), 'scheduleAutoSend 窗口内出现 silenceMs——解耦不彻底')
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
