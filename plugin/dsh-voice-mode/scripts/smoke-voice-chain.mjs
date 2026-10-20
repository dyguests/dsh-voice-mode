#!/usr/bin/env node
/**
 * 语音全链路冒烟（真实语音 → 浏览器采集 → 插件 worklet → POST /asr → host 流式识别 → 文本）。
 * 无需 LLM 凭据：只验证「说话→识别」这一半；朗读半边由 full-e2e / smoke-tts-engines 覆盖。
 *
 * 素材：用本地 VITS（sherpa-onnx WASM，离线、确定性）合成一句中文，写成 16k mono wav，交给 Chromium 的
 *   --use-file-for-fake-audio-capture 当麦克风输入（循环播放）。会话：经 dsh RPC（session/create）创建真实会话。
 * --loop：完整闭环（需宿主有 LLM 凭据，如 full-e2e.sh 的隔离实例）：说话 → 识别 → 自动发送 → LLM 回复 → 朗读音频帧到达客户端、无 tts-error。
 * 用法：node scripts/smoke-voice-chain.mjs <宿主启动 URL> [--loop]   环境变量：DSHVM_ELECTRON=<electron> 时在桌面端外壳里跑（需 xvfb-run）
 *        DSHVM_MODEL_CACHE=<模型缓存目录>（默认 ~/.cache/dsh-voice-mode/models）；缺 VITS/zipformer 模型则跳过
 * 仅适用 dsh ≥0.1.7（桌面端外壳路径；Chromium 路径对 ≥0.1.5 的 RPC 形态通用）。
 */
