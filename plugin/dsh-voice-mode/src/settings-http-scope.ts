/**
 * 0.1.7+ 宿主的设置读写适配器：把 `VoiceSettingsCard` 需要的 scope 接口（getSnapshot/subscribe/set）
 * 接到插件自己的 `/voice-mode/settings`（GET 读、POST 写覆盖层）。
 * ≤0.1.6 宿主仍用官方 settingsScope，不经本文件。
 *
 * Issue #15 R15-7：拉取失败不再是不可逆终态——
 *  - GET 失败 → 置 `unavailable` 并按退避重试（卡片开着就一直试；取回即自动出现面板）；
 *  - 卡片重新挂载（用户「关掉再打开设置页」）→ 必重拉一次，失败终态由此恢复；
 *  - 窗口重新获得焦点 → 重拉一次（别的标签页改了设置，本页不再一直显示旧值）；
 *  - 写（set）在途时不回写读结果，避免并发的 GET 把刚写好的值盖回旧值。
 */

export interface HttpScopeSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: Record<string, unknown>
  [k: string]: unknown
}

export interface HttpScope {
  getSnapshot(): HttpScopeSnapshot
  subscribe(fn: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}

const SETTINGS_URL = '/voice-mode/settings'
/** 重试退避：首发 500ms，指数翻倍，封顶 10s（卡片开着时的后台拉取频率上限）。 */
const RETRY_BASE_MS = 500
const RETRY_MAX_MS = 10_000

export function createHttpScope(origin: string = location.origin, fetchImpl: typeof fetch = fetch): HttpScope {
  let snap: HttpScopeSnapshot = { status: 'loading', value: {} }
  const subs = new Set<() => void>()
  let inFlight = false
  let writing = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryDelay = 0
  const emit = (next: HttpScopeSnapshot): void => {
    snap = next
    for (const fn of [...subs]) fn()
  }
  const clearRetry = (): void => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }
  const load = async (): Promise<void> => {
    if (inFlight) return
    inFlight = true
    clearRetry()
    try {
      const res = await fetchImpl(origin + SETTINGS_URL)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { value?: Record<string, unknown> }
      retryDelay = 0
      // 写在途时不回写读结果：并发的 GET 可能先于 POST 落定，回写会把新值盖回旧值。
      if (writing === 0) emit({ status: 'ready', value: data.value ?? {} })
    } catch {
      emit({ status: 'unavailable', value: snap.value })
      scheduleRetry()
    } finally {
      inFlight = false
    }
  }
  const scheduleRetry = (): void => {
    // 没有订阅者（卡片没挂载）就不空转——重开卡片时 subscribe 会再拉一次。
    if (subs.size === 0 || retryTimer !== null) return
    retryDelay = retryDelay === 0 ? RETRY_BASE_MS : Math.min(retryDelay * 2, RETRY_MAX_MS)
    retryTimer = setTimeout(() => {
      retryTimer = null
      void load()
    }, retryDelay)
  }
  const scope: HttpScope = {
    getSnapshot: () => snap,
    subscribe(fn) {
      const first = subs.size === 0
      subs.add(fn)
      if (first) {
        // 卡片挂载（含「关掉再打开设置页」的重挂载）→ 必重拉一次：
        // 上一轮的失败终态由此恢复；别处改过的设置也由此刷新。
        retryDelay = 0
        void load()
      }
      return () => {
        subs.delete(fn)
        if (subs.size === 0) clearRetry()
      }
    },
    async set(field, value) {
      // 乐观更新：失败则以服务端当前值回滚（卡片不需要感知错误细节）。
      const before = snap
      writing++
      emit({ status: 'ready', value: { ...snap.value, [field]: value } })
      let ok = false
      try {
        const res = await fetchImpl(origin + SETTINGS_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ [field]: value }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as { value?: Record<string, unknown> }
        emit({ status: 'ready', value: data.value ?? before.value })
        ok = true
      } catch {
        emit(before)
      } finally {
        writing--
      }
      // 写失败：回滚后以服务端当前值兜底（成功路径已由 POST 响应带回全量值）。
      if (!ok) await load()
    },
  }
  // 窗口重新获得焦点 → 重拉一次：别的标签页改了设置时本页不再一直显示旧值
  // （宿主虽对任一路径的改动都广播 display，但那条通道在 client.tsx 里，不在本文件）。
  // 非浏览器环境（测试里的 window 桩、Node 侧加载）可能没有 addEventListener——加前先探。
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', () => {
      if (subs.size > 0) void load()
    })
  }
  return scope
}
