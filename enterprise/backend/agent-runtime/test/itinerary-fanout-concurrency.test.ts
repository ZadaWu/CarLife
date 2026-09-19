/**
 * [F-13-01][AC-13-1] 骨架轮五条腿真并行——ownership 不该排队（M77 走查追修）。
 *
 * fanout 的缺省池子只有 4 个位置（`DEFAULT_MAX_CONCURRENCY`），而行程骨架轮发五条
 * （drive/hotel/tour/transit + ownership）。第五条只能等，且排到的永远是数组末尾的
 * ownership——它恒定卡在跑得最快的 transit 结束那一刻才起跑。真跑三轮同一形状：
 * turn-b2c1f36f +9.17、turn-25bfe47d +9.53、turn-60df5cd1 +10.70，
 * 每次都正好等于该轮 transit 的结束时刻。
 *
 * 代价看 ownership 自己多长：b2c1f36f 它 12.1 秒被压在 tour 底下只多付 0.54 秒；
 * 60df5cd1 它 16.0 秒直接成了关键路径，节点从 ~16.7 秒涨到 24.3 秒。
 *
 * **而 ownership 不依赖任何一条腿的产出**，本来就该同时开跑。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runItineraryFanout, type ItineraryInput } from "../src/graph/subgraphs/itinerary";
import { hasParallelOverlap, overlaps } from "../src/graph/fanout";
import type { ChatStreamer } from "../src/llm";

/*
 * 这些用例走的是 M86 之前的 fan-out 路径，Plan 层显式关掉（M87-05 之后缺省是 `plan`）。
 * 不关的话 `maybeRunPlanLayer` 会去调 `city_districts` / `spot_search`——`CARLIFE_TOOLS` 缺省 real，单测就打真网络了。
 */
process.env.CARLIFE_TRIP_PLAN_LAYER = "off";

const INPUT: ItineraryInput = {
  goal: "南通三天",
  constraints: [],
  userText: "南通三天",
  energyType: "bev",
  plan: undefined,
  destinations: ["南通"],
  turnId: "t1",
};

/** transit 很快、其余都慢：池子不够时 ownership 必然被推到 transit 之后。 */
const paced: ChatStreamer = async function* (_m, hooks) {
  const a = hooks?.agent ?? "";
  const ms = a === "transit-task" ? 10 : 80;
  await new Promise((r) => setTimeout(r, ms));
  if (a === "tour-task") return yield '{"destination":"南通","days":[{"day":1,"theme":"x","area":"崇川","spots":[{"name":"濠河"}]}]}';
  if (a === "drive-task") return yield '{"origin":"上海","legMinutes":[150],"stops":[],"findings":[]}';
  if (a === "ownership-task") return yield '{"rangePercent":60,"findings":[]}';
  return yield '{"hotels":[],"findings":[]}';
};

describe("[F-13-01][AC-13-1] 骨架轮并发", () => {
  it("五条腿全部起跑于同一时刻——ownership 与 transit 的区间也重叠", async () => {
    const out = await runItineraryFanout(paced, INPUT, { threadId: "s1", highlights: { fetch: async () => undefined } });
    const by = new Map(out.branches.map((b) => [b.agent, b]));
    assert.equal(by.size, 5, `应有五条分支，实际 ${[...by.keys()].join("、")}`);

    const transit = by.get("transit-task")!;
    const ownership = by.get("ownership-task")!;
    // 这一条就是判据：池子不够时 ownership 只能等 transit 让位，两者区间不相交。
    assert.ok(
      overlaps(transit, ownership),
      `ownership 排在了 transit 之后：transit ${transit.startedAt}-${transit.endedAt}、ownership ${ownership.startedAt}-${ownership.endedAt}`,
    );
    assert.ok(hasParallelOverlap(out.branches));
  });

  it("五条腿的起跑时刻挤在一起（不是一条接一条）", async () => {
    const out = await runItineraryFanout(paced, INPUT, { threadId: "s2", highlights: { fetch: async () => undefined } });
    const starts = out.branches.map((b) => b.startedAt);
    const spread = Math.max(...starts) - Math.min(...starts);
    // 串行时 spread 会接近最快那条的耗时（10ms+）；并行时只差几毫秒的调度抖动。
    assert.ok(spread < 10, `起跑时刻最大差 ${spread}ms，看起来仍有排队`);
  });
});
