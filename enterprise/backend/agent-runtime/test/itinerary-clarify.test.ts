/**
 * 出行需求澄清门（ACR-039 / M90-01，F-11-05 合并式追问）。
 *
 * 门的判断是纯函数 `decideTripClarify`，节点只消费；这里钉它的全部分支、narrator 指令、
 * 轨迹 span 与通道白名单。端到端的"问一句 → 答天数 → 出草案"由 `smoke:acp` 覆盖。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { laneChannelsOf } from "../src/graph/compound";
import {
  decideTripClarify,
  describeTripClarify,
  missingTripEssentials,
  recordTripClarify,
} from "../src/graph/subgraphs/itinerary";
import { setSpanSink, type SpanEvent } from "../src/trace/span";

// 单测里不许打真网络（内部开发指引 已知坑）。
process.env.CARLIFE_TRIP_PLAN_LAYER = "off";

describe("[M90-01][F-11-05][AC-11-4] missingTripEssentials：缺不缺只看意图 JSON", () => {
  it("都有 → undefined", () => assert.equal(missingTripEssentials({ destinations: ["杭州"], days: 3 }), undefined));
  it("缺目的地", () => assert.deepEqual(missingTripEssentials({ days: 2 }), { destination: true, days: false }));
  it("缺天数", () => assert.deepEqual(missingTripEssentials({ destinations: ["黄山"] }), { destination: false, days: true }));
  it("都缺", () => assert.deepEqual(missingTripEssentials({}), { destination: true, days: true }));
  it("空串目的地当缺；days 0 当缺", () => {
    assert.deepEqual(missingTripEssentials({ destinations: [" "], days: 0 }), { destination: true, days: true });
  });
});

describe("[M90-01][F-11-05][AC-11-4] decideTripClarify：只问一次、存已知的那一半、用过即清", () => {
  const intentNoDays = { route: "itinerary", destinations: ["杭州"], tripLimits: {} };
  it("骨架轮缺天数 → ask，存下目的地", () => {
    const d = decideTripClarify({ enabled: true, skeletonTurn: true, intent: intentNoDays, prior: undefined });
    assert.equal(d.kind, "ask");
    assert.deepEqual(d.kind === "ask" && d.missing, { destination: false, days: true });
    assert.deepEqual(d.patch, { tripClarify: { asked: true, destinations: ["杭州"] } });
  });
  it("骨架轮缺目的地 → ask，存下天数", () => {
    const d = decideTripClarify({ enabled: true, skeletonTurn: true, intent: { route: "itinerary", tripLimits: { days: 2 } }, prior: undefined });
    assert.deepEqual(d.patch, { tripClarify: { asked: true, days: 2 } });
  });
  it("都缺 → ask，什么都不存", () => {
    const d = decideTripClarify({ enabled: true, skeletonTurn: true, intent: { route: "itinerary" }, prior: undefined });
    assert.deepEqual(d.patch, { tripClarify: { asked: true } });
  });
  it("都有 → proceed，不碰通道", () => {
    const d = decideTripClarify({ enabled: true, skeletonTurn: true, intent: { route: "itinerary", destinations: ["杭州"], tripLimits: { days: 3 } }, prior: undefined });
    assert.equal(d.kind, "proceed");
    assert.deepEqual(d.kind === "proceed" && [d.destinations, d.days], [["杭州"], 3]);
    assert.deepEqual(d.patch, {});
  });
  it("细化轮不问（缺什么都放行）", () => {
    const d = decideTripClarify({ enabled: true, skeletonTurn: false, intent: { route: "itinerary" }, prior: undefined });
    assert.equal(d.kind, "proceed");
    assert.deepEqual(d.patch, {});
  });
  it("意图不是模型判的（离线 / fake / 规则表兜底：intent 无 route）→ 不问，缺什么都放行（ADR-010）", () => {
    const d = decideTripClarify({ enabled: true, skeletonTurn: true, intent: { goal: "x" } as never, prior: undefined });
    assert.equal(d.kind, "proceed");
    assert.deepEqual(d.patch, {});
    const d2 = decideTripClarify({ enabled: true, skeletonTurn: true, intent: undefined, prior: undefined });
    assert.equal(d2.kind, "proceed");
  });
  it("开关 off 不问、不碰通道——逐字等于 M90 之前", () => {
    const d = decideTripClarify({ enabled: false, skeletonTurn: true, intent: intentNoDays, prior: undefined });
    assert.equal(d.kind, "proceed");
    assert.deepEqual(d.kind === "proceed" && [d.destinations, d.days], [["杭州"], undefined]);
    assert.deepEqual(d.patch, {});
  });
  it("答复轮只带 days → 目的地从上一轮存的补，存货清成 { asked: true }", () => {
    const d = decideTripClarify({
      enabled: true, skeletonTurn: true,
      intent: { route: "itinerary", tripLimits: { days: 2 } },
      prior: { asked: true, destinations: ["杭州"] },
    });
    assert.equal(d.kind, "proceed");
    assert.deepEqual(d.kind === "proceed" && [d.destinations, d.days], [["杭州"], 2]);
    assert.deepEqual(d.patch, { tripClarify: { asked: true } });
  });
  it("答复轮意图层自己给了目的地 → 意图的优先，不用存的", () => {
    const d = decideTripClarify({
      enabled: true, skeletonTurn: true,
      intent: { route: "itinerary", destinations: ["南京"], tripLimits: { days: 2 } },
      prior: { asked: true, destinations: ["杭州"] },
    });
    assert.deepEqual(d.kind === "proceed" && d.destinations, ["南京"]);
  });
  it("问过一次、第二次仍缺 → 不再问，按今天的路径放行（fail-open）；没存货就不写通道", () => {
    const d = decideTripClarify({ enabled: true, skeletonTurn: true, intent: { route: "itinerary" }, prior: { asked: true } });
    assert.equal(d.kind, "proceed");
    assert.deepEqual(d.patch, {});
  });
});

describe("[M90-01][F-11-05] describeTripClarify：一句话把缺的都问了，不猜不排", () => {
  it("都缺：例句同时含去哪儿与几天，且明写不拆成几轮", () => {
    const s = describeTripClarify({ destination: true, days: true });
    assert.match(s, /去哪儿、玩几天/);
    assert.match(s, /一句话/);
    assert.match(s, /不要拆成几轮/);
    assert.match(s, /本地游/);
  });
  it("只缺天数：不提本地游，不让他说去哪", () => {
    const s = describeTripClarify({ destination: false, days: true });
    assert.match(s, /玩几天/);
    assert.doesNotMatch(s, /本地游/);
  });
  it("只缺目的地：本地游要问城市；不替他猜", () => {
    const s = describeTripClarify({ destination: true, days: false });
    assert.match(s, /在哪个城市转/);
    assert.match(s, /不要替他猜/);
  });
});

describe("[M90-01][F-58-14] recordTripClarify：itinerary.clarify span，detail 只记缺哪几项", () => {
  it("零时长、agent trip、missing 列表", () => {
    const got: SpanEvent[] = [];
    setSpanSink((e) => void got.push(e));
    try {
      recordTripClarify("thread-1", { destination: false, days: true });
    } finally {
      setSpanSink(undefined);
    }
    assert.equal(got.length, 1);
    const data = got[0]!.data as { name?: string; agent?: string; detail?: string; startedAt?: number; endedAt?: number };
    assert.equal(got[0]!.kind, "span");
    assert.equal(data.name, "itinerary.clarify");
    assert.equal(data.agent, "trip");
    assert.equal(data.startedAt, data.endedAt);
    assert.deepEqual(JSON.parse(data.detail ?? "{}"), { missing: ["days"] });
  });
});

describe("[M90-01][ACR-023] tripClarify 通道进 itineraryPlan 的白名单", () => {
  it("不在表里会被投影成 undefined、每轮都问", () => {
    assert.ok(laneChannelsOf("itineraryPlan").includes("tripClarify"));
  });
});
