/**
 * [F-58-06][F-13-02] Plan 层 1a `planCollect`（施工单 M86-02，ACR-037）。
 *
 * 全部走注入的假 `invoke`：验的是"发了哪几路、按什么顺序合并、失败怎么记账"，
 * 不碰高德。坐标与名字必须原样来自工具返回（ADR-008）——这里顺带断言没有任何改写。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HOT_KEYWORDS, INDOOR_KEYWORDS, planCollect, rankDistricts, type ToolInvoke } from "../src/graph/trip-plan-layer/collect";
import { PLAN_DISTRICT_LIMIT, PLAN_DISTRICT_SEARCHES_MAX, PLAN_HOT_LIMIT, PLAN_INDOOR_LIMIT } from "../src/graph/trip-plan-layer/config";
import type { PlanSpot } from "../src/graph/trip-plan-layer/types";

type Call = { name: string; args: Record<string, unknown> };
type Cand = { name: string; lat: number; lon: number; district?: string; rating?: string };

const spot = (name: string, lat: number, lon: number, district?: string, rating?: string): Cand => ({
  name,
  lat,
  lon,
  ...(district ? { district } : {}),
  ...(rating ? { rating } : {}),
});

/** 假工具：按 keywords 发不同的候选；`fail` 里的路径抛错。 */
function fakeInvoke(opts: {
  byKeywords: Record<string, Cand[]>;
  districts?: string[];
  fail?: Set<string>;
  calls: Call[];
}): ToolInvoke {
  return async (name, args) => {
    opts.calls.push({ name, args });
    const key = name === "spot_search" ? String(args.keywords) : name;
    if (opts.fail?.has(key)) throw new Error(`boom:${key}`);
    if (name === "city_districts") {
      return { data: { city: args.city, districts: (opts.districts ?? []).map((n, i) => ({ name: n, adcode: String(i), lat: 0, lon: 0 })) }, source: "mock" };
    }
    if (name === "spot_search") return { data: { city: args.city, candidates: opts.byKeywords[key] ?? [] }, source: "mock" };
    throw new Error(`unexpected tool ${name}`);
  };
}

const HOT = [spot("陈家祠", 23.126, 113.246, "荔湾区", "4.7"), spot("广州塔", 23.106, 113.324, "海珠区", "4.8"), spot("沙面", 23.108, 113.239, "荔湾区", "4.6")];
const INDOOR = [spot("广东省博物馆", 23.114, 113.323, "天河区", "4.8"), spot("陈家祠", 23.126, 113.246, "荔湾区", "4.7")];
const LIWAN = [spot("永庆坊", 23.115, 113.238, "荔湾区", "4.5"), spot("沙面", 23.108, 113.239, "荔湾区", "4.6"), spot("某打卡点", 23.11, 113.24, "荔湾区", "0.0")];
const HAIZHU = [spot("海心沙", 23.112, 113.322, "海珠区", "4.4")];
const TIANHE = [spot("天河公园", 23.13, 113.36, "天河区", "4.3")];

