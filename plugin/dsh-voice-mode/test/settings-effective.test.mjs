/**
 * Issue #15 批 6：设置生效反馈单测（诚实文案 + 当前生效值探针 + README 引导）。
 * 运行：node test/settings-effective.test.mjs（npm test 串联）。
 *
 * 背景（用户反馈问题⑧）：settingsEffectiveNote 声称字幕字号/让位窗口等「即时生效」，
 * 实际走 fetchConfig 白名单下次进入才生效（actively misleading，§2.D 实测）。
 *
 * 覆盖：
 *  1) 文案诚实：四档分组，白名单字段归「下次进入」不再声称即时；effectivePending 双语占位键；
 *  2) settings-form：/config 运行态探针 + NEXT_ENTRY_FIELDS 清单 + EffectivePending 渲染；
 *  3) README：设置入口引导 + 四档生效时机；
 *  4) 反向变异锁：探针 fetch/提示块渲染删掉 → 红。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '..')
const repoRoot = join(here, '..', '..', '..')
const read = (f) => readFileSync(join(root, f), 'utf8')

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

const stringsSrc = read('src/strings.ts')
const formSrc = read('src/settings-form.tsx')
const readmeSrc = readFileSync(join(repoRoot, 'README.md'), 'utf8')

t('文案诚实：四档分组，白名单字段归「下次进入」不再声称即时', () => {
  const m = /settingsEffectiveNote: '([^']*)'/.exec(stringsSrc)
  assert.ok(m, '缺 settingsEffectiveNote zh')
  const note = m[1]
  // 旧文案的 actively misleading 形态：把字幕字号/让位窗口与「即时生效」写在一起
  assert.ok(!/即时生效；[^']*字幕字号/.test(note), '仍有把字幕字号等白名单字段称即时的旧形态')
  assert.ok(note.includes('四档'), '缺四档分组框架')
  assert.ok(note.includes('下次进入语音模式'), '缺第四档（下次进入）')
  assert.ok(note.includes('当前生效值'), '缺生效值提示')
})

t('strings：effectivePending 双语占位键（{count}/{items}）', () => {
  assert.ok(stringsSrc.includes("effectivePending: '有 {count} 项修改将在下次进入语音模式时生效：{items}'"), 'zh effectivePending 缺失或占位不符')
  assert.ok(/effectivePending: '\{count\} change\(s\) will apply next time you enter voice mode: \{items\}'/.test(stringsSrc), 'en effectivePending 缺失或占位不符')
})

t('settings-form：/config 运行态探针存在（fetch BASE_PATH + /config）', () => {
  assert.ok(formSrc.includes("fetch(location.origin + BASE_PATH + '/config')"), '缺运行态探针——无当前生效值数据源')
  assert.ok(formSrc.includes('const [effective, setEffective]'), '缺 effective 状态')
})

t('settings-form：NEXT_ENTRY_FIELDS 清单 + EffectivePending 渲染', () => {
  assert.ok(formSrc.includes('const NEXT_ENTRY_FIELDS'), '缺下次进入字段清单')
  // 白名单字段必须在清单里（字幕字号/让位窗口/打断抢救/LLM 纠错）
  for (const k of ['captionFontSize', 'yieldMs', 'bargeInSalvage', 'llmCorrect', 'autoSend', 'wakeWord']) {
    assert.ok(formSrc.includes(`key: '${k}'`), `清单缺 ${k}——该字段的生效反馈不显示`)
  }
  assert.ok(formSrc.includes('function EffectivePending'), '缺提示块组件')
  assert.ok(formSrc.includes('<EffectivePending effective={effective} value={value} />'), '卡片体未渲染提示块')
})

t('README：设置入口引导 + 四档生效时机', () => {
  assert.ok(readmeSrc.includes('设置（Settings）→ 语音模式（Voice Mode）'), '缺全版本通用入口引导')
  assert.ok(readmeSrc.includes('生效时机分四档'), '缺四档生效时机说明')
  assert.ok(readmeSrc.includes('当前生效值'), '缺当前生效值指引')
})

console.log(`\nsettings-effective：${passed} 项通过`)
