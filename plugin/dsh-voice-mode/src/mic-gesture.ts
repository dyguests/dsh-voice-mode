/** 客户端的纯判定逻辑（无 DOM 依赖，供 client.tsx 与单测共用）：
 *  麦克风手势判定 / 竖条绘制 / 右键菜单方向键 / SSE 'replaced' 处理 /
 *  焦点归属（实例级所有权）/ 设置 scope 失效桥。 */

/** 快捷键是否与编辑操作撞车（全选/复制/粘贴/剪切/撤销/重做，含 Shift 变体如「粘贴纯文本」）：
 *  撞车的组合在输入框里不劫持，交给浏览器；其余组合在输入框里也能切换语音。 */
export function isEditingShortcut(
  combo: { key: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean },
  mac: boolean,
): boolean {
  const primary = mac ? combo.meta && !combo.ctrl : combo.ctrl && !combo.meta
  return primary && !combo.alt && combo.key.length === 1 && 'acvxzy'.includes(combo.key)
}

/** 进/出语音的点击节流：与 host /toggle 限流（每会话 2 次/2s）同口径，另加 250ms 去抖（双击）。
 *  history 为调用方持有的时间戳数组（就地裁剪）；放行返回 true 并记一笔。 */
export function takeToggleSlot(history: number[], now: number): boolean {
  while (history.length > 0 && now - history[0] >= 2000) history.shift()
  if (history.length >= 2) return false
  if (history.length > 0 && now - history[history.length - 1] < 250) return false
  history.push(now)
  return true
}

/** once 模式「回复已读完」：本轮回合跑过且已结束、host TTS 队列已排空、本地不在播放。 */
export function onceFinished(o: { sawRun: boolean }, running: boolean, ttsDrained: boolean, playing: boolean): boolean {
  return o.sawRun && !running && ttsDrained && !playing
}

/** pointerdown/up 是否为主键——只有主键才允许启动手势（长按打断 / 按住说话）。
 *  Pointer Events 对右键、中键同样派发 pointerdown/up，若不拦截：用户右键开快捷设置菜单时
 *  （macOS 上的常规动作就是「按住不放等菜单弹出」，≥250ms 是必然而非偶然）会 arm 长按打断
 *  并中止正在生成的回复、朗读静默。右键语义由 onContextMenu 独占，故这里只放行主键。
 *  触屏/笔不报 hover，其 pointerdown/up 的 button 恒为 0——按住说话手势不受影响。
 *
 *  macOS 特例：系统「Secondary click」默认关闭时**右键 = ctrl+click**，而浏览器派发的
 *  辅助点击 pointerdown 是 **button=0 + ctrlKey=true**（辅助点击仍属主键，button 拦不住）。
 *  只按 button 判 → macOS 上「按住 ctrl+click 等右键菜单弹出」照样 arm 长按打断并中止正在
 *  生成的回复（= 本 issue 在 macOS 上的形态）。故 mac 上再拦 ctrl+click。
 *  Windows/Linux 的 ctrl+click 语义不同（不是右键；其右键本来就走 button=2），故不拦。
 *  辅助点击在浏览器里本来就会触发 contextmenu → 右键菜单照常开，只是不再误触打断。
 *  平台与修饰键由调用方注入（opts），便于单测覆盖各平台语义。 */
export function isPrimaryPress(
  button: number,
  opts: { mac: boolean; ctrlKey: boolean },
): boolean {
  if (button !== 0) return false
  if (opts.mac && opts.ctrlKey) return false
  return true
}

/* ---------------------------------------------------------------------------
 * 竖条绘制（麦克风电平竖条）
 *
 * 「减少动态效果」是系统级可访问性偏好，用户可能随时开关。原先只在 effect 建立时
 * 读一次偏好，之后开关不生效 → 竖条不重绘。绘制方式抽成纯判定，供 client.tsx 在
 * matchMedia 的 change 事件里重新求值。
 * ------------------------------------------------------------------------- */

/** 竖条绘制方式：开了「减少动态效果」→ 画满高且不跑 rAF；否则走平滑动画。 */
export function eqPaintMode(reducedMotion: boolean): 'static-full' | 'animated' {
  return reducedMotion ? 'static-full' : 'animated'
}

/* ---------------------------------------------------------------------------
 * 右键快捷设置菜单（MicMenu）的方向键环绕
 * ------------------------------------------------------------------------- */

/** 菜单方向键的环绕目标下标：i = 当前焦点在 items 里的下标（-1 = 焦点不在菜单内），
 *  dir = +1（ArrowDown）/ -1（ArrowUp），两端环绕。
 *  i = -1（焦点被外部抢走）时：ArrowDown 落到首项、ArrowUp 落到**末项**——
 *  按 (i + len - 1) % len 算会落到倒数第二项（错位）。 */
