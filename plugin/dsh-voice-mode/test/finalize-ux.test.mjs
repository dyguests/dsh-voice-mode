/**
 * Issue #15 批 4a：定稿链路口径与 UX 单测（超时对齐 + 快速/准确模式文案 + 定稿耗时）。
 * 运行：node test/finalize-ux.test.mjs（npm test 串联）。
 *
 * 覆盖（源码锁+词典闭合，本仓 client.tsx 无组件挂载设施的既定模式）：
 *  1) asr.ts 三处 final fetch 超时 25s（对齐 host SenseVoice race 上限 20s——原 10s
 *     必触发一次空转重试，asr-host.ts:591-594）；
 *  2) strings.ts descSenseVoice 快速/准确模式语义化 + recognizingSec 双语占位键；
 *  3) client.tsx VoiceStatusBar 的 transcribingSec wiring（>=2s 才显示耗时）。
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

const asrSrc = read('src/asr.ts')
const clientSrc = read('src/client.tsx')
const stringsSrc = read('src/strings.ts')

t('asr.ts：三处 final fetch 超时为 25s（对齐 host 20s race；无残留 10000）', () => {
  const n25 = (asrSrc.match(/AbortSignal\.timeout\(25000\)/g) ?? []).length
  assert.equal(n25, 3, `应有 3 处 25000（实际 ${n25}）——final 三处尝试全部对齐`)
  assert.ok(!asrSrc.includes('AbortSignal.timeout(10000)'), '仍有 10000 残留——慢定稿会空转重试')
  // detect/reset 的 5000 不动（防挂起锁死，与 final 超时无关）
  assert.ok((asrSrc.match(/AbortSignal\.timeout\(5000\)/g) ?? []).length >= 2, 'detect/reset 的 5000 被误改')
})

t('strings：descSenseVoice 语义化为快速/准确模式（双语）', () => {
  assert.ok(stringsSrc.includes('快速模式'), 'zh 缺快速模式语义')
  assert.ok(stringsSrc.includes('准确模式'), 'zh 缺准确模式语义')
  assert.ok(stringsSrc.includes('fast mode'), 'en 缺 fast mode 语义')
  assert.ok(stringsSrc.includes('accurate mode'), 'en 缺 accurate mode 语义')
})

t('strings：recognizingSec 双语占位键（{sec}）', () => {
  assert.ok(stringsSrc.includes("recognizingSec: '识别中… {sec}s'"), 'zh recognizingSec 缺失或占位不符')
  assert.ok(stringsSrc.includes("recognizingSec: 'Recognizing… {sec}s'"), 'en recognizingSec 缺失或占位不符')
})

t('client：VoiceStatusBar 有 transcribingSec wiring（>=2s 才显示耗时）', () => {
  assert.ok(clientSrc.includes('transcribingSec'), '缺 transcribingSec 状态')
  assert.ok(clientSrc.includes("b.ui.state !== 'transcribing'"), '缺 transcribing 态复位')
  assert.ok(clientSrc.includes('setInterval(() => setTranscribingSec((s) => s + 1), 1000)'), '缺秒级计时')
  const idx = clientSrc.indexOf('transcribingSec >= 2')
  assert.ok(idx >= 0, '缺 >=2s 门控（快定稿会闪烁）')
  assert.ok(clientSrc.includes("t('recognizingSec').replace('{sec}'"), '未用 recognizingSec 占位键')
})

console.log(`\nfinalize-ux：${passed} 项通过`)
