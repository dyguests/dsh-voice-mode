# Changelog

本项目的所有重要变更都记录在本文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.7.25] - 2026-10-19

**Patch**：兼容 dsh 0.2.1-alpha.5 / 0.2.1-rc.2（四层验证全绿）；`engines.dsh` 改为带上界；验证矩阵扩至 17 版 / 14 核心；冒烟脚本适配 0.2.1 设置入口迁移。

### 兼容

- 复核 dsh **0.2.1-alpha.5 / 0.2.1-rc.2**（next 通道；rc.2 为 0.2.1 正式版候选）：17 版锚点 9/9、17 版 host/client 双 typecheck、14 核心 runtime 冒烟（16 断言：mic 双语渲染、设置卡片/迁移/写入/刷新保留/专属页/双语卡片/语言热切换/覆盖层落盘/引擎热切换/非法值与跨源拒绝）、真 LLM + 真实语音闭环 4 帧 / 0 tts-error。实证见 `docs/compat-contract.md` §19。
- **`engines.dsh` 改为 `">=0.1.1-rc.2 <0.3.0"`**（原无上界）：dsh 0.2.1-alpha.4 起 next/alpha 通道由 `engines.dsh` 单独硬校验兼容性（不满足即拒绝加载），无上界意味着未来破坏性大版本仍会被放行到未测试宿主；按官方推荐风格封顶 0.3.0，未验证的新大版本将被干净拒绝。已实测范围 0.1.1-rc.2 → 0.2.1-rc.2 全部落在界内。
- 适配 0.2.1-alpha.4/5 起设置入口迁移：Settings 从侧栏「More」菜单移入底部「Account menu」弹出层（未认证时引导后弹可关登录门）。插件两处入口（设置弹窗「语音模式」专属页 + 插件详情页卡片）均仍有效，业务源码零改动；冒烟脚本新增第三条导航路径与登录门关闭（对照组线上 0.2.0-rc.2 回归 16/16，旧宿主无回归）。

### 测试与工具

- `scripts/typecheck-dual.sh` cordis 映射补表：`0.2.1-alpha.4/5 → 4.0.5-alpha.2`、`0.2.1-rc.2 → 4.0.5`（npm view peer 实证）。
- `scripts/verify-dual.sh` 矩阵 15→17 版锚点/typecheck、12→14 核心冒烟；`check-dsh-version.sh` 恢复 exit 0 对齐。
- 文档同步：根/插件中英 README 兼容声明、CONTEXT.md 宿主兼容行、`docs/RELEASE-WORKFLOW.md`（发版正典回 release.sh）。

## [Unreleased]

### Issue #15 用户体验反馈处置（10 项，8 批+收口；计划真源 `docs/plan/issue-15-ux-feedback.md`）

**新增**

- **打断语音抢救（问题①）**：AI 朗读中开口打断，从「开口」到「打断生效」之间说的话不再被吃——播放期 AEC 后墙钟预录 2s 环，hardBreak 时把「语音起始前 250ms」起的音频并入新识别段（ADR-0012）。种子锚点锚 detect 请求体起点（帧级 VAD 语义保证不切句首）；抢救段若整段只是「嗯/对」等附和词则 engine 侧弃段（不当消息发出）；设置「打断语音抢救」（默认开，回声劣化环境可关）。
- **运行中语音插话（问题②）**：宿主提交槽位硬编码 queue（语音消息必排队）→ 运行中改用 `session.prompt(text,'steer')` 直达（下一个 step 边界消费，不等任务结束）；任何失败/老宿主自动回退原队列路径（不劣于现状、不双发）。
- **实时转写回填输入框（问题③）**：partial 实时写入草稿（定稿时替换尾部，不重复计入）；唤醒待机态的 partial 仍是诊断反馈不进草稿。
- **识别模式语义化与定稿耗时（问题④）**：senseVoice 开关文案改「准确/快速模式」讲清快慢取舍；final 请求超时 10s→25s 对齐宿主 20s race 上限（慢定稿不再空转重试）；定稿超过 2 秒状态条显示「识别中… Ns」。
- **LLM 纠错（问题⑤，默认关）**：发送前对整条语音文本做一次「只改错别字/同音字/标点」的纠错（复用宿主已配置模型，不引入新凭据）；失败/超时一律回退原文，不阻断发送。设置「LLM 纠错」。
- **设置生效反馈（问题⑧）**：生效时机改为四档诚实文案（即时/下次识别/下一段话/下次进入语音模式）；设置卡片顶部列出「已保存但未生效」的项及其**当前生效值**（与运行态配置快照比对）。
- **静默路径提示与诊断复制（问题⑨）**：识别/检测通道连续失败 3 次、SSE 断连时状态条提示；一键复制诊断信息（只含版本/状态/设置/阶段耗时，不含任何转写原文）。

**变更**

- **发送延迟与静音阈值解耦（问题⑦）**：自动发送的附加等待从 silenceMs 改为固定 1200ms——调低「静音判定时长」不再连带压缩发送窗口（长句不再被自然停顿切成多条）；端点语义不变。

**修复**

- 打断吃句（问题①根治）、运行中排队（问题②）、partial 不回填（问题③）、识别慢的感知面（问题④）、同音字/错别字（问题⑤）、设置不生效的误导文案（问题⑧）、静默故障无头（问题⑨）。
- 真机验收项（外放/耳机 salvage 纯度、运行中插话、LLM 纠错开/关、发送延迟、桌面端 Electron 冒烟）登记于 `docs/qa/must-verify-manually.md`；0.2.1-rc.2 runtime 冒烟全量通过、alpha.5 设置卡片探针失败经发布包 A/B 实证非回归（`docs/compat-contract.md` §20）。

**明确不做（issue 回复中已向用户交代）**：真全双工、乐观发送/两段下发、云端 ASR、自定义热词、纠错确认 UI、语义断句、外部文件 watch 等（架构级或需单独议题）。

### Issue #15 R2 全量多代理协同深化（5 Blocker + 20 Important + 60+ Minor；2026-10-20，commit `6995ae7`）

用户指令升级为「全代码库多代理协同、逐行细审、loop 到连续 2 轮零问题」：R1 发现轮（7 个只读代理：asr/client/host/新模块+i18n/docs/test/UX）→ R2 修复轮（6 个 teammate 按不相交 write scope 并行）→ 集成轮（行为测试补齐 + 文档终态 sync）。

**修复（用户可见，5 个 Blocker）**

- **400ms 回声尾音宽限从未生效**（自 `6b1ea37` 起跨 8 批未发现）：播放引擎收到的是不记录 playing 降沿的裸 `setUi` 闭包 → `playingEndAt` 恒 0 → ECHO_TAIL 宽限恒不触发（句播完瞬间残响漏入 ASR 的自聊风险）。提取命名 `setUi` 为唯一写入入口，播放引擎与状态条/手势同源。
- **五条错误提示路径永不可见**：麦克风被拒 / 插件被禁用 / 429 限流 / 空闲退出 / autoResume 的提示写在退出之后，用户什么都看不到。改为麦克风按钮旁常驻提示面（与激活态解耦），空闲提示后移到退出完成之后。
- **唤醒词泄漏进消息**（issue #10 症状回归）：待机期一次 host 202（模型加载中）把状态切出 wake → 唤醒门失效到下一段定稿。待机期 202 不再切 state；台架锁定 + 反向变异实证。
- **引擎热切换后回复前 N 句静默丢弃**：`tts-queue` `setEngine` 不升 epoch（与已修的 prune 同反模式）→ 新句 seq 归零撞拒绝线 + 孤儿泵双轨。逐队列 epoch++ 且保留 SessionQueue 对象保 seq 连续；red-green 回归测试。
- **文档与实现直接矛盾**：README 设置表漏 2 项（23→25）、生效范围两档过期、发送等待 1500ms→1200ms 五处与 issue 回复稿矛盾——中英 README、CONTEXT、ADR、plan 全修（含 27 处行号终态 sync）。

