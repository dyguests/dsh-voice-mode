/**
 * 焦点归属（实例级所有权）：焦点必须带**实例级所有权**——
 *  同一标签页里两个 MicButton 实例并存（宿主把麦克风按钮挂在
 *  conversation.input.activity / conversation.input.right 两个槽位，兜底切换期间
 *  短暂共存）时，先卸载的那个只释放自己的持有，存活实例仍持有的焦点不被清掉。
 *
 * 旧实现的毛病：焦点是「标签页级」全局量，任何实例卸载都无条件清它 →
 *  存活实例的 effect 依赖没变、不会重报 → readAloud=always 的朗读归属被**永久**清空
 *  （host 也收到了 POST /focus {sessionId:null}，别的标签页同时失去该会话的归属）。
 *
 * 这里用纯状态机（src/mic-gesture.ts 的 focusClaim/focusRelease/focusSession）
 * 模拟两个实例的挂载/卸载时序，再用源码锁确认 client.tsx 真的接上了归属判定
 *  （交互层无 DOM 渲染条件，与本仓既有做法一致）。
 *
 * 运行：node test/focus-ownership.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { focusClaim, focusRelease, focusSession } from '../src/mic-gesture.ts'

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

const SID = 'sess-1'

t('单实例：挂载即持有，卸载即让出（关页/离开会话要真清焦点）', () => {
  const owners = new Map()
  focusClaim(owners, 'mic-1', SID)
  assert.equal(focusSession(owners), SID, '上报后应持有焦点')
  const rel = focusRelease(owners, 'mic-1')
  assert.equal(rel.changed, true, '唯一持有者卸载 → 焦点应变空')
  assert.equal(rel.focused, null, '唯一持有者卸载后焦点必须清空')
  assert.equal(focusSession(owners), null)
})

t('两个实例先后挂载：先卸载的那个不夺走存活实例的焦点', () => {
  const owners = new Map()
  // 实例 A 挂载（activity 槽位）
  focusClaim(owners, 'mic-1', SID)
  // 实例 B 挂载（right 槽位兜底，同一会话）
  focusClaim(owners, 'mic-2', SID)
  assert.equal(focusSession(owners), SID)
  // A 先卸载：只释放自己的持有
  const rel = focusRelease(owners, 'mic-1')
  assert.equal(rel.changed, false, 'A 卸载不应改动当前焦点——焦点仍归存活实例 B')
  assert.equal(rel.focused, SID, '存活实例 B 仍持有的焦点被清掉了')
  assert.equal(focusSession(owners), SID, '全局焦点被卸载的非持有者清成 null')
})

t('两个实例持有不同会话：焦点归最后上报者；它卸载后回落到存活实例', () => {
  const owners = new Map()
  focusClaim(owners, 'mic-1', 'sess-A')
  focusClaim(owners, 'mic-2', 'sess-B')
  assert.equal(focusSession(owners), 'sess-B', '最后上报者应持有焦点')
  // 当前持有者 mic-2 卸载 → 焦点回落到仍存活的 mic-1
  const rel = focusRelease(owners, 'mic-2')
  assert.equal(rel.changed, true, '当前持有者卸载 → 焦点应变')
  assert.equal(rel.focused, 'sess-A', '焦点应回落到存活实例')
  assert.equal(focusSession(owners), 'sess-A')
})

t('释放未持有过焦点的实例：不动焦点（老标签页级调用的默认持有者也不会误清）', () => {
  const owners = new Map()
  focusClaim(owners, 'mic-1', SID)
  const rel = focusRelease(owners, 'mic-never')
  assert.equal(rel.changed, false)
  assert.equal(rel.focused, SID)
})

t('重新上报会把该实例移回末位（切回可见时夺回焦点）', () => {
  const owners = new Map()
  focusClaim(owners, 'mic-1', 'sess-A')
  focusClaim(owners, 'mic-2', 'sess-B')
  // mic-1 切回可见 → 重新上报 → 夺回焦点
  focusClaim(owners, 'mic-1', 'sess-A')
  assert.equal(focusSession(owners), 'sess-A', '重新上报的实例应成为当前焦点持有者')
})

// --------------------------------------------------------------------------
// 源码锁：client.tsx 真的接上了归属判定（纯函数正确但接线断了，行为仍是坏的）
// --------------------------------------------------------------------------
const clientSrc = readFileSync(new URL('../src/client.tsx', import.meta.url), 'utf8')

t('接线：MicButton 上报/让出都带本实例的 token', () => {
  // 计数式：client.tsx 有两处「上报焦点」+ 一处「让出焦点」，都必须带 token。
  // 只用「≥1 处匹配」的话，把其中一处改成不带 token（bus.setFocusedSession(sessionId)）
  // 仍会因另一处匹配而通过——上报落到默认持有者 'default'，卸载走 focusRelease(owners,'mic-1')
  // 对不上 token → changed=false → 焦点永不清空 → host 按 readAloud=always 持续给已卸载实例朗读。
  assert.equal(
    clientSrc.split('bus.setFocusedSession(sessionId, focusOwner)').length - 1,
    2,
    '两处「上报焦点」都必须带实例 token（少一处 → 焦点落到默认持有者，卸载时对不上 token → 焦点永不清空）',
  )
  assert.equal(
    clientSrc.split('bus.setFocusedSession(null, focusOwner)').length - 1,
    1,
    '「让出焦点」必须带实例 token——卸载时清的是别人的焦点',
  )
  assert.ok(
    !/bus\.setFocusedSession\((sessionId|null)\)/.test(clientSrc),
    '存在不带实例 token 的 setFocusedSession 调用——焦点会落到默认持有者',
  )
  assert.ok(
    /focusOwnerRef\.current === null/.test(clientSrc),
    'token 未惰性初始化——每次渲染都会换一个 token',
  )
  assert.ok(/\+\+focusOwnerSeq/.test(clientSrc), 'token 未取自实例唯一计数')
})

t('接线：bus 的让出路径先问归属（不再无条件清全局焦点）', () => {
  const m = /setFocusedSession\([^)]*\)\s*\{([\s\S]*?)\n {4}\},/.exec(clientSrc)
  assert.ok(m, '未找到 bus.setFocusedSession 的实现')
  const body = m[1]
  assert.ok(/focusClaim\(focusOwners, owner, sessionId\)/.test(body), '上报路径未登记归属')
  assert.ok(/focusRelease\(focusOwners, owner\)/.test(body), '让出路径未走归属判定')
  assert.ok(!/focusedSessionId = null/.test(body), '让出路径仍在无条件清全局焦点')
})

t('接线：焦点回落到存活实例时必须同步给 host（否则 host 仍记着已卸载实例的会话）', () => {
  // 删掉这行 postFocus(focused) → host 仍认为焦点在已卸载实例上 → readAloud=always
  // 会持续给已卸载实例的会话朗读。本条以前零覆盖（删掉它全套件仍绿）。
  const m = /setFocusedSession\([^)]*\)\s*\{([\s\S]*?)\n {4}\},/.exec(clientSrc)
  assert.ok(m, '未找到 bus.setFocusedSession 的实现')
  const branch = /if \(focused !== null\) \{([\s\S]*?)\n {8}\}/.exec(m[1])
  assert.ok(branch, '未找到「焦点回落到仍存活的实例」的分支')
  assert.ok(
    /postFocus\(focused\)/.test(branch[1]),
    '焦点回落后未同步给 host——host 仍记着已卸载实例的会话（readAloud=always 会持续给已卸载实例朗读）',
  )
})

console.log(`\nfocus-ownership：${passed} 项通过`)
