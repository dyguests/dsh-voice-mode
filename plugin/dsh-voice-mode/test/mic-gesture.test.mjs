/**
 * PR #16 移植：麦克风按钮纯判定逻辑（快捷键撞车 / 进出节流 / once 收尾 / 非主键守卫）。
 * 运行：node test/mic-gesture.test.mjs（npm test 串联）
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createScopeBridge, isEditingShortcut, isPrimaryPress, onceFinished, takeToggleSlot } from '../src/mic-gesture.ts'
import { createHttpScope } from '../src/settings-http-scope.ts'

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}
/** 异步版（设置 scope 的拉取是 promise）。 */
const ta = async (name, fn) => {
  await fn()
  passed++
  console.log('  ✓ ' + name)
}
/** 轮询等待条件成立（比固定 sleep 稳）。 */
const waitFor = async (fn, timeoutMs = 3000) => {
  const t0 = Date.now()
  for (;;) {
    if (fn()) return true
    if (Date.now() - t0 > timeoutMs) return false
    await new Promise((r) => setTimeout(r, 10))
  }
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

// --------------------------------------------------------------------------
// 设置 scope 失效桥：host 对任一标签页、任一路径的显示类设置改动都广播 SSE 'display'
// （载荷 = readAloud / showCaptions / showStatusBar）。设置卡片原先拿不到这条广播
// （EventSource 只在麦克风按钮那侧订阅）→ 别的标签页改了显示类设置，本页设置卡一直
// 显示旧值；本页不切回焦点时也不会触发 scope 自己的「获焦重拉」。
// 这里直接用真实的 createHttpScope + 桥，验证「收到 display → scope 重拉一次」。
// --------------------------------------------------------------------------
await ta('display 事件 → 设置 scope 重拉一次（别的标签页改了显示类设置，本页不再显示旧值）', async () => {
  let fetches = 0
  let payload = { readAloud: 'voice' }
  const fetchImpl = async () => {
    fetches++
    return { ok: true, status: 200, json: async () => ({ value: payload }) }
  }
  const raw = createHttpScope('http://scope.test', fetchImpl)
  const bridge = createScopeBridge(raw)
  const seen = []
  const off = bridge.scope.subscribe(() => seen.push(bridge.scope.getSnapshot().value.readAloud))
  assert.ok(await waitFor(() => fetches === 1 && seen.length === 1), '设置卡挂载时应拉取一次并推给订阅者')
  assert.deepEqual(seen, ['voice'], '首次拉取值应发给订阅者')
  // 别的标签页改了显示类设置 → host 广播 display → 本页 scope 失效重拉
  payload = { readAloud: 'always' }
  bridge.invalidate()
  assert.ok(
    await waitFor(() => fetches === 2 && seen.length === 2),
    `收到 display 事件后设置 scope 未重拉（fetches=${fetches}）`,
  )
  assert.equal(bridge.scope.getSnapshot().value.readAloud, 'always', '重拉后应拿到新值')
  assert.deepEqual(seen, ['voice', 'always'], '重拉后的新值应推给订阅者（设置卡才会更新）')
  off()
})

await ta('桥不破坏「重新挂载必重拉」：退订后再订阅仍会拉一次', async () => {
  let fetches = 0
  const fetchImpl = async () => {
    fetches++
    return { ok: true, status: 200, json: async () => ({ value: { readAloud: 'voice' } }) }
  }
  const raw = createHttpScope('http://scope.test', fetchImpl)
  const bridge = createScopeBridge(raw)
  const off1 = bridge.scope.subscribe(() => {})
  assert.ok(await waitFor(() => fetches === 1 && bridge.scope.getSnapshot().status === 'ready'), '挂载应拉一次')
  off1()
  const off2 = bridge.scope.subscribe(() => {})
  assert.ok(await waitFor(() => fetches === 2), '重新挂载应再拉一次（失败终态由此恢复）')
  off2()
})

await ta('底层自带 invalidate() 时优先用它（不再走退订再订阅）', async () => {
  let invalidated = 0
  const raw = {
    getSnapshot: () => ({ status: 'ready', value: {} }),
    subscribe: () => () => {},
    set: () => {},
    invalidate: () => {
      invalidated++
    },
  }
  const bridge = createScopeBridge(raw)
  const off = bridge.scope.subscribe(() => {})
  bridge.invalidate()
  assert.equal(invalidated, 1, '底层有失效入口时应直接调用它')
  off()
})

t('接线：client.tsx 的 display 事件触发设置 scope 失效重拉', () => {
  const start = clientSrc.indexOf("source.addEventListener('display'")
  assert.notEqual(start, -1, 'client.tsx 里找不到 display 事件监听')
  const body = clientSrc.slice(start, start + 600)
  assert.ok(/settingsScopeInvalidate\?\.\(\)/.test(body), 'display 事件未触发设置 scope 失效——设置卡仍旧值')
  assert.ok(
    /settingsScopeInvalidate = bridge\.invalidate/.test(clientSrc),
    'apply() 未把桥的失效钩子登记给 bus（display 事件无处可叫）',
  )
})

console.log(`\nmic-gesture：${passed} 项通过`)
