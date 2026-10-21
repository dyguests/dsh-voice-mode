# R15 剩余待办与接手说明（2026-10-21）

> 本文件是 **Issue #15 R2 全量深化轮 R15 阶段收尾时的交接件**。下一会话从本文件接手。
> 权威账本仍是 `docs/rules/STATE.md`（本仓「唯一恢复点」）；本文件只是把**剩余待办**单独拎出来，便于直接开工。

## 0. 交接基线（接手前先核对这一行）

| 项 | 值 | 核对命令 |
| --- | --- | --- |
| 基线 commit | `cb6cafd`（`fix(I15-R15-J)`） | `git log --oneline -1` |
| 全套件 | **785 ✓ / 53 套件** | `cd plugin/dsh-voice-mode && npm test 2>&1 \| grep -oE '[0-9]+ 项通过' \| grep -oE '^[0-9]+' \| awk '{s+=$1} END{print s}'` |
| 类型检查 | exit 0 | `npm run typecheck` |
| 宿主锚点 | 9/9 | `npm run check:anchors` |
| 文档锚点守卫 | exit 0（**在基线内**） | `npm run check:doc-anchors` |
| 行为级 / 合同级 | 492 / 293（492+293=785） | `docs/rules/STATE.md` 口径段 |
| R13 口径 13 文件子集 | 141 | 同上 |
| 工作区 | 干净，与 `origin/main` 同步 | `git status --short && git rev-list --left-right --count origin/main...HEAD` |

**接手第一件事**：`git fetch origin` + 核对 `origin/main...HEAD` 是否为 `0 0`——**本项目在 R15 轮吃过大亏**：本地 `main` 落后 `origin/main` **18 个提交**（含 v0.7.26 / v0.7.27 两次发版）却不自知，据此做了两小时无效审计。见 §4「纪律」第 1 条。

---

## 1. 本阶段已完成（供接手者建立心智模型，不必重查）

R15 阶段围绕**已发布代码（v0.7.27）**做了三轮「独立 sweep → 验真 → 修复」。**所有代码侧的 Blocker / Important 已清完，每条都有变异实证**。要点：

- **9 次独立 sweep**（分域只读取证）+ **3 轮验真**（核验修复本身、找连带回归）。每轮都真的查出了新东西——**验真轮查出的 4 个 Important 中有 2 个指向本仓自己刚提交的工作**。
- 修掉的代表性缺陷：
  - **segmenter 跨 delta 围栏状态机**（3 个 Blocker）：delta 末尾恰为 ``` 时状态机反向卡死、吞掉整回合正文；token 级围栏形态下「代码块不朗读」完全失效；未配对围栏吞整回合。
  - **麦克风按钮右键误触长按打断**（Blocker）：右键开快捷设置会取消正在生成的回复；后续又查出 **macOS Safari 的 ctrl+click 仍会切语音模式**。
  - **TTS 引擎级 closed 闸门**（第 7/8 道门）：close 后仍 fork 出携完整模型的孤儿子进程。
  - **`settings-http-scope` 的 `writing` 守卫方向反了**：迟到的 GET 会把刚写好的值盖回旧值（计数不建立 happens-before，改成单调写代数）。
  - **寒暄剥离削掉用户原话**（回归）：「好的，我知道了。」被静默改写成「我知道了。」。
  - **「停止朗读」在回合内被下一个 step 解除**；**跨会话叠播**；**焦点归属无实例级所有权**。
- **文档侧做了结构改造**（关键）：文档 `file:line` 锚点**每改一次代码就批量作废**，该缺陷已复发两轮。现新增 `scripts/check-doc-anchors.mjs` + 债务基线 `scripts/doc-anchors-baseline.json`，并**接进 CI**（`package.json` 的 `check:doc-anchors` + `.github/workflows/ci.yml` 的 `Doc anchor health check` 步）。口径同时升级为「**第一方代码的引用一律以符号锚为权威，行号仅作快照并可滞后**」（见 `docs/adr/README.md`）。

---

## 2. 剩余待办队列

### P0-1｜回填 130 处行号快照（机械，守卫逐条报出正确行号）

守卫报的 **DRIFT = 130**（行号快照漂移，**符号仍有效**，故不判红）。形态：

```
   docs/adr/0003-server-side-vad.md:10  src/client.tsx:53
      行号快照已漂移：INT_CONFIRM_FRAMES 不在 …/src/client.tsx:53 附近（±3 行窗口），但在同文件他处
      实际位置：INT_CONFIRM_FRAMES → plugin/dsh-voice-mode/src/client.tsx:47
