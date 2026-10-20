/**
 * 逐会话 TTS 队列：串行合成 + SSE 广播。
 *
 * 合成引擎抽象为 TtsEngine 接口——EdgeTtsEngine（微软云端 Edge TTS）与本地
 * VITS/Kokoro（tts-local.ts）都实现同一接口，队列/分句/打断/退避逻辑完全复用。
 *
 * 分块转发协议（P1-1，与 client 拼帧兼容）：引擎整句合成得到 Buffer 后，pump
 * 以「单个 chunk + final 帧」下发——Edge 与本地引擎统一走同一协议，客户端按句
 * 拼帧解码起播（本地 VITS/Kokoro 为单 chunk WAV，Edge 为单 chunk MP3）。
 *
 * 打断（Q2/Q8）：cancel() 提升会话 epoch——积压句子全弃，合成中句子在下一
 * chunk 到达时被丢弃，实现真正的静音。
 */
import { MsEdgeTTS, OUTPUT_FORMAT, type ProsodyOptions } from 'msedge-tts'

/** 合成引擎统一接口（云端/本地实现互替）。 */
export interface TtsEngine {
  /** 产出音频的 MIME（audio/mpeg = Edge；audio/wav = 本地 VITS/Kokoro）。 */
  readonly mime: string
  /** 热更新音色/语速（设置变更即时生效）。 */
  updateVoice(voice: string, rate?: number): void
  /** 合成一段文本为音频字节；失败抛错（上层退避重试）。 */
  synthesize(text: string, options?: { voice?: string; rate?: number }): Promise<Buffer>
  /** 打断：立刻中止在途合成并释放计算资源（本地引擎杀子进程；下一句自动重建）。 */
  interrupt?(): void
  /** 释放引擎资源（插件卸载/热重载）。 */
  close(): Promise<void>
  /** 引擎/模型现状（设置面板状态区轮询；可选）。 */
  status?(): TtsEngineStatus
  /** 预热/下载本地模型并初始化（设置面板「下载」按钮；Edge 无操作，缺省不实现）。 */
  prepare?(): Promise<void>
}

/** 单个模型文件的存在状态（用于设置面板现状展示）。 */
export interface TtsFileStatus {
  name: string
  exists: boolean
  size: number
}

/** 本地引擎某模型的组状态（仓库内文件 + 就绪/加载/失败）。 */
export interface TtsModelGroup {
  repo: string
  /** 组内全部必需文件已就绪（校验通过）。 */
  ready: boolean
  /** 正在初始化/加载（下载/子进程 init）。 */
  loading: boolean
  /** 最近一次加载/下载错误（可读字符串）。 */
  error?: string
  files: TtsFileStatus[]
}

/** 引擎/模型现状（设置面板轮询）。 */
export interface TtsEngineStatus {
  /** 当前生效引擎。 */
  engine: 'edge' | 'vits' | 'kokoro'
  /** 当前引擎是否就绪（本地：模型校验 + 子进程 init；edge：恒 true）。 */
  ready: boolean
  /** 当前引擎正在初始化/加载。 */
  loading: boolean
  /** 当前引擎最近一次错误。 */
  error?: string
  /** 最近一次错误的稳定错误码（可选；客户端据此翻译，无码则展示 error 原文）。 */
  errorCode?: string
  /** 当前模型下载进度（本地引擎下载时；edge 无）。 */
  progress?: { file: string; percent: number }
  /** 当前引擎的模型组（edge 无 local）。 */
  local?: TtsModelGroup
}

/** TTS 分块帧（P1-1）：单 chunk 合成场景下 chunkId 固定 0，final=true 帧携带字幕文本。 */
export interface TtsChunkFrame {
  sessionId: string
  /** 句序号（句级不变；客户端按句拼帧）。 */
  sentenceId: number
  /** chunk 序号（句内递增；单 chunk 场景恒为 0）。 */
  chunkId: number
  /** true = 本句最后一个 chunk，此后客户端拼帧完成可起播。 */
  final: boolean
  /** 句子文本（剥离 markdown 后；仅 final 帧携带）。 */
  text?: string
  /** base64 音频分片。 */
  audio: string
  /** 音频 MIME（client 据此构造 Blob 类型：audio/wav 或 audio/mpeg）。 */
  mime?: string
}

export type FrameListener = (frame: TtsChunkFrame) => void

const MP3_MAGIC = 0xff