export function menuFocusIndex(i: number, len: number, dir: 1 | -1): number {
  if (len <= 0) return -1
  if (i < 0) return dir === 1 ? 0 : len - 1
  return (i + dir + len) % len
}

/* ---------------------------------------------------------------------------
 * SSE 'replaced'（同 tabId 的新连接顶替了本连接）
 * ------------------------------------------------------------------------- */

/** 'replaced' 的处理。两种来源必须分开，否则两边每 3s 互相顶替、朗读时断时续：
 *  - staleBus = true：同一页面里已有更新的 bus 实例（插件热更新）→ 本（旧）实例退场，不重连；
 *  - staleBus = false：另一个文档（复制标签页）带走了同一个 tabId → 本页换新 tabId 并重连。
 *  依赖注入（renewTabId / reconnect / retire），便于单测断言「换了新 id 且重连」这个行为本身。 */
export function handleReplaced(o: {
  staleBus: boolean
  /** 取一个新的 tabId（真实实现 = getTabId(true)） */
  renewTabId: () => string
  /** 用新 tabId 重连（真实实现 = connect()） */
  reconnect: (tabId: string) => void
  /** 旧实例退场（真实实现 = 标 SSE 断） */
  retire: () => void
}): void {
  if (o.staleBus) {
    o.retire()
    return
  }
  o.reconnect(o.renewTabId())
}

/* ---------------------------------------------------------------------------
 * 打断确认计数（VAD 迟滞机制）
 * ------------------------------------------------------------------------- */

/** 迟滞衰减一步：连续 2 拍判假 → 确认计数减 1。
 *  归零 = 本次检测的证据耗尽（从未达打断门槛）→ 客户端**放弃**该检测 → 须作废引擎的
 *  抢救种子：否则这次「孤立判真」（回声突发）锁定的种子会成为下次真打断的锚点，
 *  陈旧种子被 Math.max 钳到环起点 → 整环 2s AI 音频并入用户消息（R15-5 症状）。
 *  代价（主会话 R15-5 裁定接受）：真实语音中的 VAD 抖动（≤1 个检测窗）不再被抢救并入 ——
 *  拿「少并入 ≤1 窗用户音」换「整环 AI 音频灌进用户消息」。
 *  与「打断已发生」的区分：那里计数同样归零，但含义是**打断成立**，抢救种子要留着给
 *  随后的 hardBreak() → discardSegment() 消费；提前作废会让抢救退回整环兜底，反而制造症状。 */
export function decayConfirmCount(count: number, abandon: () => void): number {
  const next = Math.max(0, count - 1)
  if (next === 0) abandon()
  return next
}

/* ---------------------------------------------------------------------------
 * 焦点归属（实例级所有权）
 *
 * 同一标签页里可能同时存在多个 MicButton 实例（宿主把麦克风按钮挂在
 * conversation.input.activity / conversation.input.right 两个槽位上，兜底切换
 * 期间会短暂并存）。焦点必须带**实例级所有权**：某个实例卸载只释放自己的持有，
 * 不能清掉另一个实例仍持有的焦点——否则 readAloud=always 的朗读归属被永久清空
 * （宿主也收到了 sessionId:null，别处再无归属）。
 * ------------------------------------------------------------------------- */

/** 焦点持有者表：实例 token → 该实例上报的会话；插入序末位 = 当前焦点持有者。 */
export type FocusOwners = Map<string, string>

/** 未带实例 token 的老调用方（标签页级调用）使用的默认持有者。 */
export const FOCUS_OWNER_DEFAULT = 'default'

/** 当前焦点会话（末位持有者的会话；无人持有为 null）。 */
export function focusSession(owners: FocusOwners): string | null {
  let last: string | null = null
  for (const sessionId of owners.values()) last = sessionId
  return last
}

/** 实例上报焦点：登记所有权并把自己移到末位（末位 = 当前焦点持有者）。 */
export function focusClaim(owners: FocusOwners, owner: string, sessionId: string): void {
  owners.delete(owner)
  owners.set(owner, sessionId)
}

/** 实例卸载/让出：只释放自己的持有，别人仍持有的焦点不动。
 *  changed = 当前焦点是否因此改变；focused = 释放后的当前焦点会话
 *  （仍有存活实例持有时归它，否则 null）。 */
export function focusRelease(owners: FocusOwners, owner: string): { changed: boolean; focused: string | null } {
  const before = focusSession(owners)
  owners.delete(owner)
  const focused = focusSession(owners)
  return { changed: before !== focused, focused }
}

