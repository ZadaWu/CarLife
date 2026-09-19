/**
 * mem0 遥测缺省关（施工单 M95-04）。
 *
 * `mem0ai` 3.1.5 的 `getAll` / `search` / `add` / `get` / `update` 每次调用都
 * `await this._captureEvent(...)`：先 `_getTelemetryId()`（读写本地 id 文件 + 向量库
 * `getUserId/setUserId` 两跳 PG），再向 `us.i.posthog.com` 发事件；`get` / `search` / `add`
 * 还 `await _displayFirstRunNotice()` 去 PostHog 拉一次 feature flag。2026-09-16 探针：
 * 同一条 `getAll`（SQL 本体 0.4 ms）遥测开 317 / 303 / 846 ms，关 3 / 2 / 2 ms——
 * 上下文装载 300 ms 的预算被它一个人吃完。
 *
 * 开关是环境变量 `MEM0_TELEMETRY`，**只认字面 `"false"`**，并且在 `mem0ai/oss` 模块求值那一刻
 * 读一次。所以这个文件必须是 `client.ts` 的第一条 import（ESM 按 import 声明顺序求值），
 * 而且仓内只有 `client.ts` import `mem0ai`——多一处更早的 import，这里就白设了。
 *
 * 只补缺省、不强制：谁要开遥测就显式写 `MEM0_TELEMETRY=true`。
 */

export const MEM0_TELEMETRY_DEFAULT = "false";

/** 返回最终生效的值；`env` 已设（任何值）时原样保留。 */
export function applyMem0TelemetryDefault(env: { MEM0_TELEMETRY?: string }): string {
  if (env.MEM0_TELEMETRY === undefined) env.MEM0_TELEMETRY = MEM0_TELEMETRY_DEFAULT;
  return env.MEM0_TELEMETRY;
}

applyMem0TelemetryDefault(process.env);
