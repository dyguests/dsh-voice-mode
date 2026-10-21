/**
 * models.ts 供应链校验单测（真离线）：SHA256 校验 + 损坏自愈 + 下载校验路径。
 * 运行：node test/download.test.mjs（npm test 串联——每文件独立进程，fetch 桩不跨文件泄漏）。
 *
 * I7：globalThis.fetch 全程桩化（记录调用 + 返回受控响应）。旧实现把 primaryHost 设为
 * 'http://127.0.0.1:1' 指望「必然失败」，但 models.ts:115 的 hosts 会回退
 * HOST_PRIMARY/HOST_FALLBACK，仍对 huggingface.co 发起真实请求（npm test stderr 曾
 * 有 fetch failed 痕迹）——「离线」声明不实。桩化后无任何真实外连，且下载/校验/续传
 * 代码路径首次获得确定性覆盖。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureModelFile, ensureModelTree, sha256OfFile } from '../src/models.ts'

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const DATA = Buffer.alloc(1000, 7)
const DATA_SHA = sha256(DATA)

// --------------------------------------------------------------------------
// I7：fetch 桩（记录调用 + 受控响应）。models.ts 的 fetch 是全局查找，运行期替换即生效。
//   mode='missing' → 404 上游不可用（损坏自愈路径：三个上游依次尝试后失败）；
//   mode='ok'      → 200 + 受控内容（下载→SHA 校验→改名路径）。
// --------------------------------------------------------------------------
let fetchMode = 'missing'
const fetchCalls = []
/** M-1：逐文件下载那一次 fetch 的 init（用于断言是否带 signal——headers 阶段超时的载体）。 */
let fileFetchInit = null
globalThis.fetch = async (url, init) => {
  fetchCalls.push(String(url))
  // M-1：模型树桩——清单列举正常，逐文件下载「接受连接后永不吐响应头」。
  if (fetchMode === 'hang-file') {
    if (String(url).includes('/api/models/')) {
      return {
        url: String(url),
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => ({ siblings: [{ rfilename: 'espeak-ng-data/zh_dict' }] }),
        body: null,
      }
    }
    // 逐文件下载：带 signal → abort 时 reject（模拟 headers 超时）；不带 signal → 永不
    // settle（模拟裸 fetch 挂起——这正是 M-1 修复前的形态）。
    fileFetchInit = init
    return new Promise((_resolve, reject) => {
      const sig = init && init.signal
      if (!sig) return
      sig.addEventListener('abort', () => reject(sig.reason ?? new Error('aborted')))
    })
  }
  if (fetchMode === 'missing') {
    return { url: String(url), status: 404, headers: { get: () => null }, body: null }
  }
  return {
    url: String(url),
    status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? String(DATA.length) : null) },
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(DATA))
        c.close()
      },
    }),
  }
}

