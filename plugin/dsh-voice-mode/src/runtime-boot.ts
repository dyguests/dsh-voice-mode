/**
 * Issue #15 批 6：运行态 boot 快照镜像（设置卡片「当前生效值」的数据源）。
 *
 * 为什么需要它：设置卡片（host 侧 settings 槽位）拿不到客户端 bus，而「当前生效值」
 * 的真语义 = **运行中的语音会话实际在用的配置** = 客户端 fetchConfig（每次进入语音
 * 模式）拉到的 boot 快照。host 的 /config 与 /settings 同源（都返回 vset）——拿它俩
 * 互比在稳态永相等（审查 I-1：那只能比出「挂载时的一次性快照」，是同类 misleading）。
 *
 * 生命周期：客户端 fetchConfig 成功即刷新（进入语音模式/轮询）；null = 本页面加载后
 * 还没进入过语音模式（此时所有可改项都还没生效过——如实显示待生效）。
 */

let runtimeBoot: Record<string, unknown> | null = null

/** fetchConfig 成功后调用（client.tsx）。 */
export function setRuntimeBoot(boot: Record<string, unknown> | null): void {
  runtimeBoot = boot
}

/** 设置卡片渲染时读取（settings-form.tsx）。 */
export function getRuntimeBoot(): Record<string, unknown> | null {
  return runtimeBoot
}
