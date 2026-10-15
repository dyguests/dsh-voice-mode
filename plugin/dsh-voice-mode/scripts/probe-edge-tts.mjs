#!/usr/bin/env node
/**
 * Edge 云端 TTS 实时探针：用「发布包里内联的」lib/msedge-tts.cjs 真实合成一句话。
 * 目的：微软服务端会不经通知调整握手/端点（2026-10-15 对 msedge-tts ≤2.0.9 一律 403，默认朗读引擎整体无声）；
 *       本探针由定时 CI（.github/workflows/edge-tts-probe.yml）每日运行，失败即红灯，及早提示升级内联依赖。
 * 用法：node scripts/probe-edge-tts.mjs        退出码：0 = 合成成功；1 = 失败/超时/音频异常小
 * 依赖外网；不属于 npm test（单测不得触网）。
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { MsEdgeTTS, OUTPUT_FORMAT } = createRequire(import.meta.url)(join(here, '..', 'lib', 'msedge-tts.cjs'))

async function synth() {
  const tts = new MsEdgeTTS()
  await tts.setMetadata('zh-CN-XiaoxiaoNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
  const { audioStream } = tts.toStream('你好')
  let bytes = 0
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout 20s')), 20000)
    audioStream.on('data', (d) => { bytes += d.length })
    audioStream.on('end', () => { clearTimeout(timer); resolve() })
    audioStream.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
  if (bytes < 1000) throw new Error(`音频异常小：${bytes} 字节`)
  return bytes
}

// 429 = 服务端对共享出口 IP 限流（服务可达，握手本身是对的），退避重试；403/其他错误 = 真失败，立即报告。
const t0 = Date.now()
let lastErr
for (let attempt = 1; attempt <= 4; attempt++) {
  try {
    const bytes = await synth()
    console.log(`✓ Edge TTS 合成成功：${bytes} 字节，${Date.now() - t0}ms（第 ${attempt} 次）`)
    process.exit(0)
  } catch (e) {
    lastErr = e
    const msg = e && e.message ? e.message : String(e)
    if (!/\b429\b/.test(msg)) break
    console.warn(`  第 ${attempt} 次被限流（429），${attempt < 4 ? '20s 后重试' : '放弃'}`)
    if (attempt < 4) await new Promise((r) => setTimeout(r, 20000))
  }
}
console.error(`✗ Edge TTS 合成失败：${lastErr && lastErr.message ? lastErr.message : lastErr}`)
console.error('  服务端可能调整了握手/端点：升级内联依赖 msedge-tts 后重建 lib/msedge-tts.cjs（见 docs/adr/0011、CHANGELOG 0.7.24）')
process.exit(1)
