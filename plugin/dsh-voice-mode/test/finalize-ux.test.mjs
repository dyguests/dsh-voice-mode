/**
 * Issue #15 批 4a：定稿链路口径与 UX 单测（超时对齐 + 快速/准确模式文案 + 定稿耗时）。
 * 运行：node test/finalize-ux.test.mjs（npm test 串联）。
 *
 * 覆盖（源码锁+词典闭合，本仓 client.tsx 无组件挂载设施的既定模式）：
 *  1) asr.ts 三处 final fetch 超时 25s（对齐 host SenseVoice race 上限 20s——原 10s
 *     必触发一次空转重试，asr-host.ts:591-594）；
 *  2) strings.ts descSenseVoice 快速/准确模式语义化 + recognizingSec 双语占位键；
 *  3) client.tsx VoiceStatusBar 的 transcribingSec wiring（>=2s 才显示耗时）；
 *  4) R1 I-3：correctText 输出护栏（超长回退 + 前言回退，行为测试——llm-correct.test.mjs
 *     归 host/test teammate 维护，本文件先行落地两态锁，PM 可令其合并）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '..')
const read = (f) => readFileSync(join(root, f), 'utf8')

const { correctText } = await import(pathToFileURL(join(root, 'src', 'llm-correct.ts')).href)

let passed = 0
const t = async (name, fn) => {
  await fn()
  passed++
  console.log('  ✓ ' + name)
}

const asrSrc = read('src/asr.ts')
const clientSrc = read('src/client.tsx')
const stringsSrc = read('src/strings.ts')

await t('asr.ts：三处 final fetch 超时为 25s（对齐 host 20s race；无残留 10000）', () => {
  const n25 = (asrSrc.match(/AbortSignal\.timeout\(25000\)/g) ?? []).length
  assert.equal(n25, 3, `应有 3 处 25000（实际 ${n25}）——final 三处尝试全部对齐`)
  assert.ok(!asrSrc.includes('AbortSignal.timeout(10000)'), '仍有 10000 残留——慢定稿会空转重试')
  // detect/reset 的 5000 不动（防挂起锁死，与 final 超时无关）
  assert.ok((asrSrc.match(/AbortSignal\.timeout\(5000\)/g) ?? []).length >= 2, 'detect/reset 的 5000 被误改')
})

await t('strings：descSenseVoice 语义化为快速/准确模式（双语）', () => {
  assert.ok(stringsSrc.includes('快速模式'), 'zh 缺快速模式语义')
  assert.ok(stringsSrc.includes('准确模式'), 'zh 缺准确模式语义')
  assert.ok(stringsSrc.includes('fast mode'), 'en 缺 fast mode 语义')
  assert.ok(stringsSrc.includes('accurate mode'), 'en 缺 accurate mode 语义')
})

await t('strings：recognizingSec 双语占位键（{sec}）', () => {
  assert.ok(stringsSrc.includes("recognizingSec: '识别中… {sec}s'"), 'zh recognizingSec 缺失或占位不符')
  assert.ok(stringsSrc.includes("recognizingSec: 'Recognizing… {sec}s'"), 'en recognizingSec 缺失或占位不符')
})

await t('client：VoiceStatusBar 有 transcribingSec wiring（>=2s 才显示耗时）', () => {
  assert.ok(clientSrc.includes('transcribingSec'), '缺 transcribingSec 状态')
  assert.ok(clientSrc.includes("b.ui.state !== 'transcribing'"), '缺 transcribing 态复位')
  assert.ok(clientSrc.includes('setInterval(() => setTranscribingSec((s) => s + 1), 1000)'), '缺秒级计时')
  const idx = clientSrc.indexOf('transcribingSec >= 2')
  assert.ok(idx >= 0, '缺 >=2s 门控（快定稿会闪烁）')
  assert.ok(clientSrc.includes("t('recognizingSec').replace('{sec}'"), '未用 recognizingSec 占位键')
})

// ── R1 I-3：correctText 输出护栏（弱模型加前言/复述/作答 → 用户消息被静默替换）──
const streamOf = (chunks) => ({
  async *[Symbol.asyncIterator]() {
    for (const c of chunks) yield c
  },
})
// ctx.get 形态（与 llm-correct.test.mjs 一致：真宿主属性访问抛错，模块必须走 get）。
const ctxWith = (chunks) => ({
  get: (name) =>
    name === 'llm'
      ? { stream: () => streamOf(chunks) }
      : name === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
        : undefined,
})

await t('I-3 护栏①：超长输出（复述/作答形态）→ 回退原文', async () => {
  // 弱模型把原文复述一遍再加解释：长度远超 max(64, 原文×3)。
  const bloated = '好的，我来帮您修正这段话。原句是「帮我查一下天气」，修正后仍然是「帮我查一下天气」，没有任何错别字和标点问题，建议原样发送。'.repeat(2)
  assert.equal(await correctText(ctxWith([{ type: 'text-delta', index: 0, text: bloated }]), '帮我查一下天气', 'zh'), '帮我查一下天气')
})

await t('I-3 护栏②：前言前缀（「修正后：」「Corrected:」）→ 回退原文', async () => {
  assert.equal(
    await correctText(ctxWith([{ type: 'text-delta', index: 0, text: '修正后：帮我查一下天气' }]), '帮我查一下天气', 'zh'),
    '帮我查一下天气',
  )
  assert.equal(
    await correctText(ctxWith([{ type: 'text-delta', index: 0, text: 'Corrected: check the weather' }]), 'check the weather', 'en'),
    'check the weather',
  )
})

await t('I-3 护栏边界：阈值 = max(64, 原文×3)（短输入 64 起跳；无冒号前缀不误伤）', async () => {
  const src20 = '原'.repeat(20)
  assert.equal(await correctText(ctxWith([{ type: 'text-delta', index: 0, text: '改'.repeat(60) }]), src20, 'zh'), '改'.repeat(60), '60 字符（≤64）应通过')
  assert.equal(await correctText(ctxWith([{ type: 'text-delta', index: 0, text: '改'.repeat(65) }]), src20, 'zh'), src20, '65 字符（>64）应回退')
  // 无冒号的前言样文本（历史 llm-correct 测试的「纠错后」形态）不触发前缀护栏——只拦带说明头的输出。
  assert.equal(await correctText(ctxWith([{ type: 'text-delta', index: 0, text: '纠错后' }]), '原文', 'zh'), '纠错后')
})

await t('I-3 护栏不误伤：正常等长纠错原样通过', async () => {
  assert.equal(await correctText(ctxWith([{ type: 'text-delta', index: 0, text: '帮我查一下天气' }]), '帮我查一下天气', 'zh'), '帮我查一下天气')
})

console.log(`\nfinalize-ux：${passed} 项通过`)
