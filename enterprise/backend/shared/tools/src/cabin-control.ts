/**
 * cabin_control / cabin_child_mode —— 舒适域设置下发（施工单 M24-03，F-49-04/07）。
 *
 * # 为什么是两个工具（M24-03 方案 B）
 *
 * 权限门是**工具名**粒度（`tools-endpoint` 按 `reg.sensitive` 查表）。儿童模式动作
 * 影响第三人的乘坐体验要确认，其余舒适域执行后播报即可——一个工具塞两种敏感级，
 * 要么每次调温都弹窗，要么把门的判断下放进工具（"工具自己不判断该不该执行"，
 * appointment 文件头那条纪律）。拆两个名字，门的语义原封不动：
 *
 *   `cabin_control`     舒适域五域，`sensitive: false`，schema 拒收 childMode
 *   `cabin_child_mode`  只收 childMode，`sensitive: true` → §8.4 需确认档
 *
 * 混合设置单由子图先调 child（确认在前），确认过了再下发舒适域——被拒时
 * 舒适域**还没发出**，不存在"部分生效后回滚"。
 *
 * # requestId 的确定性
 *
 * mock 侧按 requestId 幂等。id 在这里按 (sessionId, turnId, ops) 派生：
 * 同一轮里同一张单的重试（模型重发、网络重发）命中同一 id 不双改；
 * 新一轮"再调一次同样的"是新 id，照常执行。turnId 缺失时退回随机——
 * 宁可失去幂等，不能让两轮真实操作被误判成重复。
 */

import { createHash, randomUUID } from "node:crypto";

import {
  requireCabinClient,
  type CabinApplyOp,
  type CabinOpResult,
  type CabinState,
} from "./cabin-backend";
import { resolveCabinVin, type CabinVinArgs } from "./cabin-status";
import { defineExternalTool, ToolError, type ExternalTool, type ToolCallContext } from "./external";

/** 舒适域（cabin_control 收的全部）。childMode 刻意不在——它走 cabin_child_mode。 */
export const CABIN_COMFORT_DOMAINS = ["climate", "seat", "ambientLight", "media", "fragrance"] as const;

export interface CabinControlArgs extends CabinVinArgs {
  ops: CabinApplyOp[];
  /** 调用方可显式给（HITL 恢复路径要保 id 稳定）；缺省按 (session, turn, ops) 派生。 */
  requestId?: string;
}

export interface CabinControlData {
  vin: string;
  model: string;
  requestId: string;
  results: CabinOpResult[];
  state: CabinState;
  /** 同一 requestId 的重发命中幂等——没有第二次变更。 */
  duplicate: boolean;
  rebuilt: boolean;
}

export function deriveRequestId(ctx: ToolCallContext, ops: CabinApplyOp[]): string {
  if (!ctx.turnId) return `creq-${randomUUID()}`;
  const digest = createHash("sha256")
    .update(`${ctx.sessionId}|${ctx.turnId}|${JSON.stringify(ops)}`)
    .digest("hex")
    .slice(0, 16);
  return `creq-${digest}`;
}

function checkOps(tool: string, ops: unknown, allowed: readonly string[]): CabinApplyOp[] {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new ToolError(tool, "invalid", "ops 不能为空：[{domain, zone?, set}]", false);
  }
  if (ops.length > 20) throw new ToolError(tool, "invalid", "一次最多 20 条操作（车机契约上限）", false);
  for (const op of ops as CabinApplyOp[]) {
    if (!op || typeof op !== "object" || typeof op.domain !== "string") {
      throw new ToolError(tool, "invalid", "每条操作需要 domain 字段", false);
    }
    if (!allowed.includes(op.domain)) {
      const hint =
        op.domain === "childMode"
          ? "childMode 属需确认动作，走 cabin_child_mode 工具"
          : `可选：${allowed.join("/")}`;
      throw new ToolError(tool, "invalid", `域不在本工具范围：${op.domain}（${hint}）`, false);
    }
    if (!op.set || typeof op.set !== "object" || Object.keys(op.set).length === 0) {
      throw new ToolError(tool, "invalid", `set 不能为空（${op.domain}）`, false);
    }
  }
  return ops as CabinApplyOp[];
}

async function applyOps(
  tool: string,
  args: CabinControlArgs,
  ctx: ToolCallContext,
  allowed: readonly string[],
): Promise<CabinControlData> {
  const ops = checkOps(tool, args.ops, allowed);
  const vin = await resolveCabinVin(tool, args);
  const requestId = args.requestId?.trim() || deriveRequestId(ctx, ops);
  const r = await requireCabinClient().apply(vin, { requestId, ops });
  return {
    vin,
    model: r.model,
    requestId,
    results: r.results,
    state: r.state,
    duplicate: r.duplicate === true,
    rebuilt: r.rebuilt,
  };
}

export const cabinControlTool: ExternalTool<CabinControlArgs, CabinControlData> = defineExternalTool({
  name: "cabin_control",
  provider: "mock-cabin",
  timeoutMs: 5_000,
  // 有副作用：不自动重试（重试语义由 requestId 幂等承担，不靠包装器）。
  retries: 0,
  async real(args, ctx) {
    return applyOps("cabin_control", args, ctx, CABIN_COMFORT_DOMAINS);
  },
});

export const cabinChildModeTool: ExternalTool<CabinControlArgs, CabinControlData> = defineExternalTool({
  name: "cabin_child_mode",
  provider: "mock-cabin",
  timeoutMs: 5_000,
  sensitive: true,
  retries: 0,
  async real(args, ctx) {
    return applyOps("cabin_child_mode", args, ctx, ["childMode"]);
  },
});
