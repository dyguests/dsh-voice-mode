// 测试夹具：让进程内对 Edge TTS 域名（*.bing.com / *.msedgeservices.com）的连接一律失败，用来复现「云端朗读整体不可用」。
// 用法：NODE_OPTIONS="--require <本文件>" 启动 dsh 核心（见 scripts/full-e2e.sh 的 DSHVM_TTS_DOWN=1）。
// 只影响 Edge TTS 相关域名；LLM、模型下载等其他域名不受影响。
const net = require('node:net')
const blocked = (h) => typeof h === 'string' && /(^|\.)(bing\.com|msedgeservices\.com)$/i.test(h)
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const o = Array.isArray(args[0]) ? args[0][0] : args[0]
  const host = o && typeof o === 'object' ? o.host || o.hostname : null
  if (blocked(host)) {
    const e = Object.assign(new Error(`connect ECONNREFUSED ${host} (blocked by test fixture)`), { code: 'ECONNREFUSED' })
    process.nextTick(() => this.destroy(e))
    return this
  }
  return connect.apply(this, args)
}
