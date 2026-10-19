/**
 * Issue #15 批 4：LLM 纠错（可选，llmCorrect 设置默认关）——host 侧纠错核心。
 *
 * 背景（用户反馈问题⑤）：本地 zipformer2 流式识别几乎每句都有同音字/错别字/标点问题；
 * SenseVoice 只做一次整句重转写，不改语义层错字。修复：发送前对整条草稿做一次
 * 「只改错别字/同音字/纯标点，保持原意」的 LLM 纠错（复用 DSH 已配置模型，不引入
 * 新凭据）；失败/无模型/空结果一律回退原文——纠错是纯附加层，不阻断发送。
 *
 * 调用点：host 路由 POST /voice-mode/correct（客户端发送前调一次，每消息一次 RTT）。
 * 避自 tap：本调用不传 sessionId（index.ts 的 llm/stream tap 只拦本会话无 purpose 流，
 * 无 sessionId 直放行——已实证 index.ts:803）。
 */

/** ctx 的最小面（本模块只用 llm + agentDefaultModel；其余不依赖）。 */
export interface CorrectCtx {
  llm?: {
    stream(options: {
      provider: string
      model: string
      system?: string
      messages: { role: 'user'; content: { type: 'text'; text: string }[] }[]
    }): AsyncIterable<{ type: string; text?: string }>
  }
  agentDefaultModel?: {
    currentSelection?: () => { provider: string; model: string } | undefined
  }
}

/** 纠错系统提示（双语；只做最小修正，禁止改写/补充/回答）。 */
export function correctionSystem(lang: 'zh' | 'en'): string {
  return lang === 'en'
    ? 'You are a speech-recognition corrector. The user text comes from ASR and may contain homophone errors, typos, or missing/wrong punctuation. Make only minimal fixes: correct typos/homophones and fix punctuation, preserving the original meaning and colloquial style. Do not rewrite sentences, do not add content, do not answer questions, and do not alter numbers or proper nouns. Output only the corrected text, with no explanation. If the input has no obvious errors, return it unchanged.'
    : '你是中文语音识别纠错器。用户的话来自语音识别（ASR），可能有同音字、错别字、标点缺失或错误。请只做最小修正：改错别字/同音字、补标点，保持原意与口语风格；不要改写句子、不要补充内容、不要回答问题、不要改变数字和专业术语。只输出修正后的文本，不要任何解释。如果原文没有明显错误，原样返回。'
}

/**
 * 纠错一条文本。任何失败（无 ctx.llm / 无默认模型 / stream 抛错 / 空结果）都原样
 * 返回——纠错不可用时行为与关闭设置一致（纯附加层）。
 */
export async function correctText(
  ctx: CorrectCtx | undefined,
  text: string,
  lang: 'zh' | 'en',
): Promise<string> {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return text
  const llm = ctx?.llm
  const sel = ctx?.agentDefaultModel?.currentSelection?.()
  if (!llm || typeof llm.stream !== 'function') return text
  if (!sel?.provider || !sel?.model) return text
  try {
    const stream = llm.stream({
      provider: sel.provider,
      model: sel.model,
      system: correctionSystem(lang),
      messages: [{ role: 'user', content: [{ type: 'text', text: trimmed }] }],
    })
    let out = ''
    for await (const chunk of stream) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
    }
    const corrected = out.trim()
    return corrected || text
  } catch {
    return text
  }
}
