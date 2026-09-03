/**
 * 启动时那个会话怎么处置（施工单 M50-02）——**纯函数，因为它的判定是这单的全部**。
 *
 * # 只有两种结果，没有第三种
 *
 * `resume`（接着用上次那段）或 `none`（手上没有会话）。**没有 `create`。**
 *
 * 原先是"回源失败就 `create_session`"，也就是开机即建：启动后没说话就留下一个
 * 零消息会话，而服务端的过期是懒关闭（只在下一次访问那个会话时才落 `closed_at`），
 * 没人再碰它就永远显示成活着。建会话交给发送侧——那条路建完立刻就发。
 *
 * # 与车机的判定不同，这是刻意的
 *
 * 车机多一道"太旧就不复用"（`canResume`，M22-03）——车机是共用设备，
 * 上一段可能是别人几小时前留下的。手机是个人设备，回源得到就接着用。
 * **两端各存一份而不是抽公共模块**：判定本来就不一样，合并会逼出一个配置参数，
 * 而那个参数迟早被设错。
 */

export type BootstrapPlan =
  | { kind: "resume"; sessionId: string }
  /** `reason` 只进日志，不影响行为——分开是为了排障看得出是哪一种。 */
  | { kind: "none"; reason: "no-stored" | "unreachable" };

export function planBootstrap(args: {
  /** localStorage 里的 sid；null = 没存过。 */
  stored: string | null;
  /** 服务端历史；`null` = 回源失败（会话不存在 / 网关不在）。 */
  history: unknown[] | null;
}): BootstrapPlan {
  if (!args.stored) return { kind: "none", reason: "no-stored" };
  if (args.history === null) return { kind: "none", reason: "unreachable" };
  return { kind: "resume", sessionId: args.stored };
}
