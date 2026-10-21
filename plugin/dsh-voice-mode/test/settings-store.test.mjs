/**
 * settings-store（0.1.7+ 路径 B 覆盖层持久化）单测 + 防回归结构守卫。
 * 运行：node test/settings-store.test.mjs（npm test 串联）
 *
 * 守卫的真机教训（2026-10-01，0.2.0-rc.2 实测）：
 *  - 客户端 inject 不得含 settingsScope（0.1.7+ 无此服务 → 插件永远 pending）；
 *  - host 不得直接属性访问 ctx.profileContext（旧宿主抛 "cannot get property without inject"，整个插件起不来）。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'vm-settings-store-'))
const out = join(work, 'store.mjs')
await build({ entryPoints: [join(root, 'src/settings-store.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' })
const S = await import(pathToFileURL(out).href)

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`) }
const KEYS = ['ttsEngine', 'rate', 'toolBeep']

console.log('settings-store 单测')
t('路径：优先 profile home，其次 DSH_HOME，最后 ~/.dsh', () => {
  assert.equal(S.settingsFilePath('/p/home'), join('/p/home', S.SETTINGS_FILE_NAME))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = '/env/home'
  assert.equal(S.settingsFilePath(undefined), join('/env/home', S.SETTINGS_FILE_NAME))
  assert.equal(S.settingsFilePath(''), join('/env/home', S.SETTINGS_FILE_NAME))
  assert.equal(S.settingsFilePath(123), join('/env/home', S.SETTINGS_FILE_NAME))
  delete process.env.DSH_HOME
  assert.ok(S.settingsFilePath(undefined).endsWith(join('.dsh', S.SETTINGS_FILE_NAME)))
  if (saved !== undefined) process.env.DSH_HOME = saved
})
t('pickKnownKeys 只保留白名单键，丢弃 __proto__/未知键/undefined', () => {
  const evil = JSON.parse('{"rate":1.2,"__proto__":{"x":1},"constructor":{"y":2},"nope":3,"toolBeep":true}')
  const r = S.pickKnownKeys(evil, KEYS)
  assert.deepEqual(r, { rate: 1.2, toolBeep: true })
  assert.equal(Object.getPrototypeOf(r), Object.prototype)
  assert.equal({}.x, undefined)
  assert.deepEqual(S.pickKnownKeys(null, KEYS), {})
  assert.deepEqual(S.pickKnownKeys([1], KEYS), {})
  assert.deepEqual(S.pickKnownKeys({ rate: undefined }, KEYS), {})
})
t('unknownKeys 列出非白名单键', () => {
  assert.deepEqual(S.unknownKeys({ rate: 1, a: 1, b: 2 }, KEYS), ['a', 'b'])
  assert.deepEqual(S.unknownKeys([], KEYS), [])
})
t('读：文件不存在 → 空且无 warn', () => {
  const r = S.readOverrides(join(work, 'nope.json'), KEYS)
  assert.deepEqual(r, { values: {}, exists: false })
})
t('读：损坏 JSON / 非对象 → 空并带 warn（不抛）', () => {
  const f = join(work, 'bad.json')
  writeFileSync(f, '{oops')
  assert.deepEqual(S.readOverrides(f, KEYS).values, {})
  assert.ok(S.readOverrides(f, KEYS).warn)
  writeFileSync(f, '[1,2]')
  assert.ok(S.readOverrides(f, KEYS).warn)
  writeFileSync(f, '"str"')
  assert.ok(S.readOverrides(f, KEYS).warn)
})
t('写：原子落盘、0600、可读回、目录自动创建、不遗留临时文件', () => {
  const dir = join(work, 'deep', 'dir')
  const f = join(dir, S.SETTINGS_FILE_NAME)
  S.writeOverrides(f, { rate: 1.3, toolBeep: true })
  assert.deepEqual(S.readOverrides(f, KEYS).values, { rate: 1.3, toolBeep: true })
  if (process.platform !== 'win32') assert.equal(statSync(f).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(dir), [S.SETTINGS_FILE_NAME])
  S.writeOverrides(f, { rate: 0.9 })
  assert.deepEqual(S.readOverrides(f, KEYS).values, { rate: 0.9 })
  assert.ok(readFileSync(f, 'utf8').endsWith('\n'))
})
t('读：落盘文件中的未知键被过滤', () => {
  const f = join(work, 'mixed.json')
  writeFileSync(f, JSON.stringify({ rate: 1.1, evil: 1 }))
  assert.deepEqual(S.readOverrides(f, KEYS).values, { rate: 1.1 })
})

console.log('旧 settings.yaml 迁移')
const LEGACY = [
  'permission:',
  '  defaultPreset: danger-full-access',
  'voice-mode:',
  '  spokenFormat: true',
  '  ttsEngine: edge',
  '  voice: "zh-CN-XiaoxiaoNeural"   # 行内注释',
  '  mode: hold',
  '  silenceMs: 1500',
  '  rate: 1.1',
  '  asrHotwords: |',
  '    dsh-voice-mode',
  '  recognitionLanguage: en',
  "  wakeWord: ''",
  '  senseITN: false',
  '  nested:',
  '    a: 1',
  'dsh-perf:',
  '  rate: 9',
].join('\n')
const ALLKEYS = ['spokenFormat', 'ttsEngine', 'voice', 'mode', 'silenceMs', 'rate', 'wakeWord', 'senseITN']
t('解析 voice-mode 段：标量类型/引号/注释正确，块标量与嵌套跳过，不越界读下一段', () => {
  const r = S.parseLegacyVoiceSection(LEGACY)
  assert.deepEqual(r, {
    spokenFormat: true, ttsEngine: 'edge', voice: 'zh-CN-XiaoxiaoNeural', mode: 'hold',
    silenceMs: 1500, rate: 1.1, recognitionLanguage: 'en', wakeWord: '', senseITN: false,
  })
})
t('无 voice-mode 段 / 空文本 → 空', () => {
  assert.deepEqual(S.parseLegacyVoiceSection('permission:\n  a: 1\n'), {})
  assert.deepEqual(S.parseLegacyVoiceSection(''), {})
})
t('readLegacyVoiceSettings：白名单过滤；settings.yaml 优先于 .imported；都没有返回空', () => {
  const dir = join(work, 'legacy'); S.writeOverrides(join(dir, 'x'), {}) // 建目录
  assert.deepEqual(S.readLegacyVoiceSettings(dir, ALLKEYS), {})
  writeFileSync(join(dir, 'settings.yaml.imported'), 'voice-mode:\n  rate: 1.2\n  recognitionLanguage: en\n')
  assert.deepEqual(S.readLegacyVoiceSettings(dir, ALLKEYS), { rate: 1.2 })
  writeFileSync(join(dir, 'settings.yaml'), 'voice-mode:\n  rate: 0.9\n')
  assert.deepEqual(S.readLegacyVoiceSettings(dir, ALLKEYS), { rate: 0.9 })
})

console.log('settings-http-scope 行为级单测')
// R15-7：设置 scope 的拉取失败不得是不可逆终态——此前 load() 的 catch 直接进
// `unavailable` 且 `started` 一生只 load 一次，用户首次打开设置面板那一次 GET
// 瞬时失败后，只能刷新整页恢复（全仓唯一断言只是源码文本匹配，抓不住）。
// 这里直接调 createHttpScope，注入 fetch 桩做行为级验证。
const scopeOut = join(work, 'scope.mjs')
await build({ entryPoints: [join(root, 'src/settings-http-scope.ts')], bundle: true, platform: 'node', format: 'esm', outfile: scopeOut, logLevel: 'silent' })
const H = await import(pathToFileURL(scopeOut).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 轮询等待条件成立（比固定 sleep 稳，机器慢时不会误判）。 */
const waitFor = async (fn, timeoutMs = 5000) => {
  const t0 = Date.now()
  for (;;) {
    if (fn()) return true
    if (Date.now() - t0 > timeoutMs) return false
    await sleep(20)
  }
}
const okJson = (value) => ({ ok: true, status: 200, json: async () => ({ value }) })
const ta = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`) }

await ta('首次 GET 失败后自动退避重试并恢复到 ready（不再是不可逆终态）', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls++
    if (calls === 1) throw new Error('boom')
    return okJson({ rate: 1.2 })
  }
  const scope = H.createHttpScope('http://scope.test', fetchImpl)
  const un = scope.subscribe(() => {})
  assert.ok(await waitFor(() => scope.getSnapshot().status === 'ready'), '失败后未自动恢复到 ready')
  assert.equal(scope.getSnapshot().value.rate, 1.2)
  assert.ok(calls >= 2, `未发生重试（calls=${calls}）`)
  un()
})

await ta('unavailable 之后重新挂载卡片可恢复（用户关掉再打开设置页）', async () => {
  let fail = true
  const fetchImpl = async () => {
    if (fail) throw new Error('boom')
    return okJson({ rate: 2 })
  }
  const scope = H.createHttpScope('http://scope.test', fetchImpl)
  const un1 = scope.subscribe(() => {})
  assert.ok(await waitFor(() => scope.getSnapshot().status === 'unavailable'), '失败未落到 unavailable')
  un1()
  fail = false
  const un2 = scope.subscribe(() => {})
  assert.ok(await waitFor(() => scope.getSnapshot().status === 'ready'), '重新挂载未恢复')
  assert.equal(scope.getSnapshot().value.rate, 2)
  un2()
})

await ta('卡片关闭（无订阅者）后不再后台重试', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; throw new Error('boom') }
  const scope = H.createHttpScope('http://scope.test', fetchImpl)
  const un = scope.subscribe(() => {})
  assert.ok(await waitFor(() => scope.getSnapshot().status === 'unavailable'))
  un()
  const before = calls
  await sleep(900) // > 首发退避 500ms
  assert.equal(calls, before, `卡片关闭后仍在后台重试（calls ${before} → ${calls}）`)
})

await ta('set() 乐观更新 + 失败回滚（回滚后以服务端值兜底）', async () => {
  const fetchImpl = async (_url, init) => {
    if (init?.method === 'POST') throw new Error('post boom')
    return okJson({ rate: 1 })
  }
  const scope = H.createHttpScope('http://scope.test', fetchImpl)
  const seen = []
  const un = scope.subscribe(() => seen.push(scope.getSnapshot().value.rate))
  assert.ok(await waitFor(() => scope.getSnapshot().status === 'ready'))
  await scope.set('rate', 9)
  assert.ok(seen.includes(9), '乐观更新未生效')
  assert.equal(scope.getSnapshot().value.rate, 1, '写失败后未回滚到服务端值')
  un()
})

await ta('写在途时并发的读结果不回写（乐观值不被旧 GET 盖掉）', async () => {
  let release = null
  let gets = 0
  const fetchImpl = async (_url, init) => {
    if (init?.method === 'POST') return new Promise((r) => { release = () => r(okJson({ rate: 5 })) })
    gets++
    return okJson({ rate: 1 })
  }
  const scope = H.createHttpScope('http://scope.test', fetchImpl)
  const un = scope.subscribe(() => {})
  assert.ok(await waitFor(() => scope.getSnapshot().status === 'ready'))
  const pending = scope.set('rate', 5) // POST 挂起
  await sleep(20)
  assert.equal(scope.getSnapshot().value.rate, 5, '乐观更新未生效')
  const getsBefore = gets
  un()
  const un2 = scope.subscribe(() => {}) // 重挂载 → 触发并发 GET
  assert.ok(await waitFor(() => gets > getsBefore), '并发 GET 未发出')
  await sleep(20)
  assert.equal(scope.getSnapshot().value.rate, 5, '在途写的值被并发的旧 GET 盖回')
  release()
  await pending
  assert.equal(scope.getSnapshot().value.rate, 5)
  un2()
})

await ta('窗口重新获得焦点 → 重拉一次（别的标签页改了设置，本页不再陈旧）', async () => {
  const handlers = {}
  const prevWindow = globalThis.window
  globalThis.window = { addEventListener: (type, fn) => { handlers[type] = fn } }
  try {
    let gets = 0
    const fetchImpl = async () => { gets++; return okJson({ rate: gets }) }
    const scope = H.createHttpScope('http://scope.test', fetchImpl)
    const un = scope.subscribe(() => {})
    assert.ok(await waitFor(() => scope.getSnapshot().status === 'ready'))
    const before = gets
    assert.equal(typeof handlers.focus, 'function', '未注册窗口焦点重拉监听')
    handlers.focus()
    assert.ok(await waitFor(() => gets > before), '焦点回到本页未触发重拉')
    un()
  } finally {
    if (prevWindow === undefined) delete globalThis.window
    else globalThis.window = prevWindow
  }
})

console.log('结构守卫（防回归）')
const clientSrc = readFileSync(join(root, 'src/client.tsx'), 'utf8')
const indexSrc = readFileSync(join(root, 'src/index.ts'), 'utf8')
t('client inject 不含 settingsScope', () => {
  const m = clientSrc.match(/export const inject = \[([^\]]*)\]/)
  assert.ok(m, '找不到 export const inject')
  assert.ok(!m[1].includes('settingsScope'), `inject 含 settingsScope：${m[1]}`)
  assert.ok(m[1].includes('slots') && m[1].includes('sessions'))
})
t('client 设置卡片：新旧槽位都注册，数据面按 settingsScope 有无分流', () => {
  assert.ok(clientSrc.includes("get?.('settingsScope')"))
  assert.ok(clientSrc.includes("'settings.plugin.item'"))
  assert.ok(clientSrc.includes("'plugins.bundle.config'"))
  assert.ok(clientSrc.includes('createHttpScope()'))
})
t('host 不直接属性访问 ctx.profileContext（必须 ctx.get 可选查找）', () => {
  assert.ok(!/ctx\.profileContext/.test(indexSrc), '发现 ctx.profileContext 直接访问')
  assert.ok(indexSrc.includes("get?.('profileContext')"))
})
t('host 首次运行迁移旧设置（覆盖层不存在时才迁，落盘后以覆盖层为准）', () => {
  assert.ok(indexSrc.includes('readLegacyVoiceSettings(') && indexSrc.includes('if (!loaded.exists)'))
})
t('host 注册了 /settings 路由且写入受跨源与大小限制保护', () => {
  const i = indexSrc.indexOf('path: `${base}/settings`')
  assert.ok(i > 0)
  const blk = indexSrc.slice(i, i + 2200)
  assert.ok(blk.includes('denyNonLoopback') && blk.includes('denyCrossOrigin') && blk.includes('MAX_JSON_BODY'))
})

console.log(`\nsettings-store：${n} 项通过`)
