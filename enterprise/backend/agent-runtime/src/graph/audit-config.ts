/**
 * 行程体检的运行参数（施工单 M77-02，FL-58 F-58-13）。
 *
 * 四个数都是**产品口径**，不是算法常数，所以走 `process.env` + 默认值（与 `answerTimeoutMs()` 同形态），
 * 登记在根 `.env.example`。`shared/tools` 里的 `plan_audit` **不读 env**——限值经入参进，
 * 这样工具可以脱离环境单测，也不会在工具层出现第二份默认值。
 *
 * 默认值来源（FL-58 未决 #1，取值前不写死进工具）：
 * - 全天累计 540 min（9 h）：交通运输部《道路运输车辆动态监督管理办法》对营运驾驶员的日累计上限口径，作为家用出行的保守参考；
 * - 安全单段 180 min（3 h）：同上法规对连续驾驶不超过 4 h 的口径再收一档；
 * - 修复轮数 3 / 预算 90 s：RoadMan 的 `MAX_AUTO_REPAIR_ATTEMPTS = 3` 与本仓分支超时的量级，真跑后再调。
 */

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export function auditMaxRounds(): number {
  return envInt("CARLIFE_PLAN_AUDIT_MAX_ROUNDS", 3);
}

export function auditBudgetMs(): number {
  return envInt("CARLIFE_PLAN_AUDIT_BUDGET_MS", 90_000);
}

/**
 * 连续多少轮没压下 blocker 就停手（M94-03）。
 *
 * **2 不是"不降即停"的保守版，是实测出来的那个数。** 离线复算库里 44 个可复算的 turn
 * （111 轮，`scripts/dev/check/replay-audit-rounds.mts`）：`1` 省下 58% 的轮数，却让其中
 * 18 个 turn 的最终结果比跑满更差——第一轮重排后先变差、第二轮收回来是这条链路的常态；
 * `2` 只省 6%，且只影响 1 个 turn。
 * 想省时间就调大 `MAX_ROUNDS` 或收紧 `BUDGET_MS`，别把这个数调成 1。
 */
export function auditStallRounds(): number {
  return envInt("CARLIFE_PLAN_AUDIT_STALL_ROUNDS", 2);
}

export function driveDailyMaxMin(): number {
  return envInt("CARLIFE_DRIVE_DAILY_MAX_MIN", 540);
}

export function driveLegSafeMaxMin(): number {
  return envInt("CARLIFE_DRIVE_LEG_SAFE_MAX_MIN", 180);
}

/** 体检用的限值一次取齐；同行者上限（`legMaxMin`）来自约束集，由调用方合进去。 */
export function auditLimits(legMaxMin?: number): { legMaxMin?: number; legSafeMaxMin: number; dailyMaxMin: number } {
  return {
    ...(legMaxMin !== undefined ? { legMaxMin } : {}),
    legSafeMaxMin: driveLegSafeMaxMin(),
    dailyMaxMin: driveDailyMaxMin(),
  };
}
