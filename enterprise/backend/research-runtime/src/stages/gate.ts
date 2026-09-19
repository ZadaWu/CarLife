/**
 * 图的 `gate` 节点：算门、报天花板、**确保 level 仍是 signal**（施工单 M85-01）。
 *
 * # 这个节点不升级任何东西
 *
 * 图上它排在 `challenge` 之后、`review` 之前，位置看起来像"评审前的自动裁决"，
 * 而它**刻意什么都不裁**：`levelCeilingOf` 给的是"门允许到的最高一级"，
 * 不是"现在是哪一级"。signal → candidate 只经 `review/:threadId/resume`
 * 的人工决定（§18.10 高分即批准）。
 *
 * 所以本节点对洞察行的唯一写动作是**把跑偏的 level 拉回 signal**——
 * 它是那条纪律在运行时的兜底，不是它的执行者。正常情况下一行都不会被改，
 * 改了就说明有人开了一条自动升级的路径，日志会喊出来。
 *
 * # 门是整窗的，不是每张卡各算一份
 *
 * `runResearch` 已经在 `buildAllSnapshots` 里算过四道门并写进了每份快照
 * （`research_lens_snapshots.gates`）。这里**读回来**而不是重算：
 * 重算一份意味着同一个窗口上有两套门的判定，而它们分叉时不会报错。
 */

import { anyGateFailed, levelCeilingOf, type Gates } from "@carlife/research";
import type { ResearchRepository } from "@carlife/db";

export interface GateOptions {
  repo: ResearchRepository;
  contractId: string;
}

export interface GateOutcome {
  /** 四道门允许到的最高等级。**不是**任何一张卡当前的等级。 */
  ceiling: "signal" | "candidate" | "validated";
  anyFailed: boolean;
  /** 被拉回 signal 的洞察数。正常恒为 0。 */
  reset: number;
  note: string;
}

export async function gateAll(
  insightIds: readonly string[],
  opts: GateOptions,
): Promise<GateOutcome> {
  const snapshot = (await opts.repo.snapshots.latest(opts.contractId, "evidence-matrix")) as {
    gates?: Gates;
  } | null;

  if (!snapshot?.gates) {
    // 没有快照就没有门。如实说，不给一个"全过"的默认值——
    // 默认全过会让一次根本没算过门的运行看起来完全合规。
    return {
      ceiling: "signal",
      anyFailed: true,
      reset: 0,
      note: "没有快照可读，四道门未知：本次运行的等级天花板按最低的 signal 记",
    };
  }

  const gates = snapshot.gates;
  const ceiling = levelCeilingOf(gates);
  const anyFailed = anyGateFailed(gates);

  /*
   * 兜底：任何一张卡的 level 不是 signal，就拉回来并喊出来。
   * `synthesizeOne` 写死 signal，所以这里正常一行都不会命中；
   * 命中即意味着有人绕过了那一处，而那正是本纪律最容易被悄悄破掉的方式。
   */
  let reset = 0;
  for (const id of insightIds) {
    const row = (await opts.repo.insights.byId(id)) as { level?: string } | null;
    if (row && row.level !== "signal") {
      console.warn(
        `[research-runtime] ⚠️ 洞察 ${id} 的 level 是 ${row.level} 而不是 signal——` +
          "有人开了一条自动升级的路径。已拉回 signal；升级只能经 review resume 的人工决定",
      );
      await opts.repo.insights.setLevel(id, "signal");
      reset += 1;
    }
  }

  const failedNames = (Object.keys(gates) as Array<keyof Gates>).filter(
    (k) => gates[k].status === "fail",
  );
  const note =
    `四道门：${failedNames.length > 0 ? `${failedNames.join(" / ")} 未过` : "全部通过或降级"}；` +
    `等级天花板 ${ceiling}（当前全部为 signal，升级只经人工决定）` +
    (reset > 0 ? `；⚠️ 拉回 ${reset} 张被改过等级的卡` : "");

  return { ceiling, anyFailed, reset, note };
}