/** setMetadata 的统一选项：句子/词边界回调都不需要（帧内无字幕元数据）。 */
const TTS_METADATA = { wordBoundaryEnabled: false, sentenceBoundaryEnabled: false } as const

/** Edge 音色列表请求超时（ms）：库内 axios 无超时，调用侧 race 兜底（M4）。 */
const EDGE_VOICES_TIMEOUT_MS = 30000

function prosodyFromRate(rate?: number): ProsodyOptions | undefined {
  if (rate !== undefined && rate > 0 && rate !== 1) return { rate }
  return undefined
}

/** 合法 MP3 帧以同步字开头；空音频（如英文音色读不了中文）视同无效。 */
function isValidMp3(buf: Buffer): boolean {
  return buf.length > 0 && buf[0] === MP3_MAGIC
}

/** Edge TTS 引擎（微软语音服务，云端；被朗读文本发送到微软）。 */
export class EdgeTtsEngine implements TtsEngine {
  private voice: string
  private rate?: number

  constructor(voice = 'zh-CN-XiaoxiaoNeural', rate?: number) {
    this.voice = voice
    this.rate = rate
  }

  readonly mime = 'audio/mpeg'

  updateVoice(voice: string, rate?: number): void {
    this.voice = voice
    if (rate !== undefined && Number.isFinite(rate)) this.rate = rate
  }

  async synthesize(text: string, options: { voice?: string; rate?: number } = {}): Promise<Buffer> {
    // Edge 直传云端，SSML 未启用，strip 另开批。
    const tts = new MsEdgeTTS()
    try {
      await tts.setMetadata(
        options.voice ?? this.voice,
        OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
        TTS_METADATA,
      )
      const { audioStream } = tts.toStream(text, prosodyFromRate(options.rate ?? this.rate))
      const chunks: Buffer[] = []
      for await (const chunk of audioStream) chunks.push(chunk as Buffer)
      const buf = Buffer.concat(chunks)
      if (!isValidMp3(buf)) throw new Error('empty or invalid audio')
      return buf
    } finally {
      try {
        await tts.close()
      } catch {
        // ignore
      }
    }
  }

  async close(): Promise<void> {
    // 无持久连接（每句独立连接），无需清理。
  }
}

/** Edge 音色列表（重命名缓存；/voice-mode/voices 用；失败抛错由调用方处理）。 */
let edgeVoicesCache: Array<{ ShortName: string; Locale: string; Gender: string; FriendlyName: string }> | null = null
export async function listEdgeVoices(force = false): Promise<Array<{ ShortName: string; Locale: string; Gender: string; FriendlyName: string }>> {
  if (edgeVoicesCache && !force) return edgeVoicesCache
  const tts = new MsEdgeTTS()
  try {
    // M4（Issue #15 审查 Minor）：补超时。MsEdgeTTS.getVoices() 内部是无超时的
    // axios.get（msedge-tts 2.1.0 只给 WebSocket 连接/合成设了 deadline，音色列表
    // 这条 REST 不在其列）——上游挂住时 /voices 路由的 Promise 永不 settle，
    // 设置面板「选 Edge 音色」转圈到浏览器超时，且 tts 实例悬挂。库不暴露信号，
    // 故在调用侧用 Promise.race 兜底（库内超时只覆盖 WS，与 models.ts 同思路：
    // 只兜「上游不响应」，不限制正常往返）。
    // R2 验真轮：超时 timer 落定后也 clear（与 asr-host.ts senseP 的 M2 同一反模式：
    // 持句柄 + race 落定即 clear）。注意 impact 表述要如实——早年实现带了 `.unref()`，
    // **unref 的 timer 不阻挠进程自然退出**（实测仅挂一个 unref 30s timer 的进程 37ms
    // 即退出），所以这里不是「修退出阻塞」。clear 的价值有两条：
    //  1) 避免长会话累积悬挂句柄——/voices 每次调用留一个 30s timer，设置面板反复
    //     拉取音色（或 force 刷新）即累积，虽不阻退出但仍常驻 timer 堆；
    //  2) 与 asr-host senseP 修法统一——那一处的 timer **没有** unref（是 ref'd），
    //     不 clear 真的会拖住 host 退出，两处同一模式便于对照审查。
    // 已知测试局限：「只 unref 不 clear」这一中间态在外部不可观测
    // （getActiveResourcesInfo / _getActiveHandles 均不报 unref'd timer），故回归测试
    // 只能锁「clear 到位」，抓不住回退到 unref-only——已在 test/host-fixes.test.mjs 注明。
    let voicesTimer: ReturnType<typeof setTimeout> | null = null
    const voices = await Promise.race([
      tts.getVoices(),
      new Promise<never>((_, reject) => {
        voicesTimer = setTimeout(() => reject(new Error('edge voices request timed out')), EDGE_VOICES_TIMEOUT_MS)
      }),
    ]).finally(() => {
      if (voicesTimer) clearTimeout(voicesTimer)
    })
    edgeVoicesCache = voices.map((v) => ({
      ShortName: v.ShortName,
      Locale: v.Locale,
      Gender: v.Gender,
      FriendlyName: v.FriendlyName,
    }))
    return edgeVoicesCache
  } finally {
    try {
      await tts.close()
    } catch {
      // ignore
    }
  }
}