**修复（健壮性，Important 代表项）**

- hardBreak 清 autoSend/in-flight 标记（打断后幽灵提交）；打字退出不掐朗读；可见性恢复失败完整退出；backchannel 让位段打标 + 弃段（「嗯」不再泄漏进消息，含客户端剥尾闭环）。
- requestPartial 补 5s 超时（host 挂起不再静默死亡）；stop() 作废在途启动 + 双启动竞态 + stopRecorder 收尾 identity 守卫（麦克风常开 / 幽灵上行 / 新 audioCtx 被置空）。
- warmup 门控（`enabled=false` 不再后台下载 390MB 模型）；6 处隐式头改 `respondJson`（gzip 包装器下 403 复事故）；Config schema 补界（rate 五倍速 / silenceMs 碎句）；限流键 per-client（反代下不塌缩）；纠错 RTT 独立标记（12s 反馈黑屏 + 消息切分）；`correctText` 输出护栏（前言/超长回退原文）；EffectivePending 五项 fmt 映射（裸枚举不再示人）；toggle+manual 静默致聋如实披露。

**测试与工具**

- 测试套件自身修复：B1 五个文件 40 处 `t()` 异步不匹配（summary 提前打印少报 19——「518 全绿」口径的根源）；B2 preview-error 中文检查改扫原始 src（esbuild ascii 转义致证伪不了）。
- **新增 31 项行为级测试**（`fail-streak-notice` / `steer-submit-behavior` / `partial-gating` / `host-security-behavior` 等，连败提示 / steer 双发 / partial 门控 / 安全守卫，全部变异实证），连同 echo-tail 等共 7 个新文件登记入 `scripts.test`；装饰锁 5 处、死断言、K:/ 死脚本删除、陈旧行号实测刷新。
- 计数口径（**R2 时点**；R3 后 603 ✓ / 49 文件、R4 后 611 ✓ / 50 文件，见下两条）：`npm test` exit 0 / **583 ✓ / 48 文件**（两种求和法一致：各文件「N 项通过」之和 = `grep -c '✓'` = 583）。两个数字勿混用：**31 项为行为级测试**（R2 时点窄口径；R4 终态宽口径 74 项，含 R2 前存量 26 项，R3 时点宽口径 66 项）；**48 文件 / 583 项为全套件计数**，另含合同级/静态守卫类用例（如 `host-fixes.test.mjs` 为合同级非行为级）。

**文档事实同步**

- 测试计数 583/48 全位置落地（**R2 时点**；README 中英徽章/正文、TEST-SYSTEM、qa/checklist、STATE 口径注记含沿革）；ADR 11→12；must-verify/checklist/docs-CONTEXT 基线滚至 `6995ae7`；ADR-0012/0003/0008/CONTEXT/plan 共 30+ 处行号终态 sync（sed 逐行自检）；echoGate 0/937；issue 回复稿「开口前约 250ms」。

### Issue #15 R3 修复轮 + R3 验真轮（6 Important + 测试缺口；2026-10-20，`c11d311`+`6ddfb09`）

R2 验真轮发现 6 个新 Important（其中 2 个是 R2 修复自身引入的回归），R3 六个 teammate 并行修复并落库。

**修复**

- **sweep 孤立会话回收的代际投毒**（R2 自身回归）：sweep 只判 `segments` 不判 `finalizing` 在途 → 「定稿在途 + 30s 一扫 + barge-in」可构造陈旧定稿写入新会话 epoch 0 缓存 → 下一句 final 缓存命中返回旧文本（autoSend 默认开，错文本可能直接发出）。判定同时排除 `finalizing` 在途。
- **纠错周期串话**（R2 自身回归）：`correctInFlightRef` 单布尔跨周期复用 → 旧纠错周期 `.then` 清新周期标记 → 新文本静默漏发。改计数器令牌（只增不减），submitDraftNow / hardBreak / 退出 / 抢占 / 卸载均参与取废。
- **回填窗收窄 + 短输入护栏**：提交在途窗内 onPartial 不回写草稿（防已提交文本被写回且 steer 守卫跳过清草稿）；llm-correct 短输入长度护栏失效（64 下限旁路 3x 比率）修复。
- **start() 世代守卫 + worklet 回退路径复检**：授权返回/双启动竞态下旧启动不再抢新流；ScriptProcessor 回退路径补齐与 worklet 路径同构的复检（I1-I4 补行为级锁定）。
- **host-fixes 退出崩溃三层修法**：dispose/退出路径资源释放顺序修正（timer 清理 → 在途作废 → 句柄释放），修复设置面板多次拉取音色后的退出崩溃。

**测试**

- 新增 `correct-cycle-behavior` 9 项行为测试；行为级测试总数按**宽口径**（fix-test scope 枚举，含 R2 前存量文件 26 项）回放：R2 时点窄口径 31 项 → R3 时点宽口径 66 项 → R4 终态 **74** 项（+8；明细见 R4 条目）——勿误读为「R3 单轮 31→74」；全套件 `npm test` exit 0 / **611 ✓ / 50 文件**（两种求和法一致；本数字为 R4 后终态，沿革：R2 集成轮 583/48 → R3 后 603/49 → R4 后 611/50，+20 与 +8 拆解见 R4 条目）。
- R3 验真轮结论（4 只读代理）：**无 Blocker**；R3 修复本体 6/7 关闭 + 1 部分关闭（仅 tts-queue B1 注释行号）；新增 6 个 Important 转 R4 修复中（host-fixes 同步 t 复辟 / 双发防护腿行为锁 / en 前言放宽漏拦 / lib BUILD_TAG dangling / 文档计数与基线 / sweep loop1 守卫零锁），详见 `docs/rules/STATE.md`。

### Issue #15 R4 修复轮（R3 验真轮 6 Important；2026-10-20，`4916bd8`）

**修复**

- **host-fixes 同步 `t()` 复辟 R2-B1 反模式**（两个代理独立发现）：改 `async` + `await`；**双发防护腿补行为级锁**（移位置后全绿的空档）；**sweep loop1 守卫两段式毒链行为锁**（单废 loop1 全套件绿的空档）；**asr 生命周期行为锁**（`asr-lifecycle` 5 项：start/stop 世代、双启动竞态、stopRecorder 收尾）。
- **modules：en 前言放宽回退严格形态**（R3 修法副作用——三类元叙述形态穿过护栏且被测试固化，本次回退并修正测试固化）；**client/host 注释与矛盾注释修正**（含多处注释行号实测刷新）。

**测试与口径（终态）**

