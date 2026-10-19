/**
 * Issue #15 批 2：运行中语音 steer 直提交（判定+调用，纯副作用隔离便于单测）。
 *
 * 背景（用户反馈问题②）：AI 执行任务时用户说话，语音消息进「等待发送」区排队，
 * 最长等十几秒。根因：宿主给插件槽位的 InputActions.submit() 无参数且实现里
 * 硬编码 submit("queue")（dsh-client-ui-conversation client.js:13481-13483）——
 * 语音提交恒为 queue，用户改宿主 busyEnter 设置也没用。
 *
 * 解：绕过 InputActions.submit，运行中直接用 SessionFace.prompt(content,'steer')
 * （一等 API：'queue' appends a turn; 'steer' interrupts the running one——
 * 下一个 step 边界消费，不中断当前工具调用；窗口关闭时 AgentLoop 天然降级为
 * 下一队列项，无硬失败）。仅 RemoteResult.ok 才视为直达；任何失败（抛错/ok:false/
 * 无 binding/无 prompt 函数——老宿主）返回 false，调用方回退现状 submit() 队列
 * 路径（自带 3 重试+草稿保留，不劣于现状）。
 */

/** SessionFace 的最小面（本插件只用 prompt；其余不依赖）。 */
export interface SteerSession {
  prompt?: (
    content: { type: 'text'; text: string }[],
    mode: 'queue' | 'steer',
  ) => Promise<{ ok?: boolean } | undefined>
}

/**
 * 是否应走 steer 直提交：会话运行中 + 草稿不是命令（trim 后以 '/' 开头须走宿主
 * adjudication/claim 链，不能被绕过——内部 trim 防前导空格脚枪）。
 */
export function shouldSteerSubmit(running: boolean, draft: string): boolean {
  return running === true && !draft.trim().startsWith('/')
}

/**
 * 尝试 steer 直提交。true=已直达（调用方清草稿、跳过重试与 submit() 防双发）；
 * false=调用方回退队列路径。任何异常都吞掉返回 false（老宿主无 mode 参数/
 * 抛错时安全降级）。
 *
 * 交付判据取**保守口径**：prompt resolve 且未显式 ok:false 即视为已交付。宿主契约
 * 返回 RemoteResult 判别联合（{ok:true,value}|{ok:false,error}，0.1.2-rc.1+ 实证）；
 * 0.1.1-rc.2 的 api-session-controller 子包未发布（npm E404）、返回形状未知——若其
 * 成功却返回非 RemoteResult（如 undefined），严判（仅 ok:true 算交付）会回退队列造成
 * **双发**；宁可以「未显式失败即交付」承受假想的信息丢失，也不双发（审查 OQ-1）。
 */
export async function trySteerSubmit(session: SteerSession | undefined, text: string): Promise<boolean> {
  if (typeof session?.prompt !== 'function') return false
  try {
    const r = await session.prompt([{ type: 'text', text }], 'steer')
    return !(r && r.ok === false)
  } catch {
    return false
  }
}
