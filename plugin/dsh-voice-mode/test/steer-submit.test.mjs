/**
 * Issue #15 批 2：运行中 steer 直提交单测（五态 + 守卫 + wiring 顺序锁）。
 * 运行：node test/steer-submit.test.mjs（npm test 串联）。
 *
 * 背景：宿主 InputActions.submit 硬编码 queue（client.js:13481-13483）→ 语音提交恒
 * 排队。本批绕过之：运行中直接 session.prompt(text,'steer')，未显式失败即视为直达，
 * 显式失败/抛错/无 prompt 回退现状 submit() 队列路径（不劣于现状、不双发）。
 *
 * 覆盖：
 *  1) trySteerSubmit 五态：ok:true→true / ok:false→false / 抛错→false / 无 prompt→false /
 *     undefined（老宿主非 RemoteResult 形状）→true（保守交付，防双发，审查 OQ-1）；
 *  2) shouldSteerSubmit 守卫：running+普通草稿→true；非 running→false；'/' 命令→false；
 *  3) wiring **顺序锁**（审查 Important#1，wake-standby 相对 indexOf 先例）：清草稿后
 *     必须立即 return；失败回退必须在 delivered return 之后、外层 return 之前——三类
 *     安全突变（删 return / 删回退 / 无条件回退）均抓红。
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
const t = async (name, fn) => {
  await fn()
  passed++
  console.log('  ✓ ' + name)
}

await t('五态①：prompt resolve {ok:true} → true（直达）', async () => {
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

await t('五态②：prompt resolve {ok:false} → false（显式失败，回退队列）', async () => {
  const session = { prompt: async () => ({ ok: false }) }
  assert.equal(await trySteerSubmit(session, 'x'), false)
})

await t('五态③：prompt 抛错 → false（老宿主无 mode 参数安全降级）', async () => {
  const session = {
    prompt: async () => {
      throw new Error('old host')
    },
  }
  assert.equal(await trySteerSubmit(session, 'x'), false)
})

await t('五态④：无 session / prompt 非函数 → false（无 binding 回退）', async () => {
  assert.equal(await trySteerSubmit(undefined, 'x'), false)
  assert.equal(await trySteerSubmit({}, 'x'), false)
  assert.equal(await trySteerSubmit({ prompt: undefined }, 'x'), false)
})

await t('五态⑤：prompt resolve undefined（老宿主非 RemoteResult 形状）→ true（保守交付防双发）', async () => {
  const session = { prompt: async () => undefined }
  assert.equal(await trySteerSubmit(session, 'x'), true)
})

t('守卫：非 running 不走 steer（空闲提交维持队列原行为）', () => {
  assert.equal(shouldSteerSubmit(false, '帮我查天气'), false)
  assert.equal(shouldSteerSubmit(true, '帮我查天气'), true)
})

t('守卫：`/` 开头命令草稿不走 steer（须走宿主 adjudication）', () => {
  assert.equal(shouldSteerSubmit(true, '/help'), false)
  assert.equal(shouldSteerSubmit(true, ' /help'), false, '前导空格的命令也不绕（函数内部 trim）')
})

// ---- wiring 顺序锁（审查 Important#1：存在性锁抓不住三类安全突变，改锁语句次序）----
const clientSrc = readFileSync(join(root, 'src', 'client.tsx'), 'utf8')

t('wiring：submitDraftNow 有 steer 分流分支（running && 非命令 → bus.steerSubmit）', () => {
  const idx = clientSrc.indexOf('shouldSteerSubmit(runningRef.current, draftSnapshot)')
  assert.ok(idx >= 0, 'submitDraftNow 缺 steer 分流条件')
  assert.ok(clientSrc.slice(idx, idx + 700).includes('bus.steerSubmit('), '分流块未调 bus.steerSubmit')
})

t('wiring 顺序①：delivered 分支清草稿后必须立即 return（删 return 防双发 → 红）', () => {
  const idx = clientSrc.indexOf('shouldSteerSubmit(runningRef.current, draftSnapshot)')
  const win = clientSrc.slice(idx, idx + 900)
  const setDraftIdx = win.indexOf("setDraft?.('')")
  assert.ok(setDraftIdx >= 0, 'delivered 分支未清草稿')
  const returnIdx = win.indexOf('return', setDraftIdx)
  assert.ok(returnIdx > setDraftIdx, '清草稿之后未紧跟 return——直达成功会继续走队列（双发）')
})

t('wiring 顺序②：失败回退在 .then 内（delivered return 之后、.catch 与外层 return 之前）', () => {
  const idx = clientSrc.indexOf('shouldSteerSubmit(runningRef.current, draftSnapshot)')
  const win = clientSrc.slice(idx, idx + 900)
  const setDraftIdx = win.indexOf("setDraft?.('')")
  const deliveredReturn = win.indexOf('return', setDraftIdx)
  const catchIdx = win.indexOf('.catch(')
  assert.ok(catchIdx > 0, '缺 .catch 兜底')
  const fallback = win.indexOf('submitViaQueue()', deliveredReturn)
  assert.ok(fallback > deliveredReturn, 'delivered return 之后无失败回退——steer 失败不回退队列')
  // 回退必须在 .then 内（.catch 之前）：只在 .catch 里有回退时，delivered=false 不触发
  // 回退 → 消息根本不发（突变②：删 .then 回退 → 红）。
  assert.ok(fallback < catchIdx, '失败回退不在 .then 内（落在 .catch 里——delivered=false 不会回退，消息丢失）')
  const outerReturn = win.indexOf('return', fallback)
  assert.ok(outerReturn > fallback, '失败回退不在 .then 内（落到了外层 return 之后=不可达）')
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

t('wiring：用户改写守卫（RPC 在途改写不清草稿，审查 M-1）', () => {
  const idx = clientSrc.indexOf('shouldSteerSubmit(runningRef.current, draftSnapshot)')
  const win = clientSrc.slice(idx, idx + 900)
  assert.ok(win.includes('draftRef.current.trim() === draftSnapshot'), 'delivered 分支缺用户改写守卫')
})

console.log(`\nsteer-submit：${passed} 项通过`)
