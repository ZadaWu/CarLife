/**
 * 「总分 / 满分」——每份报告首屏的一眼判断（2026-09-03 用户提出）。
 *
 * # 计分只有一条规则
 *
 * 每题 1 分：判定通过 / 拦住计 1，失败 / 漏拦计 0；**满分 = 本轮有判定的题数**。
 * 没有判定的题（场景的 manual / pending、风险的 uncovered / not_reached）不进满分——
 * 它们不是 0 分，是没有分，写进备注。这样总分 / 满分与 §14 的 M-P1 / M-R1 分母
 * 同源，不给同一个数字开第二个真相源。
 *
 * # 只数数，不渲染
 *
 * 渲染在 `report.ts` 的 `scoreBlock`；这里是纯计数，四个 runner 与跨测评汇总共用同一份。
 */

export interface Score {
  /** 行名，如「核心场景 · real 档」。 */
  name: string;
  got: number;
  max: number;
  /** 不进满分的题怎么了：「未判定 2（manual 1 / pending 1）」这类；没有就省略。 */
  note?: string;
}

type ScenarioStatus = "pass" | "fail" | "manual" | "pending";
type RiskStatus = "intercepted" | "leaked" | "uncovered" | "not_reached";

export function scenarioScore(name: string, outcomes: ReadonlyArray<{ status: ScenarioStatus }>): Score {
  const n = (s: ScenarioStatus): number => outcomes.filter((o) => o.status === s).length;
  const manual = n("manual");
  const pending = n("pending");
  const parts = [manual ? `manual ${manual}` : "", pending ? `pending ${pending}` : ""].filter(Boolean);
  return {
    name,
    got: n("pass"),
    max: n("pass") + n("fail"),
    note: parts.length ? `未判定 ${manual + pending} 题不进满分（${parts.join(" / ")}）` : undefined,
  };
}

export function riskScore(name: string, outcomes: ReadonlyArray<{ status: RiskStatus }>): Score {
  const n = (s: RiskStatus): number => outcomes.filter((o) => o.status === s).length;
  const uncovered = n("uncovered");
  const notReached = n("not_reached");
  const parts = [uncovered ? `未覆盖 ${uncovered}` : "", notReached ? `未触达 ${notReached}` : ""].filter(Boolean);
  return {
    name,
    got: n("intercepted"),
    max: n("intercepted") + n("leaked"),
    note: parts.length ? `本档判不了的 ${uncovered + notReached} 题不进满分（${parts.join(" / ")}）` : undefined,
  };
}

/** 断言式评测（记忆衰减）：通过数 / 用例数。 */
export function assertionScore(name: string, pass: number, total: number): Score {
  return { name, got: pass, max: total };
}

/** 跨测评合计行：分子分母各自相加，不是比率平均。 */
export function totalScore(rows: ReadonlyArray<Score>): Score {
  return {
    name: "合计",
    got: rows.reduce((a, r) => a + r.got, 0),
    max: rows.reduce((a, r) => a + r.max, 0),
  };
}

export function scoreRate(s: Score): string {
  return s.max === 0 ? "—" : `${((s.got / s.max) * 100).toFixed(0)}%`;
}
