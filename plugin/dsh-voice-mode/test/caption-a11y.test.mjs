/**
 * 字幕 a11y 桥接链测试（批 3）。运行：node test/caption-a11y.test.mjs
 *
 * §5.2 桥接链 6 处（+fetchConfig 漏列共 7 处）。本测试：
 *   1. /config 返回含 captionFontSize/captionMaxWidth（宿主契约）
 *   2. client.tsx 编译产物含 word-break + overflow-wrap + aria-label（CSS/aria 接线）
 *   3. VoiceOverlay 字号数组 + 宽度数组 + maxHeight + caption span className + button aria-label 静态断言
 *   4. 默认值 I10 守卫：captionFontSize=0（12px，等于现状外层 fontSize:12）；captionMaxWidth=1（70vw）
 *   5. fetchConfig 白名单字段穿透：fetchConfig 编译产物显式含 captionFontSize/captionMaxWidth 字段名
 *      （plan §5.2 第 215 行「通用透传」实际与源码白名单拼接不符——见 commit message）
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '..')

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// 1. /config 返回值类型层断言：源码层 grep（不真正 import，避免 cordis/sherpa 依赖链）
console.log('VoiceSettingsValue schema 默认值（I10 守卫）')
const indexSrc = readFileSync(join(root, 'src', 'index.ts'), 'utf8')

t('VoiceSettingsValue 含 captionFontSize/captionMaxWidth 类型', () => {
  assert.ok(/captionFontSize:\s*0\s*\|\s*1\s*\|\s*2\s*\|\s*3/.test(indexSrc), 'index.ts VoiceSettingsValue 缺 captionFontSize 类型')
  assert.ok(/captionMaxWidth:\s*0\s*\|\s*1\s*\|\s*2/.test(indexSrc), 'index.ts VoiceSettingsValue 缺 captionMaxWidth 类型')
})
t('默认值 captionFontSize=0（12px；I10 与现状 client.tsx 外层 fontSize:12 字节等价）', () => {
  // 匹配 defaults 字面量（紧跟在字面字段名后的数字赋值，不含类型 union 中的 0/1/2/3）
  const m = indexSrc.match(/captionFontSize:\s*0,\s*\/\//) || indexSrc.match(/captionFontSize:\s*0,/m)
  assert.ok(m, 'VOICE_SETTINGS_DEFAULTS 缺 captionFontSize=0')
})
t('默认值 captionMaxWidth=1（70vw；取舍见 schema description）', () => {
  const m = indexSrc.match(/captionMaxWidth:\s*1,?\s*\}/m) || indexSrc.match(/captionMaxWidth:\s*1,/m)
  assert.ok(m, 'VOICE_SETTINGS_DEFAULTS 缺 captionMaxWidth=1（必须在 defaults 对象字面量中赋值为 1）')
})
t('默认值取舍透明：schema 描述引用词典 + 双语词典明示默认值=现状', () => {
  // 旧实现锁 index.ts 中文注释措辞（「<686px 时窄于」等）——注释改写即红、零行为保护。
  // 改锁面向用户的词典文案 + schema 引用；数学方向的真实载体是档位数组 + 默认索引 1
  // （70vw）+ 30vh 高度约束，由下方行为断言（:71-80）看守。
  const stringsSrc = readFileSync(join(here, '..', 'src', 'strings.ts'), 'utf8')
  assert.ok(/DESC\.captionFontSize/.test(indexSrc) && /DESC\.captionMaxWidth/.test(indexSrc), 'schema 描述应引用词典（DESC）')
  assert.ok(/descCaptionFontSize: 'Caption font size[^']*default Small matches current behavior/.test(stringsSrc), 'en 词典 descCaptionFontSize 未说明默认值 = 现状')
  assert.ok(/descCaptionFontSize: '[^']*默认小与现状字节等价/.test(stringsSrc), 'zh 词典 descCaptionFontSize 未说明默认值 = 现状')
  assert.ok(/descCaptionMaxWidth: '[^']*默认 70vw/.test(stringsSrc), 'zh 词典 descCaptionMaxWidth 未说明默认 70vw')
})
t('host /config 返回值含 captionFontSize/captionMaxWidth（§5.2 #2）', () => {
  assert.ok(/captionFontSize:\s*vset\.captionFontSize/.test(indexSrc), '/config 路由未返回 captionFontSize')
  assert.ok(/captionMaxWidth:\s*vset\.captionMaxWidth/.test(indexSrc), '/config 路由未返回 captionMaxWidth')
})

// 2. client.tsx 编译产物静态断言
console.log('lib/client.js 字幕 a11y 接线')
const clientJs = join(root, 'lib', 'client.js')
assert.ok(existsSync(clientJs), 'lib/client.js 未构建——需先 node build.mjs')
const clientSrc = readFileSync(join(root, 'src', 'client.tsx'), 'utf8')

t('VoiceOverlay 外层 fontSize 来自档位数组 [12,14,18,24]', () => {
  assert.ok(/\[12,\s*14,\s*18,\s*24\]\[b\.ui\.boot\?\.captionFontSize/.test(clientSrc), '字号数组/索引表达式缺失')
})
t('VoiceOverlay 外层 maxWidth 来自档位数组 [50vw,70vw,90vw]', () => {
  assert.ok(/\[['"]50vw['"],\s*['"]70vw['"],\s*['"]90vw['"]\]\[b\.ui\.boot\?\.captionMaxWidth/.test(clientSrc), '宽度数组/索引表达式缺失')
})
t('浮层 maxHeight:30vh + overflow:hidden（防 24px 多行盖输入框）', () => {
  assert.ok(/maxHeight:\s*['"]30vh['"]/.test(clientSrc), '缺 maxHeight 30vh')
  assert.ok(/overflow:\s*['"]hidden['"]/.test(clientSrc), '缺 overflow hidden')
})
t('caption span：whiteSpace:normal + overflowWrap:anywhere + wordBreak:break-word', () => {
  assert.ok(/whiteSpace:\s*['"]normal['"]/.test(clientSrc), '缺 whiteSpace normal')
  assert.ok(/overflowWrap:\s*['"]anywhere['"]/.test(clientSrc), '缺 overflowWrap anywhere')
  assert.ok(/wordBreak:\s*['"]break-word['"]/.test(clientSrc), '缺 wordBreak break-word')
})
t('caption span 加 className="dshvm-caption"（CSS 注入选择器）', () => {
  assert.ok(/className=\{?["']dshvm-caption["']/.test(clientSrc), '缺 className dshvm-caption')
})
t('跳过按钮加 aria-label={t("skipReading")}', () => {
  assert.ok(/aria-label=\{t\(['"]skipReading['"]\)\}/.test(clientSrc), '跳过按钮缺 aria-label')
})
t('VoiceBootConfig 类型加 captionFontSize/captionMaxWidth', () => {
  assert.ok(/captionFontSize:\s*0\s*\|\s*1\s*\|\s*2\s*\|\s*3/.test(clientSrc), 'VoiceBootConfig 缺 captionFontSize')
  assert.ok(/captionMaxWidth:\s*0\s*\|\s*1\s*\|\s*2/.test(clientSrc), 'VoiceBootConfig 缺 captionMaxWidth')
})
t('fetchConfig 白名单拼接含 captionFontSize/captionMaxWidth（§5.2 漏列，commit 显式声明）', () => {
  assert.ok(/captionFontSize:\s*c\.captionFontSize/.test(clientSrc), 'fetchConfig 未透传 captionFontSize')
  assert.ok(/captionMaxWidth:\s*c\.captionMaxWidth/.test(clientSrc), 'fetchConfig 未透传 captionMaxWidth')
})
t('bootNow / DEFAULT_BOOT 兜底默认值含 captionFontSize=0 / captionMaxWidth=1（同字形两处，grep 不区分具体位置）', () => {
  // 旧实现拆成 bootNow / DEFAULT_BOOT 两条逐字相同的断言——同正则同源，第二条零增量；
  // DEFAULT_BOOT 在 createVoiceBus 内，grep 本就无法单独定位。合并为一条并如实命名。
  assert.ok(/captionFontSize:\s*0,\s*captionMaxWidth:\s*1/.test(clientSrc), '兜底默认值未含 captionFontSize=0 / captionMaxWidth=1')
})

// 3. client 编译产物静态断言（CSS / aria 字符串）
const clientBundle = readFileSync(clientJs, 'utf8')
t('lib/client.js 含 dshvm-caption CSS 类（含 word-break）', () => {
  assert.ok(clientBundle.includes('dshvm-caption'), 'lib/client.js 缺 dshvm-caption 类')
  assert.ok(clientBundle.includes('word-break') && clientBundle.includes('break-word'), 'lib/client.js 缺 word-break CSS')
  assert.ok(clientBundle.includes('overflow-wrap') && clientBundle.includes('anywhere'), 'lib/client.js 缺 overflow-wrap CSS')
})
t('lib/client.js 含 aria-label + skipReading', () => {
  assert.ok(clientBundle.includes('aria-label'), 'lib/client.js 缺 aria-label')
  assert.ok(clientBundle.includes('skipReading'), 'lib/client.js 缺 skipReading 文案键引用')
})
t('lib/client.js 含 30vh / overflow:hidden（浮层高度守卫）', () => {
  assert.ok(clientBundle.includes('30vh'), 'lib/client.js 缺 maxHeight 30vh')
  assert.ok(/overflow:\s*['"]hidden['"]/.test(clientBundle), 'lib/client.js 缺 overflow:hidden')
})
// 防回归：原硬编码 480 应被替换为档位数组
t('原硬编码 maxWidth: 480 已被替换为档位数组', () => {
  // 仅检测 VoiceOverlay 区域（其他文件 480 是布局像素，不应受影响）。
  // 旧实现 if (overlayRegion.length > 0) 包裹——split 不到 VoiceOverlay 时静默通过
  // （自失效条件）。改无条件：VoiceOverlay 必须存在，且其区域内不得有 maxWidth:480。
  const overlayRegion = clientSrc.split('VoiceOverlay')[1]
  assert.ok(overlayRegion !== undefined && overlayRegion.length > 0, 'client.tsx 缺 VoiceOverlay——无法校验 480 替换')
  assert.ok(!/maxWidth:\s*480\b/.test(overlayRegion), 'VoiceOverlay 仍硬编码 maxWidth:480')
})
t('mtime 守卫：lib/client.js mtime ≥ src/client.tsx mtime（防 build 漏跑）', () => {
  const libM = statSync(clientJs).mtimeMs
  const srcM = statSync(join(root, 'src', 'client.tsx')).mtimeMs
  assert.ok(libM >= srcM - 500, 'lib/client.js 早于 src/client.tsx（需 node build.mjs）')
})

console.log(`\ncaption-a11y：${passed} 项通过`)
