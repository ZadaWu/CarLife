/**
 * [F-19-07][AC-19-4] 点火播报的三道闸（M72-05）。
 *
 * 主动发起最容易变成骚扰：同一份变化每次点火都说一遍、一天说好几遍、开车时冒出来。
 * 这里把"什么时候**不**说"逐条钉住；文案以 `【行程提醒】` 开头（服务端按它只转述不进 fan-out）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TripPlanListEntry, TripPlanSnapshot } from "@carlife/shared";

import { REVIEW_NOTICE_PREFIX, announceNote, createReviewAnnouncer, shouldAnnounce, type AnnounceStore } from "../src/hud/review-announce";

function plan(): TripPlanSnapshot {
  return {
    status: "confirmed",
    destination: "青岛",
    startDate: "2026-09-12",
    days: 2,
    skeleton: [{ day: 1, theme: "a", spots: [{ name: "x" }] }],
    caveats: [],
    updatedTurnId: "t",
  };
}

function entry(planId: string, severity: "critical" | "notice", over: Partial<NonNullable<TripPlanListEntry["review"]>> = {}): TripPlanListEntry {
  return {
    planId,
    plan: plan(),
    committedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    review: {
      reviewId: `r-${planId}`,
      planId,
      reviewedAt: "2026-09-08T06:10:00.000Z",
      days: [],
      changes: [{ kind: "alarm", day: 1, before: "无预警", after: "暴雨橙色预警", severity: severity === "critical" ? "critical" : "notice", text: "第 1 天：新增暴雨橙色预警" }],
      severity,
      ...over,
    },
  };
}

const gate = (over: Partial<Parameters<typeof shouldAnnounce>[1]> = {}) => ({
  announced: new Set<string>(),
  today: "2026-09-08",
  enabled: true,
  driving: false,
  ...over,
});

describe("shouldAnnounce", () => {
  it("critical 未 ack 且未播 → 那一程", () => {
    assert.equal(shouldAnnounce([entry("p1", "critical")], gate())?.planId, "p1");
  });

  it("已播过 → 不播；今天播过别的 → 不播；开关关 → 不播；行驶中 → 不播", () => {
    const e = [entry("p1", "critical")];
    assert.equal(shouldAnnounce(e, gate({ announced: new Set(["r-p1"]) })), undefined);
    assert.equal(shouldAnnounce(e, gate({ lastDay: "2026-09-08" })), undefined);
    assert.equal(shouldAnnounce(e, gate({ enabled: false })), undefined);
    assert.equal(shouldAnnounce(e, gate({ driving: true })), undefined);
    // 昨天播过不挡今天
    assert.equal(shouldAnnounce(e, gate({ lastDay: "2026-09-07" }))?.planId, "p1");
  });

  it("notice 不播；ack 过的不播；作废的不播", () => {
    assert.equal(shouldAnnounce([entry("p1", "notice")], gate()), undefined);
    assert.equal(shouldAnnounce([entry("p1", "critical", { ackedAt: "2026-09-08T07:00:00.000Z" })], gate()), undefined);
    const stale = { ...entry("p1", "critical"), updatedAt: "2026-09-09T00:00:00.000Z" };
    assert.equal(shouldAnnounce([stale], gate()), undefined);
  });

  it("文案以【行程提醒】开头，带目的地与第一条变化，问一句", () => {
    const note = announceNote(entry("p1", "critical"));
    assert.ok(note.startsWith(REVIEW_NOTICE_PREFIX));
    assert.equal(note, "【行程提醒】青岛 行程：第 1 天：新增暴雨橙色预警，要不要我把相关安排调整一下");
  });
});

describe("createReviewAnnouncer：先记再发、在飞不叠", () => {
  function memStore(enabled = true): AnnounceStore & { marks: Array<[string, string]> } {
    const ids = new Set<string>();
    let last: string | undefined;
    const marks: Array<[string, string]> = [];
    return {
      marks,
      announced: () => ids,
      markAnnounced(id, day) {
        ids.add(id);
        last = day;
        marks.push([id, day]);
      },
      lastDay: () => last,
      enabled: () => enabled,
    };
  }

  it("同一份核查连喂三次只发一次；发失败也不重播", async () => {
    const sent: string[] = [];
    const store = memStore();
    const a = createReviewAnnouncer(async (n) => {
      sent.push(n);
      throw new Error("网络");
    }, store);
    const e = [entry("p1", "critical")];
    a.consider(e, { today: "2026-09-08", driving: false });
    a.consider(e, { today: "2026-09-08", driving: false });
    await new Promise((r) => setTimeout(r, 5));
    a.consider(e, { today: "2026-09-08", driving: false });
    assert.equal(sent.length, 1);
    assert.deepEqual(store.marks, [["r-p1", "2026-09-08"]]);
  });

  it("两程都 critical：今天只播第一程；第二天才轮到第二程", async () => {
    const sent: string[] = [];
    const store = memStore();
    const a = createReviewAnnouncer(async (n) => {
      sent.push(n);
    }, store);
    const e = [entry("p1", "critical"), entry("p2", "critical")];
    a.consider(e, { today: "2026-09-08", driving: false });
    await new Promise((r) => setTimeout(r, 5));
    a.consider(e, { today: "2026-09-08", driving: false });
    assert.equal(sent.length, 1);
    a.consider(e, { today: "2026-09-09", driving: false });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(sent.length, 2);
    assert.ok(sent[1]!.includes("青岛"));
  });

  it("开关关着一句都不发", () => {
    const sent: string[] = [];
    const a = createReviewAnnouncer(async (n) => {
      sent.push(n);
    }, memStore(false));
    a.consider([entry("p1", "critical")], { today: "2026-09-08", driving: false });
    assert.equal(sent.length, 0);
  });
});
