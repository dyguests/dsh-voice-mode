/**
 * PR #16 移植：麦克风按钮纯判定逻辑（快捷键撞车 / 进出节流 / once 收尾 / 非主键守卫）。
 * 运行：node test/mic-gesture.test.mjs（npm test 串联）
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isEditingShortcut, isPrimaryPress, onceFinished, takeToggleSlot } from '../src/mic-gesture.ts'

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}
const combo = (s) => {
  const parts = s.toLowerCase().split('+')
  return {
    key: parts.at(-1),
    ctrl: parts.includes('ctrl'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
    meta: parts.includes('meta'),
  }
}

t('Windows/Linux：Ctrl+Shift+V（粘贴纯文本）撞车，输入框里让给浏览器', () => {
  assert.equal(isEditingShortcut(combo('Ctrl+Shift+V'), false), true)
  assert.equal(isEditingShortcut(combo('Ctrl+Z'), false), true)
})
t('macOS：Ctrl+Shift+V 不撞车（编辑键在 Cmd 上），Cmd+Shift+V 撞车', () => {
  assert.equal(isEditingShortcut(combo('Ctrl+Shift+V'), true), false)
  assert.equal(isEditingShortcut(combo('Meta+Shift+V'), true), true)
})
t('非编辑字母 / 带 Alt / 功能键 → 不撞车', () => {
  assert.equal(isEditingShortcut(combo('Ctrl+Shift+M'), false), false)
  assert.equal(isEditingShortcut(combo('Ctrl+Alt+V'), false), false)
  assert.equal(isEditingShortcut(combo('Ctrl+F2'), false), false)
})

t('节流：250ms 内的第二下（双击）被吞', () => {
  const h = []
  assert.equal(takeToggleSlot(h, 1000), true)
  assert.equal(takeToggleSlot(h, 1100), false)
})
t('节流：进了马上退（>250ms）放行；2s 内第三下拒（与 host 限流同口径）', () => {
  const h = []
  assert.equal(takeToggleSlot(h, 0), true)
  assert.equal(takeToggleSlot(h, 400), true)
  assert.equal(takeToggleSlot(h, 900), false)
  assert.equal(takeToggleSlot(h, 2001), true, '窗口滑过后恢复')
})

t('once 收尾：必须跑过回合、已结束、TTS 排空、本地不在播', () => {
  assert.equal(onceFinished({ sawRun: false }, false, true, false), false, '还没开始回合')
  assert.equal(onceFinished({ sawRun: true }, true, true, false), false, '回合进行中')
  assert.equal(onceFinished({ sawRun: true }, false, false, false), false, 'host 队列未排空')
  assert.equal(onceFinished({ sawRun: true }, false, true, true), false, '本地还在播')
  assert.equal(onceFinished({ sawRun: true }, false, true, false), true)
})

// Issue #15 R2 Blocker：右键开快捷设置会误触长按打断。交互层无 DOM 渲染条件（无 jsdom），
// 故按本仓既有做法从 src/client.tsx 读接线 + 用真实模块的判定推演：接线与判定任一被改，
// 本节用例都会转红。
const clientSrc = readFileSync(new URL('../src/client.tsx', import.meta.url), 'utf8')
/** client.tsx 里某个 pointer 事件处理器的源码片段（含签名，不含闭合大括号）。 */
const handlerSrc = (sig) => {
  const start = clientSrc.indexOf(sig)
  assert.notEqual(start, -1, `client.tsx 里找不到 ${sig}`)
  const end = clientSrc.indexOf('\n  }\n', start)
  assert.notEqual(end, -1, `${sig} 的函数体未正常闭合`)
  return clientSrc.slice(start, end)
}
/** onPointerDown 是否会因这个按键的 pointerdown 而 arm 手势（起 250ms 打断计时器 + beginHeld）。 */
const pressArms = (button) => {
  const body = handlerSrc('const onPointerDown = (e: React.PointerEvent): void => {')
  const guard = body.search(/if \(!isPrimaryPress\(e\.button\)\) return/)
  assert.notEqual(guard, -1, 'onPointerDown 缺少非主键守卫：右键会 arm 长按打断')
  assert.ok(guard < body.indexOf('lockSelection'), '守卫必须早于手势状态的写入（lockSelection 之前）')
  return isPrimaryPress(button)
}

t('右键 pointerdown（button=2）：不 arm 长按打断 / 不 beginHeld / 不起 250ms 计时器', () => {
  assert.equal(pressArms(2), false, '右键按下只应交给 onContextMenu，不得 arm 任何手势')
  assert.equal(pressArms(1), false, '中键同样不得 arm')
})
t('左键 pointerdown（button=0）：照常 arm，长按打断不被守卫误伤', () => {
  assert.equal(pressArms(0), true, '主键按住仍走 beginHeld + 250ms 打断计时器')
  assert.equal(pressArms(0), true, '触屏/笔的 pointerdown 同为 0，按住说话手势不受影响')
})
t('onPointerUp 对称拦截：右键抬起不会被误读成手势松手', () => {
  const body = handlerSrc('const onPointerUp = (e: React.PointerEvent): void => {')
  const guard = body.search(/if \(!isPrimaryPress\(e\.button\)\) return/)
  assert.notEqual(guard, -1, 'onPointerUp 必须与非主键抬起对称（鼠标所有按键共用一个 pointerId）')
  assert.ok(guard < body.indexOf('holdPtrRef.current = null'), '守卫必须早于 holdPtrRef / 打断计时器的清理')
})
t('右键菜单仍能开：守卫只落在 pointerdown/up，未波及 onContextMenu', () => {
  assert.ok(clientSrc.includes('onContextMenu={(e) => {'), '按钮仍绑定 onContextMenu')
  assert.ok(
    /onContextMenu=\{\(e\) => \{[\s\S]{0,400}setMenuOpen\(true\)/.test(clientSrc),
    'onContextMenu 仍走 setMenuOpen(true) 开快捷设置',
  )
  assert.equal(
    clientSrc.split('isPrimaryPress(e.button)').length - 1,
    2,
    '守卫只应出现在 onPointerDown / onPointerUp 两处',
  )
})

console.log(`\nmic-gesture：${passed} 项通过`)