- 计数（**R4 时点**；终态 624 ✓ / 51 文件——R9 后 616（+5 barge-in-detect-behavior）、R11 后 618（+2 M7）、R12 后 622（+4 I-1/M7①/warmupSense）、R13 后 624（+2 第 6 道门/Minor-8），沿革见 STATE 账本）：`npm test` exit 0 / **611 ✓ / 50 文件**（两种求和法一致；`scripts.test` 链 50 个文件调用）。沿革：R1 41 文件/518 项 → R2 48 文件/583 项 → R3 49 文件/603 项（+20）→ R4 50 文件/611 项（**+8 = asr-lifecycle 5 + correct-cycle-behavior 9→11 + host-fixes 15→16**）。
- **行为级测试 74 项**（fix-test scope 枚举口径，**R4 时点**；终态 87 项 = 74 + barge-in-detect-behavior 5 + M7/I-1/warmupSense 行为回归 6 + 第 6 道门/Minor-8 2）：fail-streak-notice 4/4、partial-gating 3/3、asr-lifecycle 5/5、steer-submit-behavior 9/9、correct-cycle-behavior 11/11、host-security-behavior 13/15（余 2 条为源码常量锁）、host-fixes 3/16（R4 时点；**现值 7/20**——R12 后 host-fixes 行为级 +4 = M7① 入口判序双路径 3 + warmupSense 1（I-1 闸门锁在 tts-queue-engine、不计入 host-fixes；全套件 +4 breakdown 见 STATE 账本），余 13 条合同级；其余各文件计数与 R4 时点一致，现值以 STATE 账本枚举为准）、download 4/4、barge-in-manual 8/8、detect-route 6/6、sense-worker 8/8；镜像级（hold-clear 5/11、backchannel 5/31）不计。**与全套件 50 文件/611 项是两个口径，勿混用**。

### Issue #15 R5 修复轮（R4 验真轮 2 Important；2026-10-20，`0763966`）

**修复（用户可见）**

- **echo-tail 假绿修复**：`echo-tail.test.mjs` 复辟 R2-B1 同款反模式（同步 `t()` + async 用例浮动）——修复前「✓ 假绿 + summary 提前打印 + 之后才崩」，400ms 回声尾音宽限的行为锁恢复可信（变异实证：宽限永不到期）。
- **B1 缺陷类全库扫尾**：逐文件审计「t 定义形态 × async 用例体 × await 覆盖」，全库 B1 类残留为零（commit message 审计数字不可复现，更正注记见 `docs/rules/STATE.md`）。
- **dangling hash 修正**：CHANGELOG/STATE 引用的 `ad824b4`（amend 前同树哈希、从未 push）→ `4916bd8` 并补可追溯说明。

### Issue #15 R6-R8 勘误与口径治理（2026-10-20，`62698e5`+`77cb212`+`4230ba3`+`3cb2046`+`7997b4a`+`a549141`）

**修复（文档事实准确性，用户可见的结论不再失真）**

- **ADR-0008 假断言勘误两轮**：wakeEnabled「仅在 `/stay wake/` 时启用」（全仓零命中该符号）与「真机让位指令 = 0」（调研时点属实、落地后 ADR 未同步而 propagated）均改现态如实 + 勘误句。
- **口径约定三条**（STATE）：轮次标签按验真轮发现归标签；基线取代码+lib 批（docs-only 提交不滚）；commit message 数字/叙述失准以 STATE 更正注记为准。
- **计数口径滚动** 583/48 → 616/51 + 沿革落盘（「行为级 vs 全套件」双口径成文）；基线随收口批滚动、旧值移历史备查。

### Issue #15 R9 收口轮（2026-10-20，`bb42829`+`fbf8834`+`567b26d`）

**新增（用户可见）**

- **一级自动探测行为锁**（`barge-in-detect-behavior` 5 项）：detect 模式按原生 AEC 状态落 auto/manual 的行为级锁定（计数 +5）。

**修复（文档事实）**

- **ADR-0006 item 3 假断言勘误**：「第一级自动探测仍未实现」→ 已实现（`503e83e`；`asr.ts:1134-1136`，运行时取值消费于 :301-302/:828-829），一级（已实现）/二级（待真机样本）探测辨析。
- **全 ADR file:line 终态**（42 处刷新，逐处实测）：STATE Q1「ADR 行号全量同步」彻底关闭（锚点口径后于 R11 成文）。

### Issue #15 R10-R11 最终收尾（2026-10-20，`c4e2c3a`+`7f1b0f4`+`44f8ce6`）

**修复（用户可见，真实代码修复）**

- **dispose 懒重建泄漏两处**（`c4e2c3a`）：dispose 路径资源释放顺序修正，修设置面板多次拉取音色后退出时的泄漏路径；附 M7 两处行为回归（host-fixes +1、tts-queue-engine +1；计数 616→618）。
- **注释如实化 + 待决登记**：`needsRespawn` 死逻辑（M5）注释改如实，「Aborted 后是否允许同步重试」语义登记产品待决（当前恢复靠 tts-queue pump 3 次有界重试，功能不缺损）。

**治理**

- 锚点口径成文（现态锚点 + 漂移括注 + 历史时点例外）；第三方符号统一按符号定位；全仓 markdown 链接零坏链；计数 618 ✓ / 51 文件（R12 后 622、R13 后 624）、行为级 81 项（R12 后 85、R13 后 87）；基线滚至 `c4e2c3a`（R12 后 `38cc23e`、R13 后 `d7890a4`）。

### Issue #15 R12 修复轮（R11 验真轮 I-1 Important；2026-10-20，`38cc23e`+`bdeaa8d`+`ef80f9b`）

**修复（用户可见，真实代码修复）**

- **I-1：TtsQueue 无 closed 闸门**（Important）：dispose/close 之后，在途 pump 与后续 enqueue 仍对已关闭引擎 `synthesize`、本地 TTS 子进程被重新 fork（热重载泄漏）——补 closed 闸门（5 处判序）+ 行为锁 red-green 实证。
- **warmupSense 5s race timer**：同型第三处修（计时器生命周期与会话代际对齐）。
- **M7① 入口判序双路径独立抓红**：入口判序（防 dispose 后在途 final 继续走 `ensureSenseModel`+fork 的浪费）此前零行为锁，本轮与 create 后判序各自独立抓红（host-fixes +3）；**I-1 闸门锁**（tts-queue-engine +1）。
- **CI 纳入 `check:anchors`**：文档锚点检查进 CI，防行号漂移复发；另清理 Minor-6 死行。

**测试与口径**

- 计数：R11 后 618 → **R12 后 622 ✓ / 51 文件**（+4 = I-1 闸门锁 1 + M7① 入口判序双路径锁 2 + warmupSense 1；现行口径实为 14 处，更正注记见 STATE 账本）；行为级 81 → **85 项**。

### Issue #15 R13 修复轮（第六次全新 sweep 1 Important；2026-10-20，`d7890a4`）

**修复（用户可见，真实代码修复）**

- **Important-1：第 6 道门——重试 sleep 期间 close 不再 post-close synthesize**：有界重试的退避 sleep（400ms×attempt）期间若会话被 close，sleep 返回后仍会对已关闭引擎 `synthesize` → 本地 TTS 孤儿子进程被重新 fork（热重载泄漏同型第六处）；修「sleep 期间 close 不再触达 synthesize + 重试 timer 纳入取消集」，锁 B（timer 取消）red-green 实证（锁 A 抓红能力当时为零，更正注记见 STATE R13 账本）。
- **Minor-8：纵深防御**：close 后入口早返锁（双保险）。
- 测试：tts-queue-engine 5→7（+2），计数 622→**624 ✓ / 51 文件**、行为级 85→**87 项**。

### 规划中

- F1：emotion 标签 DSL 全量上线（LLM 侧标签使用指引注入 + 真机验收）
- ADR-0003：client-side VAD 下沉（语音活动检测从 host 侧移至客户端，进一步压延迟）
- 发布与美化批次：博客、发布说明与文档收尾（对应 `blog/` 与 `RELEASE-NOTES.md`）
- 引擎层静态审计待办（需真机验证后再改，见 CONTEXT.md「已知待办」）

