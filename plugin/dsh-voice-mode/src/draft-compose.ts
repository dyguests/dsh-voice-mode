/**
 * Issue #15 批 3：实时转写回填草稿的组成逻辑（纯函数，便于单测）。
 *
 * 背景（用户反馈问题③）：实时 partial 只显示在状态条/字幕，输入框要等定稿后才一次性
 * 出现文字。修复：partial 实时写入草稿——宿主 setDraft 是整篇替换纯文本，故草稿
 * 组成 = 「已定稿前缀 + 当前 partial 尾」；定稿时用定稿文本**替换** partial 尾
 * （不是追加——否则 partial 会被重复计入，主会话预审定位的 double-append 风险）。
 *
 * 宿主 slot 实际传完整 InputActions（含 setDraft）；纯文本面无富样式，用户要的
 * 「未定稿部分差异样式」在 composer 面不可达（计划 Open Question）。
 */

/**
 * 组成新草稿：把 current 末尾的 tail（上次写入的 partial 尾）剥掉，拼上 addition。
 *  - tail 匹配 current 末尾才剥（宿主草稿可能已被提交清空/用户改写——不匹配时按
 *    current 原样为基，自愈：提交后草稿为空 → base 为空 → 从 addition 新起）；
 *  - addition 为空（纯 partial 场景不会发生，防御）时返回 base。
 */
export function composeDraft(current: string, tail: string, addition: string): string {
  const cur = String(current ?? '')
  const t = String(tail ?? '')
  const base = t && cur.endsWith(t) ? cur.slice(0, cur.length - t.length).replace(/\s+$/, '') : cur.trim()
  const add = String(addition ?? '').trim()
  if (!add) return base
  return base ? `${base} ${add}` : add
}

/**
 * partial 是否应写草稿：wake 待机态的 partial 是「它听到了什么」的诊断反馈
 * （含唤醒词、未进入识别），不得写草稿（asr.ts:379-399 同款语义的客户端侧）。
 */
export function shouldWritePartial(state: string): boolean {
  return state !== 'wake'
}
