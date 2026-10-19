/**
 * Issue #15 批 7：关键静默路径提示 + 诊断复制单测（源码锁）。
 * 运行：node test/silent-path-hints.test.mjs（npm test 串联）。
 *
 * 背景（用户反馈问题⑨）：partial 上行失败/detect 通道失败/SSE 断连等路径静默——用户
 * 看到的是「字幕不走/打断不灵/状态不更新」的无头故障。本批：连败 3 次才提示（可自愈的
 * 瞬时失败不噪）+ SSE 断连指示 + 一键复制诊断（隐私口径：只含版本/状态/设置/耗时）。
 *
 * 覆盖（本仓 client.tsx 无组件挂载设施的既定模式：源码锁）：
 *  1) asr.ts：onNotice 通道 + partial/detect 连败计数（3 次阈、成功清零）；
 *  2) client.tsx：onNotice→bus.setNotice（5s 自动清除）+ SSE error/open 指示 +
 *     诊断按钮与隐私口径（汇总不含转写原文）；
 *  3) strings：六键双语；
 *  4) 反向变异锁：删连败提示/删 SSE 指示/删诊断按钮/汇总加原文字段 → 红。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '..')
const read = (f) => readFileSync(join(root, f), 'utf8')

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

const asrSrc = read('src/asr.ts')
const clientSrc = read('src/client.tsx')
const stringsSrc = read('src/strings.ts')

t('asr.ts：onNotice 瞬态提示通道存在（与 onError 硬失败区分）', () => {
  assert.ok(asrSrc.includes('readonly onNotice: (fn: (key: string) => void) => () => void'), 'AsrConfig 缺 onNotice')
  assert.ok(asrSrc.includes('const noticeListeners'), '缺 noticeListeners')
  const idx = asrSrc.indexOf('onNotice(fn)')
  assert.ok(idx >= 0 && asrSrc.slice(idx, idx + 200).includes('noticeListeners.add'), '缺 onNotice 发射器实现')
})

t('asr.ts：partial 连败计数（3 次阈 + 成功清零）', () => {
  assert.ok(asrSrc.includes('let partialFailStreak = 0'), '缺 partial 连败计数')
  assert.ok(asrSrc.includes("if (++partialFailStreak >= 3) emit(noticeListeners, 'partialFail')"), '缺 3 次阈提示')
  // 整行字面量（审查 I2）：includes/计数式都会被声明行或段界重置处满足而无区分度——
  // 锁 requestPartial 成功路径那一行（带注释锚）。
  assert.ok(asrSrc.includes('partialFailStreak = 0 // Issue #15 批 7：成功即清零'), '缺成功清零——瞬时失败会累积误提示')
})

t('asr.ts：detect 连败计数（3 次阈 + 成功清零）', () => {
  assert.ok(asrSrc.includes('let detectFailStreak = 0'), '缺 detect 连败计数')
  assert.ok(asrSrc.includes("if (++detectFailStreak >= 3) emit(noticeListeners, 'detectFail')"), '缺 3 次阈提示')
  assert.ok(asrSrc.includes('detectFailStreak = 0 // Issue #15 批 7：成功即清零'), '缺成功清零')
})

t('asr.ts（审查 M3）：连败计数在段边界重置（clearWakeSegment/discardSegment/start）', () => {
  for (const fn of ['const clearWakeSegment', 'discardSegment() {', 'async start() {']) {
    const idx = asrSrc.indexOf(fn)
    assert.ok(idx >= 0, `缺 ${fn}`)
    const win = asrSrc.slice(idx, idx + 700)
    assert.ok(win.includes('partialFailStreak = 0'), `${fn} 未重置连败计数——跨段累积会误提示`)
  }
})

t('client：onNotice → bus.setNotice（5s 自动清除）', () => {
  const idx = clientSrc.indexOf('engine.onNotice(')
  assert.ok(idx >= 0, '缺 onNotice 处理')
  const win = clientSrc.slice(idx, idx + 900)
  assert.ok(win.includes('bus.setNotice('), 'onNotice 未走 setNotice')
  // bus.setNotice 实现：5s 清除 + 仅当 notice 仍是本次文案才清
  const sIdx = clientSrc.indexOf('setNotice(hint)')
  assert.ok(sIdx >= 0, 'bus 缺 setNotice 实现')
  const sWin = clientSrc.slice(sIdx, sIdx + 500)
  assert.ok(sWin.includes('5000'), '缺 5s 自动清除')
  assert.ok(sWin.includes('ui.notice === hint'), '缺「仅当仍是本次文案才清」保护——会冲掉用户新提示')
})

t('client（Issue #15 接口约定）：onNotice 特判 backchannelDropped——先剥 live 尾再提示', () => {
  const idx = clientSrc.indexOf('engine.onNotice(')
  assert.ok(idx >= 0, '缺 onNotice 处理')
  const win = clientSrc.slice(idx, idx + 900)
  const keyIdx = win.indexOf("key === 'backchannelDropped'")
  assert.ok(keyIdx >= 0, '缺 backchannelDropped 特判（asr 弃段键无客户端处理）')
  // 顺序锁：剥尾 → 清 partial → setNotice（清理必须先于提示，否则草稿残留 Ghost 文本）
  const stripIdx = win.indexOf("composeDraft(draftRef.current, lastPartialRef.current, '')", keyIdx)
  assert.ok(stripIdx > keyIdx, '未剥草稿 live 尾——被弃段的 partial 会残留进下次草稿')
  assert.ok(win.includes("lastPartialRef.current = ''"), '剥尾未清 lastPartial 记录')
  const clearIdx = win.indexOf("bus.setUi({ partial: '' })", stripIdx)
  assert.ok(clearIdx > stripIdx, '未清状态条 partial')
  const noticeIdx = win.indexOf('bus.setNotice(', clearIdx)
  assert.ok(noticeIdx > clearIdx, '提示未走在清理之后')
})

t('client：SSE 断连指示（error 置位 / open 清除）', () => {
  const idx = clientSrc.indexOf("source.addEventListener('error'")
  assert.ok(idx >= 0, '缺 SSE error 监听')
  const win = clientSrc.slice(idx, idx + 500)
  assert.ok(win.includes('ui.sseDown = true'), 'error 未置断连指示')
  const oIdx = clientSrc.indexOf("source.addEventListener('open'")
  assert.ok(oIdx >= 0, '缺 open 监听')
  const oWin = clientSrc.slice(oIdx, oIdx + 500)
  assert.ok(oWin.includes('ui.sseDown = false'), 'open 未清断连指示——重连成功提示不消失')
  // 状态条文本链含 sseDown（error 之后、notice 之前）
  assert.ok(clientSrc.includes("b.ui.sseDown"), '状态条未消费 sseDown')
})

t('client：诊断按钮 + 隐私口径（汇总不含转写原文）', () => {
  assert.ok(clientSrc.includes('data-dshvm="diag"'), '缺诊断按钮')
  const idx = clientSrc.indexOf('const copyDiagnostics =')
  assert.ok(idx >= 0, '缺 copyDiagnostics')
  const win = clientSrc.slice(idx, idx + 1200)
  assert.ok(win.includes('navigator.clipboard.writeText'), '未写剪贴板')
  assert.ok(win.includes('BUILD_TAG'), '汇总缺构建版本（issue 定位必需）')
  // 隐私：汇总字段只允许 build/state/settings/telemetry——不得出现 partial/draft/segment 文本
  for (const bad of ['draftRef', 'b.ui.partial', 'b.ui.playingCaption', 'lastPartialRef']) {
    assert.ok(!win.includes(bad), `汇总含 ${bad}——违反「只记时间戳+长度+成败不记原文」隐私口径`)
  }
  assert.ok(/telemetry/.test(win), '汇总缺 telemetry（阶段耗时）')
})

t('strings：六键双语', () => {
  for (const k of ['partialFail', 'detectFail', 'sseReconnect', 'diagCopy', 'diagCopied', 'diagCopyFailed']) {
    assert.ok(new RegExp(`${k}: '`).test(stringsSrc), `缺 ${k}`)
  }
  // 双语各一份
  for (const k of ['partialFail', 'detectFail', 'sseReconnect', 'diagCopy', 'diagCopied', 'diagCopyFailed']) {
    assert.ok((stringsSrc.match(new RegExp(`${k}: '`, 'g')) ?? []).length === 2, `${k} 非双语`)
  }
})

t('VoiceBus 接口声明 setNotice（类型闭合）', () => {
  assert.ok(clientSrc.includes('setNotice(hint: string): void'), 'VoiceBus 接口缺 setNotice')
})

// ---- Issue #15 UX Blocker：错误提示表面与激活状态解耦（五条静默路径）----

t('client（UX Blocker）：mic 按钮旁常驻提示面（data-dshvm=mic-hint，与 activeSessionId 解耦）', () => {
  // 前提：错误/提示的唯一原渲染处是状态条，而状态条仅激活时渲染
  const barIdx = clientSrc.indexOf('const isActive = b.active === sessionId')
  assert.ok(barIdx >= 0, '缺状态条激活门')
  assert.ok(clientSrc.slice(barIdx, barIdx + 80).includes('if (!isActive) return'), '状态条未在非激活态早退')
  // 常驻提示面：mic 按钮（conversation.input.right 常驻）旁红字
  assert.ok(clientSrc.includes('data-dshvm="mic-hint"'), '缺 mic 旁常驻提示面')
  const hintIdx = clientSrc.indexOf('const micHint =')
  assert.ok(hintIdx >= 0, '缺 micHint 计算')
  const hintWin = clientSrc.slice(hintIdx, hintIdx + 500)
  assert.ok(hintWin.includes('bus.activeSessionId !== sessionId'), '提示面未与激活态解耦（激活态应让位状态条，防双份）')
  assert.ok(hintWin.includes('bus.ui.error ?? bus.ui.notice'), '提示面未读 error/notice')
  // a11y：提示面可被屏幕阅读器播报（aria-live 在 data-dshvm 之后）
  const domIdx = clientSrc.indexOf('data-dshvm="mic-hint"')
  assert.ok(clientSrc.slice(domIdx, domIdx + 300).includes('aria-live'), '提示面缺 aria-live')
})

t('client（UX Blocker）：空闲超时提示在退出流程之后写入（exitMode 会清 error + 3s 计时器）', () => {
  const idx = clientSrc.indexOf("const quitMsg = t('idleTimeoutQuit')")
  assert.ok(idx >= 0, '缺 idleTimeoutQuit 文案')
  const win = clientSrc.slice(idx, idx + 800)
  const exitIdx = win.indexOf("exitModeRef.current('idle')")
  const writeIdx = win.indexOf('bus.setUi({ error:')
  assert.ok(exitIdx > 0, '缺退出调用')
  assert.ok(writeIdx > exitIdx, '提示未在退出之后写——exitMode 内的 setUi({error:null}) 与 clearIdle 会擦掉提示（原顺序下永不可见）')
})

t('client（UX Blocker）：状态条补 role/aria-live（可访问性）', () => {
  const idx = clientSrc.indexOf('role="status"')
  assert.ok(idx >= 0, '状态条/提示面缺 role=status')
  assert.ok(clientSrc.slice(idx, idx + 200).includes('aria-live="polite"'), '缺 aria-live=polite')
})

console.log(`\nsilent-path-hints：${passed} 项通过`)