## [0.7.24] - 2026-10-15

**Patch**：恢复 Edge 云端朗读 + 朗读失败可见性 + host 加固 + 兼容 dsh 0.2.1-alpha.2 / alpha.3。

### Fixed

- **Edge 云端朗读恢复（影响 ≤0.7.23 的默认引擎）**：微软 Edge TTS 服务端自 2026-10-15 起对内联的 msedge-tts 2.0.7 / 2.0.9 的 WebSocket 握手一律返回 403，默认朗读引擎整体无声；升级到 **msedge-tts 2.1.0** 并重新内联（`lib/msedge-tts.cjs`、`THIRD_PARTY_NOTICES.md`）。本地 VITS / Kokoro 不受影响。
- **朗读连续失败时给出可行动提示**：此前每句失败只提示「网络抖动，可重发」，且状态条优先级最低、回复期间常被「思考中」遮蔽，用户只会觉得「没声音」。现在 host 的 `tts-skip` 带连续失败计数，连续 ≥2 句失败时弹出并持续显示「云端朗读暂不可用，可稍后再试或切换本地引擎」；预览的 `WebSocket error` 归入网络类。
- **设置面板不再直出 host 原始错误串**（可能含路径），统一显示本地化文案。

### Security

- `/voice-mode/models/retry` 只接受**同源 POST**：跨站 `<img src>` 的 GET 不带 Origin，原先可让本机悄悄下载约 388MB 模型。
- 模型树下载条目路径校验（拒绝 `..`、`.`、空段、反斜杠、NUL），防止远端 `rfilename` 经 `join` 写出缓存目录。
- `asr-error` 的 SSE 下行不再携带原始下载错误串（改为只写宿主日志）。

### 兼容

- 复核 dsh **0.2.1-alpha.2 / 0.2.1-alpha.3**（锚点 9/9、双 typecheck、runtime 冒烟、真 LLM 全流程）。alpha.3 起设置入口移入侧栏「More」菜单、设置弹窗里的「Plugins」改名「Built-in plugins」；本插件两处设置入口（设置弹窗专属页 / 插件详情页卡片）仍有效，冒烟脚本已适配（详见 docs/compat-contract.md §17–§18）。

### 测试与文档

- 新增 `test/host-hardening.test.mjs`、连续失败计数与预览归类用例；单测 440 项 / 34 套件。
- 架构图 `assets/architecture.svg` 重绘（旧图仍写「静音 700ms」且连线穿框）；README 去掉叠放的装饰图与过期的批次术语，中英文对齐，设置表以 23 项为准。

## [0.7.23] - 2026-10-08

**Patch**：内联依赖的安全修复 + 测试装置。

### Security

- 升级被内联进 `lib/msedge-tts.cjs` 的 **axios 1.19.0 → 1.20.0**：`pnpm audit` 报告 12 条公告（7 高危、5 中危，均修复于 ≥1.20.0；msedge-tts 仅用 axios 拉取微软语音列表，实际可达面有限，但发布物不应带已知高危代码）。通过 `pnpm-workspace.yaml` 的 `overrides` 固定；`THIRD_PARTY_NOTICES.md` 同步；CI 新增 `audit` job（high 及以上即红）。已验证升级后 Edge 真实合成（Node 与 Electron）与 322 个音色列表正常。

### 测试装置

- **语音全链路冒烟** `scripts/smoke-voice-chain.mjs`：本地 VITS 合成的真实语音作假麦克风 → 采集 → worklet → `/asr` → host 流式识别；`--loop`（`DSHVM_VOICE_LOOP=1 full-e2e.sh`）扩展为完整闭环：自动发送 → 真 LLM 回复 → 朗读音频帧到达客户端、tts-error 0。已在 dsh 0.1.5-rc.3 / 0.1.6-alpha.2 / 0.1.7-rc.2 / 0.2.0-rc.2 / 0.2.1-alpha.1 通过；`DSHVM_VOICE_CHAIN=1` 另可在桌面端外壳（Electron）内跑，通过。
- 桌面端外壳冒烟补充播放半边：Edge 的 MP3 与本地 VITS 的 WAV 在 Electron Chromium 里解码并有声音。
- 新增桌面端外壳冒烟：`scripts/desktop-shell/`（官方 `apps/desktop` 关键机制的最小复刻）+ `scripts/smoke-desktop-shell.mjs`，真 Electron + Xvfb 下验证 `dsh-app://` 安全上下文、请求转发（Origin 被剥离）、SSE 流式、麦克风放行/拒绝策略、插件真实 AudioWorklet 收帧、mic 按钮渲染；`smoke-runtime.sh` 以 `DSHVM_ELECTRON=<electron>` 启用，<0.1.7 自动跳过。已在 dsh 0.1.6-alpha.2 / 0.1.7-rc.2 / 0.2.0-rc.2 / 0.2.1-alpha.1 通过。运行行为零改动。


## [0.7.22] - 2026-10-07

**Patch**：桌面端 Kokoro 失败提示本地化 + 预览归类修正。

### Fixed

- 官方桌面端（Electron）且 PATH 上没有 Node.js 时，选本地 Kokoro 的失败提示此前在设置面板里以**英文原文**展示（中文界面也是），试听失败还被误归为「请检查网络或音色名」。现在 host 返回稳定错误码 `kokoro_needs_node`，设置面板按界面语言显示可操作的中/英文提示，试听归为「引擎未就绪」。

### Changed

- README（中/英）故障排查补充桌面端 Kokoro 条目；`smoke-tts-engines.mjs` 断言无真 Node 时状态带该错误码；`smoke-settings.mjs` 支持 `DSHVM_SHOT_DIR` 截图供体验审查。

## [0.7.21] - 2026-10-03

**Patch**：权限/数据流与兼容声明完善（运行行为零改动）。

### Added

- 新增 `SECURITY.md`（并启用 GitHub 私密漏洞报告）；README（中/英）新增「权限与数据流声明」（对应插件市场能力扫描的 network / fs / shell / env）与「兼容声明」（`engines.dsh` 为市场版本筛选依据）；README 中指向仓库文件的链接改为绝对 URL（npm 页面上相对链接会失效）。

## [0.7.20] - 2026-10-03

**Patch**：文档与包元数据（运行行为零改动）。

### Fixed

- README（中/英）顶部「最近变更」横幅更新为 v0.7.17 ~ v0.7.19（此前仍停留在 v0.7.10），npm 页面首屏不再误导。
- 移除 `package.json` 中指向本地专用脚本的 `release` / `check:dsh-version` 两个入口（脚本被 `.gitignore`、不在仓库与包内，公开用户执行会报文件不存在）。
- `build.mjs` 过时注释更正（运行时依赖清单、客户端不从 CDN 加载代码）。

### 兼容性（0.2.1-alpha.1 验证）

- 已验证 dsh `0.2.1-alpha.1`（锚点 / 双 typecheck / 已安装形态冒烟含 Electron 宿主 / 真流程 e2e 全过），纳入 `verify-dual.sh` 矩阵；`ensure-core.sh` 容忍 pnpm 11 的 `ERR_PNPM_IGNORED_BUILDS`。插件运行行为无改动，未发版（见 `docs/compat-contract.md` §16）。

## [0.7.19] - 2026-10-02

**Patch**：官方桌面端（Electron）下本地 Kokoro 引擎修复 + 工程质量。

### Fixed

