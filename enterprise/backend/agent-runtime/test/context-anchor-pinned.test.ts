/**
 * [F-11-03][AC-11-2] 锚定块钉在线程上（M84-03，ACR-036 §4.9）。
 *
 * 车主档案在一次对话中间会变（他刚确认了一份行程、worker 刚算出一条保养提醒），
 * 于是"如实反映最新事实"与"别动前缀"直接冲突。取舍是**前缀不动、变化走本轮尾区的一行**。
 *
 * 这一条的反面很难发现：不钉的话每次档案一变就换一次 system，而那只表现为账单变贵。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { UserContext } from "@carlife/shared";

import { AnchorPins, anchorDeltaLine } from "../src/context/anchor";
import { loadTurnContext } from "../src/context";

const base: UserContext = {
  userId: "u-1",
  identity: { userId: "u-1", displayName: "老王", role: "owner" },
  vehicle: { model: "Model Y", energyType: "bev", odometerKm: 32_140 },
  trips: [{ ref: "plan-ab12cd34", destination: "青岛", days: 3 }],
};

describe("[F-11-03][AC-11-2] 锚定：同一线程内前缀不动", () => {
  it("同一线程 × 同一 Agent 两次取，文本严格相等", () => {
    const pins = new AnchorPins();
    const a = pins.resolve("th-1", "trip", base);
    const b = pins.resolve("th-1", "trip", base);
    assert.strictEqual(a.text, b.text);
    assert.equal(a.version, b.version);
  });

  it("档案变了也不重钉，但报告 changed=true", () => {
    const pins = new AnchorPins();
    const first = pins.resolve("th-1", "trip", base);
    const after = pins.resolve("th-1", "trip", {
      ...base,
      trips: [...(base.trips as []), { ref: "plan-new00001", destination: "南通", days: 2 }] as never,
    });
    assert.strictEqual(after.text, first.text, "前缀不许动");
    assert.equal(after.changed, true, "但要告诉调用方事实变了，好让它在尾区补一行");
    assert.ok(anchorDeltaLine(true)?.includes("以本轮说的为准"));
    assert.equal(anchorDeltaLine(false), undefined);
  });

  it("换一个线程就换一份——新线程本来就没有可命中的前缀", () => {
    const pins = new AnchorPins();
    const a = pins.resolve("th-1", "trip", base);
    const b = pins.resolve("th-2", "trip", { ...base, identity: { userId: "u-1", role: "owner" } });
    assert.notStrictEqual(a.text, b.text);
    assert.equal(pins.size(), 2);
  });

  it("同一线程不同 Agent 各钉各的——投影表不同，内容本来就该不同", () => {
    const pins = new AnchorPins();
    const trip = pins.resolve("th-1", "trip", base);
    const cabin = pins.resolve("th-1", "cabin", base);
    assert.notStrictEqual(trip.text, cabin.text);
    assert.ok(trip.text.includes("Model Y"));
    assert.ok(!cabin.text.includes("Model Y"));
  });
});

describe("[F-11-03][AC-11-2] 装载：两轮之间锚定块逐字相同", () => {
  const readers = {
    identity: async () => ({ userId: "u-1", displayName: "老王", role: "owner" as const }),
    vehicle: async () => ({ model: "Model Y", energyType: "bev", odometerKm: 32_140 }),
  };

  it("同一线程跑两轮，anchorFor 的结果严格相等", async () => {
    const pins = new AnchorPins();
    const deps = { readers, pins };
    const t1 = await loadTurnContext(deps, { userId: "u-1", threadId: "th-1", now: 1_757_800_000_000 }, "inject");
    const t2 = await loadTurnContext(deps, { userId: "u-1", threadId: "th-1", now: 1_757_800_600_000 }, "inject");
    assert.strictEqual(t1?.anchorFor("trip"), t2?.anchorFor("trip"));
  });

  it("本轮尾区每轮都在变（今天几号进的是这里）", async () => {
    const pins = new AnchorPins();
    const deps = { readers, pins };
    const t1 = await loadTurnContext(deps, { userId: "u-1", threadId: "th-1", now: Date.parse("2026-09-14T02:00:00Z") }, "inject");
    const t2 = await loadTurnContext(deps, { userId: "u-1", threadId: "th-1", now: Date.parse("2026-09-15T02:00:00Z") }, "inject");
    assert.ok(t1?.turnFor("trip")?.includes("2026-09-14"));
    assert.ok(t2?.turnFor("trip")?.includes("2026-09-15"));
    assert.notStrictEqual(t1?.turnFor("trip"), t2?.turnFor("trip"));
  });

  it("off 档返回 undefined——各节点走老路径，零开销", async () => {
    const ctx = await loadTurnContext({ readers, pins: new AnchorPins() }, { userId: "u-1", threadId: "th-1", now: 1 }, "off");
    assert.equal(ctx, undefined);
  });

  it("没有 userId 时不产出锚定块（车机上还没人声明上车）", async () => {
    const ctx = await loadTurnContext({ readers, pins: new AnchorPins() }, { threadId: "th-1", now: 1 }, "inject");
    assert.equal(ctx?.anchorFor("trip"), undefined);
    assert.ok(ctx?.turnFor("trip")?.includes("今天是"), "日期还是要给的");
  });
});
