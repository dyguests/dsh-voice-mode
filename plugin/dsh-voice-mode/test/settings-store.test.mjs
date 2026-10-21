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

// ── M-1（Issue #15 R4）：读在写「之前」发出、写落定之后才返回的另一半顺序 ──
// 早年的守卫是 `if (writing === 0)`——计数只表达「此刻有没有写」，表达不了先后：
// 读在写之前发出（写落定前读未返回）时，写落定后 writing 归 0，迟到的旧快照照写不误
// → 把刚写好的值盖回旧值。本用例走查该顺序：GET 慢、POST 快，GET 最后才落定。
await ta('读在写之前发出、写落定之后才返回 → 迟到的旧读不得盖回新值（单调序号守卫）', async () => {
  let releaseGet = null
  const fetchImpl = async (_url, init) => {
    if (init?.method === 'POST') return okJson({ rate: 2 }) // 写快
    // 读慢：接受连接后一直不返回，直到测试放行（快照是旧值 rate=1）
    return new Promise((r) => { releaseGet = () => r(okJson({ rate: 1 })) })
  }
  const scope = H.createHttpScope('http://scope.test', fetchImpl)
  const seen = []
  const un = scope.subscribe(() => seen.push(scope.getSnapshot().value.rate))
  assert.ok(await waitFor(() => releaseGet !== null), '首次 GET 未发出')
  // 用户在 GET 返回前改开关：POST 更快落定（值 rate=2）
  await scope.set('rate', 2)
  assert.equal(scope.getSnapshot().value.rate, 2, '乐观更新未生效')
  // 迟到的 GET 落定（旧快照 rate=1）——不得盖回新值
  releaseGet()
  await sleep(50)
  assert.equal(scope.getSnapshot().value.rate, 2, '迟到的旧 GET 把刚写好的值盖回旧值')
  assert.deepEqual(seen, [2, 2], `订阅者序列里出现了旧值（不该有 1）：${JSON.stringify(seen)}`)
  un()
})

