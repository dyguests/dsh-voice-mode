/**
 * markStale 接口契约单测（批 A，B2 防回归）。运行：node test/asr-host-rebuild.test.mjs
 *
 * 覆盖：
 *  1) markStale 作为函数暴露在 createAsrRuntime 返回对象上（settingsScope.watch 调用契约）。
 *  2) 调用 markStale 不抛错、不破坏 runtime 句柄（modelStatus / warmup / dispose 仍可用）。
 *  3) 高频重复调用 markStale 安全（设置面板拨滑块可能一帧内多次触发）。
 *  4) 反向契约：markStale 不主动 free recognizer（实现只清两个闭包键，无 dispose 副作用）。
 *
 * 实现策略：esbuild 真编译 asr-host.ts，但 externalize + 桩化两处会触发网络/IO 的边界——
 *   - 'sherpa-onnx' → 内置桩（createOnlineRecognizer/createVad 返回 stub），
 *     保证 getRecognizer 不依赖 200MB+ 真模型也能走通到「创建并保留引用」这一步。
 *   - './models.ts' → 桩 ensureModelFile 恒返回 true（跳过 SHA256 校验与下载）。
 * 这样可观测到 recognizer 句柄本身，验证 markStale 不动它；否则真模型环境无法离线跑。
 *
 * 不变量 I1 保护：markStale() 故意只清 recognizerHotwordsKey + senseWorkerLangKey 两个
 * 闭包字符串，不调用 recognizer.free?.() / senseWorker.terminate()——in-flight finalize
 * 拿到的旧 recognizer 引用安全（旧段定稿不会被强制 free 丢句）。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-rebuild-'))

// --- sherpa-onnx 桩：可被识别为合法 stub，createOnlineRecognizer 返回的对象必须
//     包含 asr-host.ts 调用到的所有方法（createStream/isReady/decode/getResult/free
//     + config.featConfig.sampleRate）。createVad 同理但 VAD 路径本测试不触发。
const sherpaStub = join(tmp, 'sherpa-stub.mjs')
writeFileSync(
  sherpaStub,
  `
export function createOnlineRecognizer() {
  globalThis.__sherpaRecognizerCreated = (globalThis.__sherpaRecognizerCreated || 0) + 1
  return {
    createStream: () => ({
      acceptWaveform: () => {},
      clear: () => {},
      free: () => {},
    }),
    isReady: () => false,
    decode: () => {},
    getResult: () => ({ text: '' }),
    free: () => { globalThis.__sherpaRecognizerFreeCalls = (globalThis.__sherpaRecognizerFreeCalls || 0) + 1 },
    config: { featConfig: { sampleRate: 16000 } },
  }
}
export function createVad() {
  return {
    acceptWaveform: () => {},
    isDetected: () => false,
    isEmpty: () => true,
    front: () => ({ samples: new Float32Array(0), start: 0 }),
    pop: () => {},
    clear: () => {},
    free: () => {},
  }
}
export default { createOnlineRecognizer, createVad }
`,
)

// --- models 桩：ensureModelFile 恒返回 true，跳过 SHA256 校验与下载——
//     测试目的不是验下载链路，是验 markStale 接口契约。
const modelsStub = join(tmp, 'models-stub.mjs')
writeFileSync(
  modelsStub,
  `
export const HOST_PRIMARY = 'https://huggingface.co'
export function validateModelHost(h, _allow) {
  return h || HOST_PRIMARY
}
export async function ensureModelFile() { return true }
export async function ensureModelTree() { return true }
`,
)

// --- esbuild 编译 asr-host.ts：alias 'sherpa-onnx'，并用插件把 './models.ts'
//     重定向到我们的桩（esbuild alias 对相对路径不生效，需插件拦截 onResolve）。
const out = join(tmp, 'asr-host.bundle.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'asr-host.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: { 'sherpa-onnx': sherpaStub },
  plugins: [
    {
      name: 'stub-models',
      setup(build) {
        build.onResolve({ filter: /\.\.?\/models\.ts$/ }, () => ({
          path: modelsStub,
        }))
      },
    },
  ],
  logLevel: 'silent',
})

const { createAsrRuntime } = await import(pathToFileURL(out).href)

let passed = 0
const t = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// 构造最小 runtime：cacheDir 指向临时目录（ensureModelFile 桩恒返回 true，
// recognizer 创建在 stub 层面「成功」——但 stub 不暴露外部可观测引用，故此处用
// 反向契约（markStale 后 runtime 句柄仍完整 + 方法签名不变）+ 接口契约双重断言。
const runtime = createAsrRuntime({
  cacheDir: tmp,
  modelHost: () => 'huggingface.co',
  senseVoice: () => false, // 关闭：避免 getSenseWorker 触发 worker 文件解析（独立 .mjs）
  silenceMs: () => 1500,
  senseITN: () => true,
  allowCustomHost: false,
  broadcast: () => {},
})

console.log('createAsrRuntime 接口契约')

await t('返回对象暴露 markStale 函数（B2 防回归接口签名）', () => {
  assert.equal(typeof runtime.markStale, 'function')
})
await t('markStale 与 warmup / modelStatus 平级（不是私有方法）', () => {
  // Object.keys 检查可枚举性（runtime 是对象字面量返回——markStale 与 warmup 等并列）
  const keys = Object.keys(runtime).sort()
  assert.ok(keys.includes('markStale'), `runtime 缺 markStale，keys=${keys.join(',')}`)
  assert.ok(keys.includes('warmup'))
  assert.ok(keys.includes('modelStatus'))
})
await t('markStale 不返回值（void 返回，调用方不应依赖其返回）', () => {
  const r = runtime.markStale()
  assert.equal(r, undefined)
})

console.log('markStale 副作用：清缓存键 + 不 dispose')

await t('markStale 不抛错（无 recognizer / senseWorker 状态下也安全）', () => {
  assert.doesNotThrow(() => runtime.markStale())
})
await t('重复调用 markStale 仍不抛错（设置面板高频拨滑块模拟）', () => {
  assert.doesNotThrow(() => {
    runtime.markStale()
    runtime.markStale()
    runtime.markStale()
  })
})
await t('高频 200 次连续调用 markStale 不抛错（防回归：闭包变量被异常赋值会爆栈）', async () => {
  assert.doesNotThrow(() => {
    for (let i = 0; i < 200; i++) runtime.markStale()
  })
})

console.log('markStale 不 free recognizer（I1 free 契约 spy——头注 4 的实证）')

await t('markStale 不 free recognizer：建流→markStale×50→free 计数不变；dispose 才 free（对照）', async () => {
  // 头注 4 宣称「markStale 不主动 free recognizer」但旧实现无 spy 实证（零保护）——
  // 若 markStale 改调 recognizer.free()，in-flight finalize 的旧引用被强制释放会丢句（I1）。
  globalThis.__sherpaRecognizerFreeCalls = 0
  const rt = createAsrRuntime({
    cacheDir: tmp,
    modelHost: () => 'huggingface.co',
    senseVoice: () => false,
    silenceMs: () => 1500,
    senseITN: () => true,
    allowCustomHost: false,
    broadcast: () => {},
    bargeInMode: () => 'auto', // 批 7N 起 feed 守卫必读（auto 放行，与本测试意图无关但须提供）
  })
  await rt.feed('s-free', new Float32Array(1600), false, 0, 0, true) // 触发 recognizer + stream 创建
  assert.equal(globalThis.__sherpaRecognizerFreeCalls, 0, '基线：feed 建流本身不应 free')
  for (let i = 0; i < 50; i++) rt.markStale()
  assert.equal(globalThis.__sherpaRecognizerFreeCalls, 0, 'markStale 不得 free recognizer（I1：in-flight finalize 旧引用安全）')
  rt.dispose()
  assert.ok(globalThis.__sherpaRecognizerFreeCalls > 0, 'dispose 必须 free recognizer（spy 对照——证明计数器真能观测到 free，上一断言非恒真）')
})

console.log('markStale 不破坏 runtime 其它方法')

await t('markStale 后 modelStatus 仍返回完整结构（asr/vad/sense 三块齐全）', () => {
  const s = runtime.modelStatus()
  assert.ok(s.asr && s.vad && s.sense, `modelStatus 缺块：${JSON.stringify(s)}`)
  assert.equal(typeof s.asr.ready, 'boolean')
  assert.equal(typeof s.vad.ready, 'boolean')
  assert.equal(typeof s.sense.enabled, 'boolean')
})
await t('markStale 后 warmup 仍可调用（不破坏 recognizer 懒创建路径）', () => {
  assert.doesNotThrow(() => runtime.warmup())
  // warmup 是 fire-and-forget；此处只验证不抛同步错（异步部分不影响接口契约）。
})
await t('markStale 后 dispose 仍可调用（runtime 句柄未被破坏）', () => {
  assert.doesNotThrow(() => runtime.dispose())
  // 注：此处调 dispose 会清掉 runtime 内部状态——若本测试后还有用例需用 runtime，
  // 应复制 runtime 实例或重排顺序。本测试不再使用 runtime，可安全 dispose。
})

// ---------------------------------------------------------------------------
// M-2（Issue #15 R2）：dispose 后禁止 zipformer recognizer 懒重建。
//
// 泄漏链（与 senseDisposed/M7① 同型，但 zipformer 侧此前没有守卫）：dispose() 只 free
// **当时已存在**的 recognizer；而在途的 ensureModels()（首用要下 153MB encoder，窗口
// 以秒计）完成后，getRecognizer 会新建 recognizer 并赋值回闭包——这个 dispose 完全
// 不知道的 ~150MB WASM 块再无人 free（热重载每代泄漏一块，长命 host 进程内线性累积）。
//
// 本用例走查该时序：模型下载在途 → dispose → 放行下载（初始化完成回调在 dispose 之后
// 到达）。桩：models.ensureModelFile 可控挂起；sherpa 桩计数 createOnlineRecognizer
// 次数（新建次数是泄漏的直接可观测量——新建即无人 free）。
// ---------------------------------------------------------------------------
console.log('M-2：dispose 后 zipformer recognizer 不得懒重建（在途模型下载完成于 dispose 之后）')

const m2Tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-m2-dispose-'))
const m2ModelsStub = join(m2Tmp, 'models-stub.mjs')
writeFileSync(
  m2ModelsStub,
  `
export const HOST_PRIMARY = 'https://huggingface.co'
export function validateModelHost(h, _allow) {
  return h || HOST_PRIMARY
}
let downloaded = false
let pending = 0
const waiters = []
globalThis.__modelsPending = () => pending
globalThis.__modelsRelease = () => {
  downloaded = true
  const ws = waiters.splice(0)
  for (const w of ws) w()
}
export async function ensureModelFile() {
  if (!downloaded) {
    pending++
    await new Promise((res) => { waiters.push(res) })  // 模拟 153MB encoder 下载窗口
    pending--
  }
  return true
}
export async function ensureModelTree() { return true }
`,
)
const m2Out = join(m2Tmp, 'asr-host.bundle.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'asr-host.ts')],
  outfile: m2Out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: { 'sherpa-onnx': sherpaStub },
  plugins: [
    {
      name: 'stub-models-m2',
      setup(build) {
        build.onResolve({ filter: /\.\.?\/models\.ts$/ }, () => ({
          path: m2ModelsStub,
        }))
      },
    },
  ],
  logLevel: 'silent',
})
const { createAsrRuntime: createAsrRuntimeM2 } = await import(pathToFileURL(m2Out).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await t('M-2：在途模型下载完成于 dispose 之后 → 不得新建 recognizer（~150MB WASM 无人 free）', async () => {
  globalThis.__sherpaRecognizerCreated = 0
  const rt = createAsrRuntimeM2({
    cacheDir: m2Tmp,
    modelHost: () => 'huggingface.co',
    senseVoice: () => false,
    silenceMs: () => 1500,
    senseITN: () => true,
    allowCustomHost: false,
    broadcast: () => {},
    bargeInMode: () => 'auto',
  })
  // 发起一次 feed → getRecognizer → ensureModels（模型下载在途，本用例的关键窗口）
  const p = rt.feed('s-m2', new Float32Array(1600).fill(0.1), false, 0, 0, true)
  await sleep(300)
  assert.equal(globalThis.__modelsPending(), 1, '前置条件：应有一次 ensureModelFile 在途（模型下载窗口）')
  assert.equal(globalThis.__sherpaRecognizerCreated, 0, '前置条件：下载未完成时不得已创建 recognizer')
  // dispose 在在途下载期间到达。
  rt.dispose()
  // 放行下载：初始化完成回调在 dispose 之后才到达（本用例的核心时序）。
  globalThis.__modelsRelease()
  await p.catch(() => {})
  await sleep(300)
  assert.equal(
    globalThis.__sherpaRecognizerCreated,
    0,
    'dispose 后在途的 getRecognizer 仍新建了 recognizer 并赋值回闭包——该 ~150MB WASM 块再无人 free（热重载每代泄漏一块，长命 host 进程内线性累积）',
  )
})

rmSync(m2Tmp, { recursive: true, force: true })
rmSync(tmp, { recursive: true, force: true })
console.log(`\nasr-host-rebuild：${passed} 项通过`)