let passed = 0
const t = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`) }

await t('sha256OfFile：正确计算文件内容哈希', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-h-'))
  const p = join(dir, 'a.bin')
  writeFileSync(p, DATA)
  assert.equal(await sha256OfFile(p), DATA_SHA)
  rmSync(dir, { recursive: true, force: true })
})

await t('ensureModelFile：已存在且 SHA256 正确 → 直接 true（不触发下载）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-ok-'))
  writeFileSync(join(dir, 'a.bin'), DATA)
  fetchCalls.length = 0
  const ok = await ensureModelFile({
    repo: 'ok-repo', repoDir: dir, spec: { file: 'a.bin', sha256: DATA_SHA },
    primaryHost: '', allowCustomHost: true, broadcast: () => {},
  })
  assert.ok(ok)
  assert.equal(fetchCalls.length, 0, '哈希已正确的文件不得发起任何下载请求')
  rmSync(dir, { recursive: true, force: true })
})

await t('ensureModelFile：已存在但 SHA256 不匹配 → 删除自愈 + 三上游依次尝试后失败（真离线，无真实外连）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-corrupt-'))
  const p = join(dir, 'a.bin')
  writeFileSync(p, Buffer.alloc(1000, 9)) // 错误内容
  fetchCalls.length = 0
  fetchMode = 'missing' // 受控 404：所有上游不可达
  const ok = await ensureModelFile({
    repo: 'corrupt-repo', repoDir: dir, spec: { file: 'a.bin', sha256: DATA_SHA },
    primaryHost: 'http://127.0.0.1:1', allowCustomHost: true, broadcast: () => {},
  })
  assert.ok(!ok)
  assert.ok(!existsSync(p), '损坏文件应被删除（自愈）')
  // primaryHost + HOST_PRIMARY + HOST_FALLBACK 三个上游依次尝试（models.ts:115 hosts 回退链）；
  // 全部走 fetch 桩——旧实现此处会对 huggingface.co 真实外连。
  assert.equal(fetchCalls.length, 3, '应按 hosts 回退链依次尝试 3 个上游')
  assert.ok(fetchCalls.every((u) => u.startsWith('http')), 'fetch 桩应收到完整 URL')
  rmSync(dir, { recursive: true, force: true })
})

await t('ensureModelFile：下载→SHA 校验→落盘全路径（受控 200 响应，真离线）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-ok-'))
  const p = join(dir, 'a.bin')
  fetchCalls.length = 0
  fetchMode = 'ok' // 受控 200：返回内容与 spec.sha256 一致
  try {
    const ok = await ensureModelFile({
      repo: 'dl-repo', repoDir: dir, spec: { file: 'a.bin', sha256: DATA_SHA },
      primaryHost: 'https://mirror.invalid', allowCustomHost: true, broadcast: () => {},
    })
    assert.ok(ok, '内容哈希匹配时应下载成功')
    assert.equal(fetchCalls.length, 1, '首个上游成功即止，不走回退')
    assert.ok(existsSync(p), '校验通过后应落盘为正式文件')
    assert.deepEqual(readFileSync(p), DATA, '落盘内容应与受控响应一致')
    assert.equal(await sha256OfFile(p), DATA_SHA)
    assert.ok(!existsSync(`${p}.part`), '成功后不应残留 .part')
  } finally {
    fetchMode = 'missing'
    rmSync(dir, { recursive: true, force: true })
  }
})

// --------------------------------------------------------------------------
// M-1（Issue #15 R2）：ensureModelTree 的逐文件下载必须走「仅 headers 阶段」超时。
//
// 真实失效形态：清单列举（/api/models/…）正常返回，但逐文件下载（/resolve/main/…）的
// 上游「接受连接后永不吐响应头」→ 该 worker 的 await 永不 settle → Promise.all 永不
// resolve → ensureModelTree 永不返回 → tts-local.ts:299 的 await 永不返回 →
// Kokoro espeak-ng-data 树（355 文件 / 8 路并发）加载永久挂起：不抛错、不进
// engineError、连日志都没有（与 M4 当初修掉的 ASR「麦克风无响应、控制台无错」同型）。
//
// 桩：清单返回 1 个条目；逐文件 fetch 带 signal → abort 时 reject（模拟超时），
// 不带 signal → 永不 settle（模拟裸 fetch 挂起）。
// 时钟：models.ts 的 headers 超时是 60s 常量（MODEL_FETCH_HEADERS_TIMEOUT_MS），
// 真等 60s × 3 个上游不现实——测试窗口内把 setTimeout 的延迟前移到 0（只改「何时
// 触发」，不改「是否触发」：带 signal 的 fetch 仍要等 abort 才失败）。未修复时
// （裸 fetch 无 signal）仍会永久挂起——本用例必须红。
// --------------------------------------------------------------------------
await t('M-1：逐文件下载上游挂起（接受连接后不吐响应头）→ ensureModelTree 有界 settle（不永久挂起）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-tree-'))
  fetchCalls.length = 0
  fileFetchInit = null
  fetchMode = 'hang-file'
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  // 压缩时钟：只前移 setTimeout 的触发时刻，不改触发与否。
  globalThis.setTimeout = (fn, _ms, ...rest) => realSetTimeout(fn, 0, ...rest)
  let guardTimer = null
  try {
    const p = ensureModelTree({
      repo: 'kokoro-onnx',
      repoDir: dir,
      subdir: 'espeak-ng-data',
      primaryHost: 'https://mirror.invalid',
      allowCustomHost: true,
      broadcast: () => {},
    })
    // 兜底闸门：3s 内没有 settle 即判「永久挂起」（用例必须红，而不是把测试挂死）。
    const guard = new Promise((r) => {
      guardTimer = realSetTimeout(() => r('HUNG'), 3000)
    })
    const res = await Promise.race([p, guard])
    assert.equal(
      res,
      false,
      'ensureModelTree 在上游「接受连接后不吐响应头」时永久不 settle——Kokoro 模型加载永久挂起（不抛错、不进 engineError、连日志都没有）',
    )
    assert.ok(
      fetchCalls.some((u) => u.includes('/resolve/main/')),
      '前置条件：应已发起逐文件下载请求（清单列举路径没走到，本用例失去意义）',
    )
    assert.ok(
      fileFetchInit && fileFetchInit.signal,
      '逐文件下载未带 AbortSignal——裸 fetch 无 headers 阶段超时（修复前形态）',
    )
  } finally {
    if (guardTimer) realClearTimeout(guardTimer)
    globalThis.setTimeout = realSetTimeout
    fetchMode = 'missing'
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log(`\ndownload：${passed} 项通过`)
