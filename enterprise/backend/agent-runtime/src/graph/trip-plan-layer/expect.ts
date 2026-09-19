/**
 * tour 这条腿**该交回哪几天**——骨架轮的提交期望（真跑 turn-dc5da219）。
 *
 * 有骨架时 tour 只补字段（estStart / estEnd / rainBackup / lodging），"交几天"没有任何裁量余地：
 * 骨架几天就该交几天。那一轮它只交了第 1 天，形状合法所以照收，第 2、3 天靠 `mergeItinerary` 的
 * 骨架守卫接回——点都对，但整天没有时段，车主听到的是「第 2、3 天的详细安排这次没交回来」。
 *
 * 对照台用同一份输入重放 20 次，20 次都交齐：这是低概率的随机退化，不是提示词能对准的病。
 * 所以不去劝它别犯，而是让它**犯了当场被退回**：暂存区（`branch-submissions.ts`）按这份期望
 * 拒收残缺提交，原因原样回到模型手里，它在同一个会话里重交（上下文都在，约一轮往返）。
 *
 * 判据只有一条——**天号覆盖**。时段齐不齐、名字对不对不在这里判：
 * 前者库里 35 轮真实提交 0 例，后者骨架守卫已经在管；每多一条判据就多一种把好提交退回去的可能。
 */

import type { SubmissionExpectation } from "../../branch-submissions";
import type { TripSkeleton } from "./types";

/** 同一跳最多退回几次。一次退回 ≈ 一轮模型往返；两次还交不齐就照收，交给骨架守卫兜。 */
export const TOUR_DAYS_MAX_REJECTS = 2;

/** 与 `mergeItinerary` 同一口径取天号：`day` 没给就按数组下标 + 1。两处不一致的话，这里放行的会在那边被判缺天。 */
function submittedDays(payload: unknown): number[] | undefined {
  const days = (payload as { days?: unknown } | null | undefined)?.days;
  if (!Array.isArray(days)) return undefined;
  return days.map((d, i) => {
    const n = (d as { day?: unknown } | null | undefined)?.day;
    return typeof n === "number" && Number.isFinite(n) ? n : i + 1;
  });
}

export function tourDaysExpectation(skeleton: TripSkeleton): SubmissionExpectation {
  const want = skeleton.days.map((d) => d.day).sort((a, b) => a - b);
  return {
    maxRejects: TOUR_DAYS_MAX_REJECTS,
    check(tool, payload) {
      if (tool !== "submit_tour_days") return undefined;
      const got = submittedDays(payload);
      // 连 days 数组都没有：那是形状问题，zod 那一层的事，这里不重复判。
      if (!got) return undefined;
      const have = new Set(got);
      const missing = want.filter((d) => !have.has(d));
      if (missing.length === 0) return undefined;
      const handed = want.filter((d) => have.has(d));
      return [
        `这次的逐天骨架是 ${want.length} 天（第 ${want.join("、")} 天），`,
        handed.length > 0 ? `你只交了第 ${handed.join("、")} 天，` : "你一天都没交，",
        `缺第 ${missing.join("、")} 天，这份提交没有被收下。`,
        `请**再调一次** \`submit_tour_days\`，一次交齐全部 ${want.length} 天——`,
        "已经补好的那几天原样带上，不要分天提交。",
      ].join("");
    },
  };
}
