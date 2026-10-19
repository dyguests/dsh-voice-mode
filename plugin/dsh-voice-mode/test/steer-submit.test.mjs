/**
 * Issue #15 批 2：运行中 steer 直提交单测（四态 + 守卫 + wiring 锁）。
 * 运行：node test/steer-submit.test.mjs（npm test 串联）。
 *
 * 背景：宿主 InputActions.submit 硬编码 queue（client.js:13481-13483）→ 语音提交恒
 * 排队。本批绕过之：运行中直接 session.prompt(text,'steer')，仅 ok 直达，任何失败
 * 回退现状 submit() 队列路径（不劣于现状）。
 *
 * 覆盖：
 *  1) trySteerSubmit 四态：ok→true / ok:false→false / 抛错→false / 无 prompt→false；
 *  2) shouldSteerSubmit 守卫：running+普通草稿→true；非 running→false；'/' 命令→false；
 *  3) wiring 锁（源码 grep，wake-standby 同款模式）：client.tsx 的分流分支、bus
 *     方法、ctx.sessions 同源访问都在（防回归成硬编码 queue）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '..')
const { shouldSteerSubmit, trySteerSubmit } = await import(
  pathToFileURL(join(root, 'src', 'steer-submit.ts')).href
)

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

await t('四态①：prompt  resolve {ok:true} → true（直达）', async () => {
  const calls = []
  const session = {
    prompt: async (content, mode) => {
      calls.push({ content, mode })
      return { ok: true }
    },
  }
  assert.equal(await trySteerSubmit(session, '帮我查天气'), true)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].content, [{ type: 'text', text: '帮我查天气' }])
  assert.equal(calls[0].mode, 'steer', '必须带 steer 模式')
})

await t('四态②：prompt resolve {ok:false} → false（回退队列）', async () => {
  const session = { prompt: async () => ({ ok: false }) }
  assert.equal(await trySteerSubmit(session, 'x'), false)
})

await t('四态③：prompt 抛错 → false（老宿主无 mode 参数/抛错安全降级）', async () => {
  const session = {
    prompt: async () => {
      throw new Error('old host')
    },
  }
  assert.equal(await trySteerSubmit(session, 'x'), false)
})

await t('四态④：无 session / prompt 非函数 → false（无 binding 回退）', async () => {
  assert.equal(await trySteerSubmit(undefined, 'x'), false)
  assert.equal(await trySteerSubmit({}, 'x'), false)
  assert.equal(await trySteerSubmit({ prompt: undefined }, 'x'), false)
})

t('守卫：非 running 不走 steer（空闲提交维持队列原行为）', () => {
  assert.equal(shouldSteerSubmit(false, '帮我查天气'), false)
  assert.equal(shouldSteerSubmit(true, '帮我查天气'), true)
})

t('守卫：`/` 开头命令草稿不走 steer（须走宿主 adjudication）', () => {
  assert.equal(shouldSteerSubmit(true, '/help'), false)
  assert.equal(shouldSteerSubmit(true, ' /help'), false, '前导空格的命令也不绕（函数内部 trim）')
})

// ---- wiring 锁（源码 grep：分流真实存在，非注释）----
const clientSrc = readFileSync(join(root, 'src', 'client.tsx'), 'utf8')

t('wiring：submitDraftNow 内有 steer 分流分支（running && 非命令 → bus.steerSubmit）', () => {
  const idx = clientSrc.indexOf('shouldSteerSubmit(runningRef.current, draftSnapshot)')
  assert.ok(idx >= 0, 'submitDraftNow 缺 steer 分流条件')
  const window = clientSrc.slice(idx, idx + 700)
  assert.ok(window.includes('bus.steerSubmit('), '分流块未调 bus.steerSubmit')
  assert.ok(window.includes('submitViaQueue()'), '分流块缺回退队列路径')
  assert.ok(window.includes("setDraft?.('')"), '直达成功未清草稿')
})

t('wiring：bus.steerSubmit 经 ctx.sessions.binding 同源访问（cancelTurn 模式）', () => {
  const idx = clientSrc.indexOf('steerSubmit(sessionId, text)')
  assert.ok(idx >= 0, 'bus 缺 steerSubmit 实现')
  const window = clientSrc.slice(idx, idx + 400)
  assert.ok(window.includes('ctx?.sessions?.binding?.(sessionId)?.session'), '未走 ctx.sessions 同源访问')
  assert.ok(window.includes('trySteerSubmit('), '未调用纯模块 trySteerSubmit')
})

t('wiring：VoiceBus 接口声明 steerSubmit（类型闭合）', () => {
  assert.ok(clientSrc.includes('steerSubmit(sessionId: string, text: string): Promise<boolean>'), 'VoiceBus 接口缺声明')
})

rmSyncDone()
function rmSyncDone() {}

console.log(`\nsteer-submit：${passed} 项通过`)
