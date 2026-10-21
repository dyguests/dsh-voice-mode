/** 麦克风按钮的纯判定逻辑（无 DOM 依赖，供 client.tsx 与单测共用）。 */

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