interface QueuedSentence {
  text: string
  epoch: number
}

interface SessionQueue {
  pending: QueuedSentence[]
  busy: boolean
  seq: number
  /** cancel() 时提升；携带旧 epoch 的句子被丢弃。 */
  epoch: number
  /** TTS 不可达已通知过（去重，直到下一帧成功才复位）。 */
  errorNotified: boolean
  /** 连续被跳过的句数（任一句合成成功即清零）：区分「偶发抖动」与「云端整体不可用」。 */
  failStreak: number
  /** 错误退避毫秒（成功后清零）。 */
  backoff: number
}

export class TtsQueue {
  private readonly queues = new Map<string, SessionQueue>()
  private readonly listeners = new Set<FrameListener>()
  private engine: TtsEngine
  /** TTS 全体不可达通知（每会话去重，成功后复位）。 */
  private readonly onError?: (sessionId: string) => void
  /** 单句合成重试耗尽被跳过通知（每句一次；此前是静默丢句——真机「回复偶尔不朗读」根因之一）。 */
  private readonly onSkip?: (sessionId: string, text: string, streak: number) => void
  /**
   * M7②（Issue #15 R11）：退避重启计时器句柄集。
   *
   * 漏洞：pump 失败退避路径的 `setTimeout(() => void this.pump(...), delay)` 不持句柄，
   * close() 无从取消。close 后计时器仍触发 pump → 若该会话还有 pending，就会调
   * engine.synthesize → 本地引擎 ensureReady() **重新 fork 合成子进程**——插件已卸载、
   * 引擎已 close，却留下一个孤儿子进程（热重载每代泄漏一个，CPU/内存常驻）。
   * 修法：句柄入集，触发即自摘；close() 时全量 clearTimeout（与 asr-host senseP、
   * listEdgeVoices 的 timer 修法同构）。
   */
  private readonly backoffTimers = new Set<ReturnType<typeof setTimeout>>()
  /**
   * R13（Issue #15 Important-1）：重试 sleep 计时器句柄集。
   *
   * 与 backoffTimers 分开而非合并：语义不同（一个是「失败退避后重启泵」，一个是
   * 「单句合成重试间的 sleep」），且 sleep 由 retrySleep 统一创建、落定即自摘。
   * 不持句柄的后果：close 落进 400/800ms sleep 窗口时，该 timer 仍会走完——
   * 残留一个 ref'd Timeout 拖住事件循环 ≤800ms（同型反模式家族第 5 处，
   * 前三处：asr-host senseP、listEdgeVoices、warmupSense；第四处 backoffTimers）。
   */
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>()

