/**
 * 活动行程的排序（`orderActive`）：主页默认展示的就是这个列表的首条，所以"谁排第一"
 * 是一条用户可见的规则，不是内部细节。
 *
 * 2026-09-16 走查：车机主页默认钉着一份 9/3 出发、两天、**已结束**的行程，地图整块收起。
 * 成因不在端上——`endDate` 列比 `startDate` 晚加，那一行的它还是 `null`，于是
 * `activeForUser` 的 `endDate IS NULL` 分支（本意是放行"没定日期"）把走完的老行程也放了进来，
 * 而它出发日最早、按出发日升序恰好排第一。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { orderActive } from "../src/repositories/trip-plan";

const TODAY = "2026-09-16";

/** `endDate` 显式传 `null` = 那一列还空着的老行（补算结束日的分支）。 */
function row(id: string, startDate: string | null, days: number, endDate?: string | null) {
  return {
    id,
    userId: "u-1",
    sessionId: `sess-${id}`,
    status: "confirmed",
    plan: { days, destination: id },
    startDate,
    endDate: endDate === undefined ? null : endDate,
    committedAt: new Date(`2026-09-0${(id.length % 9) + 1}T00:00:00.000Z`),
    updatedAt: new Date("2026-09-10T00:00:00.000Z"),
  };
}

const ids = (rows: ReturnType<typeof orderActive>) => rows.map((r) => r.planId);

describe("orderActive", () => {
  it("进行中 → 未来 → 未定日期", () => {
    const out = orderActive(
      [row("undated", null, 2), row("future", "2026-10-01", 2), row("ongoing", "2026-09-15", 3)],
      TODAY,
    );
    assert.deepEqual(ids(out), ["ongoing", "future", "undated"]);
  });

  it("`endDate` 列还空着的已结束老行不许占首条——按快照的天数补算结束日", () => {
    const out = orderActive([row("ended", "2026-09-03", 2), row("future", "2026-10-01", 2)], TODAY);
    assert.deepEqual(ids(out), ["future", "ended"], "已结束的沉到末尾，首条必须是未结束的那程");
  });

  it("已结束的**不剔除**：车主还要能点开走完的那一程看路线", () => {
    const out = orderActive([row("ended", "2026-09-03", 2)], TODAY);
    assert.deepEqual(ids(out), ["ended"]);
  });

  it("末尾那一档最近结束的在前", () => {
    const out = orderActive([row("old", "2026-07-01", 1), row("recent", "2026-09-10", 2)], TODAY);
    assert.deepEqual(ids(out), ["recent", "old"]);
  });

  it("末日当天仍算进行中（结束日 = 出发日 + 天数 - 1，含当天）", () => {
    const out = orderActive([row("lastDay", "2026-09-15", 2), row("future", "2026-10-01", 2)], TODAY);
    assert.deepEqual(ids(out), ["lastDay", "future"]);
  });

  it("没定日期的不凭空获得地位，也不算已结束", () => {
    const out = orderActive([row("ended", "2026-09-03", 2), row("undated", null, 2)], TODAY);
    assert.deepEqual(ids(out), ["undated", "ended"]);
  });
});