- **官方桌面端（Electron 宿主）下本地 Kokoro 无法合成**：`sherpa-onnx-node` 的 `generate()` 在 Electron 中抛 `External buffers are not allowed`（V8 内存笼拒绝 N-API 外部缓冲区；Electron 44.0.0 / Node 24.18.1 实测复现，普通 Node 正常）。现宿主为 Electron 时，Kokoro 子进程改用真正的 Node.js ≥18（env `DSHVM_NODE` 优先，其次 PATH 上的 `node`）；找不到时给出可操作的提示（安装 Node 或改用 Edge/VITS），而不是原生异常。vits / Edge / ASR 在 Electron 下均实测正常，不受影响。

### Added

- `src/tts-runtime.ts` + `test/tts-runtime.test.mjs`（7 项）；`scripts/smoke-tts-engines.mjs`（vits/kokoro 真实合成冒烟）；`smoke-runtime.sh` 支持 `DSHVM_HOST_CMD`（以 Electron RunAsNode 作宿主）、`DSHVM_TTS_SMOKE=1`、`DSHVM_ALLOW_BUILDS=1`（复现旧版缺陷）。
- 验证：以 Electron 44.0.0 RunAsNode 作宿主，已安装形态完整冒烟在 dsh 0.1.7-rc.2 / 0.2.0-rc.2 通过；同环境下 0.7.15 复现 issue #12；全部 33 个单测套件在 Electron 运行时下通过。

### 工程质量（未改变运行行为）

- 删除 5 处死代码（`asr-host.ts` 的 `dirname`/`statFile`/`stat`、`models.ts` 解构里未用的 `repo`/`allowCustomHost`、`segmenter.ts` 的 `TERMINAL`、`client.tsx` 的 `SUBMIT_DELAY_MS`），`tsconfig` 开启 `noUnusedLocals` 防回潮。
- CI 新增 `install` job：对打包产物做 pnpm(严格 build 脚本策略) + npm 全新安装并 import，Node 18 / 22 各一遍（兑现 `engines.node >=18`）。

## [0.7.18] - 2026-10-02

**Patch**：修复「别人从 npm 安装」类缺陷。**0.7.17 及更早所有版本**在 npm / pnpm 全新安装形态下存在下列问题（此前一直用 `link:` 测试，未暴露）；请升级到本版本。

### Fixed

- **pnpm 11 / npm 安装失败**：运行时依赖 `msedge-tts` 带 `preinstall: npx only-allow pnpm`，pnpm 11 报 `ERR_PNPM_IGNORED_BUILDS`、npm 被 only-allow 拒绝。现将 msedge-tts 连同全部传递依赖内联为独立 `lib/msedge-tts.cjs`，并移入 devDependencies（ADR-0011）。
- **dsh ≥0.1.7 上已安装形态「failed to import」**：`msedge-tts` 的 `require("buffer/index")` 经 dsh `ResolutionRouter` 对已安装插件的路由抛 TypeError。内联产物里的 Node 核心模块一律 `node:` 前缀、可选依赖打桩，不再有任何指向非核心模块的裸 require。
- 英文 README 设置表补齐缺失的 7 项（bargeInMode / echoGateDb / autoResume / shortcut / senseVoice / toolBeep / yieldMs）；移除未被引用的词典键 `previewSynthesisFail`。

### Added

- `THIRD_PARTY_NOTICES.md`（随包发布被内联的 32 个第三方包许可）与 `scripts/gen-third-party-notices.mjs`（`--check` 校验覆盖）。
- 防回归 `test/package-install.test.mjs`（11 项）：运行时依赖无安装脚本、产物只含核心模块/相对/已声明依赖、files 覆盖、许可覆盖。
- 发版前门禁：`scripts/verify-install.sh`（pnpm + npm 全新安装打包产物并 import）、`DSHVM_SPEC=file:<tgz>` 已安装形态冒烟（`docs/qa/TEST-SYSTEM.md` L5）。
- ADR-0009（设置自持久化）、ADR-0010（国际化绑定官方 locale）、ADR-0011（msedge-tts 内联）。

## [0.7.17] - 2026-10-02

**Minor**：设置面全版本打通 + 国际化重做。0.7.16 在 dsh 0.1.7+ 上插件**没有设置页**、`/mode` 切换持久化 500，且界面语言只读一次、设置卡片中英混杂；本版修复并以官方 `ctx.locale`、官方插件元数据格式落地国际化。验证：九个隔离核心（0.1.1-rc.2 → 0.2.0-rc.2）真浏览器冒烟全过，`npm test` 全绿，本机 dsh 0.2.0-rc.2 线上真流程通过。详见 `docs/compat-contract.md` §13–§15。

### Fixed

- **0.1.7+ 宿主上插件没有设置页、`/mode` 切换持久化 500**（0.7.16 及之前均存在）：0.1.7 起官方设置存储对本插件条目一律拒写（`settings/rejected: has no volatile fields`），旧槽位 `settings.plugin.item` 与客户端 `settingsScope` 同时被移除。现改为：0.1.7+ 用户设置落插件自有覆盖层文件 `$DSH_HOME/voice-mode.settings.json`（原子写、0600、逐键校验、损坏文件回退），经新增 `GET/POST /voice-mode/settings` 读写并热生效（引擎/音色/语速即时，与 ≤0.1.6 一致）；设置卡片注册到 `plugins.bundle.config`（插件详情页）。
- **升级后设置静默回到默认**：dsh ≤0.1.6 → 0.1.7+ 时，dsh 把旧 `settings.yaml` 改名为 `settings.yaml.imported`，但本插件的 `voice-mode:` 段不被官方存储接受、被留在改名文件里。现首次运行（覆盖层文件尚不存在）自动从 `settings.yaml`/`settings.yaml.imported` 的 `voice-mode:` 段迁移一次（仅平铺标量，逐键校验，未知/已砍键丢弃）。恢复默认请把覆盖层文件内容改成 `{}`（勿删除，否则会再次迁移）。
- **0.1.6-alpha.x 设置卡片不可见**：该线 `settings.plugin.item` 槽位已不存在而 `settingsScope` 仍在，卡片注册到不存在的槽位。现新旧两个槽位都注册。

### Changed（国际化重做）

