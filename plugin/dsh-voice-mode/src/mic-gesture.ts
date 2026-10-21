/** 客户端的纯判定逻辑（无 DOM 依赖，供 client.tsx 与单测共用）：
 *  麦克风手势判定 / 焦点归属（实例级所有权）/ 设置 scope 失效桥。 */

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
 *  触屏/笔不报 hover，其 pointerdown/up 的 button 恒为 0——按住说话手势不受影响。 */
export function isPrimaryPress(button: number): boolean {
  return button === 0
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

export interface ScopeBridge {
  /** 给设置卡片/右键菜单用的 scope（订阅经桥转发到底层）。 */
  scope: ScopeLike
  /** 失效：让底层重新拉取一次（host 广播 display → 别的标签页改了显示类设置）。 */
  invalidate(): void
}

/** 建桥：raw 是 0.1.7+ 的 HttpScope 时，失效走它的「0→1 订阅 → 必重拉」路径；
 *  raw 带了 invalidate() 入口则直接用。 */
export function createScopeBridge(raw: ScopeLike & { invalidate?: () => void }): ScopeBridge {
  const listeners = new Set<() => void>()
  let off: (() => void) | null = null
  const forward = (): void => {
    for (const fn of [...listeners]) fn()
  }
  const scope: ScopeLike = {
    getSnapshot: () => raw.getSnapshot(),
    subscribe(fn) {
      listeners.add(fn)
      // 底层只保持一份订阅：首个订阅者建立、最后一个退订时撤掉（底层 0→1 会重拉）。
      if (listeners.size === 1) off = raw.subscribe(forward)
      return () => {
        listeners.delete(fn)
        if (listeners.size === 0 && off !== null) {
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
      if (listeners.size === 0) return // 卡片没挂载 → 没人看，无需重拉
      off?.()
      off = raw.subscribe(forward) // 底层 0→1 → 必重拉一次
    },
  }
}
