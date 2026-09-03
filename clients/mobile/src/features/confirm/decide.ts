/**
 * HITL resume 结果 → 弹层该怎么办（施工单 M65-02 任务 1，F-04-08）。
 *
 * 纯函数，从 `app/index.tsx` 的 `decidePermission` 里抽出来——它是本单最容易写错、
 * 也最不该靠真机手测的那一段：三种结果里有两种**必须不收弹层**。
 *
 * # 为什么 `!accepted` 与抛错都不能收
 *
 * 车机端 M13-12 实测过一次：服务端进程在确认挂起期间重启，挂起随进程消失；
 * 端上原先只 `console.warn` 然后照常收起——车主看到"点了确认、窗关了"，以为定了，
 * 而实际什么都没发生。**任何一次 resume 没被接住，都不能表现得像成功。**
 * 手机端此前更糟：approve 根本没有上行，只打一行 warn 就收窗（M65-00 决策 3）。
 */

export type ResumeOutcome =
  /** 服务端接住了：`POST /v1/session/:id/resume` 返回 `resumed:true`。 */
  | { kind: "accepted" }
  /** 请求到了但服务端已不在等这条确认（超时 / 重启）：`resumed:false`。 */
  | { kind: "not_waiting" }
  /** 请求根本没送达（网络 / 服务异常）。 */
  | { kind: "failed" };

export interface ResumeDisposition {
  /** true = 弹层收起、动作已被服务端接走；false = 弹层留着，改成告知态。 */
  close: boolean;
  /** 告知文案；`close` 为 true 时恒为 undefined。 */
  notice?: string;
}

export const NOTICE_NOT_WAITING =
  "这次确认没有生效——服务端已经不在等这条确认了（多半是超时或服务重启）。动作没有执行，请再说一次。";
export const NOTICE_FAILED = "确认没能送达（网络或服务异常）。动作没有执行，请稍后再说一次。";

export function resumeDisposition(outcome: ResumeOutcome): ResumeDisposition {
  switch (outcome.kind) {
    case "accepted":
      return { close: true };
    case "not_waiting":
      return { close: false, notice: NOTICE_NOT_WAITING };
    case "failed":
      return { close: false, notice: NOTICE_FAILED };
  }
}
