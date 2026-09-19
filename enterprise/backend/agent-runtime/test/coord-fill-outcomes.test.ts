/**
 * 坐标回填的三态：命中 / 高德说没有 / 问都没问到。
 *
 * 旧实现把后两者混成一条路：`catch { cache.set(name, undefined) }`。两个后果都咬过人：
 *
 *  1. **限流被当成"查不到"**，走「不标不猜」不落坐标，HUD 上那天悄悄少几个点，无报错。
 *  2. **失败还进了负缓存**，于是同一个名字在这一轮里再也不会被问第二次——
 *     同一家酒店在 3 天里出现 3 次，第一次被限流，三天就全空了。
 *
 * 所以这里钉的不是"重试几次"，是**两条路的走向不同**：限流不进缓存、要上报；
 * 查不到进缓存、是诚实的缺席。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { ToolError } from "@carlife/tools";

import {
  resolveTripPlanCoords,
  type CoordFillReport,
  type PoiCoordSearch,
} from "../src/graph/subgraphs/itinerary";
import type { TripPlanState } from "../src/graph/state";

const limit = () => new ToolError("amap", "upstream", "QPS 超限", true, "10021");
const bad = () => new ToolError("amap", "upstream", "参数非法", false, "20000");

/** 三天都住同一家酒店——「失败进负缓存」那个坑只有这种形状才暴露得出来。 */
function plan(): TripPlanState {
  return {
    status: "confirmed",
    destination: "苏州",
    days: 3,
    skeleton: [
      { day: 1, theme: "一", spots: [{ name: "拙政园" }], hotel: { name: "平江客栈" } },
      { day: 2, theme: "二", spots: [{ name: "虎丘" }], hotel: { name: "平江客栈" } },
      { day: 3, theme: "三", spots: [{ name: "沧浪亭" }], hotel: { name: "平江客栈" } },
    ],
    caveats: [],
    updatedTurnId: "t",
  } as unknown as TripPlanState;
}

const fast = { retryDelayMs: 0, sleep: async () => {} };
const hit = (lat: number, lon: number) => ({ lat, lon });

async function run(search: PoiCoordSearch, over: Record<string, unknown> = {}) {
  let report: CoordFillReport | undefined;
  const out = await resolveTripPlanCoords(plan(), search, {
    ...fast,
    ...over,
    onReport: (r) => {
      report = r;
    },
  });
  assert.ok(report, "onReport 没被调用——没人看得到这一步发生了什么");
  return { out, report: report! };
}

