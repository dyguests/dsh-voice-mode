/**
 * 快捷键 UI 与按住说话行为（feat/voice-input-polish）的接线红线。
 * 运行：node test/shortcut-ui.test.mjs
 *
 * 防的是「设置里有、代码没接上」和「源码改了、lib 没重建」两类回归：
 *  1. 快捷键分组：settings-form 有独立 Section + 两个 ShortcutField 行；
 *  2. 词典：录制/说明/标签等新键 zh/en 都存在，且标签不重复；
 *  3. 解析：parseShortcut 接受 Enter/Space/Tab 这类具名键（Alt+Enter 依赖）；
 *  4. 客户端：输入框内快捷键走 capture 监听、设置变更后重拉配置；
 *  5. hold：空闲直接按住、松手后按朗读模式进入 once 收尾或退出、关自动发送时不提交；
 *  6. 宿主：composerShortcut 进 schema / Config / /config 响应；
 *  7. 构建产物与源码同步（lib/client.js、lib/index.js 含同样标记）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const read = (f) => readFileSync(join(root, f), 'utf8')

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}
const has = (hay, needle, label) => assert.ok(hay.includes(needle), `${label}: 缺少 ${needle}`)

const client = read('src/client.tsx')
const form = read('src/settings-form.tsx')
const strings = read('src/strings.ts')
const host = read('src/index.ts')
const libClient = read('lib/client.js')
const libHost = read('lib/index.js')

console.log('快捷键分组与词典')
t('settings-form 有独立快捷键分组与两个录制行', () => {
  has(form, "tr('secShortcut')", 'settings-form')
  has(form, 'function ShortcutField(', 'settings-form')
  has(form, 'field="shortcut"', 'settings-form')
  has(form, 'field="composerShortcut"', 'settings-form')
  has(form, "tr('descComposerShortcut')", 'settings-form')
})
t('录制按钮与提示文案走词典', () => {
  for (const k of ['shortcutRecord', 'shortcutRecording', 'shortcutCancel', 'shortcutNeedModifier', 'shortcutPlaceholder', 'shortcutReset', 'shortcutNote']) {
    has(form, `tr('${k}')`, 'settings-form')
  }
})
t('词典 zh/en 成对提供新键且不是占位', () => {
  for (const k of ['descComposerShortcut', 'composerShortcutLabel', 'shortcutRecord', 'shortcutRecording', 'shortcutCancel', 'shortcutNeedModifier', 'shortcutPlaceholder', 'shortcutReset', 'shortcutNote', 'secShortcut']) {
    assert.ok(strings.includes(`${k}:`), `strings 缺少 ${k}`)
  }
  has(strings, "composerShortcutLabel: '进入 / 退出语音模式（输入框内）'", 'strings')
  has(strings, "composerShortcutLabel: 'Enter / exit voice mode (in composer)'", 'strings')
})
t('应用内和输入框内的行标题不重复', () => {
  has(strings, "shortcutLabel: '进入 / 退出语音模式（应用内）'", 'strings')
  has(strings, "composerShortcutLabel: '进入 / 退出语音模式（输入框内）'", 'strings')
})

console.log('快捷键解析')
t('parseShortcut 支持 Enter / Space / Tab 具名键', () => {
  has(client, "t === 'enter' || t === 'space' || t === 'tab'", 'client')
  has(client, 'key = t', 'client')
})
t('输入框内快捷键走 capture 且只在编辑态生效', () => {
  has(client, 'onComposerKey', 'client')
  has(client, "window.addEventListener('keydown', onComposerKey, true)", 'client')
  has(client, 'isContentEditable', 'client')
  has(client, 'parseShortcut(bootNow().composerShortcut)', 'client')
})
t('设置卡片改完重拉配置（快捷键/交互模式即时生效）', () => {
  has(client, "window.addEventListener('dshvm-settings-changed', onChanged)", 'client')
  has(form, "new Event('dshvm-settings-changed')", 'settings-form')
})

console.log('按住说话')
t('空闲按住直接进入并接管收音', () => {
  has(client, 'pendingHoldRef.current = true', 'client')
  has(client, 'engineRef.current?.beginHeld()', 'client')
})
t('松手按朗读模式收尾：开朗读走 once 等待，关朗读直接退出', () => {
  has(client, "if (bootNow().readAloud === 'off' || bootNow().autoSend === false)", 'client')
  has(client, 'beginOnceWait()', 'client')
  has(client, "void exitModeRef.current('manual')", 'client')
})
t('关自动发送时松手只定稿不提交', () => {
  has(client, "if (bootNow().mode === 'hold' && bootNow().autoSend === false) return", 'client')
})
t('等待/朗读中点击可彻底停止', () => {
  has(client, "bus.stopReading(!!useSession)", 'client')
  has(client, 'onceRef.current', 'client')
})

console.log('宿主与构建产物')
t('composerShortcut 进 schema / Config / /config', () => {
  has(host, "composerShortcut: z.string().default('Alt+Enter')", 'index')
  has(host, 'composerShortcut: vset.composerShortcut', 'index')
  has(host, 'composerShortcut: en.descComposerShortcut', 'index')
})
t('lib 与源码同步', () => {
  has(libClient, 'composerShortcut', 'lib/client.js')
  has(libClient, 'pendingHoldRef', 'lib/client.js')
  has(libHost, 'composerShortcut', 'lib/index.js')
})

console.log('合并复审修正')
t('输入框快捷键：留空即禁用（不回落默认值）、设置卡片内不拦截', () => {
  const i = client.indexOf('const onComposerKey =')
  const win = client.slice(i, i + 900)
  assert.ok(!win.includes("composerShortcut || 'Alt+Enter'"), '留空回落到 Alt+Enter，设置里无法禁用')
  has(win, "closest('[data-dshvm-settings]')", 'onComposerKey')
})
t('hold 长按松手抑制随后的合成 click（播放中按住说话不被 click 停朗读并退出）', () => {
  const i = client.indexOf('const onPointerUp =')
  const body = client.slice(i, client.indexOf('const onPointerCancel =', i))
  const n = body.split('holdReleaseExitRef.current = true').length - 1
  assert.equal(n, 2, '松手置退出标记的两处')
  const m = body.split('suppressClickUntilRef.current = Date.now() + 500').length - 1
  assert.ok(m >= 3, 'toggle 长按 + hold 两处长按松手都须抑制 click')
})
t('hold 松手 + 关自动发送：不进 once 等待（没有回复可等）', () => {
  const i = client.indexOf('if (holdReleaseExitRef.current) {')
  has(client.slice(i, i + 400), "bootNow().autoSend === false", 'onSegment')
})
t('enterMode 失败清掉待决按住状态', () => {
  const i = client.indexOf('// getUserMedia 被拒等：留在 off')
  has(client.slice(i - 80, i + 200), 'pendingHoldRef.current = false', 'enterMode catch')
})

console.log(`shortcut-ui：${passed} 项通过`)
