/**
 * Issue #15 批 4b：LLM 纠错单测（纯模块六态 + wiring 锁）。
 * 运行：node test/llm-correct.test.mjs（npm test 串联）。
 *
 * 覆盖：
 *  1) correctText：流拼接触发 / 无 ctx.llm 回退 / 无默认模型回退 / stream 抛错回退 /
 *     空结果回退 / 空输入直返；
 *  2) correctionSystem：双语提示含关键约束（最小修正/禁止改写）；
 *  3) wiring 锁：host /correct 路由 + llmCorrect 设置十站（interface/默认/DESC/zod×2/
 *     fromConfig/config 响应）+ client correctDraft + submitDraftNow 纠错预步（命令不纠错）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '..')
const { correctText, correctionSystem } = await import(
  pathToFileURL(join(root, 'src', 'llm-correct.ts')).href
)

let passed = 0
const t = async (name, fn) => {
  await fn()
  passed++
  console.log('  ✓ ' + name)
}

const streamOf = (chunks) => ({
  async *[Symbol.asyncIterator]() {
    for (const c of chunks) yield c
  },
})

// ctx.get 形态（审查 B1 后）：真宿主是非 inject 服务属性访问抛错的 proxy，模块必须走 get。
const ctxWith = (chunks) => ({
  get: (name) =>
    name === 'llm'
      ? { stream: () => streamOf(chunks) }
      : name === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
        : undefined,
})

await t('流拼接：text-delta 累积为纠错文本', async () => {
  const ctx = ctxWith([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '帮我查' },
    { type: 'reasoning-delta', index: 1, text: '（思考不应入文本）' },
    { type: 'text-delta', index: 0, text: '一下天气' },
    { type: 'block-stop', index: 0 },
  ])
  assert.equal(await correctText(ctx, '帮我查一下天气', 'zh'), '帮我查一下天气')
})

await t('回退①：ctx.get 无 llm 服务 / ctx 缺失 → 原样返回', async () => {
  assert.equal(await correctText({ get: () => undefined }, '原文', 'zh'), '原文')
  assert.equal(await correctText({}, '原文', 'zh'), '原文')
  assert.equal(await correctText(undefined, '原文', 'zh'), '原文')
})

await t('回退②：无默认模型选择 → 原样返回', async () => {
  const noSel = { get: (n) => (n === 'llm' ? { stream: () => streamOf([]) } : n === 'agentDefaultModel' ? {} : undefined) }
  assert.equal(await correctText(noSel, '原文', 'zh'), '原文')
  const selUndef = { get: (n) => (n === 'llm' ? { stream: () => streamOf([]) } : n === 'agentDefaultModel' ? { currentSelection: () => undefined } : undefined) }
  assert.equal(await correctText(selUndef, '原文', 'zh'), '原文')
})

await t('B1 回归：属性访问抛错的真 cordis 形态 ctx（proxy）→ 不抛、原样返回', async () => {
  // 复刻审查 B1 的实证形态：ReflectService get trap 对未 inject 服务抛错。
  const throwing = new Proxy({}, { get(_t, prop) { throw new Error(`cannot get property "${String(prop)}" without inject`) } })
  assert.equal(await correctText(throwing, '原文', 'zh'), '原文', '属性访问抛错不得逃逸（否则 host 未处理 rejection+HTTP 永不响应）')
  // get 可用但 llm/agentDefaultModel 属性仍抛——证明走 get 即可正常工作
  // 注意：mock 的纠错输出不能以纠正动词（修正/纠正/更正/纠错）开头——那会被
  // llm-correct.ts 的 CORRECTION_PREAMBLE_RE 前言护栏命中并回退原文（R1 I-3，
  // 方向正确：这类输出本就是前言样文本）。故用 '改好的文本' 这类非动词前缀串，
  // 保持本用例意图（proxy 抛错形态下纠错仍生效）不变。
  const mixed = new Proxy({ get: (n) => (n === 'llm' ? { stream: () => streamOf([{ type: 'text-delta', index: 0, text: '改好的文本' }]) } : n === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined) }, { get(t, prop) { if (prop === 'get') return t.get; throw new Error('no inject') } })
  assert.equal(await correctText(mixed, '原文', 'zh'), '改好的文本', '走 ctx.get 的属性抛错形态下纠错仍生效')
})

await t('回退③：stream 抛错 → 原样返回（纠错不可用不阻断发送）', async () => {
  const ctx = {
    get: (n) =>
      n === 'llm'
        ? {
            stream: () => ({
              async *[Symbol.asyncIterator]() {
                throw new Error('provider down')
              },
            }),
          }
        : n === 'agentDefaultModel'
          ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
          : undefined,
  }
  assert.equal(await correctText(ctx, '原文', 'zh'), '原文')
})

await t('回退④：空结果（无 text-delta）→ 原样返回', async () => {
  assert.equal(await correctText(ctxWith([{ type: 'block-start', index: 0, blockType: 'text' }]), '原文', 'zh'), '原文')
})

await t('回退⑤：空输入直返（不发请求）', async () => {
  let called = false
  const ctx = { get: (n) => (n === 'llm' ? { stream: () => { called = true; return streamOf([]) } } : n === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined) }
  assert.equal(await correctText(ctx, '   ', 'zh'), '   ')
  assert.equal(called, false, '空输入不应发 LLM 请求')
})

await t('M-3：带寒暄前缀的说明头（英文侧）→ 回退原文（元叙述不得进入用户消息）', async () => {
  // 弱模型在说明头前加一句客套（"OK, ""Sure,"）即越过前言护栏的 ^ 锚，元叙述原样
  // 进入用户消息（autoSend 默认开会直接发出去）。长度护栏兜不住——见前置断言。
  const src = 'hello world'
  const threshold = Math.max(src.length * 3, src.length + 24)
  for (const out of ['OK, corrected: hello world', 'Sure, corrected: hello world']) {
    assert.ok(out.length < threshold, `前置条件：样例长度应低于长度护栏阈值 ${threshold}（否则本例测的是长度护栏）`)
    assert.equal(
      await correctText(ctxWith([{ type: 'text-delta', index: 0, text: out }]), src, 'en'),
      src,
      '寒暄前缀绕过前言护栏：模型元叙述原样进入用户消息',
    )
  }
})

await t('M-2：模型只回寒暄没给正文（剥成空串）→ 回退原文（zh + en）', async () => {
  // 弱模型只回了客套（「好的，」「Sure,」）没给正文——剥完是空串。
  // 空串是信号：此前没被消费，模型输出直接顶替了用户消息（autoSend 默认开会直接发出去）。
  const zhSrc = '今天天气不错'
  assert.equal(
    await correctText(ctxWith([{ type: 'text-delta', index: 0, text: '好的，' }]), zhSrc, 'zh'),
    zhSrc,
    '剥成空串未回退原文（zh）——模型输出直接顶替了用户消息',
  )
  const enSrc = 'hello world'
  assert.equal(
    await correctText(ctxWith([{ type: 'text-delta', index: 0, text: 'Sure,' }]), enSrc, 'en'),
    enSrc,
    '剥成空串未回退原文（en）——模型输出直接顶替了用户消息',
  )
})

await t('M-2：zh 侧寒暄词（好的/当然/好吧/行吧/是的）→ 寒暄后面的说明头仍被前言护栏兜住', async () => {
  // 此前 zh 侧寒暄词一条测试都没有（只测了英文两个样例）——护栏在这半边是零覆盖。
  // R5 起：寒暄剥离只用于「让前言正则看穿寒暄」，不再改写模型输出（见 M-6），
  // 故这里的可观测量是「寒暄后面的说明头仍被兜住」。
  const src = '今天天气不错'
  for (const filler of ['好的，', '当然，', '好吧，', '行吧，', '是的，']) {
    const out = filler + '修正后的文本：今天天气不错'
    assert.ok(out.length < Math.max(src.length * 3, src.length + 24), '前置条件：样例长度应低于长度护栏阈值')
    assert.equal(
      await correctText(ctxWith([{ type: 'text-delta', index: 0, text: out }]), src, 'zh'),
      src,
      `寒暄「${filler}」后面的说明头未被前言护栏兜住（元叙述不得进用户消息）`,
    )
  }
})

await t('M-6：用户原话以寒暄词开头时不得被削（输出原样保留问候）', async () => {
  // 回归来源：上一批「剥后是正文 → 用剥后正文」把**用户自己说的**开头问候也削了：
  //   「好的，我知道了。」→「我知道了。」；「Hi, what time is it」→「what time is it」；
  //   「Hello there」→「there」（整句削成残句）——用户消息被静默改写后直接发出去。
  // 判据：模型加的客套与用户自己说的问候在输出里形态完全相同，且模型输出与用户原话
  //   之间没有可靠对应关系 → **无法区分** → 剥后的串只用于前言判定，绝不作为输出。
  for (const [src, lang] of [
    ['好的，我知道了。', 'zh'],
    ['Hi, what time is it', 'en'],
    ['Hello there', 'en'],
  ]) {
    assert.equal(
      await correctText(ctxWith([{ type: 'text-delta', index: 0, text: src }]), src, lang),
      src,
      `用户原话以寒暄开头却被削（用户的话被静默改写）：${src}`,
    )
  }
  // 模型把用户的问候保留、只改了标点 → 问候同样必须原样保留。
  assert.equal(
    await correctText(ctxWith([{ type: 'text-delta', index: 0, text: '好的，我知道了!' }]), '好的，我知道了。', 'zh'),
    '好的，我知道了!',
    '用户自己的问候被削掉了（只该改标点，不该削问候）',
  )
  // 保守取舍：模型给「本来没有寒暄」的原话加了寒暄 → 寒暄保留（不改写用户的话），
  // 而不是把它剥掉——剥了就无法保证剩下的是用户的原话（见 M-6 注释）。
  assert.equal(
    await correctText(ctxWith([{ type: 'text-delta', index: 0, text: '好的，我知道了。' }]), '我知道了。', 'zh'),
    '好的，我知道了。',
    '模型加的寒暄被剥掉了（保守口径：宁可保留寒暄，也不改写用户的话）',
  )
})

await t('M-2：叠着寒暄（好的，当然，这是修正结果：…）→ 回退原文（循环剥离 + 说明头命中）', async () => {
  const src = '今天天气不错'
  assert.equal(
    await correctText(ctxWith([{ type: 'text-delta', index: 0, text: '好的，当然，这是修正结果：今天天气不错。' }]), src, 'zh'),
    src,
    '叠着寒暄的说明头未回退原文（元叙述不得进用户消息）',
  )
})

await t('M-7：纯寒暄（无尾随标点：「好的」「Sure」「OK」「当然」）→ 回退原文', async () => {
  // 寒暄前缀正则要求每个词后面跟分隔符（否则会误剥「好的东西」）→ 这类**无标点**
  // 的纯客套原本不被识别为寒暄 → 整串三档判据被跳过 → 模型输出（只有「好的」）
  // 直接顶替了用户消息（autoSend 默认开会把它发出去）。
  const zhSrc = '今天天气不错'
  for (const out of ['好的', '当然', '好吧', '行吧', '是的', '当然可以']) {
    assert.ok(
      out.length < Math.max(zhSrc.length * 3, zhSrc.length + 24),
      '前置条件：样例长度应低于长度护栏阈值（否则本例测的是长度护栏）',
    )
    assert.equal(
      await correctText(ctxWith([{ type: 'text-delta', index: 0, text: out }]), zhSrc, 'zh'),
      zhSrc,
      `纯寒暄「${out}」未回退原文（模型输出直接顶替了用户消息）`,
    )
  }
  const enSrc = 'hello world'
  for (const out of ['Sure', 'OK', 'Okay', 'Hello', 'Certainly']) {
    assert.ok(
      out.length < Math.max(enSrc.length * 3, enSrc.length + 24),
      '前置条件：样例长度应低于长度护栏阈值（否则本例测的是长度护栏）',
    )
    assert.equal(
      await correctText(ctxWith([{ type: 'text-delta', index: 0, text: out }]), enSrc, 'en'),
      enSrc,
      `纯寒暄「${out}」未回退原文（模型输出直接顶替了用户消息）`,
    )
  }
  // 反向：不能把「以寒暄词开头的合法正文」误判成纯寒暄（M-6 的不变量）：
  // 「好的东西」不是纯寒暄 → 原样通过（不被回退、不被削）。
  assert.equal(
    await correctText(ctxWith([{ type: 'text-delta', index: 0, text: '好的东西' }]), '好的东西', 'zh'),
    '好的东西',
    '「好的东西」被误判成纯寒暄——以寒暄词开头的合法正文必须原样通过',
  )
})

await t('M-8：空白分隔的叠着寒暄（好的 好的  Sure, corrected: …）→ 回退原文（循环剥离）', async () => {
  // 既有的叠层锁用**逗号**分隔形态 → 单次 replace 即可吃完（量词 (...)+ 贪婪），
  // 锁不到循环：空白分隔时单次 replace 会留下前导空白，锚定 ^ 的前言正则
  // 看不见说明头 → 模型元叙述泄漏进用户消息。
  const src = '原'.repeat(20)
  const out = '好的 好的  Sure, corrected: 今天天气不错'
  assert.ok(
    out.length < Math.max(src.length * 3, src.length + 24),
    '前置条件：样例长度应低于长度护栏阈值（否则本例测的是长度护栏）',
  )
  assert.equal(
    await correctText(ctxWith([{ type: 'text-delta', index: 0, text: out }]), src, 'zh'),
    src,
    '空白分隔的叠着寒暄未被剥穿——模型元叙述泄漏进用户消息',
  )
})

// --------------------------------------------------------------------------
// MO-3（Issue #15 R8 发版前）：纯寒暄的判定域由词表圈定——词表外的客套应答
// （Yes / Thank you / Got it / 嗯 / 收到 …）仍会整条顶替用户原话。
// 词表在此**枚举**（与 src/llm-correct.ts 的 CORRECTION_FILLER_WORDS 对应）——
// 枚举本身就是锁：新增/漏词都会红。
// --------------------------------------------------------------------------
const FILLER_ZH = ['好的', '当然', '当然可以', '好吧', '行吧', '行', '是的', '嗯', '收到', '明白了', '知道了']
const FILLER_EN = [
  'OK', 'Okay', 'Sure', 'Certainly', 'Alright', 'Understood', 'Hello', 'Hi',
  'Yes', 'Thank you', 'Thanks', 'Got it', 'Of course',
]

await t('MO-3：模型只回客套应答（词表全枚举）→ 回退原文（用户原话不得被顶替）', async () => {
  const zhSrc = '帮我把接口改成异步的'
  for (const w of FILLER_ZH) {
    assert.ok(
      w.length < Math.max(zhSrc.length * 3, zhSrc.length + 24),
      '前置条件：样例长度应低于长度护栏阈值（否则本例测的是长度护栏）',
    )
    assert.equal(
      await correctText(ctxWith([{ type: 'text-delta', index: 0, text: w }]), zhSrc, 'zh'),
      zhSrc,
      `模型只回「${w}」未回退原文（用户原话被静默丢弃）`,
    )
  }
  const enSrc = 'make the interface async please'
  for (const w of FILLER_EN) {
    assert.ok(
      w.length < Math.max(enSrc.length * 3, enSrc.length + 24),
      '前置条件：样例长度应低于长度护栏阈值（否则本例测的是长度护栏）',
    )
    assert.equal(
      await correctText(ctxWith([{ type: 'text-delta', index: 0, text: w }]), enSrc, 'en'),
      enSrc,
      `模型只回「${w}」未回退原文（用户原话被静默丢弃）`,
    )
  }
})

await t('MO-3：客套 + 正文 → 不误判为纯寒暄（M-6 不变量：用户原话不得被削）', async () => {
  // 逐词验证：词 + 正文 不是「整串纯寒暄」→ 输出原样保留（既不回退、也不被削）。
  for (const w of FILLER_ZH) {
    const out = w + '，我知道了。'
    assert.ok(
      out.length < Math.max('今天天气不错'.length * 3, '今天天气不错'.length + 24),
      '前置条件：样例长度应低于长度护栏阈值（否则本例测的是长度护栏）',
    )
    assert.equal(
      await correctText(ctxWith([{ type: 'text-delta', index: 0, text: out }]), '今天天气不错', 'zh'),
      out,
      `「${w}，我知道了。」被误判为纯寒暄——用户原话不得被削`,
    )
  }
  for (const w of FILLER_EN) {
    const out = w + ', I got it'
    assert.ok(
      out.length < Math.max('check the weather'.length * 3, 'check the weather'.length + 24),
      '前置条件：样例长度应低于长度护栏阈值（否则本例测的是长度护栏）',
    )
    assert.equal(
      await correctText(ctxWith([{ type: 'text-delta', index: 0, text: out }]), 'check the weather', 'en'),
      out,
      `「${w}, I got it」被误判为纯寒暄——用户原话不得被削`,
    )
  }
})

// --------------------------------------------------------------------------
// MO-4（Issue #15 R8）：前言正则的**撇号形态**漏检——`here is` 不匹配 `here's`，
// 弱模型写 "here's corrected: …" / "here's the corrected text: …" 时越过 ^ 锚，
// 元叙述静默顶替用户消息（与 M-2/M-3 同型）。
// --------------------------------------------------------------------------
await t('MO-4：撇号形态的前言（here\'s corrected: / here\'s the corrected text:）→ 回退原文', async () => {
  const src = '帮我把接口改成异步的，谢谢'
  for (const out of ["here's corrected: 今天天气不错", "here's the corrected text: 今天天气不错"]) {
    assert.ok(
      out.length < Math.max(src.length * 3, src.length + 24),
      `前置条件：样例长度应低于长度护栏阈值（否则本例测的是长度护栏）：len=${out.length}`,
    )
    assert.equal(
      await correctText(ctxWith([{ type: 'text-delta', index: 0, text: out }]), src, 'zh'),
      src,
      `撇号形态的前言「${out}」未回退原文（元叙述不得进用户消息）`,
    )
  }
})

await t('MO-4：用户原话本就含 "here\'s" → 不得被当成元叙述回退（不误伤合法正文）', async () => {
  // 边界：用户原话里本就含 here's（如「here's the thing you asked for」）→
  // 那不是模型加的说明头 → 模型输出原样保留（不回退原文）。
  const src = "here's the thing you asked for"
  assert.equal(
    await correctText(ctxWith([{ type: 'text-delta', index: 0, text: src }]), src, 'en'),
    src,
    '用户原话含 "here\'s" 被误判成元叙述',
  )
  // 模型只改了标点（合法纠错）时也应保留——不得因含 here's 而回退原文。
  assert.equal(
    await correctText(ctxWith([{ type: 'text-delta', index: 0, text: "here's the thing you asked for!" }]), src, 'en'),
    "here's the thing you asked for!",
    '模型只改了标点却被回退（用户原话含 "here\'s"）',
  )
  // 「corrected」不在问候语之后（说明头形态是「here's [the] corrected…」）→
  // 合法正文不得被当说明头。**模型输出须与原文不同**，否则「回退原文」与「原样返回」
  // 观察上不可区分（回退返回的就是原文本身）——故用改标点的版本。
  const src2 = "here's my file, already corrected"
  assert.equal(
    await correctText(ctxWith([{ type: 'text-delta', index: 0, text: "here's my file, already corrected!" }]), src2, 'en'),
    "here's my file, already corrected!",
    '「corrected」不在问候语之后的合法正文被当成了说明头（模型只改标点也被回退）',
  )
})

// --------------------------------------------------------------------------
// MO-5（Issue #15 R8）：前言正则的**冠词形态**只收 `the` → "here's a correction: …"
// / "here is a corrected version: …" 仍漏检（与 MO-4 同型：模型元叙述静默顶替用户消息）。
//
// 判据（与既有形态统一）：`corrected`/`correction` **紧跟在引导语（here is / here's）
// 及其冠词之后** ⇒ 说明头（回退原文）；`corrected` 出现在别处 ⇒ 正文（不判说明头）。
// "here's a corrected file" 按此判据 ⇒ **说明头**（回退原文）：冠词是说明头形态的
// 一部分，不是判别依据；且两种误判代价不对称——判成正文 = 模型元叙述顶替用户话
// （发布说明第 9 条要修的正是这个），判成说明头 = 白丢一次纠错（用户话仍在）。
// 锁形态沿用 MO-4 已验证的：**模型输出与原文不同**（否则回退与原样返回不可区分）。
// --------------------------------------------------------------------------
await t('MO-5：冠词形态的前言（here\'s a correction: / here is a corrected version:）→ 回退原文', async () => {
  const src = '帮我把接口改成异步的，谢谢'
  for (const out of ["here's a correction: 今天天气不错", 'here is a corrected version: 今天天气不错']) {
    assert.ok(
      out.length < Math.max(src.length * 3, src.length + 24),
      `前置条件：样例长度应低于长度护栏阈值（否则本例测的是长度护栏）：len=${out.length}`,
    )
    assert.equal(
      await correctText(ctxWith([{ type: 'text-delta', index: 0, text: out }]), src, 'zh'),
      src,
      `冠词形态的前言「${out}」未回退原文（元叙述不得进用户消息）`,
    )
  }
})

await t('MO-5：冠词 + corrected 的说明头形态（here\'s a corrected file）→ 判为说明头（回退原文）', async () => {
  // 判据：corrected 紧跟在引导语及其冠词之后 ⇒ 说明头。
  // 锁形态：模型输出与原文不同（只差标点）——否则「回退原文」与「原样返回」不可区分。
  const src = "here's a corrected file"
  assert.equal(
    await correctText(ctxWith([{ type: 'text-delta', index: 0, text: "here's a corrected file!" }]), src, 'en'),
    src,
    '「here\'s a corrected file」应判为说明头并回退原文（冠词是说明头形态的一部分）',
  )
})

await t('correctionSystem：双语提示含关键约束', () => {
  const zh = correctionSystem('zh')
  const en = correctionSystem('en')
  assert.ok(zh.length > 20 && en.length > 20, '提示为空')
  assert.ok(zh.includes('同音字') && zh.includes('不要改写'), 'zh 缺关键约束')
  assert.ok(en.includes('homophone') && /do not rewrite/i.test(en), 'en 缺关键约束')
  assert.notEqual(zh, en, '双语提示相同')
})

// ---- wiring 锁 ----
const indexSrc = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
const clientSrc = readFileSync(join(root, 'src', 'client.tsx'), 'utf8')
const stringsSrc = readFileSync(join(root, 'src', 'strings.ts'), 'utf8')
const formSrc = readFileSync(join(root, 'src', 'settings-form.tsx'), 'utf8')

await t('wiring：host /correct 路由存在（loopback+跨源守卫+collectBody+correctText）', () => {
  const idx = indexSrc.indexOf('path: `${base}/correct`')
  assert.ok(idx >= 0, '缺 /correct 路由')
  // 窗口取到路由结束（下一个 ctx.effect 注册处）而非固定长度：M6 重构在该路由内
  // 插入了 enabled/限流分流，固定窗口会把待锁的 .catch 与 limiter 门切在窗外。
  const end = indexSrc.indexOf('ctx.effect(() =>', idx + 10)
  const win = indexSrc.slice(idx - 200, end > idx ? end : idx + 1800)
  assert.ok(win.includes('denyNonLoopback'), '缺 loopback 守卫')
  assert.ok(win.includes('denyCrossOrigin'), '缺跨源守卫')
  assert.ok(win.includes('correctText(ctx,'), '未调 correctText')
  // 审查 Minor-2：路由层 .catch 恒 200 与 limiter 门也要锁（删了全量套件仍绿过）
  assert.ok(win.includes('.catch('), '缺 .catch 恒 200——correctText 异常会逃逸成未处理 rejection+HTTP 永不响应')
  // M6：键从全局 'correct' 改为 per-client（反代部署下限流桶不塌缩）
  assert.ok(/limiter\.hit\(`correct:\$\{clientKey\(req\)\}`/.test(win), '缺 per-client 限流门——本地页面可无上限触发 LLM 调用')
  // M6：enabled=false 返 403 voice_disabled（与限流 429 分流，不再混为一谈）
  assert.ok(win.includes("respondJson(res, 403, { code: 'voice_disabled'"), 'enabled=false 未返 403 voice_disabled')
  // M6：lang 归一化走 prompts.ts 单一真源，不再内联 === 'en'
  assert.ok(win.includes('normalizePromptLang(parsed.lang)'), 'lang 未走 normalizePromptLang（内联 === 会误判 en-US/zh-CN）')
})

await t('wiring：llmCorrect 设置十站（interface/默认/DESC/zod×2/fromConfig×2/config 响应）', () => {
  assert.ok((indexSrc.match(/llmCorrect: boolean/g) ?? []).length === 2, 'interface 两处缺（VoiceSettingsValue + Config）')
  assert.ok(indexSrc.includes('llmCorrect: false,'), '默认值缺')
  assert.ok(indexSrc.includes('llmCorrect: en.descLlmCorrect,'), 'DESC 缺')
  assert.ok((indexSrc.match(/llmCorrect: z/g) ?? []).length === 2, 'zod 两处（settings schema + boot schema）缺失')
  assert.ok((indexSrc.match(/bargeInSalvage, llmCorrect,/g) ?? []).length === 2, 'fromConfig 解构+返回两处缺')
  assert.ok(indexSrc.includes('llmCorrect: vset.llmCorrect,'), '/config 响应透传缺')
})

await t('wiring：strings 双语 label+desc', () => {
  assert.ok(stringsSrc.includes("llmCorrectLabel: 'LLM 纠错'"), 'zh label 缺')
  assert.ok(stringsSrc.includes("llmCorrectLabel: 'LLM correction'"), 'en label 缺')
  assert.ok(stringsSrc.includes('descLlmCorrect:'), 'desc 缺')
})

await t('wiring：settings-form 显式 Row', () => {
  assert.ok(formSrc.includes('name="llmCorrect"'), '设置面板缺 Row')
})

await t('wiring：client 四站（DEFAULT_BOOT/VoiceBootConfig/bootNow/fetchConfig）+ correctDraft', () => {
  assert.ok((clientSrc.match(/llmCorrect: false/g) ?? []).length === 2, 'DEFAULT_BOOT+bootNow 缺')
  assert.ok(clientSrc.includes('llmCorrect: boolean'), 'VoiceBootConfig 缺')
  assert.ok(clientSrc.includes('llmCorrect: c.llmCorrect === true,'), 'fetchConfig 缺（=== true：默认关）')
  const idx = clientSrc.indexOf('const correctDraft =')
  assert.ok(idx >= 0, '缺 correctDraft')
  const win = clientSrc.slice(idx, idx + 900)
  assert.ok(win.includes('/correct'), 'correctDraft 未打 /correct')
  assert.ok(win.includes('AbortSignal.timeout'), 'correctDraft 缺超时')
})

await t('wiring：submitDraftNow 纠错预步（默认关才走+命令不纠错+失败回退 runSubmit）', () => {
  const idx = clientSrc.indexOf("bootNow().llmCorrect === true")
  assert.ok(idx >= 0, '缺纠错分支条件')
  // 窗口取到纠错分支结束（下一个 '}, AUTO_SEND' 定时器注册处）而非固定长度：
  // client 侧有效性复核块在历次审查中逐轮增厚，固定窗口会把 runSubmit 切在窗外。
  const branchEnd = clientSrc.indexOf('}, AUTO_SEND', idx)
  const win = clientSrc.slice(idx - 100, branchEnd > idx ? branchEnd : idx + 400)
  assert.ok(win.includes("draftSnapshot.startsWith('/')"), '命令草稿未排除（会绕过宿主 adjudication）')
  assert.ok(win.includes('correctDraft(draftSnapshot).then'), '未走 correctDraft')
  assert.ok(win.includes('runSubmit(finalText)'), '未回退 runSubmit（纠错失败=不发送）')
})

await t('wiring 顺序（审查 I4）：纠错分支 correctDraft.then 后必须 return（删 return=双发）', () => {
  const idx = clientSrc.indexOf('correctDraft(draftSnapshot).then')
  assert.ok(idx >= 0, '缺纠错调用')
  const win = clientSrc.slice(idx, idx + 1400)
  const runIdx = win.indexOf('runSubmit(finalText)')
  assert.ok(runIdx >= 0, 'then 内未调 runSubmit')
  const returnIdx = win.indexOf('return', runIdx)
  assert.ok(returnIdx > runIdx, 'then 之后缺 return——纠错路径会 fall-through 到立即 runSubmit(draftSnapshot)（双发）')
  const tail = win.slice(returnIdx)
  assert.ok(tail.includes('runSubmit(draftSnapshot)'), 'then+return 之后未见非纠错路径的 runSubmit(draftSnapshot)')
})

await t('wiring（审查 I1）：纠错 then 内必须有效性复核（RTT 内退出/改写 → 放弃发送）', () => {
  const idx = clientSrc.indexOf('correctDraft(draftSnapshot).then')
  const win = clientSrc.slice(idx, idx + 1400)
  assert.ok(win.includes('submitInFlightRef.current'), '缺在途标记复核——退出/打字/抢占后幽灵提交')
  // 草稿未变复核：早年为 !== 写法，Issue #15 UX-I2 起收敛为 valid 表达式里的
  // === 判断（语义等价：任一条件不成立即放弃发送）。两种写法都接受。
  assert.ok(
    win.includes("draftRef.current.trim() !== draftSnapshot") || /draftRef\.current\.trim\(\) === draftSnapshot/.test(win),
    '缺草稿未变复核——用户改写后旧 snapshot 覆盖用户文本',
  )
})

await t('wiring（审查 I2）：steer 守卫基线按写回是否落地取（wroteBack）', () => {
  const idx = clientSrc.indexOf('wroteBack')
  assert.ok(idx >= 0, '缺写回成功跟踪')
  assert.ok(clientSrc.includes('wroteBack = true'), '写回成功未记录')
  assert.ok(clientSrc.includes('wroteBack ? snapshot : draftSnapshot'), '守卫基线未按写回落地与否分流——写回失败时已发消息与原文草稿并存')
})

console.log(`\nllm-correct：${passed} 项通过`)