describe("[F-58-06][F-13-02] planCollect：三路打底 + 按区县分次", () => {
  it("热门 / 室内 / 区县清单并发发出，再按区县各搜一组；合并去重保序，\"0.0\" 沉底，室内组即雨备池", async () => {
    const calls: Call[] = [];
    const invoke = fakeInvoke({
      calls,
      districts: ["荔湾区", "海珠区", "天河区"],
      byKeywords: { [HOT_KEYWORDS]: HOT, [INDOOR_KEYWORDS]: INDOOR, [`荔湾区 ${HOT_KEYWORDS}`]: LIWAN, [`海珠区 ${HOT_KEYWORDS}`]: HAIZHU, [`天河区 ${HOT_KEYWORDS}`]: TIANHE },
    });
    const out = await planCollect({ destination: "广州", invoke });
    assert.ok(out);
    // 调用形状：前三路 + 三个区县
    assert.deepEqual(
      calls.map((c) => c.name),
      ["spot_search", "spot_search", "city_districts", "spot_search", "spot_search", "spot_search"],
    );
    assert.deepEqual(calls[0]!.args, { city: "广州", keywords: HOT_KEYWORDS, limit: PLAN_HOT_LIMIT });
    assert.deepEqual(calls[1]!.args, { city: "广州", keywords: INDOOR_KEYWORDS, limit: PLAN_INDOOR_LIMIT });
    assert.deepEqual(calls[2]!.args, { city: "广州" });
    assert.deepEqual(calls[3]!.args, { city: "广州", keywords: `荔湾区 ${HOT_KEYWORDS}`, limit: PLAN_DISTRICT_LIMIT });
    assert.equal(out.calls, 6);
    assert.equal(out.failed, 0);
    assert.equal(out.districtsSearched, 3);
    // 合并顺序：热门 → 区县（荔湾先于海珠先于天河）→ 室内；重名只留第一次；"0.0" 最后
    assert.deepEqual(
      out.pool.map((s) => s.name),
      ["陈家祠", "广州塔", "沙面", "永庆坊", "海心沙", "天河公园", "广东省博物馆", "某打卡点"],
    );
    // 坐标与名字逐字来自工具返回，没有改写
    const chen = out.pool.find((s) => s.name === "陈家祠")!;
    assert.deepEqual({ lat: chen.lat, lon: chen.lon, district: chen.district, rating: chen.rating, indoor: chen.indoor }, { lat: 23.126, lon: 113.246, district: "荔湾区", rating: "4.7", indoor: false });
    assert.equal(out.pool.find((s) => s.name === "广东省博物馆")!.indoor, true);
    assert.deepEqual(out.rainPool.map((s) => s.name), ["广东省博物馆", "陈家祠"]);
  });

  it("区县顺序：热门结果落在过的区县在前（按次数），再按行政区划顺序补齐，总数封顶", () => {
    const hot: PlanSpot[] = HOT.map((c) => ({ ...c, indoor: false }));
    const districts = ["越秀区", "海珠区", "荔湾区", "天河区", "白云区", "黄埔区", "番禺区", "花都区", "南沙区", "从化区", "增城区"];
    const ranked = rankDistricts(hot, districts, PLAN_DISTRICT_SEARCHES_MAX);
    assert.equal(ranked.length, PLAN_DISTRICT_SEARCHES_MAX);
    assert.deepEqual(ranked.slice(0, 2), ["荔湾区", "海珠区"], "荔湾 2 次 > 海珠 1 次");
    assert.deepEqual(ranked.slice(2), districts.filter((d) => d !== "荔湾区" && d !== "海珠区").slice(0, PLAN_DISTRICT_SEARCHES_MAX - 2));
    // 热门结果里跨市的 district（不在清单里）不单独搜
    const stray: PlanSpot[] = [{ name: "x", lat: 0, lon: 0, district: "佛山市", indoor: false }];
    assert.deepEqual(rankDistricts(stray, ["越秀区"], 3), ["越秀区"]);
    assert.deepEqual(rankDistricts([], [], 3), []);
  });

  it("单路失败只记账：热门失败仍由区县凑池；区县清单失败则只发两路", async () => {
    const calls: Call[] = [];
    const invoke = fakeInvoke({
      calls,
      districts: ["荔湾区"],
      fail: new Set([HOT_KEYWORDS]),
      byKeywords: { [INDOOR_KEYWORDS]: INDOOR, [`荔湾区 ${HOT_KEYWORDS}`]: LIWAN },
    });
    const out = await planCollect({ destination: "广州", invoke });
    assert.ok(out);
    assert.equal(out.failed, 1);
    assert.equal(out.calls, 4);
    assert.deepEqual(out.pool.map((s) => s.name), ["永庆坊", "沙面", "广东省博物馆", "陈家祠", "某打卡点"]);

    const calls2: Call[] = [];
    const invoke2 = fakeInvoke({ calls: calls2, fail: new Set(["city_districts"]), byKeywords: { [HOT_KEYWORDS]: HOT } });
    const out2 = await planCollect({ destination: "广州", invoke: invoke2 });
    assert.ok(out2);
    assert.equal(out2.districtsSearched, 0);
    assert.equal(calls2.length, 3);
    assert.equal(out2.failed, 1);
    assert.deepEqual(out2.pool.map((s) => s.name), HOT.map((c) => c.name));
  });

  it("全部失败 / 一条候选都没有 → 空池但计数照记（调用方据此跳过并把计数写进 span），坏条目（缺坐标）丢弃", async () => {
    const calls: Call[] = [];
    const invoke = fakeInvoke({ calls, fail: new Set([HOT_KEYWORDS, INDOOR_KEYWORDS, "city_districts"]), byKeywords: {} });
    const out = await planCollect({ destination: "广州", invoke });
    assert.deepEqual({ pool: out.pool, calls: out.calls, failed: out.failed }, { pool: [], calls: 3, failed: 3 });

    const bad: ToolInvoke = async (name) =>
      name === "spot_search" ? { data: { candidates: [{ name: "无坐标" }, { name: "", lat: 1, lon: 2 }, { name: "NaN", lat: Number.NaN, lon: 1 }] } } : { data: { districts: [] } };
    const out2 = await planCollect({ destination: "广州", invoke: bad });
    assert.deepEqual({ pool: out2.pool, calls: out2.calls, failed: out2.failed }, { pool: [], calls: 3, failed: 0 });
  });
});
