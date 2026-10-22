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
  has(client, "parseShortcut(bootNow().composerShortcut || 'Alt+Enter')", 'client')
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
  has(client, "if (bootNow().readAloud === 'off')", 'client')
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

console.log(`shortcut-ui：${passed} 项通过`)
