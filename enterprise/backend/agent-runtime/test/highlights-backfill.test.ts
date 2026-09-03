/**
 * 目的地推荐的确认后补算与回写（M32-02 修订，用户走查提出）。
 *
 * 守三件事：
 *  1. 确认/变更之后，推荐**进得了库**（以前只有读时那一跳才有，60 秒轮询就擦掉了）；
 *  2. 改了目的地，旧推荐**立刻清掉**——错的推荐比暂时没有推荐糟；
 *  3. 算的那十几秒里行程又被改了，这次的结果**整个丢弃**，不覆盖用户刚改的东西。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { DestinationHighlights, TripPlanSnapshot } from "@carlife/shared";

import {
  carryOverHighlights,
  createHighlightsBackfill,
  type HighlightsPlanStore,
} from "../src/graph/highlights";

const TODAY = "2026-08-29";

function plan(over: Partial<TripPlanSnapshot> = {}): TripPlanSnapshot {
  return {
    status: "confirmed",
    destination: "舟山普陀山",
    startDate: TODAY,
    days: 2,
    skeleton: [
      { day: 1, theme: "上岛", spots: [{ name: "普济寺" }] },
      { day: 2, theme: "环岛", spots: [{ name: "千步沙" }] },
    ],
    caveats: [],
    updatedTurnId: "t1",
    ...over,
  } as TripPlanSnapshot;
}

function highlights(destination: string): DestinationHighlights {
  return {
    destination,
    foods: [{ name: "海鲜面", note: "码头边的老店" }],
    spots: [{ name: "南海观音", note: "地标" }],
    photoTips: [{ spot: "南海观音", tip: "傍晚斜阳" }],
    computedAt: "2026-08-29T02:00:00.000Z",
  };
}

/** 只记一次写入的假仓储。`current` 可在补算途中被换掉，用来演"算着算着行程变了"。 */
function fakeStore(current: { planId: string; sessionId: string; plan: TripPlanSnapshot } | null) {
  const writes: TripPlanSnapshot[] = [];
  const store: HighlightsPlanStore & {
    writes: TripPlanSnapshot[];
    set: (v: typeof current) => void;
  } = {
    writes,
    set: (v) => {
      current = v;
    },
    async currentForUser() {
      return current;
    },
    async update(_userId, _planId, _sessionId, p) {
      writes.push(p);
      return p;
    },
  };
  return store;
}

test("确认之后推荐进库——这就是它不再时有时无的原因", async () => {
  const store = fakeStore({ planId: "p1", sessionId: "s1", plan: plan() });
  const backfill = createHighlightsBackfill(store, {
    collect: async () => highlights("舟山普陀山"),
    today: () => TODAY,
  });

  backfill.schedule({ userId: "u1", planId: "p1", sessionId: "s1", plan: plan() });
  await backfill.idle();

  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].destinationHighlights?.destination, "舟山普陀山");
});

test("已结束的行程不补算——它连卡都不会上，不值得烧一次联网搜索", async () => {
  const store = fakeStore({ planId: "p1", sessionId: "s1", plan: plan() });
  let called = 0;
  const backfill = createHighlightsBackfill(store, {
    collect: async () => {
      called += 1;
      return highlights("舟山普陀山");
    },
    today: () => "2026-09-30",
  });

  backfill.schedule({ userId: "u1", planId: "p1", sessionId: "s1", plan: plan() });
  await backfill.idle();

  assert.equal(called, 0);
  assert.equal(store.writes.length, 0);
});

test("算的途中改了目的地：这次的结果整个丢弃，不覆盖用户刚改的行程", async () => {
  const store = fakeStore({ planId: "p1", sessionId: "s1", plan: plan() });
  const backfill = createHighlightsBackfill(store, {
    collect: async () => {
      // 搜索还在跑的时候，用户把目的地改成了杭州
      store.set({ planId: "p1", sessionId: "s1", plan: plan({ destination: "杭州西湖" }) });
      return highlights("舟山普陀山");
    },
    today: () => TODAY,
  });

  backfill.schedule({ userId: "u1", planId: "p1", sessionId: "s1", plan: plan() });
  await backfill.idle();

  assert.equal(store.writes.length, 0, "普陀山的推荐不许写进一趟杭州的行程");
});

test("补算失败不抛出去——确认行程是主动作，不能被环境数据拖垮", async () => {
  const store = fakeStore({ planId: "p1", sessionId: "s1", plan: plan() });
  const backfill = createHighlightsBackfill(store, {
    collect: async () => {
      throw new Error("联网搜索挂了");
    },
    today: () => TODAY,
  });

  backfill.schedule({ userId: "u1", planId: "p1", sessionId: "s1", plan: plan() });
  await backfill.idle();
  assert.equal(store.writes.length, 0);
});

test("连着改三次只跑两轮——在跑的那一轮合并掉中间那几次", async () => {
  const store = fakeStore({ planId: "p1", sessionId: "s1", plan: plan() });
  let calls = 0;
  let release: (() => void) | undefined;
  const backfill = createHighlightsBackfill(store, {
    collect: async () => {
      calls += 1;
      if (calls === 1) await new Promise<void>((r) => (release = r));
      return highlights("舟山普陀山");
    },
    today: () => TODAY,
  });

  const t = { userId: "u1", planId: "p1", sessionId: "s1", plan: plan() };
  backfill.schedule(t);
  backfill.schedule(t);
  backfill.schedule(t);
  release?.();
  await backfill.idle();

  assert.equal(calls, 2, `第一轮 + 合并后的补跑，实际 ${calls}`);
});

test("行程变更：同目的地沿用旧推荐，换了目的地立刻清掉", () => {
  const prev = plan({ destinationHighlights: highlights("舟山普陀山") });

  // 只改了天数 → 旧推荐继续显示，等后台算完再覆盖
  const sameDest = carryOverHighlights(prev, plan({ days: 3 }));
  assert.equal(sameDest.destinationHighlights?.destination, "舟山普陀山");

  // 换了目的地 → 清掉，不是等新的算完再换
  const newDest = carryOverHighlights(prev, plan({ destination: "杭州西湖" }));
  assert.equal(newDest.destinationHighlights, undefined);
  assert.ok(!("destinationHighlights" in newDest), "要删键，不是留一个 undefined");

  // 新快照自带但属于上一程（图状态里带过来的） → 同样清掉
  const staleOwn = carryOverHighlights(
    undefined,
    plan({ destination: "杭州西湖", destinationHighlights: highlights("舟山普陀山") }),
  );
  assert.equal(staleOwn.destinationHighlights, undefined);
});
