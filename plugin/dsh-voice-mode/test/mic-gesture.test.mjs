/**
 * PR #16 移植：麦克风按钮纯判定逻辑（快捷键撞车 / 进出节流 / once 收尾 / 非主键守卫）。
 * 运行：node test/mic-gesture.test.mjs（npm test 串联）
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createScopeBridge, decayConfirmCount, eqPaintMode, handleReplaced, isEditingShortcut, isPrimaryPress, menuFocusIndex, onceFinished, registerScopeDispose, takeToggleSlot } from '../src/mic-gesture.ts'
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
/** 守卫源码行（client.tsx 的 onPointerDown / onPointerUp 共用同一句式）。 */
const GUARD_LINE = 'if (!isPrimaryPress(e.button, { mac: IS_MAC, ctrlKey: e.ctrlKey })) return'
/** onPointerDown 是否会因这次 pointerdown 而 arm 手势（起 250ms 打断计时器 + beginHeld）。
 *  mods 注入平台与修饰键——macOS 的 ctrl+click（辅助点击，button 仍是 0）只有注入得进去。 */
const pressArms = (button, mods = { mac: false, ctrlKey: false }) => {
  const body = handlerSrc('const onPointerDown = (e: React.PointerEvent): void => {')
  const g = body.indexOf(GUARD_LINE)
  assert.notEqual(g, -1, 'onPointerDown 缺少非主键守卫：右键会 arm 长按打断')
  assert.ok(g < body.indexOf('lockSelection'), '守卫必须早于手势状态的写入（lockSelection 之前）')
  return isPrimaryPress(button, mods)
}
/** 截取 client.tsx 里从 startSig 到 endSig（不含 endSig）的源码片段。 */
const srcBetween = (startSig, endSig) => {
  const start = clientSrc.indexOf(startSig)
  assert.notEqual(start, -1, `client.tsx 里找不到 ${startSig}`)
  const end = clientSrc.indexOf(endSig, start)
  assert.notEqual(end, -1, `client.tsx 里找不到 ${endSig}（片段未闭合）`)
  return clientSrc.slice(start, end)
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
  const guard = body.indexOf(GUARD_LINE)
  assert.notEqual(guard, -1, 'onPointerUp 必须与非主键抬起对称（鼠标所有按键共用一个 pointerId）')
  assert.ok(guard < body.indexOf('holdPtrRef.current = null'), '守卫必须早于 holdPtrRef / 打断计时器的清理')
})