- **界面语言即时切换**：接入 dsh 官方 locale 服务（`ctx.locale`，0.1.1 → 0.2.0 全版本可用）：zh/en 词典注册到 `voice-mode` 命名空间，切换 dsh 语言**无需刷新**，社区语言包可补充其它语言，缺失回落英文；服务不可用时回退读 `<html lang>`。此前文案字典只读一次浏览器语言、需刷新。
- **设置卡片全部本地化**：字段标题此前硬编码中文（`FIELD_LABELS`，英文界面里满是「朗读引擎/音色/语速…」），现走词典并补全真实英文（修掉 `ITN` 等临时 stub）；音色下拉的名称/性别/口音/风格（含 Kokoro、VITS、Edge 常用音色）、模型镜像、数据流徽标均按语言生成。
- **host 不再发自然语言**：错误响应改为稳定错误码 `{ code, error }`，客户端按界面语言翻译；此前试听失败等固定中文被英文用户直接看到、`rate limited` 等英文机器消息与 `String(e)` 异常文本被中文用户直接看到（后者还可能泄露内部细节）。同时修复试听失败出现「试听失败：试听失败：…」重复前缀。
- **LLM 口语化提示词**中/英两版，随界面语言选择（客户端进入语音模式时上报 `lang`；旧客户端不上报则沿用中文版）。
- **试听例句**按音色语种选（新增 ja/ko/fr/de/es/pt/it/ru），不再只有中/英。
- **插件展示元数据**：新增官方 `locale/en.json`、`locale/zh.json`（标题/描述）与 `icon.svg`，Plugins 页按语言显示「Voice Mode / 语音模式」及对应描述并带图标；`package.json` 的 `description` 改为纯英文（npm 页与回退用）。
- 音色目录改为单一数据源 `voice-catalog.ts`（此前 host 与客户端各抄一份且 host 那份含从未使用的中文标签）；schema 字段说明改为引用英文词典；运行日志一律英文。
- 测试：重写 `strings-coverage`（词典对称/占位符/字段标题/键引用/错误码闭合/**UI 文件零中文字面量 AST 红线**，已做 7 种回归的反向变异验证）；新增 `i18n`（官方服务语义复刻）与 `i18n-protocol`（音色标签中英输出、提示词、试听例句、错误码翻译）；冒烟新增英文界面卡片零中文、中文界面全中文、不刷新切换语言、mic 文案语言。

### Added

- **Settings → 语音模式 专属设置页（`settings.section`，所有 dsh 版本通用入口）**：此前设置入口随版本而异（≤0.1.5 在 Settings→Plugins，0.1.6+ 在插件详情页），用户难以发现；现在每个版本的 Settings 弹窗里都有同名页面（默认展开）。与 `dsh-better-sidebar` 等已适配 0.2.x 的插件的做法一致。
- `scripts/smoke-settings.mjs`（真浏览器设置页冒烟：入口可见 → 写入生效 → 刷新保留 → 0.1.7+ 覆盖层落盘/非法值/未知键/跨源写入被拒），已接入 `smoke-runtime.sh`；`test/settings-store.test.mjs`（覆盖层单测 + 两条真机教训的结构守卫）。
- `docs/compat-contract.md` §13：设置面在各 dsh 版本的槽位/数据面演变与方案取舍；更正 §12.2 中「0.1.7+ 无设置卡片属已知差异、自带面板可用」的错误表述。

## [0.7.16] - 2026-10-01

**Patch**：0.1.7+ 客户端兼容性修复（真回归：typecheck 全绿但运行时 FAIL 的典型案例）。

### Fixed

- **0.1.7+ 客户端永久 pending**：dsh 0.1.7 起客户端不再提供 `settingsScope` 服务，而 `client.tsx` 将其列入 `inject`——cordis 4.0.4 的 inject 无可选语义，插件客户端永不就绪、mic 按钮不渲染（插桩实证：0.1.5-rc.3 为 `object`、0.2.0-rc.2 为 `undefined`）。修复：`inject` 移除该项，设置卡片注册处改 `ctx.get('settingsScope')` 可选查找——≤0.1.6 照旧渲染设置卡片，0.1.7+ 跳过（官方设置页差异与插件自带面板说明见 `docs/compat-contract.md` §12.2）。

### Changed

- 验证矩阵扩至 `0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.0-rc.2`：锚点 27/27、typecheck 新三版 6/6（host+client）、隔离冒烟 3/3（三端点 200 + mic 渲染 + console 0 error）；`typecheck-dual.sh` cordis 映射补 `0.2.0-*→4.0.4`（peer 实证 `~4.0.4`）。
- `docs/compat-contract.md` 新增 §12（0.1.7-rc.2 → 0.2.0-rc.2 契约 diff 结论）；`CONTEXT.md` / `README.md` 兼容声明同步。
- 本机生产 dsh 已升 0.2.0-rc.2 并实测：`/voice-mode` 200、NRestarts=0、真流程 6 音频帧 / 0 tts-error。

## [0.7.15] - 2026-09-24

**Patch**：dsh 全版本兼容补齐 + 测试体系固化。`src/` 业务逻辑零改动（仅设置桥接），其余为验证装置与文档。

### Added

- **0.1.7 双路径设置桥**（`src/index.ts`）：`ctx.settings.register` 存在走旧路径（≤0.1.6，`register+get+watch` 原行为）；不存在走新路径（`voiceSettingsFromConfig(config)` 平面拷贝）。Config 接口 + schema 从 12 扩展到 27 字段（新增 15 个设置面板字段，与 `VoiceSettingsValue` 一一对应）；`/mode` 端点双写（`scope.update` vs `SettingsForms.mutate`）。
- **测试装置**：`scripts/ensure-core.sh`（版本证据表驱动 pnpm/npm 选择器）；`full-e2e.sh` 加四护栏（内存守卫 1500MB + 端口预检 + 就绪等待 + 进程组回收）与 `BOOT_ARGS` 启动参数覆盖点；`verify-dual.sh` 默认矩阵 5→8→9 版。
- **两套体系文档**：`docs/qa/TEST-SYSTEM.md`（四层验证维度 + 维持/迭代循环 + 六条已知陷阱）与 `docs/plan/COLLABORATION.md`（角色分工 + 四阶段流程 + 固定门禁），均已注册进各自 README 索引。

### Changed

- `schemastery`：`^3.18.1` → `^3.18.4`。
- `typecheck-dual.sh` cordis 映射：补 `0.0.1-*→4.0.1-rc.4` / `0.1.7-*→4.0.4`，删臆测兜底（未知版本线显式 exit 1）。
- 根 README 与插件 README（中/英）兼容声明改区间写法（含 0.1.7-rc.1），不再手写版本清单（防漂移）。

### Fixed

- `register` 裸调丢 `this`（内部读 `this.registrations`）：改 `.call(legacySettings, …)` 绑定调用。
- 否决 `.volatile()` 标记 Config 字段：schemastery 3.18.4 的 volatile 破坏 schema 函数调用形态，rc.3 起设置分层调用时污染 merge → ValidationError。

### Compatibility（25/25 闭环）

- 真流程 PASS 24 版：0.0.1-rc.5、0.1.0 全线、0.1.1 全线、0.1.2 全线、0.1.3-alpha.2、0.1.5 全线、0.1.6 全线、0.1.7-alpha.1/alpha.2/rc.1（每版三端点 200 + 真实 LLM 对话 + SSE 音频帧 + 0 tts-error）。
- 结构性不兼容 2 版：0.0.1-rc.1/rc.2（不可安装：删包依赖双源 404 + 无 `webServer` + 缺 3 锚点，三重证据）。
- 证据：`docs/compat-contract.md` §10/§11；`engines.dsh = ">=0.1.1-rc.2"` 不变。

## [0.7.14] - 2026-09-19

**Patch**：仅文档与元数据变更，`src/` 与运行时行为**零改动**。承接 v0.7.13 的文档事实修正，收口两处结构性问题。

### Fixed

- **版本归属**：上一版把「文档事实修正」记在 `[0.7.12]` 名下，但它们实际随 **v0.7.13** 发布——已拆分到 `[0.7.13]` 段；`[0.7.12]` 保留其真实内容（真机演示录屏、商店策展声明、npm 检索关键词、缺陷报告模板、401 失败页截图删除）。
- **根治版本漂移**：根 README 不再手写「当前版本 vX.Y.Z」，改为引用**动态 npm 徽章**与 Releases 链接。此前每次发版都会让 README 版本号立即过期（v0.7.11 → v0.7.12 期间已实际发生），该改动使这类漂移**结构上不再可能**。
- 插件 README（中 / 英）版本说明由「截至 vX」改为「**最近一批运行时变更（v0.7.10，2026-09-18）**」——版本自身的变更事实不随新版本过期。

## [0.7.13] - 2026-09-19

**Patch**：仅文档与元数据变更，`src/` 与运行时行为**零改动**。经对抗性审查后集中修正长期累积的文档事实漂移。

### Fixed

- **测试基线口径修正**：统一为 **380 项 / 28 套件**（`npm test` 两种独立口径实测一致）。v0.7.11 条目中的「385 项」为错误声明，根 README 徽章长期停留在 325，两者均在此修正——`test/` 自 v0.7.10 起未再改动，故 385 自始即为错报，而非测试被删。
- 根 README：对比表语种宣称由「6 语种 auto/zh/en/ja/ko/yue」改为「SenseVoice 自动识别」（`recognitionLanguage` 已于批 7M 移除，语言固定 `auto`）；修正列表编号断裂与「默认值微调」项数不符；**当前版本改为引用 npm 徽章（动态），不再手写版本号**——避免每次发版再次漂移。
- 插件 README：设置表由 16 项补全到 **23 项**（补 `bargeInMode` / `echoGateDb` / `autoResume` / `senseVoice` / `shortcut` / `toolBeep` / `yieldMs`），与 schema 完全一致；补入英文版独有的「配置 / API / 模型与缓存」三节（12 → 15 节，与英文版一致）；修正英文版「4 new ASR fields」却列 5 项的自相矛盾。
- `docs/README.md`：修正 2 条失效跨文件锚点（`#设置`、`#工作原理`）。
- `docs/rules/STATE.md`：状态表测试数 385 → 380（与 README / CHANGELOG 统一）。
- `CONTEXT.md`：删除「已落地增量」流水账段并校正自述行数口径；`RELEASE-NOTES.md`：移除机器专属路径。

## [0.7.12] - 2026-09-19

**Patch**：仅素材与检索元数据变更，`src/` 与运行时行为**零改动**。

### Added

- **真机演示录屏** `plugin/dsh-voice-mode/assets/demo-voice-flow.gif`：覆写 `getUserMedia` 注入真实语音音频，驱动**完整真实链路**录制（流式转写 → 停顿自动发送 → 按句朗读 + 实时字幕），非 UI 摆拍。采集与合成脚本：`screenshots/scripts/capture-demo.mjs` + `make-demo-gif.py`。
- **真机截图脚本** `screenshots/scripts/capture-live.mjs`：真实驱动 dsh Web UI（设置 → 插件 → 展开「语音模式」），且**只截设置对话框**（不含左侧会话列表）；产出 S01 / S02 两张真机截图。
- **商店策展声明** `plugin/dsh-voice-mode/screenshots.json`（5 张：演示 GIF / 双工闭环横幅 / 真机设置面板 / 麦克风主视觉 / 社交卡片），供 dshmarket 卡片缩略图与详情轮播读取。
- **缺陷报告模板** `.github/ISSUE_TEMPLATE/bug_report.yml`（引导附遥测日志、build 哈希、dsh 版本、输出方式、TTS 引擎）。

### Changed

- README（根 / 中文 / 英文）：接入真机演示 GIF，**替换过期的上游旧版界面截图**。
- npm `keywords` 9 → 28：补 `speech-to-text` / `barge-in` / `captions` / `wake-word` 等，并加中文检索词 `语音` / `字幕` / `打断` / `中文` / `本地识别`。
- `test/`：机器专属路径参数化（新增共享解析器 `test/_playwright.js`，浏览器路径改走 `CHROME_PATH`，其余改走环境变量）；以「本机绝对路径」模式扫描 `test/` **零命中**。
- `.gitignore`：屏蔽本机 / 维护者专属流程文档与脚本。

### Removed

- `screenshots/S01-install-config-7fields.png`：经查实为 **dsh Web 401 鉴权失败页**（白底 `authentication required`），并非真实截图，已删除并由真机截图取代。

> 说明：本仓库历史 CHANGELOG 仅记录到 0.7.7；v0.7.8 / v0.7.9 / v0.7.10 三版已发布但缺 CHANGELOG 段（事实漂移，本轮不补——属独立治理批次，由用户后续决定是否回填）。

## [0.7.11] - 2026-09-18

### Added

- **`scripts/full-e2e.sh`**：五版本 dsh 真流程端到端测试装置——隔离 DSH_HOME + profile（dsh-base + dsh-web-app + dsh-voice-mode link）+ 注入 `DEEPSEEK_API_KEY`（值仅进进程 env，不落盘）→ boot → 围栏换 Cookie → 三端点断言 → 真实 LLM `session/prompt` → 读 `SSE audio 帧数` + `tts-error` 判据。复用 `test/spoken-prompt-rpc.sh` 并在临时副本里替换 `ensure_auth()` 为 `return 0`（隔离环境无 systemd journalctl，避免覆盖已准备的 Cookie）。

### Changed

- 兼容声明：`package.json` description 中英文同步加 `0.1.6-alpha.2 preview` 措辞；测试基线从「91 项 / 254 项 / 325 项」刷为 **380 项 / 28 套件**（数字于 v0.7.12 复核修正，原记「385 项」为错报）；README 兼容列表扩为含 `0.1.6-alpha.2`。
- `CONTEXT.md` 宿主兼容行扩为 `0.1.1-rc.2 → 0.1.5-rc.2 + 0.1.6-alpha.2 预览`，引 `docs/compat-contract.md §9`。
- `docs/compat-contract.md` 新增 §9（顶端三档最新版本口径 + 0.1.6-alpha.2 实证矩阵 + 与 §8 差异 + engines 语义澄清 + 隔离核心获取步骤 + §7/§8 漂移修正）。

### Fixed

- **`scripts/typecheck-dual.sh` 历史隐患**：cordis 映射对未知 dsh 版本线**静默回退 4.0.1**——0.1.6-alpha.2 子包 peerDeps 是 `^4.0.2`，用错 cordis 类型面静默通过 typecheck。扩 cordis 映射到 `0.1.6-*`（4.0.2）；未知版本线**显式报错 + `exit 1`**，不再 `continue` 把后续版本线当成"已通过"跑了。
- **`test/spoken-prompt-rpc.sh` `rpc()` 兼容性**：0.1.5-rc.2 服务端响应里字段名带 `\"request\"` JSON 转义，原正则 `missing .{0,2}"request"` 不匹配；放宽到 `missing .{0,12}${inner}`。CREATE 显式传 `inner=request`（语义对齐 §8 schema）。

### Compatibility Matrix（2026-09-18 当日实测，含真 LLM 端到端）

| dsh 版本 | 三端点 | 真实 LLM 端到端（deepseek-v4-pro）|
|---|---|---|
| 0.1.1-rc.2 | ✅ 200 | ✅ 2 audio 帧 / 0 tts-error |
| 0.1.2-rc.1 | ✅ 200 | ✅ 4 audio 帧 / 0 tts-error |
| 0.1.5-alpha.2（`/tmp/dsh015-core`）| ✅ 200 | ✅ 2 audio 帧 / 0 tts-error |
| 0.1.5-rc.2 | ✅ 200 | ✅ 2 audio 帧 / 0 tts-error |
| **0.1.6-alpha.2** | ✅ 200 | ✅ **4 audio 帧 / 0 tts-error** |

## [0.7.7] - 2026-09-14

### Added

- **热词偏置（批 1，`9467c81`）**：识别解码注入热词，偏置分可调（1-5，默认 1.5），专有名词不再靠谐音运气。
- **锁语种 + 逆文本归一化（批 2，`3025e1b`）**：识别语种支持 6 语种锁定（默认 auto），杜绝中英混识抖动；ITN 把"三点五"落成"3.5"。
- **字幕无障碍档位（批 3，`0fe3f90`）**：字幕字号 0-3 档、宽度 0-2 档，窄屏/宽屏各有正确呈现；schema description 三档说明与测试反向断言。
- **emotion 标签 DSL 步 1（批 4，ADR-0007，`959c742` → `7b94653` → `d013193`）**：`<break>` 停顿与 whisper 轻语标签进入 TTS 链路；segmenter 白名单 26 个 HTML 标签豁免 emotion 标签名；`emotion-integration.test.mjs` 全链路防回归。
- **让位语义（批 5，ADR-0008，`7f1a09f`）**：短应答（"嗯""好""对"等 17 项词表）不再触发打断，真正的插话才让朗读闭嘴；backchannel 30 项回归测试。
- **总收口（批 6，`14dfc5e`）**：不变量 I1-I10 全保确认；CONTEXT.md / ADR-0007 / ADR-0008 / backlog 文档回写。
- **批 7A-J 十批周全修复（`78574ad` → `2d646d9`）**：
  - 批 A：识别器 markStale 懒重建（5 个 ASR 设置字段全覆盖）；
  - 批 B：client `/config` 透传 5 个 ASR 字段（严格类型校验 + 兜底）；
  - 批 C：FIELD_LABELS 7 个中文字段名 + `strings-coverage.test.mjs` 33 项文案覆盖守卫；
  - 批 D：TTS 拼帧段后置静音顺序修复（"你好<break>世界"输出顺序纠正）+ stripEmotionTags 死代码下线；
  - 批 E：短句端点确认最小窗口 200ms（`CONFIRM_MIN_MS`）+ SenseVoice 预热前置 enterMode + 识别超时 10s→20s；
  - 批 F：spokenFormat 注释对齐 + matchBackchannel 关闭守卫（省 CPU）+ 设置生效说明三段分组；
  - 批 G：NumberField 红框校验 + clamp + idle 30s 预警 + yieldMs 可调（9 处对称接线）+ VoiceOverlay 浮层指针事件修复；
  - 批 H：TTS 失败 3s error toast + 字幕浮层走 dsw-alias 主题变量 + MicButton 对比度 + autoResume 提示；
  - 批 I：verify-bazong 编码修复（15 处 U+FFBD 清零）+ ADR 数字真源对齐（22→26）+ README 三语同步 + `/preview` 错误归类（network/engine/text）；
  - 批 J：strings.ts 死代码 12 键清理 + 默认值微调（rate 1.0→1.1 / idleTimeoutMinutes 10→5，字段名零变化向后兼容）+ a11y 微调（aria-controls 配对、NumberField 拒绝多小数点）。
- **批 7K 收口（`15be91a`）**：真机验收清单 `docs/qa/real-machine-acceptance-checklist.md`（386 行）+ lib BUILD_TAG 对齐。
- **批 7L 收口（`1041929`）**：文档锚点与代码逐项同步（6 处 baseline 锚点刷新、191→254 测试数、中英文案与源码一致），文档与代码完全一致。

### Changed

- 兼容声明：`package.json` engines.dsh = `>=0.1.1-rc.2`（无上界），覆盖 dsh `0.1.1-rc.2 → 0.1.5-rc.2`，含 0.1.5-rc.2 线上真实 LLM 端到端验证。
- 测试基线：91 项 → 254 项（`npm test` 18 个文件全绿）。
- 默认值微调（批 7J）：`rate` 1.0→1.1、`idleTimeoutMinutes` 10→5；字段名零变化，旧 user settings.yaml 完全兼容。

### Deprecated

- `stripEmotionTags` 导出移除前置：批 7D 已下线并加下线守门测试；Edge TTS 引擎对 emotion 标签的原生 SSML 路径暂不启用，启用时另开批次。

### Removed

- `strings.ts` 死代码 12 键（modeBtnToggle/modeBtnHold/modeBtnTitle/ttsEngine/recognitionLanguage/captionFontSize/captionMaxWidth/engineIdle/ttsRedownload/ttsRedownloadHint/ttsCleaning 等，zh + en 双段同步）。
- `src/emotion.ts` 中全库零引用的 `stripEmotionTags` 导出（ponytail 原则，配下线守门测试防复活）。

### Fixed

- **B1 假阳性（批 4 收口）**：emotion 标签被 segmenter `plainText` 误剥导致"单测全绿、集成断裂"——plainText 改为 26 标签白名单 + `sanitizeForTts` 字符集修正，补全链路断言。
- **TTS 拼帧顺序（批 7D）**：`<break>` 静音帧错位在语音之前——改为"语音 → 静音"段后置顺序。
- **端点切分（批 7E）**：换气停顿把一句话切两半——短句确认加 200ms 最小窗口；SenseVoice 冷启动超时降级——预热前置 + 超时 20s。
- **`typecheck-dual.sh` 历史缺陷**：跑完残留临时 pnpm-lock.yaml——trap restore 同步备份/还原。
- **README 4 处漏列 + 1 处笔误**（`silenceMs` 700→1500，与 `src/index.ts` schema 真源对齐）。
- **/preview 错误归类（批 7I）**：网络/引擎/文本三类用户可读提示，响应体不再泄露内部细节。
- **a11y（批 7J）**：折叠按钮 aria-controls 与折叠体 id 配对；NumberField 拒绝 `1.2.3` 式输入；计时器 mm:ss 双位补零。

