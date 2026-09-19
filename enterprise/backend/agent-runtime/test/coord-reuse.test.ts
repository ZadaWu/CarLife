/**
 * 搜索那一刻就拿到的坐标，不要在确认轮再查一遍。
 *
 * 根因：景点与酒店的名字是从 `spot_search` / `hotel_search` 的返回里**逐字抄**的，
 * 那一次返回里坐标、城市、品类全在手上，只是从没人存过。于是确认轮把同样的 12 个点
 * 重搜一遍——实测 4.3 秒、12 次请求，而搜索是**月配额只有 5000 次**的那一类。
 *
 * 这一组钉两件事：省下来的确实省了；ADR-008 的四道验证一道没少。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { fillCoordsFromSearches, resolveTripPlanCoords } from "../src/graph/subgraphs/itinerary";
import { recordPoiCoords, lookupPoiCoord, resetPoiCoords } from "../src/poi-coords";
import type { TripPlanState } from "../src/graph/state";

function plan(): TripPlanState {
  return {
    status: "skeleton",
    destination: "苏州",
    days: 2,
    skeleton: [
      { day: 1, theme: "一", area: "姑苏区", spots: [{ name: "拙政园" }], hotel: { name: "平江客栈" } },
      { day: 2, theme: "二", area: "虎丘区", spots: [{ name: "虎丘" }, { name: "山塘街" }] },
    ],
    caveats: [],
    updatedTurnId: "t",
  } as unknown as TripPlanState;
}

const BOOK: Record<string, { lat: number; lon: number; cityName?: string; poiKind?: string }> = {
  拙政园: { lat: 31.324, lon: 120.629, cityName: "苏州市", poiKind: "attraction" },
  平江客栈: { lat: 31.318, lon: 120.627, cityName: "苏州市", poiKind: "hotel" },
  虎丘: { lat: 31.35, lon: 120.572, cityName: "苏州市", poiKind: "attraction" },
  山塘街: { lat: 31.316, lon: 120.591, cityName: "苏州市", poiKind: "attraction" },
};
const coordOf = (n: string | undefined) => (n ? (BOOK[n] as never) : undefined);

describe("[F-18-15] merge 时就把搜到的坐标写进骨架", () => {
  it("景点写坐标也写品类，酒店只写坐标", () => {
    const p = plan();
    const n = fillCoordsFromSearches(p, coordOf);
    assert.deepEqual(n, { spots: 3, hotels: 1 });
    assert.equal(p.skeleton[0]!.spots[0]!.lat, 31.324);
    assert.equal(p.skeleton[0]!.spots[0]!.poiKind, "attraction");
    assert.equal(p.skeleton[0]!.hotel!.lat, 31.318);
    assert.ok(
      !("poiKind" in (p.skeleton[0]!.hotel as object)),
      "**酒店不能写 poiKind**：契约里没这个字段，写了会被 zod 静默剥掉",
    );
  });

  it("没给 coordOf 就什么都不做——单测与离线路径行为不变", () => {
    const p = plan();
    assert.deepEqual(fillCoordsFromSearches(p, undefined), { spots: 0, hotels: 0 });
    assert.equal(p.skeleton[0]!.spots[0]!.lat, undefined);
  });

  it("账本里没这个名字就不写，不猜", () => {
    const p = plan();
    p.skeleton[1]!.spots.push({ name: "模型自己编的地方" } as never);
    fillCoordsFromSearches(p, coordOf);
    assert.equal(p.skeleton[1]!.spots[2]!.lat, undefined);
  });

  it("已有坐标不覆盖——先到的那次通常带着正确的城市限定", () => {
    const p = plan();
    p.skeleton[0]!.spots[0]!.lat = 1;
    p.skeleton[0]!.spots[0]!.lon = 2;
    fillCoordsFromSearches(p, coordOf);
    assert.equal(p.skeleton[0]!.spots[0]!.lat, 1);
    assert.equal(p.skeleton[0]!.spots[0]!.poiKind, "attraction", "坐标不覆盖，缺的品类还是要补");
  });

  it("**ADR-008 第三道仍然在拦**：命中城市与条目自述的片区打架就不写", () => {
    const p = plan();
    p.skeleton[0]!.area = "徐州市中心";
    p.skeleton[0]!.hotel = { name: "如家", area: "徐州市中心" } as never;
    const n = fillCoordsFromSearches(p, (name) =>
      name === "如家" ? ({ lat: 23.1, lon: 113.3, cityName: "广州市" } as never) : coordOf(name),
    );
    assert.equal(n.hotels, 0, "广州的命中不能安到徐州条目头上");
    assert.equal(p.skeleton[0]!.hotel!.lat, undefined);
  });

  it("账本没存城市时按既有约定放行——那是 trustCoordHit 本来就有的行为", () => {
    const p = plan();
    const n = fillCoordsFromSearches(p, (name) =>
      name === "拙政园" ? ({ lat: 31.324, lon: 120.629 } as never) : undefined,
    );
    assert.equal(n.spots, 1);
  });
});

describe("省下来的确实省了：确认轮不再重查", () => {
  it("merge 写过之后，坐标回填一个请求都不发", async () => {
    const p = plan();
    fillCoordsFromSearches(p, coordOf);
    const asked: string[] = [];
    await resolveTripPlanCoords(
      p,
      async (kw) => {
        asked.push(kw);
        return { lat: 0, lon: 0 };
      },
      { sleep: async () => {} },
    );
    assert.deepEqual(asked, [], `还在搜：${asked.join("、")}`);
  });

  it("没写过的时候照旧全查——这一刀是省，不是唯一那一刀", async () => {
    const asked: string[] = [];
    await resolveTripPlanCoords(
      plan(),
      async (kw) => {
        asked.push(kw);
        return { lat: 0, lon: 0 };
      },
      { sleep: async () => {} },
    );
    assert.equal(asked.length, 4, "3 个景点 + 1 家酒店");
  });
});

describe("账本存得下城市与品类", () => {
  it("记进去取得出来", () => {
    resetPoiCoords();
    recordPoiCoords(
      { sessionId: "s", turnId: "t" },
      [{ name: "拙政园", lat: 31.324, lon: 120.629, cityName: "苏州市", poiKind: "attraction" }],
    );
    const hit = lookupPoiCoord("s", "t", "拙政园");
    assert.equal(hit?.cityName, "苏州市");
    assert.equal(hit?.poiKind, "attraction");
    resetPoiCoords();
  });

  it("没给这两样时不写空字段——缺席就是缺席，不是空串", () => {
    resetPoiCoords();
    recordPoiCoords({ sessionId: "s", turnId: "t" }, [{ name: "甲", lat: 1, lon: 2 }]);
    const hit = lookupPoiCoord("s", "t", "甲")!;
    assert.ok(!("cityName" in hit), "不该有 cityName 这个键");
    assert.ok(!("poiKind" in hit));
    resetPoiCoords();
  });
});

describe("接线", () => {
  it("merge 的末尾调它——那时账本还活着（同一轮）", () => {
    const SRC = readFileSync(new URL("../src/graph/subgraphs/itinerary.ts", import.meta.url), "utf8");
    const at = SRC.indexOf("fillCoordsFromSearches(plan, opts.coordOf)");
    const ret = SRC.indexOf("  return {\n    plan,\n    violations,");
    assert.ok(at > 0, "mergeItinerary 里没调");
    assert.ok(at < ret, "要在 return 之前");
  });

  it("搜索工具把城市与品类交给账本——不然这一刀等于没做", () => {
    const SRC = readFileSync(
      new URL("../../shared/tools/src/poi-search.ts", import.meta.url),
      "utf8",
    );
    const at = SRC.indexOf("poiCoordSink?.record");
    const block = SRC.slice(at, at + 500);
    assert.match(block, /cityName: p\.cityName/);
    assert.match(block, /poiKind: classifyAmapPoi\(p\)/);
  });
});
