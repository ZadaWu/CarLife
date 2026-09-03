/**
 * graph/interrupts —— HITL 中断点的**集中声明**（FL-04
 * F-04-10、FL-27 F-27-04，施工单 M15-04）。
 *
 * F-04-10 的原文是「中断点集中声明在 `enterprise/backend/agent-runtime/src/graph/interrupts.ts`，
 * **不散落到子图与子 Agent**」。在此之前这个文件是 `export {}`——
 * 管道早就通了（M5-03），缺的一直是**"这张图一共有几个中断点"这份清单本身**。
 *
 * # 这里是清单，不是第二个权限门
 *
 * 挂起/恢复/超时/拒绝记忆全部在 `guard/http-endpoint.ts` 的 `GuardGate` 里，
 * 本文件**一行执行逻辑都没有**。把那些搬进来，就会从"一份能回答有几个中断点的清单"
 * 变成"两个权限门"，而两个权限门必然有一个是过时的。
 *
 * # 它靠什么不腐坏
 *
 * 触发处引用这里的常量（`INTERRUPT_POINTS.guardConfirm.id`），
 * 而测试断言 `listInterruptPoints()` 的**条数与 id**。
 * 新增一个中断点却不登记，测试会红——这是这份清单唯一的存在价值。
 */

export interface InterruptPoint {
  /** 稳定 id。进轨迹与运维面，改它等于改对外契约。 */
  id: string;
  /** 谁触发的。 */
  trigger: string;
  /** 中断期间发生什么、由谁恢复。 */
  semantics: string;
  /** 对应功能点，便于回查。 */
  features: readonly string[];
}

/**
 * 当前**真实存在**的中断点。
 *
 * 只有一条。这不是遗漏——F-04-04（拒绝后的可选分支）与 F-14-03
 * （续跑不重跑已完成节点）尚未落地，如实只写一条比先占位好：
 * 占位条目会让"清单里有三条"看起来像"图上有三个中断点"。
 *
 * | 待落地 | 要求 |
 * |---|---|
 * | F-04-04 (P0) | 拒绝路径与后续可选项（`Command(resume)` 携带拒绝裁决） |
 * | F-14-03 (P0) | 中断恢复不重跑已完成节点 |
 */
export const INTERRUPT_POINTS = {
  guardConfirm: {
    id: "guard.confirm",
    trigger: "敏感工具（appointment / calendar / trip_plan_commit）经 POST /internal/guard/check 裁决为「需确认」",
    semantics:
      "该次调用的 Promise 保持挂起 → interrupt-bus 把 permission 事件推进本轮 SSE → " +
      "用户经网关 resume → 裁决作为这次挂起调用的返回值。超时按「未确认 = 不执行」收敛，绝不默认同意。",
    features: ["F-27-04", "F-04-10", "F-04-12"],
  },
} as const satisfies Record<string, InterruptPoint>;

/** 全部中断点。**新增中断点必须登记进 `INTERRUPT_POINTS`**，测试守着条数与 id。 */
export function listInterruptPoints(): InterruptPoint[] {
  return Object.values(INTERRUPT_POINTS);
}