  /** R13：可取消的重试 sleep——句柄入集供 close() 取消；落定即自摘。 */
  private retrySleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer)
        resolve()
      }, ms)
      this.retryTimers.add(timer)
    })
  }

  constructor(options: {
    engine: TtsEngine
    onError?: (sessionId: string) => void
    onSkip?: (sessionId: string, text: string, streak: number) => void
  }) {
    this.engine = options.engine
    this.onError = options.onError
    this.onSkip = options.onSkip
  }

  /** 当前引擎音频 MIME（/preview 的 Content-Type 也用它）。 */
  get mime(): string {
    return this.engine.mime
  }

  /**
   * 运行时切换引擎（设置面板「朗读引擎」即时生效 / Kokoro 精度切换 / 清理模型缓存后重建）：
   * 关闭旧引擎、作废所有会话的在途与积压；新句子用新引擎合成。
   *
   * B1（Issue #15 审查 Blocker）：早年实现只 `this.queues.clear()`——不升各队列的
   * epoch，也不保留队列本身，两处都错：
   *  1) 孤儿泵不停播：在途 synthesize 完成后 `item.epoch === q.epoch` 恒真，旧引擎的
   *     帧继续下行，与新引擎的帧双轨广播（prune() 已修同一反模式，setEngine 漏修）；
   *  2) seq 归零撞拒绝线：删队列后重入的新 SessionQueue seq 从 0 起算，而 client 的
   *     sentenceId 拒绝线（rejectSeqUpTo）是「旧会话遗留的最大句号」，新回复前 N 句
   *     全部 ≤ 线被静默丢弃——正是 /toggle 用 cancel 而非 prune 保 seq 连续的同一条
   *     不变式（index.ts:1177 进模式 cancel / :1191 让出旧会话 cancel(previous) / :1210 退出 cancel）。
   * 故此处与 cancel() 同构：逐队列 epoch++ + 清积压，但保留 SessionQueue 对象本身
   * （seq 连续递增，跨引擎切换不归零）。
   */
  setEngine(engine: TtsEngine): void {
    const old = this.engine
    this.engine = engine
    for (const q of this.queues.values()) {
      q.epoch++ // 作废在途句：孤儿泵在下一句检查时 break，不再广播旧引擎帧
      q.pending.length = 0 // 弃掉积压（旧引擎的音色/语速已不适用）
    }
    void old.close().catch(() => {})
  }

  /** 动态更换音色/语速（设置即时生效；正在合成的句子不受影响）。 */
  updateVoice(voice: string, rate?: number): void {
    this.engine.updateVoice(voice, rate)
  }

  /** 当前引擎/模型现状（设置面板状态区轮询）。 */
  status(): TtsEngineStatus {
    const s = this.engine.status?.()
    if (s) return s
    // Edge 云端引擎：无本地模型，视为恒就绪。
    return { engine: 'edge', ready: true, loading: false }
  }

  /** 触发当前引擎预热/下载模型并初始化（设置面板「下载」按钮；Edge 为无操作）。 */
  async prepare(): Promise<void> {
    // Minor-8（Issue #15 R13，纵深防御）：close 后不得再触发引擎 prepare——
    // 否则会走到 ensureReady 重走模型校验 + fork（I-1 同一条后果链）。
    // 现实调用方（设置面板「下载」按钮）在插件卸载后不可达，故非现实缺陷；
    // 补早返使公开面自成闭环，不依赖调用方自觉。
    if (this.closed) return
    await this.engine.prepare?.()
  }

  /**
   * 一次性合成（设置卡「试听」用）：委托当前引擎；不干扰朗读队列的在途合成。
   * 失败（含非法音色）抛错。
   */
  async synthesize(text: string, options: { voice?: string; rate?: number } = {}): Promise<Buffer> {
    // Minor-8：同上——close 后 reject 而非触达已 close 的引擎（调用方本就在 await，
    // reject 与既有「失败抛错」语义一致，无需新错误码）。
    if (this.closed) throw new Error('tts queue closed')
    return this.engine.synthesize(text, options)
  }

  subscribe(listener: FrameListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * I-1（Issue #15 R12）：关闭闸门。close() 最早期置位，此后：
   *  · enqueue 不再入队/起泵；
   *  · pump 入口直接返回；
   *  · pump while 不再取新句（在途那句已发出的 synthesize 允许自然结束——无法取消，
   *    但其结果不再广播，因为客户端已断开、广播无接收方）；
   *  · finally 的 pending>0 分支不再重排（即时重启与 backoff timer 都不排）。
   * 缺此闸门时 close 后仍会触达 engine.synthesize，而 tts-local 的 close() 已把
   * child/childInit/ready 全置 null → ensureReady 首行守卫失效 → 重走模型校验 + fork
   * 新子进程（热重载每代泄漏一个孤儿子进程）。详见 close() 处注释。
   */
  private closed = false

  /** 为某会话入队一句；若泵空闲则启动。 */
  enqueue(sessionId: string, text: string): void {
    if (this.closed) return // I-1：关闭后不入队、不起泵（否则会以 closed 状态再调 synthesize）
    let q = this.queues.get(sessionId)
    if (!q) {
      q = { pending: [], busy: false, seq: 0, epoch: 0, errorNotified: false, backoff: 0, failStreak: 0 }
      this.queues.set(sessionId, q)
    }
    // 队列上限（防病理性积压失控）。20 → 500：长回复流式文本比 Edge 合成快时，
    // 积压超 20 就会静默丢最旧句子——「长话跳句」的另一来源。500 覆盖任意正常回复
    // 长度（每句仅几十字，内存无忧），仍留病理性护栏；超限告警而非静默。
    if (q.pending.length >= 500) {
      console.warn('[dsh-voice-mode] TTS queue overflow, dropping oldest sentence')
      q.pending.shift()
    }
    q.pending.push({ text, epoch: q.epoch })
    void this.pump(sessionId, q)
  }

  /**
   * 弃掉某会话的所有积压并作废正在合成的句子（打断）。之后入队的句子
   * 获得新 epoch 正常播放。同时立刻中止在途合成（本地引擎杀子进程释放 CPU）。
   */
  cancel(sessionId: string): void {
    const q = this.queues.get(sessionId)
    if (q) {
      q.epoch++
      q.pending.length = 0
    }
    // 立刻中止在途合成：本地引擎杀子进程释放 CPU（在途句已被作废；否则其
    // 满核合成会饿死主进程的 ASR 解码，打断后定稿等待可达分钟级——实测根因）。
    this.engine.interrupt?.()
  }

  /** 会话退出/被抢占时彻底清理其队列（防止 Map 长期累积）。 */
  prune(sessionId: string): void {
    const q = this.queues.get(sessionId)
    if (q) {
      // 双重奏根治：孤儿泵不死——prune 只 delete queue 不提升 epoch 时，旧 q 的 pump
      // 继续合成并广播旧回合句子（item.epoch === q.epoch 对旧 q 永真），与新泵并行 →
      // 客户端同时收到旧/新两套句子（双重奏）。提升 epoch 让孤儿泵在下一句检查时
      // break，停止广播；重入的新回合用新 queue（seq/epoch 从头）。
      q.epoch++
      q.pending.length = 0
    }
    this.queues.delete(sessionId)
  }

  private async pump(sessionId: string, q: SessionQueue): Promise<void> {
    if (this.closed || q.busy) return // I-1：关闭后不起泵
    q.busy = true
    try {
      while (q.pending.length > 0) {
        if (this.closed) break // I-1：关闭后不再取新句（防 close 后继续 synthesize）
        const item = q.pending.shift()!
        // 单句合成有界重试：Edge 云端 WebSocket 偶发 ETIMEDOUT（实测日志），
        // 失败即静默丢句会表现为「长话没规律跳过几句」——重试 3 次、退避后仍失败才跳过。
        const MAX_SYNTH_ATTEMPTS = 3
        let buf: Buffer | null = null
        for (let attempt = 0; attempt < MAX_SYNTH_ATTEMPTS; attempt++) {
          if (item.epoch !== q.epoch) break // 打断：停止重试
          // R13（Issue #15 Important-1）：重试 sleep 期间 close 落进来 → 睡醒直接
          // synthesize 已 close 的引擎。I-1 的 5 处判序全在重试循环**之外**，此处是
          // 漏掉的第 6 条路径（实测复现：close 后仍有两次 synthesize@closed=true）。
          // 后果同 I-1：tts-local 的 close() 已置空 child/childInit/ready → ensureReady
          // 首行守卫失效 → 重走模型校验 + fork 孤儿子进程。真实时序无需网络故障——
          // close→kill child→在途 synthesize 被 child.on('exit') 的 rejectAll 打回即可进入。
          if (this.closed) break
          try {
            buf = await this.engine.synthesize(item.text)
            break
          } catch (e) {
            console.warn(`[dsh-voice-mode] synthesis failed (${attempt + 1}/${MAX_SYNTH_ATTEMPTS}): ${String(e)}`)
            if (attempt < MAX_SYNTH_ATTEMPTS - 1) {
              await this.retrySleep(400 * (attempt + 1))
            }
          }
        }
        // I-1：关闭后不广播——在途那句的 synthesize 允许自然结束（无法取消），但其
        // 结果已无接收方（客户端 SSE 已断），继续广播只会往断开的连接写帧。
        if (this.closed) break
        if (item.epoch !== q.epoch) continue
        if (buf === null) {
          // 重试耗尽：跳过该句（不阻塞队列），但**显式通知**调用方——静默丢句在真机上
          // 表现为「AI 回复偶尔整条/某句不朗读」，用户无从判断是网络还是功能坏了。
          q.failStreak++
          this.onSkip?.(sessionId, item.text, q.failStreak)
          continue
        }
        q.errorNotified = false // 有帧成功：复位不可达提示
        q.failStreak = 0
        q.backoff = 0 // 成功后退避清零，防下次失败时退避窗口无限递增
        const sentenceId = q.seq++
        const mime = this.engine.mime
        // 单 chunk（整句音频）+ final 帧（字幕文本）：客户端按句拼帧后解码起播。
        const dataFrame: TtsChunkFrame = {
          sessionId,
          sentenceId,
          chunkId: 0,
          final: false,
          audio: buf.toString('base64'),
          mime,
        }
        for (const fn of this.listeners) {
          try {
            fn(dataFrame)
          } catch {
            // listener 错误不得杀死泵
          }
        }
        const finalFrame: TtsChunkFrame = {
          sessionId,
          sentenceId,
          chunkId: 1,
          final: true,
          text: item.text,
          audio: '',
          mime,
        }
        for (const fn of this.listeners) {
          try {
            fn(finalFrame)
          } catch {
            // listener 错误不得杀死泵
          }
        }
      }
    } catch (e) {
      // M6（Issue #15 R11）：注释改如实。早年写「把句子推回以便重试」——**无对应代码**：
      // item 在 while 顶部已 shift() 出 q.pending，失败后并不回队，该句就此丢弃。
      // 本 catch 实际只做两件事：打一行带 sessionId 的诊断日志 + 每会话首次置
      // errorNotified 并回调 onError。且它近乎不可达——内层 for 循环已对每次
      // synthesize 做了 try/catch + 3 次重试，能逃到这里的只有监听器之外的非预期抛错。
      // 批 A：补 sessionId 上下文（item / attempt 是 while/for 内部 const/let，
      // 外层 catch 不可见——不做捕获重构以保持外科手术式改动）。
      console.warn(`[dsh-voice-mode] TTS unavailable: sid=${sessionId} err=${String(e)}`)
      if (!q.errorNotified) {
        q.errorNotified = true
        this.onError?.(sessionId)
      }
    } finally {
      q.busy = false
      // 防御：prune 后同会话立即重入时，孤儿泵不得带着残余 pending 重启
      // （否则与新的 SessionQueue 双泵并行合成）。
      if (this.queues.get(sessionId) !== q) return
      // I-1：关闭后不重排——即时重启与 backoff timer 都不排（close 的 clear 之后
      // 不得再有新 timer 入集，否则又是同一条泄漏链）。
      if (this.closed) return
      if (q.pending.length > 0) {
        // 失败退避：1s 指数递增至多 8s；成功/无错误即时。
        const delay = q.errorNotified ? q.backoff : 0
        q.backoff = Math.min(8000, delay + 1000)
        if (delay > 0) {
          // M7②：持句柄 + 触发即自摘，供 close() 全量取消（详见 backoffTimers 声明处）。
          const timer = setTimeout(() => {
            this.backoffTimers.delete(timer)
            void this.pump(sessionId, q)
          }, delay)
          this.backoffTimers.add(timer)
        } else void this.pump(sessionId, q)
      }
    }
  }

  async close(): Promise<void> {
    // I-1（Issue #15 R12）：closed 闸门必须最早期置位——早于清 timer 与关引擎。
    // M7② 只清了 backoff timer，但 close 后仍有三条路能触达 synthesize：
    //  1) enqueue 无守卫直接 void this.pump()（实测 close 后 enqueue 会以 closed=true
    //     再调一次 synthesize）；
    //  2) pump 的 while 在 await synthesize 期间不判 close，放行后继续取下一句；
    //  3) finally 的 pending>0 分支既走即时重启也走新排 backoff timer（close 的 clear
    //     之后再入集）。
    // 后果链：tts-local 的 close() 把 child/childInit/ready 全置 null → ensureReady 首行
    // `if (ready && child) return ready` 守卫失效 → 完整重走模型校验 + fork 新子进程——
    // 插件已卸载却留下孤儿子进程（热重载常态路径，非异常路径）。dispose 路径只
    // void queue.close() 不 cancel 不 prune，故闸门必须自成闭环。
    this.closed = true
    // M7②：先取消所有待触发的退避重启，再关引擎——否则计时器会在 close 后触发 pump，
    // 让本地引擎 ensureReady() 重新 fork 出一个孤儿子进程（热重载泄漏）。
    for (const timer of this.backoffTimers) clearTimeout(timer)
    this.backoffTimers.clear()
    // R13：一并取消重试 sleep 计时器——否则 close 落进 400/800ms 窗口时残留 ref'd
    // timer 拖住事件循环（且睡醒后会走上面补的 closed 判序而 break，timer 本身仍走完）。
    for (const timer of this.retryTimers) clearTimeout(timer)
    this.retryTimers.clear()
    await this.engine.close()
  }
}