// --------------------------------------------------------------------------
// C-4：macOS 主导右键手势（ctrl+click）绕过「只看 button」的守卫。
// 系统「Secondary click」默认关闭时，右键 = ctrl+click，浏览器派发的 pointerdown 是
// button=0 + ctrlKey=true（辅助点击仍属主键）→ 只按 button 判，macOS 上原症状原样存在。
// --------------------------------------------------------------------------
t('macOS 辅助点击（ctrl+click，button 仍是 0）→ 不得 arm 长按打断', () => {
  assert.equal(
    pressArms(0, { mac: true, ctrlKey: true }),
    false,
    'macOS 上 ctrl+click 即右键（Secondary click 关闭时）；按住等菜单弹出 ≥250ms 会误触长按打断、取消正在生成的回复',
  )
})
t('macOS 纯右键（button=2，Secondary click 开启时走这条）→ 不得 arm', () => {
  assert.equal(pressArms(2, { mac: true, ctrlKey: false }), false, 'macOS 真实右键同样不得 arm')
})
t('Windows/Linux 的 ctrl+click 不是右键 → 仍 arm（平台语义不同，不得一刀切）', () => {
  assert.equal(
    pressArms(0, { mac: false, ctrlKey: true }),
    true,
    'Windows/Linux 的 ctrl+click 不触发右键菜单，按住仍是长按打断手势',
  )
})
t('普通左键（无修饰键）→ 仍 arm（长按打断/按住说话不被误伤）', () => {
  assert.equal(pressArms(0, { mac: false, ctrlKey: false }), true, '主键按住仍走 beginHeld + 250ms 计时器')
  assert.equal(pressArms(0, { mac: true, ctrlKey: false }), true, 'macOS 纯左键同样照常 arm')
})
t('接线：client.tsx 的守卫按平台注入（mac 用 IS_MAC、修饰键用 e.ctrlKey）', () => {
  const body = handlerSrc('const onPointerDown = (e: React.PointerEvent): void => {')
  assert.ok(body.includes('{ mac: IS_MAC, ctrlKey: e.ctrlKey }'), '守卫未按平台/修饰键判定——macOS 的 ctrl+click 会绕过')
  assert.equal(clientSrc.split(GUARD_LINE).length - 1, 2, '守卫应恰好出现在 onPointerDown / onPointerUp 两处')
})
t('右键菜单仍能开：守卫只落在 pointerdown/up，未波及 onContextMenu', () => {
  assert.ok(clientSrc.includes('onContextMenu={(e) => {'), '按钮仍绑定 onContextMenu')
  assert.ok(
    /onContextMenu=\{\(e\) => \{[\s\S]{0,400}setMenuOpen\(true\)/.test(clientSrc),
    'onContextMenu 仍走 setMenuOpen(true) 开快捷设置',
  )
  assert.equal(
    clientSrc.split('isPrimaryPress(e.button').length - 1,
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

// --------------------------------------------------------------------------
// C-5：桥的失效若落在一次 GET 的在途窗口内，曾被底层 load() 的 inFlight 去重静默丢弃
// （在途 GET 返回的还是旧值）→ 卡片停在旧值、不再发请求、不自愈。
// 底层已改成「在途时记 pendingReload → 落定后补拉一次」，这里对**真实底层**做端到端
// 断言：桥的失效（0→1 退订再订阅）与底层的补拉任一坏掉，本条都红。
// --------------------------------------------------------------------------
await ta('桥的失效落在一次 GET 在途窗口内 → 最终仍拉到最新值（卡片不自愈的竞态）', async () => {
  let serverValue = 'off'
  let calls = 0
  let release = null
  const fetchImpl = async () => {
    calls++
    const seen = serverValue // 这次请求拿到的快照
    if (calls === 1) {
      // 第一次请求挂起 → 制造「GET 在途」窗口
      await new Promise((r) => {
        release = r
      })
    }
    return { ok: true, status: 200, json: async () => ({ value: { readAloud: seen } }) }
  }
  const raw = createHttpScope('http://scope.test', fetchImpl)
  const bridge = createScopeBridge(raw)
  const seen = []
  bridge.scope.subscribe(() => seen.push(bridge.scope.getSnapshot().value.readAloud))
  // 首次 GET 还在途（release 未调用）→ 此刻改服务器真值并失效，
  // 模拟 host 的 display 广播落在这个在途窗口内。
  serverValue = 'voice'
  bridge.invalidate()
  release()
  const ok = await waitFor(() => seen.includes('voice'))
  assert.ok(ok, `失效被在途 GET 吞掉 → 卡片停在旧值且不自愈（seen=${JSON.stringify(seen)}）`)
})

// --------------------------------------------------------------------------
// C-7：桥的订阅者若按回调去重（Set），同一回调订阅两次时第二个订阅者被静默丢弃——
// 且其中一个退订会把另一个的底层订阅一起撤掉（之后再也收不到通知）。
// --------------------------------------------------------------------------
t('桥：同一回调订阅两次 → 退订其一不误伤另一个，底层仍只保持一份订阅', () => {
  const subs = new Set()
  let subscribeCalls = 0
  let notified = 0
  const raw = {
    getSnapshot: () => ({ status: 'ready', value: {} }),
    subscribe: (fn) => {
      subscribeCalls++
      subs.add(fn)
      return () => {
        subs.delete(fn)
      }
    },
    set: () => {},
  }
  const bridge = createScopeBridge(raw)
  const fn = () => {
    notified++
  }
  const off1 = bridge.scope.subscribe(fn)
  const off2 = bridge.scope.subscribe(fn)
  assert.equal(subscribeCalls, 1, '底层被重复订阅了——按回调去重会二次触发底层的 0→1 重拉')
  off1()
  for (const s of [...subs]) s() // 底层广播一次
  assert.ok(notified > 0, '退订其一后另一个订阅者被连带退订了（通知丢失）')
  off2()
})

// --------------------------------------------------------------------------
// C-1 竖条绘制：少了动态效果是系统级可访问性偏好，用户可能在系统里随时开关。
// 绘制方式抽成纯判定（eqPaintMode），client.tsx 在 matchMedia 的 change 事件里重算。
// --------------------------------------------------------------------------
t('竖条绘制方式：开了「减少动态效果」画满高（static-full），关掉走平滑动画（animated）', () => {
  assert.equal(eqPaintMode(true), 'static-full', '开了偏好应画满高且不跑 rAF')
  assert.equal(eqPaintMode(false), 'animated', '没开偏好应走平滑动画')
})
t('接线：client.tsx 监听 prefers-reduced-motion 的 change，cleanup 里对称解绑', () => {
  const body = srcBetween('const eqKind = visual ===', '}, [eqKind, bus])')
  assert.ok(body.includes('eqPaintMode'), '竖条绘制未走 eqPaintMode 判定')
  assert.ok(
    /addEventListener\('change'/.test(body),
    '未监听 prefers-reduced-motion 的 change——用户开关偏好后竖条不重绘',
  )
  assert.ok(
    /removeEventListener\('change'/.test(body),
    'cleanup 未解绑 change 监听——反复挂载会泄漏监听器',
  )
  assert.ok(/addListener/.test(body), '缺少旧内核（无 addEventListener）的 addListener 兜底')
  assert.ok(/removeListener/.test(body), '缺少旧内核的 removeListener 对称解绑')
})

// --------------------------------------------------------------------------
// C-2 MicMenu 方向键环绕：焦点被外部抢走时（i = -1），ArrowUp 原先落到倒数第二项
// （(-1 + len - 1) % len = len - 2），应落到末项。
// --------------------------------------------------------------------------
t('菜单方向键环绕：正常路径首尾相接', () => {
  assert.equal(menuFocusIndex(0, 5, 1), 1, '首项按 ArrowDown 到第二项')
  assert.equal(menuFocusIndex(4, 5, 1), 0, '末项按 ArrowDown 绕回首项')
  assert.equal(menuFocusIndex(0, 5, -1), 4, '首项按 ArrowUp 绕到末项')
  assert.equal(menuFocusIndex(3, 5, -1), 2, '中间项按 ArrowUp 到前一项')
})
t('菜单方向键环绕：焦点被外部抢走（i=-1）时 ArrowUp 落到末项，不是倒数第二项', () => {
  assert.equal(menuFocusIndex(-1, 5, -1), 4, 'ArrowUp 应落到末项')
  assert.equal(menuFocusIndex(-1, 5, 1), 0, 'ArrowDown 应落到首项')
  assert.equal(menuFocusIndex(-1, 0, 1), -1, '没有菜单项时不得越界')
})
t('接线：MicMenu 的方向键走 menuFocusIndex（旧的内联环绕算式已下线）', () => {
  const body = srcBetween('const onKey = (e: KeyboardEvent): void => {', '\n    }\n')
  assert.ok(body.includes('menuFocusIndex'), 'MicMenu 方向键未走 menuFocusIndex 判定')
  assert.ok(
    !/items\[\(i \+ \(e\.key/.test(body),
    '旧的内联环绕算式仍在——i=-1 时 ArrowUp 会落到倒数第二项',
  )
})

// --------------------------------------------------------------------------
// C-3 SSE 'replaced'：同 tabId 的新连接顶替了本连接。两种来源必须分开，
// 否则两边每 3s 互相顶替、朗读时断时续。客户端侧此前零覆盖。
// --------------------------------------------------------------------------
t("SSE 'replaced'：复制标签页带走同一个 tabId → 换新 id 并重连", () => {
  const calls = []
  handleReplaced({
    staleBus: false,
    renewTabId: () => {
      calls.push('renew')
      return 'tab-new'
    },
    reconnect: (id) => calls.push('reconnect:' + id),
    retire: () => calls.push('retire'),
  })
  assert.deepEqual(calls, ['renew', 'reconnect:tab-new'], '必须先换新 tabId、再用新 id 重连')
})
t("SSE 'replaced'：插件热更新（页面里已有更新的 bus 实例）→ 旧实例退场，不换 id 不重连", () => {
  const calls = []
  handleReplaced({
    staleBus: true,
    renewTabId: () => {
      calls.push('renew')
      return 'tab-new'
    },
    reconnect: (id) => calls.push('reconnect:' + id),
    retire: () => calls.push('retire'),
  })
  assert.deepEqual(calls, ['retire'], '热更新场景不得换 id 也不得重连（否则两边每 3s 互相顶替）')
})
t("接线：client.tsx 的 'replaced' 监听走 handleReplaced，换 id 用 getTabId(true)", () => {
  const body = srcBetween("source.addEventListener('replaced', () => {", '\n    })\n')
  assert.ok(body.includes('handleReplaced('), "'replaced' 事件未走 handleReplaced 判定")
  assert.ok(/staleBus:[\s\S]{0,160}BUS_GEN_KEY/.test(body), '必须按 bus 代数区分「热更新退场」与「复制标签页换 id」')
  assert.ok(/renewTabId:[\s\S]{0,200}getTabId\(true\)/.test(body), '换新 id 必须用 getTabId(true)')
  assert.ok(/reconnect:[\s\S]{0,120}connect\(\)/.test(body), '换完 id 必须重连')
})

// --------------------------------------------------------------------------
// Issue #15 R15-5：迟滞衰减使确认计数归零 = 客户端**放弃**本次检测 → 引擎须作废抢救种子。
// 引擎侧锁（test/wake-flow.test.mjs）用的是**测试内复刻的假客户端**（该文件对 client.tsx
// 只有注释引用，不读源码、不 import），验的是引擎路径；client.tsx 的接线本身零覆盖 ——
// 故此处补客户端侧锁。
// --------------------------------------------------------------------------
t('客户端侧：迟滞衰减使确认计数归零 → 引擎作废抢救种子；「打断已发生」那处不得作废', () => {
  // ① 判定语义（真实生产函数）：确认计数归零 = 本次检测被放弃 → 须作废抢救种子
  const calls = []
  const next = decayConfirmCount(1, () => calls.push('invalidate'))
  assert.equal(next, 0, '孤立判真（1 拍）衰减后确认计数应归零')
  assert.deepEqual(
    calls,
    ['invalidate'],
    '确认计数归零必须作废抢救种子——否则陈旧种子被 Math.max 钳到环起点 → 整环 2s AI 音频并入用户消息',
  )
  const calls2 = []
  assert.equal(decayConfirmCount(3, () => calls2.push('invalidate')), 2, '3 拍衰减到 2')
  assert.deepEqual(calls2, [], '未归零不得作废种子（证据未耗尽，检测仍在进行）')

  // ② 接线：client.tsx 的迟滞分支把引擎的作废接上
  const decay = srcBetween('isSpeechFalseRun++', 'bus.setUi({ isSpeech: speech')
  assert.ok(decay.includes('decayConfirmCount'), '迟滞分支未走 decayConfirmCount 判定')
  assert.ok(
    /invalidateSalvageSeed/.test(decay),
    '迟滞分支未作废抢救种子——陈旧种子会成为下次真打断的锚点（整环 AI 音频灌进用户消息）',
  )
  assert.ok(
    decay.indexOf('decayConfirmCount') < decay.indexOf('invalidateSalvageSeed'),
    '作废种子必须发生在「判定归零」之后，不得无条件作废',
  )

  // ③「打断已发生」那处不得作废：那里计数归零的含义是打断成立，抢救种子要留给随后的
  //   hardBreak() → discardSegment() 消费；提前作废会让抢救退回整环兜底，反而制造症状。
  const interrupt = srcBetween('const confirmMs = interruptFirstAt > 0', 'bus.setUi({ interruptConfirmMs: confirmMs })')
  assert.ok(
    !/invalidateSalvageSeed/.test(interrupt),
    '「打断已发生」分支不得作废抢救种子（会破坏打断时的抢救）',
  )
})

// --------------------------------------------------------------------------
// M-4 闭环：createHttpScope 每次 apply()（插件每次热重载）都新建一个，它自建的
// 窗口 focus 监听 + 退避重试必须随插件卸载被摘除——否则每次热重载泄漏一个常驻
// 'focus' 监听器（窗口获焦时多一次 load() = 多一次 GET）。
// 这里用假 window + 假 ctx 走完整链路：注册 → 宿主调用 cleanup → 监听被摘除。
// --------------------------------------------------------------------------
await ta('scope 的自建资源挂到宿主 effect 生命周期：cleanup 摘除窗口 focus 监听', async () => {
  const listeners = new Map()
  const prevWindow = globalThis.window
  globalThis.window = {
    addEventListener: (type, fn) => {
      listeners.set(type, fn)
    },
    removeEventListener: (type, fn) => {
      if (listeners.get(type) === fn) listeners.delete(type)
    },
  }
  try {
    const raw = createHttpScope('http://scope.test', async () => ({ ok: true, status: 200, json: async () => ({ value: {} }) }))
    assert.equal(listeners.has('focus'), true, '底层 scope 应当注册窗口 focus 监听')
    let cleanup = null
    registerScopeDispose(
      {
        effect: (fn) => {
          // 宿主契约：effect 函数的**返回值**即清理函数（见 src/index.ts 的
          // `ctx.effect(() => unsubscribe)` / `ctx.effect(() => () => clearInterval(...))`）。
          cleanup = fn()
        },
      },
      raw,
    )
    assert.equal(typeof cleanup, 'function', '未向宿主注册 effect 清理函数——scope 的自建资源会随每次热重载泄漏')
    cleanup()
    assert.equal(listeners.has('focus'), false, 'cleanup 后窗口 focus 监听仍在 → 每次热重载泄漏一个常驻监听器')
  } finally {
    if (prevWindow === undefined) delete globalThis.window
    else globalThis.window = prevWindow
  }
})

t('接线：client.tsx 的 createHttpScope 分支把 scope 挂到 ctx.effect（卸载/热重载时 dispose）', () => {
  const body = srcBetween('const raw = createHttpScope()', 'ctx.slots.inject(')
  assert.ok(
    body.includes('registerScopeDispose(ctx, raw)'),
    '底层 scope 的自建资源未挂到宿主 effect 生命周期 → 每次热重载泄漏一个常驻 window focus 监听器',
  )
  assert.ok(body.includes('createScopeBridge(raw)'), '底层 scope 应以具名引用传入桥（否则拿不到 dispose）')
})

console.log(`\nmic-gesture：${passed} 项通过`)