describe("[F-18-15] 坐标回填：限流与「查不到」走两条路", () => {
  it("高德说没有 → 进负缓存，同名不再问第二次", async () => {
    const asked: string[] = [];
    const { report } = await run(async (kw) => {
      asked.push(kw);
      return kw === "平江客栈" ? undefined : hit(31.3, 120.6);
    });
    assert.equal(asked.filter((k) => k === "平江客栈").length, 1, "查不到是定论，问一次就够");
    assert.equal(report.missed, 1);
    assert.equal(report.failed, 0);
    assert.equal(report.resolved, 3);
  });

  it("**被限流 → 不进负缓存**，下一天用到同一个名字会重新试", async () => {
    const asked: string[] = [];
    let first = true;
    const { out, report } = await run(async (kw) => {
      asked.push(kw);
      if (kw === "平江客栈" && first) {
        first = false;
        throw limit();
      }
      return hit(31.3, 120.6);
    }, { rateLimitRetries: 0 });
    assert.ok(
      asked.filter((k) => k === "平江客栈").length >= 2,
      `同名只问了 ${asked.filter((k) => k === "平江客栈").length} 次——失败又进了负缓存`,
    );
    assert.equal(report.failed, 1, "第一次算一次失败");
    assert.equal(report.missed, 0, "它不是「查不到」");
    const hotels = out.skeleton.filter((d) => d.hotel?.lat !== undefined).length;
    assert.equal(hotels, 2, "第 1 天丢了，第 2、3 天照样拿到");
  });

  it("限流多试几轮就能拿到——「这个地方存在，只是这一刻问不到」", async () => {
    let n = 0;
    const { out, report } = await run(async () => {
      n += 1;
      if (n <= 2) throw limit();
      return hit(31.3, 120.6);
    }, { rateLimitRetries: 2 });
    assert.equal(report.failed, 0, "退避两轮之后拿到了");
    assert.equal(out.skeleton[0]!.spots[0]!.lat, 31.3);
  });

  it("参数错这类**不多试**——再试一百次也一样，白等而已", async () => {
    const asked: string[] = [];
    await run(async (kw) => {
      asked.push(kw);
      if (kw === "拙政园") throw bad();
      return hit(31.3, 120.6);
    }, { rateLimitRetries: 5 });
    const n = asked.filter((k) => k === "拙政园").length;
    assert.equal(n, 2, `问了 ${n} 次：该是首发 + 一次重试，不吃限流那份预算`);
  });

  it("限流那份预算是逐轮加长的退避，不是立刻连打", async () => {
    const waits: number[] = [];
    await run(async (kw) => {
      if (kw === "拙政园") throw limit();
      return hit(31.3, 120.6);
    }, { rateLimitRetries: 3, retryDelayMs: 100, sleep: async (ms: number) => void waits.push(ms) });
    assert.deepEqual(waits, [100, 200, 300], "第 n 轮退避 n×retryDelayMs，只有这一个名字失败");
  });

  it("报告里带上是不是限流与上游码——留痕要能回答「为什么少这个点」", async () => {
    const { report } = await run(async (kw) => {
      if (kw === "虎丘") throw limit();
      if (kw === "沧浪亭") throw bad();
      return hit(31.3, 120.6);
    }, { rateLimitRetries: 0 });
    assert.equal(report.failed, 2);
    assert.deepEqual(
      report.failures.map((f) => [f.name, f.rateLimited, f.code]),
      [
        ["虎丘", true, "10021"],
        ["沧浪亭", false, "20000"],
      ],
    );
  });

  it("命中了但对不上单独计数（rejected）——错误在场比诚实缺席更危险", async () => {
    const p = plan();
    p.skeleton[0]!.hotel = { name: "如家(徐州金鹰店)", area: "徐州市中心" } as never;
    let report: CoordFillReport | undefined;
    await resolveTripPlanCoords(
      p,
      async (kw) => (kw.includes("如家") ? { ...hit(23.1, 113.3), name: "如家广州店", cityName: "广州市" } : hit(31.3, 120.6)),
      { ...fast, onReport: (r) => (report = r) },
    );
    assert.equal(report!.rejected, 1);
    assert.equal(report!.missed, 0, "它不是查不到");
    assert.equal(report!.failed, 0, "也不是没问到");
  });

  it("一个点失败不影响别的点，行程照常确认", async () => {
    const { out, report } = await run(async (kw) => {
      if (kw === "虎丘") throw limit();
      return hit(31.3, 120.6);
    }, { rateLimitRetries: 0 });
    assert.equal(report.failed, 1);
    assert.equal(out.skeleton[0]!.spots[0]!.lat, 31.3);
    assert.equal(out.skeleton[1]!.spots[0]!.lat, undefined);
    assert.equal(out.skeleton[2]!.spots[0]!.lat, 31.3);
  });
});

describe("接线：这一步必须留下痕迹", () => {
  const SRC = readFileSync(new URL("../src/graph/supervisor.ts", import.meta.url), "utf8");

  it("trace 里分开写 missed / failed，不是一个「没拿到」了事", () => {
    const at = SRC.indexOf('scope: "coords"');
    assert.ok(at > 0, "坐标回填一点痕迹都没留");
    const block = SRC.slice(at, at + 600);
    for (const k of ["resolved", "missed", "failed", "rejected"]) {
      assert.match(block, new RegExp(`${k}:`), `trace 缺 ${k}`);
    }
  });

  it("被限流要 warn：它是可修的，而「查不到」不是", () => {
    assert.match(SRC, /坐标回填被限流/);
    assert.match(SRC, /逐日车程被限流/);
  });

  it("判据用 isRateLimited，不在这里扒 message", () => {
    assert.match(SRC, /isRateLimited/);
    assert.ok(!/infocode/.test(SRC), "supervisor 不该认识 infocode 这个词，那是工具层的事");
  });
});
