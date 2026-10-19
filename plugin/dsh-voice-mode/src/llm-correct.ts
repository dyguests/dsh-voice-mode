/**
 * Issue #15 批 4：LLM 纠错（可选，llmCorrect 设置默认关）——host 侧纠错核心。
 *
 * 背景（用户反馈问题⑤）：本地 zipformer2 流式识别几乎每句都有同音字/错别字/标点问题；
 * SenseVoice 只做一次整句重转写，不改语义层错字。修复：发送前对整条草稿做一次
 * 「只改错别字/同音字/纯标点，保持原意」的 LLM 纠错（复用 DSH 已配置模型，不引入
 * 新凭据）；失败/无模型/空结果/输出异常（超长或带前言，R1 I-3 护栏）一律回退原文
 * ——纠错是纯附加层，不阻断发送。
 *
 * 调用点：host 路由 POST /voice-mode/correct（客户端发送前调一次，每消息一次 RTT）。
 * 避自 tap：本调用不传 sessionId（index.ts 的 llm/stream tap 只拦本会话无 purpose 流，
 * 无 sessionId 直放行——已实证 index.ts:836-840）。
 */

/** ctx 的最小面（本模块只用 get('llm')/get('agentDefaultModel')；其余不依赖）。
 *  **必须走 ctx.get 可选查找，不能属性访问**：cordis 对未 inject 的服务属性访问抛错
 *  （ReflectService get trap「cannot get property without inject」，审查 B1 用兄弟插件
 *  实证复现）；本插件 host 半 inject=['webServer','settings','sessions']（index.ts:119），
 *  'llm'/'agentDefaultModel' 均不在内——属性访问会把同步抛射到路由外（host 未处理
 *  rejection + HTTP 永不响应）。同 index.ts:547/613 的 sessions/profileContext 模式。 */
export interface CorrectCtx {
  get?: (name: string) => unknown
}

/** ctx.get('llm') 的最小面。 */
interface LlmLike {
  stream(options: {
    provider: string
    model: string
    system?: string
    signal?: AbortSignal
    messages: { role: 'user'; content: { type: 'text'; text: string }[] }[]
  }): AsyncIterable<{ type: string; text?: string }>
}

/** ctx.get('agentDefaultModel') 的最小面。 */
interface DefaultModelLike {
  currentSelection?: () => { provider: string; model: string } | undefined
}

/** 纠错系统提示（双语；只做最小修正，禁止改写/补充/回答）。 */
export function correctionSystem(lang: 'zh' | 'en'): string {
  return lang === 'en'
    ? 'You are a speech-recognition corrector. The user text comes from ASR and may contain homophone errors, typos, or missing/wrong punctuation. Make only minimal fixes: correct typos/homophones and fix punctuation, preserving the original meaning and colloquial style. Do not rewrite sentences, do not add content, do not answer questions, and do not alter numbers or proper nouns. Output only the corrected text, with no explanation. If the input has no obvious errors, return it unchanged.'
    : '你是中文语音识别纠错器。用户的话来自语音识别（ASR），可能有同音字、错别字、标点缺失或错误。请只做最小修正：改错别字/同音字、补标点，保持原意与口语风格；不要改写句子、不要补充内容、不要回答问题、不要改变数字和专业术语。只输出修正后的文本，不要任何解释。如果原文没有明显错误，原样返回。'
}

/** 前言前缀形态（R1 I-3 护栏）：弱模型爱加「修正后：」「这是修正后的文本：」「Corrected:」
 *  等说明头。锚定行首、动词后限长内必须出现冒号（防误伤正文里偶合的词）。
 *  命中即回退原文——纠正是纯附加层，零护栏时用户消息会被模型的发挥静默替换。
 *  R2 误伤面收窄（Minor-2）：① zh 动词表去掉「修改」——「修改：把接口改成异步」是真实
 *  用户指令，命中=白丢一次纠错（方向安全但误伤）；保留 修正/纠正/更正/纠错 四个强信号
 *  （「纠错后」无冒号仍不命中，历史测试口径不变）。② en 分支补冒号要求与 zh 对齐——
 *  原版 "corrected" 无冒号也命中，面过宽。残余误伤（如「纠正一下：…」的指令形态）取舍：
 *  宁可漏纠（发原文），不可换字。 */
const CORRECTION_PREAMBLE_RE =
  /^(?:以下是|这是)?(?:修正|纠正|更正|纠错)[^。！？\n]{0,12}[：:]|^(?:here is (?:the )?)?(?:corrected|correction)\b[^.\n]{0,20}[：:]/i

/**
 * 纠错一条文本。任何失败（无 ctx.get / 无 llm 服务 / 无默认模型 / stream 抛错 /
 * 空结果）都原样返回——纠错不可用时行为与关闭设置一致（纯附加层）。
 */
export async function correctText(
  ctx: CorrectCtx | undefined,
  text: string,
  lang: 'zh' | 'en',
): Promise<string> {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return text
  try {
    // ctx.get 可选查找（审查 B1：属性访问对未 inject 服务抛错）——老宿主无 get/无服务
    // 均落 undefined → 回退原文。
    const llm = ctx?.get?.('llm') as LlmLike | undefined
    const sel = (ctx?.get?.('agentDefaultModel') as DefaultModelLike | undefined)?.currentSelection?.()
    if (!llm || typeof llm.stream !== 'function') return text
    if (!sel?.provider || !sel?.model) return text
    const stream = llm.stream({
      provider: sel.provider,
      model: sel.model,
      system: correctionSystem(lang),
      // host 侧自弃 10s（早于客户端 12s，审查 M3）：超时后流抛错→catch→回退原文，
      // 客户端不必等自己的 AbortSignal.timeout 才拿到响应（省 token 与等待）。
      signal: AbortSignal.timeout(10000),
      messages: [{ role: 'user', content: [{ type: 'text', text: trimmed }] }],
    })
    let out = ''
    for await (const chunk of stream) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
    }
    const corrected = out.trim()
    // R1 I-3：模型输出护栏——零护栏时弱模型加前言/复述/作答，用户消息被静默替换。
    // 廉价启发式，命中一律回退原文（宁可不纠，也不能把用户的话换成模型的发挥）：
    //   ① 超长（> max(3×原文, 原文+24)）＝复述/作答形态（纠错不应让文本膨胀数倍）。
    //      R2 修正：原 max(64, 3L) 的 64 下限对短输入完全旁路（L=7 时允许 9.1 倍膨胀，
    //      「现在几点」→「现在是下午三点。」这类简短作答可穿过）；改 max(3L, L+24) 后
    //      短输入阈值随输入收紧（L=7→31，约 4.4 倍；L≥12 起 3L 主导，长输入行为不变）。
    //      残留缺口（长度护栏原理性够不到）：与原文等长的简短「作答」仍可通过——
    //      要拦它需字符重合度等相似度判据（有误伤合法重纠的风险，不进本廉价护栏）。
    //   ② 前言前缀（「修正后：」「Corrected:」等）＝带说明输出。
    if (corrected.length > Math.max(trimmed.length * 3, trimmed.length + 24)) return text
    if (CORRECTION_PREAMBLE_RE.test(corrected)) return text
    return corrected || text
  } catch {
    return text
  }
}
