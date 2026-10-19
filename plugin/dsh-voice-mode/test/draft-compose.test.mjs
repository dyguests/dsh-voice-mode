/**
 * Issue #15 批 3：实时转写回填草稿——组成逻辑单测 + wiring 源码锁。
 * 运行：node test/draft-compose.test.mjs（npm test 串联）。
 *
 * 覆盖：
 *  1) composeDraft：剥尾追加（正常）/ 尾不匹配（草稿被清或改写→自愈）/ 空 addition /
 *     空 base / 首段无 base；
 *  2) shouldWritePartial：wake 态不写（诊断反馈），其余态写；
 *  3) wiring 锁（源码 grep）：client.tsx 的 onPartial 走 composeDraft+wake 门控，
 *     onSegment 用 composeDraft 替换 partial 尾（防 double-append）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '..')
const { composeDraft, shouldWritePartial } = await import(
  pathToFileURL(join(root, 'src', 'draft-compose.ts')).href
)

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

t('剥尾追加：partial 尾被定稿文本替换（不重复计入）', () => {
  // 草稿现为「定稿前缀 + partial 尾」；定稿到来 → 剥尾拼定稿
  assert.equal(composeDraft('帮我查 天气', '天气', '天气怎么样'), '帮我查 天气怎么样')
})

t('尾不匹配（提交后草稿被清）→ 从 addition 新起（自愈）', () => {
  assert.equal(composeDraft('', '天气', '下一句'), '下一句')
  // 用户改写草稿致尾不匹配 → 以现草稿为基追加（不丢用户内容）
  assert.equal(composeDraft('用户改写的内容', '天气', '定稿'), '用户改写的内容 定稿')
})

t('空 addition → 返回 base（防御）', () => {
  assert.equal(composeDraft('已有草稿', '', ''), '已有草稿')
  assert.equal(composeDraft('前缀 尾', '尾', '   '), '前缀')
})

t('空 base → addition 即全部（首段）', () => {
  assert.equal(composeDraft('', '', '第一段'), '第一段')
})

t('多段累积：前缀+新定稿', () => {
  assert.equal(composeDraft('第一段', '', '第二段'), '第一段 第二段')
})

t('shouldWritePartial：wake 态不写草稿（诊断反馈），其余写', () => {
  assert.equal(shouldWritePartial('wake'), false)
  assert.equal(shouldWritePartial('listening'), true)
  assert.equal(shouldWritePartial('speech'), true)
  assert.equal(shouldWritePartial('transcribing'), true)
})

// ---- wiring 锁（源码 grep：回填真实存在）----
const clientSrc = readFileSync(join(root, 'src', 'client.tsx'), 'utf8')

t('wiring：onPartial 走 composeDraft + wake 门控 + lastPartial 记录', () => {
  const idx = clientSrc.indexOf('engine.onPartial(')
  assert.ok(idx >= 0, '缺 onPartial')
  const window = clientSrc.slice(idx, idx + 700)
  assert.ok(window.includes('composeDraft('), 'onPartial 未走 composeDraft')
  assert.ok(window.includes('shouldWritePartial(') || window.includes("=== 'wake'"), 'onPartial 缺 wake 门控')
  assert.ok(window.includes('lastPartialRef'), 'onPartial 未记录 partial 尾（定稿替换需要）')
})

t('wiring：onSegment 用 composeDraft 替换 partial 尾（double-append 防护）', () => {
  const idx = clientSrc.indexOf('engine.onSegment(')
  assert.ok(idx >= 0, '缺 onSegment')
  const window = clientSrc.slice(idx, idx + 1400)
  assert.ok(window.includes('composeDraft('), 'onSegment 未走 composeDraft')
  assert.ok(window.includes('lastPartialRef.current = \'\'') || window.includes("lastPartialRef.current = ''"), 'onSegment 未清 partial 尾记录')
})

console.log(`\ndraft-compose：${passed} 项通过`)