```

**做法**：按「实际位置」逐条回填。判定纪律：
- 一处锚点可能对应**多个符号** → 取公共锚点（通常定义处），括注说明；
- 有些「实际位置」指向**不是定义处**（某符号在 HEAD 只出现一处、例如只在被引用处）→ 用那一处；
- 行号范围（`a-b`）被报成单符号 → 自行 `grep -n` 定位起止行。

**收尾**：`node scripts/check-doc-anchors.mjs` 应 **DRIFT 0 / ERROR 0 / exit 0** → 再 `node scripts/check-doc-anchors.mjs --update-baseline` 收紧基线，**并把 `scripts/doc-anchors-baseline.json` 一起提交**（否则基线与实际不符，下轮误报）。

⚠️ **回填期间若发现「某符号在 HEAD 根本不存在」**（守卫原本报 ERROR 的那种）→ 那是真缺陷，**不要猜一个符号**，单独记下来。

### P0-2｜重跑第三轮验真 sweep（本轮被用户中止，结论未取得）

中止时正在跑，分工与重点如下（原样保留，可直接复用）：

| 域 | 范围 | 重点 |
| --- | --- | --- |
| `v3-client-turn` | `src/client.tsx`、`src/mic-gesture.ts` | 权威回合号 vs 代理信号判错的一格；`shouldReleaseStopLine` 四输入判据的完备性（该解除没解除 / 不该解除却解除两个方向）；**辅助点击标志在键盘触发 click（无 pointerdown）时是否误吞正常 toggle**；`isGestureEnd` 的多 pointer 交互；`cancelPayload` 的 reason 是否有第三种语义被错标 |
| `v3-host-queue` | `src/index.ts`、`src/tts-queue.ts`、`src/llm-correct.ts` | **全局 seq 发号器**对客户端「`sentenceId` 是小整数/连续」这类隐含假设有无破坏（主会话已核：客户端三处比较全在**单会话子序列**内，`:1411 lastFinalSeq` 按会话、`:1412 curSentenceId` 换会话即重置、`:1433` 拒绝线按会话取 → **安全**）；prune/退休与 seq 不回退是否同时成立；`readMuted` 四分支 + 计数兜底的穷举时序；`abandonTurn` 与 `cancel` 组合会不会补发多余 `tts-idle`（补发会让 `mode:once` 提前退出）；`turnOfSession` 记录范围与回收的错配；剥寒暄三档判据与循环剥离 |
| `v3-tests-docs` | `test/` 全部 53 个在链 + `docs/` | 本批新增锁逐条变异实证（回合号消费 / cancel reason / 辅助点击 / `isGestureEnd` / 全局 seq / `abandonTurn` / `readMuted` 四分支与计数兜底 / 剥寒暄三档 / `dropTurnTables` 共享删除点 / `turn` 载荷带回合号 / 兼容锁「回合号不可得时键缺席」）；假绿复扫（`t(` 与 `ta(` 形态一致、恒真断言）；文档↔代码一致性（**只核「符号锚是否指对对象」**，行号漂移由守卫负责）；计数与口径自洽；**CHANGELOG 的「已发布事实」是否被追改**（v0.7.26 / v0.7.27 两段原文声称应一字未改，只允许加括注） |

**验真轮的通用纪律**（本项目已付出代价学到的）：
- 变异必须**从修复态副本**出发（`git archive HEAD | tar -x -C /tmp/xxx`）+ **`cmp` 校验变异确实生效**，空跑即判证据作废。**`git checkout --` 会回到不含修复的 HEAD**，会让变异空跑、红灯是上一轮残留状态——本项目已有多位代理栽在这里。
- 「既有失败」与「变异命中」必须分开判：先确认**基线先验绿**，再施加变异。
- 定位用 `git show HEAD:<path>`（提交态），避免并行代理的在途改动污染行号。

### P1｜消解 230 条「无法判定」债务

守卫另一类计数：**抽不出符号**的锚点（`无法判定 230`，含本文件自身引入的 3 条，见 §3 末）。这批不是「坏锚点」而是「无法机械判定」——消解方式是**给这些锚点补上可判定的符号**（例：把 `voice-catalog.ts` 的锚点写成 `BiName`、把纯枚举里的反引号路径改成不带反引号的散文），或按 `docs/adr/README.md` 的新口径把无法判定的写成符号锚。**每消解一条，用 `--update-baseline` 收紧一次。**

### P2｜已登记的残余边界（**只登记，不擅自处置**）

| # | 项 | 现状 | 出处 |
| --- | --- | --- | --- |
| R1 | **abort 收场的 `openTurns` 残留** | 队列侧 `abandonTurn()` 原语已就绪、host 侧已接 `reason: 'interrupt'`；但**用户 abort 路径宿主不派发任何信号**（`dsh-agent-loop` 的 abort 是 `catch → 直接重抛`，不发 `agent/error`、不发 `agent/turn-stopping`）→ 残留**只能靠下一个回合的 `noteTurnEnd` 自愈**。不卡死；代价是本回合 `tts-idle` 缺失 → `mode:once` 退 10s 静默兜底 | STATE R15 账本 |
| R2 | **焦点转移不打断在途朗读** | `readAloud=always` 下「会话 A 播着 → 用户切到会话 B」，A 的在途朗读**不被打断**。是既有行为（`TtsQueue.queues` 不动，见 P1-2 论证），**需产品口径**（「切走即静默」要一个不重置 seq 的队列停止接口） | STATE R15 账本 |
| R3 | **回合中途切焦点的窄边界** | 用户在回合**中途**才把会话变成焦点 → 该会话本回合的回合号取不到 → 静音退回按流解禁（`MUTED_STREAMS_WITHOUT_TURN` 计数兜底接住） | fix-host 回报 |
| R4 | **实例 token 跨模块重载的唯一性** | `focusOwnerSeq` 是模块级计数器，模块重载后归零 → 理论上的 token 碰撞。当前宿主版本下双实例并存前提**不成立**（见 §3），今日实际影响≈0 | fix-client 回报 |
| R5 | **asr 播放期静音分支缺 `isPlaying` 守卫** | 已复核为真，但影响面窄（播放期有 AI 回声即走 loud 分支并当场收口）；唯一修法会让「播放前开口段」在 AI 开播瞬间就当消息发出、并可能发 <250ms 短段（与 P1-3 短噪声门口径冲突）→ **成文取舍：暂不修**（含重新评估的 3 个触发条件） | STATE「成文取舍」段 |
| R6 | **4 条锁保真度 Minor** | ① `tts-local.ts` 的 `closed` 判序第二、四层（入口层与 `synthesize` 前层）被内层掩蔽 ② SSE 焦点保持不变量零锁定且假 res 桩结构上无法锁定 ③ `tts-local` 子进程 `error` 回调身份校验无行为锁 ④ `asr-host` `getRecognizer` **入口** disposed 判序被 await 后判序掩蔽 | STATE 登记块 |

### P2-2｜待维护者/产品拍板项

- `docs/competitive/backlog.md` 的「`normalizeWake` 加语气词白名单」条目**其实 `c9f3435`（2026-09-14）已落地**（代码在 `src/wakeword.ts` 的 `normalizeWake`），被误列在「未实施 Ready 单表」→ 是否迁入 §一「已实施条目对照表」待定。
- `docs/competitive/backlog.md` 的「删 3 个误传字段」条目要删的 3 个字段（`heldHint`/`cursorHint`/`recallAuto`）**本仓从未存在**（`git log --all -S` 对 `src/` 与 `test/` 均 0 提交，来源是 2026-09-15 沉睡能力审计记录的**上游 fork**）→ 该条是「无对象」还是「漏记」，待定。
- `docs/competitive/backlog.md` §三 Frozen 6 条是否解冻。
- `docs/research/` 断头引用（不入库但被已入库文档引用）——**知情取舍**，`docs/README.md` 已声明，待定。
- Issue #15 的回帖口径：`docs/issue-15-reply.md` 已订正版本引用；**是否补一段「发布后又做了一轮全库对抗审查」的说明**待用户定（对外发声，取舍由维护者定）。

### P3｜真机验收点（本机无法代跑）

1. `mode:once` + **带工具调用的回合**：按「停止朗读」→ 同一回合的后续 step 确实静默 → 下一回合恢复。
2. 同一场景下**用户打断**（abort）后的朗读是否正常（预期正常：下一回合 `pre-step` 让回合号递增、解禁）。
3. macOS **Safari**：对麦克风按钮 ctrl+click → 快捷设置菜单打开、**语音模式不被切换**、麦克风不被打开（这条是 C-13 的行为，只有真机能验）。
4. 焦点转移（A 播着 → 切到 B）：A 的在途朗读是否应停（**待产品口径**，见 R2）。

---

## 3. 已定性、不要再重新调查的事实

1. **`s.running` 是回合级（不是流级）** —— 主会话已从宿主源码定性：
   - `dsh-client-ui-goal/lib/types/client/activation-source.d.ts`（`activation-source` 段）：客户端会话快照 `readonly session: HostObservable<{ readonly running: boolean }>`；
   - `dsh-api-workspace-controller/lib/types/types.d.ts`（`RemoteErrorDetailsMap` 段）：会话的 running work 是「**its own turn**, a subagent, a background job, or an active schedule」；
   - `dsh-agent/lib/types/runtime-types.d.ts:157-163,170-174`：`whenIdle()` 在「**no active driver**」后兑现；非回合的维护任务期间「**public status stays `idle`**」。
   ⇒ 宿主把「会话正在跑」建模为**回合（driver）级**，一个回合内的多次模型调用共享同一 driver、`running` 其间不翻转。**证据强度**：结论基于宿主**公开状态模型**（三处源码）；插件所注入的 `useSession` 选择器自身的类型定义**未在已安装包中**（`dsh-client-web-react` 不在此环境），故**不是**「已核实插件选择器类型」。落账时须如实写明这一点。

   **宿主源码位置**：`/www/server/nodejs/v22.20.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`（**注意**：不在 `~/.dsh/profiles/web/node_modules` 下，那里只有 3 个包）。

2. **宿主 `agent/pre-step` 自 0.1.1-rc.2 即声明并派发**（覆盖插件声明的兼容区间全程）—— 回合号在任一受支持宿主上都可得，故 `MUTED_STREAMS_WITHOUT_TURN` 计数兜底**只对假想宿主生效**。

3. **SSE 同 tabId 去重先于上限判定**（`src/index.ts`），且 `latestConnByTab` 判等守卫成立（`res.end()` 触发的 `'close'` **晚于** handler 同步体 → 已用独立探针实测 `ServerResponse.end()` 不**同步**触发 `'close'`）。

4. **客户端全部 `sentenceId` 比较都在单会话子序列内**（`:1433` 拒绝线按 `frame.sessionId` 取、`:1451` 拼帧用当前会话的 `curSentenceId`、`:1411 lastFinalSeq` 按会话）→ **全局 seq 发号器安全**。

5. **CHANGELOG 的「已发布事实」纪律**：v0.7.26 / v0.7.27 两段的**原文声称**不得追改，只能加前向括注。v0.7.26 段的两个数字（624→627、87→391）是**唯一的例外**，且段首已加「数字订正声明」显式说明与 GitHub Release 正文的差异（发布物不可追改，以 Release 正文为准）。**不要再追改这两处。**

---

### 本文件自身引入的 3 条「无法判定」（已知守卫能力边界，非坏锚点）

本交接件提到 `docs/adr/README.md`、`scripts/doc-anchors-baseline.json`、宿主包的 `.d.ts` 路径 —— 守卫**只在 `src/` 下解析符号**，非源码文件里的路径提及**无法判定**，故计入「待人工确认」债务（基线已含这 3 条）。
**这不是坏锚点**：这些是**路径提及**（无行号、不指向某一行代码）。守卫的已知能力边界：**跨非 src 文件的符号判定**。`errors` 恒 0、`DRIFT` 未超基线，故真实缺陷（指向错误代码的行号）仍被严格拦住。

---

## 4. 继续这个 loop 的纪律（本阶段付出代价换来的）

1. **动手前先 `git fetch` 核对 `origin/main`**。本项目在 R15 轮因本地落后 18 个提交而白做两小时审计。`git status` 干净 + 显示已推送，**不代表基线是新的**。
2. **并行提交必须由主会话统一做**，且**提交前确认「本次 `lib/` 产物对应的 src 全部在本次提交内」**——`lib/` 是共享产物，队友中途 `node build.mjs` 会把别人的半成品烤进产物（本项目已发生过一次：提交里 `lib/index.js` 含 host 侧改动、`src/index.ts` 却不含）。`verify-client` 的 mtime 门禁**只比时间戳、不比内容**，抓不到这类不一致。
3. **每轮用固定分桶**（Blocker / Important / Minor / Open Questions）+ 结论必须绑定 `file:line`；**子代理结论是线索**，写进结论前主会话须复核证据。
4. **变异实证要可复现**：从修复态副本出发 + `cmp` 校验变异生效；**基线先验绿**再施加变异；**不要为覆盖率造假观察面**（团队已多次如实登记「该变异仍绿，因为行为等价」——这类诚实登记比补假锁更有价值）。
5. **提交信息只写实证过的范围**（R15 阶段多次出现「commit message 声称的核验与实际不符」，已被本项目自己列为 Important 口径）。
6. **发现「自己的上一批有假核验声明」要立刻登记**，不要淡化。本项目已两次出现这类问题（`f8a3268` 的「锚点实测全部正确」、`4f85c50` 的「复验 39 处」），均由下一轮独立验真轮查出。

---

## 5. 快速开始下一轮

```bash
cd /mnt/dsh-voice-mode
git fetch origin && git rev-list --left-right --count origin/main...HEAD   # 期望 0 0
cd plugin/dsh-voice-mode
npm test 2>&1 | tail -2          # 期望 exit 0 / 785 ✓ / 53 套件
npm run typecheck                # 期望 exit 0
npm run check:anchors            # 期望 9 锚点全在
npm run check:doc-anchors        # 期望 exit 0（在基线内）
```
然后按 §2 的 **P0-1（回填 130 处行号）** 与 **P0-2（重跑第三轮验真 sweep）** 开工。