### Security

- `/preview` 错误响应仅返回归类后的用户提示，console.warn 诊断上下文仅落本地日志，不向客户端泄露内部实现细节。
- 全库保持零 API Key：密钥一律由宿主 dsh 注入，插件源码与配置不含凭据。

## [0.6.0] - 2026-08-22

### Added

- Kokoro 精度可选：本地 TTS 引擎支持精度档位选择，按机器性能权衡音质与速度。
- 唤醒词：`normalizeWake` 归一化（含前缀语气词白名单），唤醒判定更稳。
- 工具提示音：工具调用期提示音反馈，交互状态可感知。
- 自研 NLMS 回声消除兜底（`src/aec.ts`）：原生 AEC 失效时的备用链路（ADR-0001）。

### Changed

- 识别链路接入 Silero VAD 门控，外放/耳机双形态回声门控策略成形（ADR-0006 前置）。

## [0.5.0] - 2026-08-15

### Added

- 语音双工插件首个稳定形态：`/voice-mode` 路由、SSE 事件流、owner 归属。
- 本地 TTS（`tts-local.ts`）与朗读队列（`tts-queue.ts`）：流式合成 + 队列调度。
- 字幕浮层：识别结果实时上屏。
- 测试基线 91 项（`npm test`）。

## [0.5.1] - 2026-08-20

### Fixed

- 采集/门控打断引擎（`asr.ts`）的 finalize 幂等性：重复 finalize 不再破坏识别句柄（不变量 I1 起点）。
- `client.inject` 9 个锚点冻结：宿主注入契约逐字锁定（不变量 I6 起点）。

[Unreleased]: https://github.com/qishuilalala/dsh-voice-mode/compare/v0.7.7...HEAD
[0.7.7]: https://github.com/qishuilalala/dsh-voice-mode/releases/tag/v0.7.7
[0.6.0]: https://github.com/qishuilalala/dsh-voice-mode/compare/v0.5.1...v0.6.0
[0.5.0]: https://github.com/qishuilalala/dsh-voice-mode/releases/tag/v0.5.0
[0.5.1]: https://github.com/qishuilalala/dsh-voice-mode/compare/v0.5.0...v0.5.1
