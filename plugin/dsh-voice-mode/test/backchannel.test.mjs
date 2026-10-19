/**
 * Backchannel 让位语义单测（批 5 / ADR-0008 Phase 1）。
 * 运行：node test/backchannel.test.mjs
 *
 * 覆盖 §7.3 词表 ~12 例 + hold 窗口 5 例：
 *   matchBackchannel 词表正/负例 + 整段匹配 + 长度边界 + 与 wakeWord 区别
 *   hold 丢帧逻辑（mock audioListeners callback，镜像 client.tsx:1094-1103 现行
 *     HOLD_CLEAR_FRAMES=2 帧语义；完整路径镜像+bundle 锁在 hold-clear.test.mjs）
 *
 * matchBackchannel 通过 esbuild bundle asr.ts 提取（asr.ts 顶层模块函数可独立测试；
 * bundle: true + 标记未使用 import 为 external 解决 native worker_threads 等依赖）。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-bc-'))
const out = join(tmp, 'asr.mjs')

// bundle + platform neutral：asr.ts 顶层 matchBackchannel 是纯函数，可独立提取
await build({
  entryPoints: [join(here, '..', 'src', 'asr.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  // 屏蔽 native 模块（sherpa-onnx 等）：matchBackchannel 不依赖它们
  external: ['sherpa-onnx'],
  logLevel: 'silent',
})
const { matchBackchannel } = await import(pathToFileURL(out).href)

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

console.log('matchBackchannel 词表正例')
t('"嗯" ✓', () => assert.equal(matchBackchannel('嗯'), true))
t('"嗯嗯" ✓（双字）', () => assert.equal(matchBackchannel('嗯嗯'), true))
t('"哎" ✓', () => assert.equal(matchBackchannel('哎'), true))
t('"呃" ✓', () => assert.equal(matchBackchannel('呃'), true))
t('"哦" ✓', () => assert.equal(matchBackchannel('哦'), true))
t('"噢" ✓', () => assert.equal(matchBackchannel('噢'), true))
t('"对" ✓', () => assert.equal(matchBackchannel('对'), true))
t('"好" ✓', () => assert.equal(matchBackchannel('好'), true))
t('"行" ✓', () => assert.equal(matchBackchannel('行'), true))
t('"是" ✓', () => assert.equal(matchBackchannel('是'), true))
t('"好好" ✓（双字）', () => assert.equal(matchBackchannel('好好'), true))
t('英文 "so/um/uh/yeah/ok" ✓（right=5 字符超 §10 R4b ≤4 上限——plan §7.2/§10 内部冲突，按 §10 严格执行，right 被滤）', () => {
  for (const w of ['so', 'um', 'uh', 'yeah', 'ok']) {
    assert.equal(matchBackchannel(w), true, `"${w}" 应命中`)
  }
  assert.equal(matchBackchannel('right'), false, 'right=5 字符超 ≤4 上限（plan §10 R4b 边界保护）')
})

console.log('matchBackchannel 词表负例')
t('"嗯你好小D" ✗（那是 wake 不是 backchannel；整段匹配非前缀）', () => {
  assert.equal(matchBackchannel('嗯你好小D'), false)
})
t('"好的没问题" ✗（长度 >4 归一化字符）', () => {
  assert.equal(matchBackchannel('好的没问题'), false, '5 字符（好的没问题）超过 ≤4 上限')
})
t('"今天天气不错" ✗（普通短句）', () => {
  assert.equal(matchBackchannel('今天天气不错'), false)
})
t('"嗯啊哦" ✗（3 字但不在词表）', () => {
  assert.equal(matchBackchannel('嗯啊哦'), false)
})
t('空串 ✗', () => assert.equal(matchBackchannel(''), false))
t('纯标点 ✗', () => assert.equal(matchBackchannel('。。'), false))

console.log('matchBackchannel 归一化与边界')
t('"嗯。" ✓（尾随标点被剥）', () => assert.equal(matchBackchannel('嗯。'), true))
t('"  嗯  " ✓（空白被剥）', () => assert.equal(matchBackchannel('  嗯  '), true))
t('"嗯嗯嗯" ✗（3 字连「嗯」不在词表：词表只含「嗯」「嗯嗯」两种）', () => {
  assert.equal(matchBackchannel('嗯嗯嗯'), false)
})
t('大小写不敏感（英文）', () => assert.equal(matchBackchannel('OK'), true))
t('"好呀" ✗（2 字符但「好呀」不是词表词）', () => assert.equal(matchBackchannel('好呀'), false))
t('长度 ≤4 边界：4 字符 "对对对对" 不在词表', () => {
  assert.equal(matchBackchannel('对对对对'), false)
})

console.log('matchBackchannel 与 wakeWord 的本质区别（整段 vs 前缀）')
t('backchannel: 整段匹配——"嗯" 命中（仅 1 字符）', () => {
  assert.equal(matchBackchannel('嗯'), true)
})
t('backchannel: 整段匹配——"嗯你好" 长度 3 但不在词表 → 不命中', () => {
  assert.equal(matchBackchannel('嗯你好'), false)
})

console.log('hold 窗口逻辑（镜像 client.tsx:1094-1103 现行语义：HOLD_CLEAR_FRAMES=2 帧后清 hold 放行）')
// 镜像对象：backchannelHoldUntilRef.current（到期时刻）+ 帧计数（同 client.tsx holdSpeechFrames）。
const HOLD_CLEAR_FRAMES = 2
function makeFrameCallback(holdRef) {
  return (frame) => {
    if (frame.sessionId !== 'active') return
    if (holdRef.current && Date.now() < holdRef.current) {
      holdRef.frames += 1
      if (holdRef.frames >= HOLD_CLEAR_FRAMES) {
        holdRef.current = 0 // 清 hold
        holdRef.frames = 0
        // 本帧不再因 hold 丢弃，继续放行（client.tsx:1096-1099）
      } else {
        return // 未达阈值：丢帧
      }
    }
    return frame
  }
}

t('hold 窗口外（过期/未设）→ 帧通过守卫', () => {
  const holdRef = { current: 0, frames: 0 }
  const cb = makeFrameCallback(holdRef)
  const result = cb({ sessionId: 'active' })
  assert.deepEqual(result, { sessionId: 'active' }, 'hold=0 时不应丢帧')
})

t('hold 窗口内第 1 帧（未达 HOLD_CLEAR_FRAMES=2）→ 帧被丢弃', () => {
  const holdRef = { current: Date.now() + 1000, frames: 0 }
  const cb = makeFrameCallback(holdRef)
  const result = cb({ sessionId: 'active' })
  assert.equal(result, undefined, 'hold 未到期且未达 2 帧阈值时帧应被丢（无返回值 = 丢帧）')
  assert.equal(holdRef.frames, 1, '丢帧应累计帧计数')
})

t('hold 窗口内第 2 帧达到 HOLD_CLEAR_FRAMES=2 → 清 hold 且本帧放行（批 7O M8 现行语义）', () => {
  const holdRef = { current: Date.now() + 1000, frames: 0 }
  const cb = makeFrameCallback(holdRef)
  assert.equal(cb({ sessionId: 'active' }), undefined, '第 1 帧仍应被丢')
  const second = cb({ sessionId: 'active' })
  assert.deepEqual(second, { sessionId: 'active' }, '第 2 帧达阈值后本帧应放行')
  assert.equal(holdRef.current, 0, '达阈值后 hold 应被清')
  assert.equal(holdRef.frames, 0, '达阈值后帧计数应重置')
})

t('sessionId 不匹配 → 直接 return，与 hold 无关', () => {
  const holdRef = { current: Date.now() + 1000, frames: 0 }
  const cb = makeFrameCallback(holdRef)
  const result = cb({ sessionId: 'other' })
  assert.equal(result, undefined, 'sessionId 不匹配 = 旧 sessionId 帧丢弃（已有逻辑）')
  assert.equal(holdRef.frames, 0, 'sessionId 不匹配不得累计 hold 帧计数')
})

t('hardBreak 清 hold 后帧立即恢复（模拟：hardBreak 路径 backchannelHoldUntil = 0）', () => {
  const holdRef = { current: Date.now() + 1000, frames: 1 }
  holdRef.current = 0 // 模拟 hardBreak
  const cb = makeFrameCallback(holdRef)
  const result = cb({ sessionId: 'active' })
  assert.deepEqual(result, { sessionId: 'active' }, 'hardBreak 清 hold 后帧恢复通过')
})

console.log(`\nbackchannel：${passed} 项通过`)
rmSync(tmp, { recursive: true, force: true })