// ── M-3（Issue #15 R4）：emit() 逐订阅者隔离异常 ──
// 抛错的订阅者曾让 set() 的 writing-- 永远到不了（writing 永久 > 0 → 此后所有读结果
// 被静默丢弃），也让 load() 的 catch 跳过 scheduleRetry()（退避重试归零）。
// 变异态下 load() 的 promise 会变成未处理 rejection（void load()）——临时接管，
// 免得测试进程被未处理 rejection 打死（那样拿不到干净的断言失败）。
await ta('订阅者抛错不掐断退避重试（首次读失败 → 退避重试 → 恢复 ready）', async () => {
  const unhandled = []
  const onUnhandled = (e) => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  try {
    let calls = 0
    const fetchImpl = async () => {
      calls++
      if (calls === 1) throw new Error('boom')
      return okJson({ rate: 7 })
    }
    const scope = H.createHttpScope('http://scope.test', fetchImpl)
    const un = scope.subscribe(() => { throw new Error('subscriber boom') })
    assert.ok(
      await waitFor(() => scope.getSnapshot().status === 'ready'),
      '订阅者抛错掐断了退避重试——emit 未隔离异常（load 的 catch 里 emit 抛错 → scheduleRetry 被跳过）',
    )
    assert.ok(calls >= 2, `未发生重试（calls=${calls}）`)
    un()
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

await ta('订阅者抛错不卡死 writing（写之后的读结果仍能回写）', async () => {
  const unhandled = []
  const onUnhandled = (e) => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  try {
    let gets = 0
    // 每次读返回递增的值：便于区分「读回写真的发生了」与「读结果被丢弃」
    const fetchImpl = async (_url, init) => {
      if (init?.method === 'POST') return okJson({ rate: 5 })
      gets++
      return okJson({ rate: gets })
    }
    const scope = H.createHttpScope('http://scope.test', fetchImpl)
    const un = scope.subscribe(() => { throw new Error('subscriber boom') })
    assert.ok(await waitFor(() => scope.getSnapshot().status === 'ready'))
    assert.equal(scope.getSnapshot().value.rate, 1)
    // 写：乐观 emit 抛错（应被隔离）→ set 不炸穿、writing 正常归零
    await scope.set('rate', 5).catch(() => {})
    // 写之后的一次读必须能回写（GET#2 → rate=2）——writing 卡死则读结果被丢弃
    un()
    const un2 = scope.subscribe(() => { throw new Error('subscriber boom') })
    assert.ok(
      await waitFor(() => scope.getSnapshot().value.rate === 2),
      '写之后的读结果未回写——writing 计数卡死（订阅者抛错使 writing-- 的 finally 到不了）',
    )
    un2()
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

// ── M-4（Issue #15 R4）：窗口 focus 监听必须可摘除 ──
// createHttpScope 每次调用（插件每次 apply / 热重载）都新建一个 focus 监听器，
// 不摘除则每次热重载泄漏一个常驻监听器（获焦时多一次 load() = 多一次 GET）。
await ta('dispose() 摘除窗口 focus 监听（每次 apply 新建 scope，不摘除则每次泄漏一个）', async () => {
  const listeners = new Map()
  const prevWindow = globalThis.window
  globalThis.window = {
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener: (type, fn) => { listeners.get(type)?.delete(fn) },
  }
  try {
    let gets = 0
    const fetchImpl = async () => { gets++; return okJson({ rate: gets }) }
    const scope = H.createHttpScope('http://scope.test', fetchImpl)
    const un = scope.subscribe(() => {})
    assert.ok(await waitFor(() => scope.getSnapshot().status === 'ready'))
    assert.equal(listeners.get('focus')?.size ?? 0, 1, '未注册窗口焦点重拉监听')
    scope.dispose()
    assert.equal(
      listeners.get('focus')?.size ?? 0,
      0,
      'dispose() 未摘除 focus 监听——插件每次 apply/热重载都泄漏一个常驻监听器',
    )
    un()
  } finally {
    if (prevWindow === undefined) delete globalThis.window
    else globalThis.window = prevWindow
  }
})

// ── M-5（Issue #15 R4）：两条既有锁抓不到它们声称锁的守卫 —— 补另一半窗口 ──
await ta('卡片关闭（无订阅者）且「在途读随后失败」→ 不后台重试', async () => {
  // 既有用例的场景是「失败先落定、再退订」——退订路径的 clearRetry() 已把定时器撤掉，
  // 删掉 scheduleRetry 里的 `subs.size === 0 ||` 照样绿。守卫真正防的窗口是：
  // 退订发生在**在途 GET 落定之前**，随后该 GET 失败 → scheduleRetry 被调用。
  let release = null
  let calls = 0
  const fetchImpl = async () => {
    calls++
    return new Promise((_r, rej) => { release = () => rej(new Error('boom')) })
  }
  const scope = H.createHttpScope('http://scope.test', fetchImpl)
  const un = scope.subscribe(() => {})
  assert.ok(await waitFor(() => release !== null), 'GET 未发出')
  un() // 卡片关闭（在途 GET 尚未落定）
  release() // 在途 GET 失败 → 走 catch → scheduleRetry()
  await sleep(900) // > 首发退避 500ms
  assert.equal(calls, 1, `卡片关闭后仍在后台重试（calls=${calls}）`)
})

await ta('写失败且回读也失败 → 快照不得留着从未落地的乐观值（回滚 emit 必须发生）', async () => {
  // 既有用例的终值由失败后的 load() 重新 GET 给出 → 回滚 emit 本身零断言。
  // 真正的差异在**订阅者序列**：写失败且回读也失败时，unavailable 快照带的应是
  // 回滚后的旧值；没有回滚 emit 就是「从未落地的乐观值」。
  let gets = 0
  const fetchImpl = async (_url, init) => {
    if (init?.method === 'POST') throw new Error('post boom')
    gets++
    if (gets === 1) return okJson({ rate: 1 })
    throw new Error('get boom') // 回读失败
  }
  const scope = H.createHttpScope('http://scope.test', fetchImpl)
  const seen = []
  const un = scope.subscribe(() => seen.push(`${scope.getSnapshot().status}:${scope.getSnapshot().value.rate}`))
  assert.ok(await waitFor(() => scope.getSnapshot().status === 'ready'))
  await scope.set('rate', 9)
  assert.deepEqual(
    seen.slice(0, 4),
    ['ready:1', 'ready:9', 'ready:1', 'unavailable:1'],
    `订阅者序列不对——回滚 emit 缺失 → 从未落地的乐观值（9）留在快照里：${JSON.stringify(seen)}`,
  )
  un()
})

// ── R4 第四批：底层 inFlight 吞失效 ──
// 旧实现 `if (inFlight) return` 把在途窗口内的重拉静默丢弃（且不排重试）：
// 这次失效就此消失，卡片永远停在旧值（不自愈）。本用例**直接对 createHttpScope
// 构造（不经桥）**——测的是底层 load() 的吞失效，不是桥侧行为（桥侧另有 pending 补拉）。
await ta('在途读期间到来的重拉不被丢弃 → 落定后补拉一次，最终拿到最新值', async () => {
  const handlers = {}
  const prevWindow = globalThis.window
  globalThis.window = { addEventListener: (type, fn) => { handlers[type] = fn } }
  try {
    let releaseGet1 = null
    let gets = 0
    const fetchImpl = async () => {
      gets++
      if (gets === 1) {
        // 第一次读在途（慢）：落定的是旧值
        return new Promise((r) => { releaseGet1 = () => r(okJson({ rate: 1 })) })
      }
      return okJson({ rate: 2 }) // 补拉拿到最新值
    }
    const scope = H.createHttpScope('http://scope.test', fetchImpl)
    const un = scope.subscribe(() => {})
    assert.ok(await waitFor(() => releaseGet1 !== null), '首次 GET 未发出')
    // 在途窗口内再来一次 load（底层语义 = invalidate 触发的重拉）
    handlers.focus()
    assert.equal(gets, 1, '在途期间的第二次 GET 不应立即发出（由在途请求落定后补拉）')
    // 在途请求落定（旧值）→ 应自动补拉一次，最终拿到最新值
    releaseGet1()
    assert.ok(
      await waitFor(() => scope.getSnapshot().value.rate === 2),
      '在途期间的重拉被吞掉——最终值停在旧值（不自愈）',
    )
    assert.ok(gets >= 2, `未发生补拉（gets=${gets}）`)
    un()
  } finally {
    if (prevWindow === undefined) delete globalThis.window
    else globalThis.window = prevWindow
  }
})

await ta('dispose() 之后不再拉取也不写（置死）', async () => {
  let gets = 0
  let posts = 0
  const fetchImpl = async (_url, init) => {
    if (init?.method === 'POST') posts++
    else gets++
    return okJson({ rate: 1 })
  }
  const scope = H.createHttpScope('http://scope.test', fetchImpl)
  const un = scope.subscribe(() => {})
  assert.ok(await waitFor(() => scope.getSnapshot().status === 'ready'))
  scope.dispose()
  const getsAfterDispose = gets
  await scope.set('rate', 2).catch(() => {})
  await sleep(50)
  assert.equal(gets, getsAfterDispose, 'dispose 之后仍发起了 GET')
  assert.equal(posts, 0, 'dispose 之后仍发起了 POST')
  un()
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