/* ---------------------------------------------------------------------------
 * 设置 scope 失效桥
 *
 * host 对任一标签页、任一路径的显示类设置改动都广播 SSE 'display'；设置卡片要跟着
 * 重拉，否则本页一直显示旧值。底层 scope（0.1.7+ 的 /voice-mode/settings）只有
 * 「0→1 订阅 → 必重拉」这一条重拉入口，没有 invalidate()：这里用一座桥把卡片订阅
 * 收在**一份**底层订阅后面，失效时把底层订阅退掉再订回来，逼出那一次重拉
 * （底层将来带了 invalidate() 入口则直接用）。
 * ------------------------------------------------------------------------- */

/** 设置 scope 的最小形态（与 client.tsx 的 MenuScope、settings-http-scope 的 HttpScope 同构）。 */
export interface ScopeLike {
  getSnapshot(): { status?: string; value?: Record<string, unknown> }
  subscribe(fn: () => void): () => void
  set(field: string, value: unknown): unknown
}

/** 宿主 effect 生命周期的最小形态（只要一个 effect 注册方法）。 */
export interface EffectHost {
  /** 注册一个 effect：宿主调用它并把**返回值**当清理函数，插件卸载/热重载时执行
   *  （宿主契约见 src/index.ts 的 `ctx.effect(() => unsubscribe)` /
   *  `ctx.effect(() => () => clearInterval(...))`）。 */
  effect(fn: () => unknown): unknown
}

/** 把 scope 自建的资源挂到宿主的 effect 生命周期上：宿主在插件卸载/热重载时调用返回的
 *  清理函数 → raw.dispose() 摘除该 scope 自建的窗口 focus 监听 + 停掉退避重试。
 *  createHttpScope 是**每次 apply() 新建**的（插件每次热重载都新建一个），不挂到生命周期上
 *  则每次热重载泄漏一个常驻 window 'focus' 监听器（窗口获焦时多一次 load() = 多一次 GET）。 */
export function registerScopeDispose(host: EffectHost, raw: { dispose: () => void }): void {
  host.effect(() => raw.dispose)
}

export interface ScopeBridge {
  /** 给设置卡片/右键菜单用的 scope（订阅经桥转发到底层）。 */
  scope: ScopeLike
  /** 失效：让底层重新拉取一次（host 广播 display → 别的标签页改了显示类设置）。 */
  invalidate(): void
}

/** 建桥：raw 是 0.1.7+ 的 HttpScope 时，失效走它的「0→1 订阅 → 必重拉」路径；
 *  raw 带了 invalidate() 入口则直接用。
 *
 *  Issue #15 R15-5：**订阅者按条目记、不按回调去重**——同一回调被订阅两次时，两个订阅者
 *  都必须继续收到通知，且其中一个退订不得把另一个的订阅一起撤掉（按回调去重会静默丢弃
 *  第二个订阅者，还会让底层被重复订阅 → 二次触发底层的 0→1 重拉）。
 *
 *  关于「失效落在一次 GET 的在途窗口内」（早期底层 `if (inFlight) return` 会把它静默
 *  丢弃 → 卡片停在旧值、不再发请求、不自愈）：**该兜底已由底层承担**——底层 load() 改成
 *  「在途时记 pendingReload → 落定后补拉一次」。桥侧**不再**重复兜底：两处都兜会让每次
 *  失效多打一次 GET（一次失效 → 3 次请求），两处不该互相依赖、也不该互相抵消。 */
export function createScopeBridge(raw: ScopeLike & { invalidate?: () => void }): ScopeBridge {
  const listeners: { fn: () => void }[] = []
  let off: (() => void) | null = null
  function resubscribe(): void {
    off?.()
    off = raw.subscribe(forward)
  }
  function forward(): void {
    for (const entry of [...listeners]) entry.fn()
  }
  const scope: ScopeLike = {
    getSnapshot: () => raw.getSnapshot(),
    subscribe(fn) {
      const entry = { fn }
      listeners.push(entry)
      // 底层只保持一份订阅：首个订阅者建立、最后一个退订时撤掉（底层 0→1 会重拉）。
      if (listeners.length === 1) off = raw.subscribe(forward)
      return () => {
        const i = listeners.indexOf(entry)
        if (i >= 0) listeners.splice(i, 1)
        if (listeners.length === 0 && off !== null) {
          off()
          off = null
        }
      }
    },
    set: (field, value) => raw.set(field, value),
  }
  return {
    scope,
    invalidate() {
      if (typeof raw.invalidate === 'function') {
        raw.invalidate()
        return
      }
      if (listeners.length === 0) return // 卡片没挂载 → 没人看，无需重拉
      resubscribe() // 底层 0→1 → 必重拉一次（在途窗口内由底层自己补拉，桥不重复兜底）
    },
  }
}
