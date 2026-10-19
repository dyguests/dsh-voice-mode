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
  const mixed = new Proxy({ get: (n) => (n === 'llm' ? { stream: () => streamOf([{ type: 'text-delta', index: 0, text: '纠错后' }]) } : n === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined) }, { get(t, prop) { if (prop === 'get') return t.get; throw new Error('no inject') } })
  assert.equal(await correctText(mixed, '原文', 'zh'), '纠错后', '走 ctx.get 的属性抛错形态下纠错仍生效')
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

t('correctionSystem：双语提示含关键约束', () => {
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

t('wiring：host /correct 路由存在（loopback+跨源守卫+collectBody+correctText）', () => {
  const idx = indexSrc.indexOf('path: `${base}/correct`')
  assert.ok(idx >= 0, '缺 /correct 路由')
  const win = indexSrc.slice(idx - 200, idx + 1800)
  assert.ok(win.includes('denyNonLoopback'), '缺 loopback 守卫')
  assert.ok(win.includes('denyCrossOrigin'), '缺跨源守卫')
  assert.ok(win.includes('correctText(ctx,'), '未调 correctText')
})

t('wiring：llmCorrect 设置十站（interface/默认/DESC/zod×2/fromConfig×2/config 响应）', () => {
  assert.ok((indexSrc.match(/llmCorrect: boolean/g) ?? []).length === 2, 'interface 两处缺（VoiceSettingsValue + Config）')
  assert.ok(indexSrc.includes('llmCorrect: false,'), '默认值缺')
  assert.ok(indexSrc.includes('llmCorrect: en.descLlmCorrect,'), 'DESC 缺')
  assert.ok((indexSrc.match(/llmCorrect: z/g) ?? []).length === 2, 'zod 两处（settings schema + boot schema）缺失')
  assert.ok((indexSrc.match(/bargeInSalvage, llmCorrect,/g) ?? []).length === 2, 'fromConfig 解构+返回两处缺')
  assert.ok(indexSrc.includes('llmCorrect: vset.llmCorrect,'), '/config 响应透传缺')
})

t('wiring：strings 双语 label+desc', () => {
  assert.ok(stringsSrc.includes("llmCorrectLabel: 'LLM 纠错'"), 'zh label 缺')
  assert.ok(stringsSrc.includes("llmCorrectLabel: 'LLM correction'"), 'en label 缺')
  assert.ok(stringsSrc.includes('descLlmCorrect:'), 'desc 缺')
})

t('wiring：settings-form 显式 Row', () => {
  assert.ok(formSrc.includes('name="llmCorrect"'), '设置面板缺 Row')
})

t('wiring：client 四站（DEFAULT_BOOT/VoiceBootConfig/bootNow/fetchConfig）+ correctDraft', () => {
  assert.ok((clientSrc.match(/llmCorrect: false/g) ?? []).length === 2, 'DEFAULT_BOOT+bootNow 缺')
  assert.ok(clientSrc.includes('llmCorrect: boolean'), 'VoiceBootConfig 缺')
  assert.ok(clientSrc.includes('llmCorrect: c.llmCorrect === true,'), 'fetchConfig 缺（=== true：默认关）')
  const idx = clientSrc.indexOf('const correctDraft =')
  assert.ok(idx >= 0, '缺 correctDraft')
  const win = clientSrc.slice(idx, idx + 900)
  assert.ok(win.includes('/correct'), 'correctDraft 未打 /correct')
  assert.ok(win.includes('AbortSignal.timeout'), 'correctDraft 缺超时')
})

t('wiring：submitDraftNow 纠错预步（默认关才走+命令不纠错+失败回退 runSubmit）', () => {
  const idx = clientSrc.indexOf("bootNow().llmCorrect === true")
  assert.ok(idx >= 0, '缺纠错分支条件')
  const win = clientSrc.slice(idx - 100, idx + 400)
  assert.ok(win.includes("draftSnapshot.startsWith('/')"), '命令草稿未排除（会绕过宿主 adjudication）')
  assert.ok(win.includes('correctDraft(draftSnapshot).then'), '未走 correctDraft')
  assert.ok(win.includes('runSubmit(finalText)'), '未回退 runSubmit（纠错失败=不发送）')
})

t('wiring 顺序（审查 I4）：纠错分支 correctDraft.then 后必须 return（删 return=双发）', () => {
  const idx = clientSrc.indexOf('correctDraft(draftSnapshot).then')
  assert.ok(idx >= 0, '缺纠错调用')
  const win = clientSrc.slice(idx, idx + 700)
  const runIdx = win.indexOf('runSubmit(finalText)')
  assert.ok(runIdx >= 0, 'then 内未调 runSubmit')
  const returnIdx = win.indexOf('return', runIdx)
  assert.ok(returnIdx > runIdx, 'then 之后缺 return——纠错路径会 fall-through 到立即 runSubmit(draftSnapshot)（双发）')
  const tail = win.slice(returnIdx)
  assert.ok(tail.includes('runSubmit(draftSnapshot)'), 'then+return 之后未见非纠错路径的 runSubmit(draftSnapshot)')
})

t('wiring（审查 I1）：纠错 then 内必须有效性复核（RTT 内退出/改写 → 放弃发送）', () => {
  const idx = clientSrc.indexOf('correctDraft(draftSnapshot).then')
  const win = clientSrc.slice(idx, idx + 700)
  assert.ok(win.includes('submitInFlightRef.current'), '缺在途标记复核——退出/打字/抢占后幽灵提交')
  assert.ok(win.includes("draftRef.current.trim() !== draftSnapshot"), '缺草稿未变复核——用户改写后旧 snapshot 覆盖用户文本')
})

t('wiring（审查 I2）：steer 守卫基线按写回是否落地取（wroteBack）', () => {
  const idx = clientSrc.indexOf('wroteBack')
  assert.ok(idx >= 0, '缺写回成功跟踪')
  assert.ok(clientSrc.includes('wroteBack = true'), '写回成功未记录')
  assert.ok(clientSrc.includes('wroteBack ? snapshot : draftSnapshot'), '守卫基线未按写回落地与否分流——写回失败时已发消息与原文草稿并存')
})

console.log(`\nllm-correct：${passed} 项通过`)
