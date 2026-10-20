/**
 * PR #16 移植：麦克风按钮纯判定逻辑（快捷键撞车 / 进出节流 / once 收尾）。
 * 运行：node test/mic-gesture.test.mjs（npm test 串联）
 */
import assert from 'node:assert/strict'
import { isEditingShortcut, onceFinished, takeToggleSlot } from '../src/mic-gesture.ts'

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

console.log(`\nmic-gesture：${passed} 项通过`)