import { chromium, _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const url = process.argv[2]
const loop = process.argv.includes('--loop')
// --tts-down：负面路径——云端朗读整体不可用（配合 scripts/fixtures/block-edge-tts.cjs）时，用户必须看到可行动的提示
const ttsDown = process.argv.includes('--tts-down')
// --once（配合 --loop）：交互模式设为 once——说完一句、回复读完后应自动退出语音模式（0.1.7+ 插件设置端点）
const once = process.argv.includes('--once')
// --always：不进语音模式，readAloud=always 下经 RPC 发一条打字消息 → 回复应在当前标签页朗读；再点按钮应停止朗读
const always = process.argv.includes('--always')
if (!url) { console.error('用法: node scripts/smoke-voice-chain.mjs <宿主启动 URL>'); process.exit(2) }
const here = dirname(fileURLToPath(import.meta.url))
const cache = process.env.DSHVM_MODEL_CACHE || join(homedir(), '.cache', 'dsh-voice-mode', 'models')
const V = join(cache, 'csukuangfj', 'sherpa-onnx-vits-zh-ll')
const Z = join(cache, 'csukuangfj', 'sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30')
if (!existsSync(join(V, 'model.onnx')) || !existsSync(join(Z, 'encoder.int8.onnx'))) {
  console.log(`  - 跳过：本机未缓存 VITS / zipformer 模型（${cache}）`); process.exit(0)
}
let failed = false
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => { console.error(`  ✗ ${m}`); failed = true }

// 1) 合成真实语音 → wav（前后各留静音，让端点检测有停顿；整段循环播放）
const sherpa = createRequire(join(here, '..', 'package.json'))('sherpa-onnx')
const tts = sherpa.createOfflineTts({
  model: { vits: { model: join(V, 'model.onnx'), lexicon: join(V, 'lexicon.txt'), tokens: join(V, 'tokens.txt') }, numThreads: 1, debug: 0, provider: 'cpu' },
  ruleFsts: ['date.fst', 'phone.fst', 'number.fst'].map((f) => join(V, f)).join(','), ruleFars: '', maxNumSentences: 1,
})
const WANT = ['天气', '识别']
const speech = tts.generate({ text: '今天天气很好，我们来测试语音识别。', sid: 0, speed: 1 })
const SR = 16000
const n16 = Math.floor(speech.samples.length * SR / speech.sampleRate)
const pcm = new Int16Array(SR * 1 + n16 + SR * 3)
for (let i = 0; i < n16; i++) {
  const p = i * speech.sampleRate / SR, j = Math.floor(p), t = p - j
  const v = speech.samples[j] * (1 - t) + (speech.samples[j + 1] ?? 0) * t
  pcm[SR + i] = Math.max(-1, Math.min(1, v)) * 32767
}
const wav = Buffer.alloc(44 + pcm.length * 2)
wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
wav.write('data', 36); wav.writeUInt32LE(pcm.length * 2, 40); Buffer.from(pcm.buffer).copy(wav, 44)
const wavPath = join(mkdtempSync(join(tmpdir(), 'dshvm-voice-')), 'speech.wav')
writeFileSync(wavPath, wav)
ok(`合成测试语音 ${(pcm.length / SR).toFixed(1)}s（VITS，16k mono）`)

// 2) 启动浏览器（Chromium 或桌面端外壳），麦克风 = 该 wav 循环
const fakeAudio = ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wavPath}`]
let page, closer
if (process.env.DSHVM_ELECTRON) {
  const app = await electron.launch({ executablePath: process.env.DSHVM_ELECTRON, args: ['--no-sandbox', ...fakeAudio, join(here, 'desktop-shell', 'main.cjs'), url] })
  page = await app.firstWindow(); closer = () => app.close()
} else {
  const exe = ['/root/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome', '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'].find(existsSync)
  const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}), args: ['--use-fake-ui-for-media-stream', ...fakeAudio] })
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1400, height: 900 } })
  page = await ctx.newPage(); closer = () => browser.close()
  await page.goto(url, { waitUntil: 'load' })
}
// 统计客户端自己的 SSE 流上收到的朗读音频帧与 tts-error（包装 EventSource；--loop 用）
await page.addInitScript(() => {
  window.__vc = { audio: 0, ttsError: 0, skip: 0, skipMax: 0 }
  const ES = window.EventSource
  window.EventSource = function (u, o) {
    const e = new ES(u, o)
    if (String(u).includes('/voice-mode/stream')) {
      e.addEventListener('audio', () => { window.__vc.audio++ })
      e.addEventListener('tts-error', () => { window.__vc.ttsError++ })
      e.addEventListener('focus', (ev) => { window.__vc.focus = ev.data })
      e.addEventListener('turn', (ev) => { window.__vc.turn = ev.data })
      e.addEventListener('tts-skip', (ev) => { try { const s = Number(JSON.parse(ev.data).streak) || 1; window.__vc.skip++; window.__vc.skipMax = Math.max(window.__vc.skipMax, s) } catch {} })
    }
    return e
  }
  window.EventSource.prototype = ES.prototype
})
const texts = []
const asrStatus = []
page.on('response', async (r) => {
  if (!r.url().includes('/voice-mode/asr')) return
  asrStatus.push(r.status())
  try { const j = JSON.parse(await r.text()); if (j.text) texts.push(j.text) } catch { /* 非 JSON 忽略 */ }
})
await page.waitForLoadState('load').catch(() => {})
await page.waitForTimeout(4000)

// 3) 创建真实会话（≥0.1.5 斜杠形 RPC + args.request 信封）并让 UI 选中它
const created = await page.evaluate(async () => {
  const r = await fetch('/api/session/create', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'vc-1', method: 'session/create', payload: { args: { request: { cwd: '/tmp' } } } }) })
  return r.text()
})
let sid = ''
try { const d = JSON.parse(created); sid = d.result?.sessionId || d.result?.value?.sessionId || d.result?.id || '' } catch { /* 解析失败见下 */ }
sid ? ok(`经 RPC 创建真实会话 ${sid.slice(0, 18)}…`) : (bad(`会话创建失败：${created.slice(0, 160)}`), await closer(), process.exit(1))
await page.evaluate((id) => { try { localStorage.setItem('dsh.sessions.current', id) } catch {} }, sid)
await page.reload({ waitUntil: 'load' }).catch(() => {})
await page.waitForTimeout(4000)
for (let i = 0; i < 5; i++) {
  if (!(await page.evaluate(() => !!document.querySelector('[role="dialog"]')))) break
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((x) => /continue|later|skip|ok|继续|稍后|跳过|好的|确定/i.test(x.textContent || '')); b?.click() })
  await page.waitForTimeout(700)
}
const mic = await page.waitForSelector('[data-dshvm="mic"]', { timeout: 30000 }).catch(() => null)
if (!mic) { bad('mic 按钮未渲染'); await closer(); process.exit(1) }
ok('mic 按钮渲染（当前会话已选中）')

if (always) {
  const st = await page.evaluate(async () => (await fetch('/voice-mode/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ readAloud: 'always' }) })).status)
  st === 200 ? ok('朗读范围已设为 always') : bad(`设置 always 失败（HTTP ${st}）`)
  // 真实用户打字时已与页面交互过（浏览器自动播放策略据此放行 AudioContext）：先在空白处点一下
  await page.mouse.click(5, 5)
  await page.waitForTimeout(1500)
  // 发给界面当前显示的会话（MicButton 上报的焦点会话；UI 可能没选中上面 RPC 新建的那个）
  const focusSid = await page.evaluate(() => { try { return JSON.parse(window.__vc.focus || '{}').sessionId || '' } catch { return '' } })
  focusSid ? ok(`可见会话已上报焦点 ${focusSid.slice(0, 18)}…`) : bad('可见会话没有上报焦点（/focus）')
  const sent = await page.evaluate(async (id) => {
    const r = await fetch('/api/session/prompt', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'vc-2', method: 'session/prompt', payload: { args: { request: { sessionId: id, requestId: 'vc-always-1', mode: 'queue', content: [{ type: 'text', text: '请用中文写三句话介绍一下春天，每句话单独成句。' }] } } } }) })
    return { status: r.status, body: (await r.text()).slice(0, 300) }
  }, focusSid || sid)
  sent.status === 200 && !/"ok":false|error/i.test(sent.body) ? ok('经 RPC 发出打字消息（未进入语音模式）') : bad(`发送失败（HTTP ${sent.status}）：${sent.body}`)
  let reading = false
  for (let i = 0; i < 90 && !reading; i++) {
    await page.waitForTimeout(1000)
    reading = await page.evaluate(() => document.querySelector('[data-dshvm="mic"]')?.getAttribute('data-state') === 'reading')
  }
  const vc = await page.evaluate(() => window.__vc)
  if (!reading) console.log('  诊断：最后 focus 事件', vc.focus, '最后 turn', vc.turn)
  reading ? ok(`always：未进语音模式也在本标签页朗读（${vc.audio} 帧，按钮进入朗读态）`) : bad(`always：90s 内没有开始朗读（音频帧 ${vc.audio}）`)
  if (reading) {
    await page.click('[data-dshvm="mic"]')
    let stopped = false
    for (let i = 0; i < 20 && !stopped; i++) {
      await page.waitForTimeout(250)
      stopped = await page.evaluate(() => document.querySelector('[data-dshvm="mic"]')?.getAttribute('data-state') === 'off')
    }
    const voiceOn = await page.evaluate(async (id) => (await (await fetch('/voice-mode')).json()).active === id, focusSid)
    stopped && !voiceOn ? ok('朗读中点按钮 = 停止朗读（没有误进语音模式）') : bad(`停止朗读失败（按钮复位=${stopped}，误进语音=${voiceOn}）`)
    await page.waitForTimeout(3000)
    const still = await page.evaluate(() => document.querySelector('[data-dshvm="mic"]')?.getAttribute('data-state'))
    still !== 'reading' ? ok('停止后本回合余句不再播放') : bad('停止后又继续朗读')
  }
  await page.evaluate(async () => { await fetch('/voice-mode/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ readAloud: 'voice' }) }) })
  await closer()
  process.exit(failed ? 1 : 0)
}

// 4) 点 mic 进入语音模式 → 等待真实语音被识别
if (once) {
  const st = await page.evaluate(async () => (await fetch('/voice-mode/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'once' }) })).status)
  st === 200 ? ok('交互模式已设为 once') : bad(`设置 once 失败（HTTP ${st}）`)
}
await mic.click()
let state = ''
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000)
  state = await page.evaluate(async () => { const r = await fetch('/voice-mode'); const j = await r.json(); return j.active ? 'active' : 'idle' })
  if (state === 'active') break
}
state === 'active' ? ok('已进入语音模式（/toggle 经真实会话放行，麦克风授权通过）') : bad('未能进入语音模式（/voice-mode 无 active 会话）')
let heard = false
for (let i = 0; i < 40 && !heard; i++) {
  await page.waitForTimeout(1000)
  heard = WANT.every((w) => texts.some((t) => t.includes(w)))
}
console.log('  识别文本片段:', JSON.stringify([...new Set(texts)].slice(-4)))
heard ? ok(`真实语音经 采集→worklet→/asr→host 识别：命中关键词「${WANT.join('」「')}」`) : bad(`未识别到关键词（/asr 状态码：${[...new Set(asrStatus)].join(',') || '无请求'}）`)
asrStatus.length && asrStatus.every((s) => s === 200) ? ok(`/voice-mode/asr 请求全部 200（${asrStatus.length} 次）`) : bad(`/asr 出现非 200：${[...new Set(asrStatus)].join(',')}`)
if (ttsDown && heard) {
  // 负面路径：LLM 回复的每一句都合成失败 → host 连续 tts-skip（streak 递增）→ 客户端必须出现可行动提示
  const NOTICE = /Read-aloud keeps failing|朗读连续失败/
  let seen = false
  let vc = { audio: 0, skip: 0, skipMax: 0 }
  for (let i = 0; i < 240 && !(seen && vc.skipMax >= 2); i++) {
    await page.waitForTimeout(500)
    vc = await page.evaluate(() => window.__vc)
    if (!seen) seen = await page.evaluate((src) => new RegExp(src).test(document.body.innerText), NOTICE.source)
  }
  vc.skipMax >= 2 ? ok(`host 连续跳过计数到达 ${vc.skipMax}（tts-skip ×${vc.skip}）`) : bad(`90s 内连续失败计数未达 2（skipMax=${vc.skipMax}）——失败被静默了？`)
  seen ? ok('客户端出现「云端朗读暂不可用」可行动提示（状态条/toast）') : bad('连续失败后客户端没有出现可行动提示（用户只会觉得没声音）')
  vc.audio === 0 ? ok('无朗读音频帧（符合云端不可用的前提）') : bad(`夹具未生效：仍收到 ${vc.audio} 帧音频`)
} else if (loop && heard) {
  // 识别定稿后插件自动发送给 LLM → 回复按句朗读：客户端 SSE 上应出现音频帧
  let vc = { audio: 0, ttsError: 0 }
  for (let i = 0; i < 90 && vc.audio < 1; i++) { await page.waitForTimeout(1000); vc = await page.evaluate(() => window.__vc) }
  vc.audio >= 1 ? ok(`LLM 回复的朗读音频帧到达客户端（${vc.audio} 帧）——说话→识别→发送→回复→朗读 闭环成立`) : bad('90s 内客户端未收到朗读音频帧（自动发送/LLM/TTS 链路中断）')
  vc.ttsError === 0 ? ok('tts-error 0') : bad(`出现 tts-error ×${vc.ttsError}`)
  if (once && vc.audio >= 1) {
    // once：回复读完（回合结束 + host tts-idle + 本地播完 + 1.2s 稳定窗）后自动退出，按钮回到未激活
    let exited = false
    for (let i = 0; i < 180 && !exited; i++) {
      await page.waitForTimeout(1000)
      exited = await page.evaluate(async () => {
        const j = await (await fetch('/voice-mode')).json()
        return !j.active && document.querySelector('[data-dshvm="mic"]')?.getAttribute('aria-pressed') === 'false'
      })
    }
    exited ? ok('once：回复读完后自动退出语音模式（按钮复位）') : bad('once：180s 内没有自动退出语音模式')
  }
}
await page.evaluate(async (id) => { await fetch('/voice-mode/toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: id, on: false }) }) }, sid).catch(() => {})
await closer()
process.exit(failed ? 1 : 0)
