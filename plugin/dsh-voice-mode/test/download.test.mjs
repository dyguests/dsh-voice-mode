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
import { ensureModelFile, sha256OfFile } from '../src/models.ts'

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
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url))
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

console.log(`\ndownload：${passed} 项通过`)
