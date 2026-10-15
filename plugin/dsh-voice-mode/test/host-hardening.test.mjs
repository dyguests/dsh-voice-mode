/**
 * host 加固守卫（审计 2026-10-15 后补）：
 *  H1 /models/retry 不得被跨站 GET 触发（<img src> 不带 Origin → 必须要求 POST + 同源校验）；
 *  H2 模型树条目路径穿越（rfilename 含 .. / 反斜杠 / 空段）必须被拒；
 *  H3 asr-error 下行不得携带原始错误串（路径/URL 泄露）；
 *  H4 设置面板不得直出 host 原始英文错误串。
 * 运行：node test/host-hardening.test.mjs（npm test 串联）
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { isSafeModelRel } from '../src/models.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const src = (f) => readFileSync(join(here, '..', 'src', f), 'utf8')
let passed = 0
const t = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name) }

console.log('H1 /models/retry 只接受同源 POST')
t('retry 路由：要求 POST 且校验跨源', () => {
  const s = src('index.ts')
  const i = s.indexOf('path: `${base}/models/retry`')
  assert.ok(i > 0, '找不到 /models/retry 路由')
  const block = s.slice(i, i + 900)
  assert.ok(/req\.method !== 'POST'/.test(block), 'retry 未限制为 POST（跨站 <img> GET 可触发下载）')
  assert.ok(/denyCrossOrigin\(req, res\)/.test(block), 'retry 未校验跨源')
})

console.log('H2 模型树路径穿越')
t('合法条目放行', () => {
  assert.equal(isSafeModelRel('espeak-ng-data/zh_dict', 'espeak-ng-data'), true)
  assert.equal(isSafeModelRel('espeak-ng-data/voices/!v/f1', 'espeak-ng-data'), true)
})
t('穿越/异常条目拒绝', () => {
  for (const bad of [
    'espeak-ng-data/../../x',
    'espeak-ng-data/a/../b',
    'espeak-ng-data/./a',
    'espeak-ng-data//a',
    'espeak-ng-data\\..\\x',
    'espeak-ng-data/a\0b',
    '../espeak-ng-data/a',
    '/espeak-ng-data/a',
    'other/a',
    'espeak-ng-data',
    '',
  ]) assert.equal(isSafeModelRel(bad, 'espeak-ng-data'), false, `应拒绝：${JSON.stringify(bad)}`)
})

console.log('H3 asr-error 不带原始错误串')
t('models.ts 的 asr-error 广播不含 detail', () => {
  const s = src('models.ts')
  const m = s.match(/broadcast\('asr-error',\s*\{[^}]*\}\)/)
  assert.ok(m, '找不到 asr-error 广播')
  assert.ok(!/detail/.test(m[0]), 'asr-error 仍携带 detail（原始错误串，可能含路径）')
})

console.log('H4 设置面板不直出 host 原始错误串')
t('tts.error 不再原样渲染', () => {
  const s = src('settings-form.tsx')
  assert.ok(!/:\s*tts\.error\}/.test(s), '设置面板仍直接渲染 tts.error 原文')
})

console.log(`\nhost-hardening：${passed} 项通过`)
