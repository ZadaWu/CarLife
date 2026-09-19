/**
 * [F-18-15][AC-18-11] 每天两头的车程回填（M83 走查追修）。
 *
 * 补的两个洞：抽屉里第 2 天起的「从酒店出发」没有时刻、每天的「入住」也没有时刻——
 * `legs` 只装大交通（`submit_drive_draft` 的 `legMinutes`），市内段从来没有人提交过。
 *
 * 这两个数**代码算，不让模型抄**（与坐标回填同一条纪律），所以这里注入一个假的
 * 逐段时长函数就能全测到，不碰网络。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { resolveDayDriveLegs, type DrivingLegMinutes } from "../src/graph/subgraphs/itinerary";
import type { TripPlanState } from "../src/graph/state";

const at = (lat: number, lon: number) => ({ lat, lon });

function plan(over: Partial<TripPlanState> = {}): TripPlanState {
  return {
    status: "confirmed",
    destination: "苏州",
    origin: "上海",
    days: 3,
    skeleton: [
      { day: 1, theme: "一", spots: [{ name: "博物馆", ...at(31.32, 120.63) }], hotel: { name: "平江客栈", ...at(31.31, 120.62) } },
      { day: 2, theme: "二", spots: [{ name: "虎丘", ...at(31.35, 120.57) }], hotel: { name: "平江客栈", ...at(31.31, 120.62) } },
      { day: 3, theme: "三", spots: [{ name: "沧浪亭", ...at(31.29, 120.62) }] },
    ],
    caveats: [],
    updatedTurnId: "t",
  } as TripPlanState;
}

/** 时刻固定，好断言。限速已经不在这一层了（见「限速只有一处」那组）。 */
const fast = { now: () => "2026-09-15T10:00:00.000Z" };

/** 每段都返回同一个数的假实现，并记下每次收到的点串。 */
function stub(minutes = 20) {
  const chains: Array<Array<{ lat: number; lon: number }>> = [];
  const legs: DrivingLegMinutes = async (points) => {
    chains.push(points.map((p) => ({ ...p })));
    return points.slice(1).map(() => minutes);
  };
  return { legs, chains };
}

describe("[F-18-15][AC-18-11] resolveDayDriveLegs：一天一次请求", () => {
  it("**每天只问一次**，点串是「前一晚酒店 → 各景点 → 当晚酒店」", async () => {
    const { legs, chains } = stub();
    await resolveDayDriveLegs(plan(), legs, fast);
    assert.equal(chains.length, 3, "3 天 3 次，不是两头各发一次的 4 次");
    // D1：没有"前一晚"，串首是景点；串尾是当晚酒店。
    assert.deepEqual(chains[0], [at(31.32, 120.63), at(31.31, 120.62)]);
    // D2：前一晚酒店 → 景点 → 当晚酒店。
    assert.deepEqual(chains[1], [at(31.31, 120.62), at(31.35, 120.57), at(31.31, 120.62)]);
    // D3：没有酒店，串尾是景点。
    assert.deepEqual(chains[2], [at(31.31, 120.62), at(31.29, 120.62)]);
  });

  it("首段落到 startLeg、末段落到 endLeg，中间段这一版先不存", async () => {
    const { legs } = stub(20);
    const out = await resolveDayDriveLegs(plan(), legs, fast);
    assert.equal(out.skeleton[0]!.startLeg, undefined, "第 1 天没有前一晚");
    assert.equal(out.skeleton[0]!.endLeg?.toName, "平江客栈");
    assert.equal(out.skeleton[1]!.startLeg?.fromName, "平江客栈");
    assert.equal(out.skeleton[1]!.endLeg?.driveMinutes, 20);
    assert.equal(out.skeleton[2]!.startLeg?.driveMinutes, 20);
    assert.equal(out.skeleton[2]!.endLeg, undefined, "第 3 天没有酒店");
  });

  it("单点成不了段就不发请求——那天没有景点，「住处→住处」不算一段", async () => {
    const p = plan();
    p.skeleton[1]!.spots = []; // D2 只剩下住处
    const { legs, chains } = stub();
    await resolveDayDriveLegs(p, legs, fast);
    assert.equal(chains.length, 2, "D2 被跳过，D1/D3 照问");
    assert.deepEqual(chains[1], [at(31.31, 120.62), at(31.29, 120.62)], "第二次问的是 D3");
  });

  it("段数对不上（假实现返回长度不符）→ 整天不写，不猜哪一段是哪一段", async () => {
    const bad: DrivingLegMinutes = async () => [10];
    const out = await resolveDayDriveLegs(plan(), bad, fast);
    assert.equal(out.skeleton[1]!.startLeg, undefined);
    assert.equal(out.skeleton[1]!.endLeg, undefined);
    assert.equal(out.skeleton[0]!.endLeg?.driveMinutes, 10, "D1 只有一段，长度正好对上");
  });

  it("某一段是 undefined / 负数 / NaN → 只跳过那一头，另一头照写", async () => {
    const legs: DrivingLegMinutes = async (points) =>
      points.slice(1).map((_, i) => (i === 0 ? undefined : 12));
    const out = await resolveDayDriveLegs(plan(), legs, fast);
    assert.equal(out.skeleton[1]!.startLeg, undefined, "首段没算出来");
    assert.equal(out.skeleton[1]!.endLeg?.driveMinutes, 12, "末段照写");
  });

  it("整天抛错只跳过那一天，后面的照算", async () => {
    let n = 0;
    const legs: DrivingLegMinutes = async (points) => {
      n += 1;
      if (n === 1) throw new Error("CUQPS_HAS_EXCEEDED_THE_LIMIT");
      return points.slice(1).map(() => 15);
    };
    const out = await resolveDayDriveLegs(plan(), legs, fast);
    assert.equal(out.skeleton[0]!.endLeg, undefined);
    assert.equal(out.skeleton[1]!.startLeg?.driveMinutes, 15);
  });

  it("不改入参（与 resolveTripPlanCoords 同款：structuredClone 之后再动）", async () => {
    const p = plan();
    await resolveDayDriveLegs(p, stub().legs, fast);
    assert.equal(p.skeleton[1]!.startLeg, undefined);
  });

  it("按天序算，不按数组给的顺序——skeleton 乱序时前一晚仍然是前一晚", async () => {
    const p = plan();
    p.skeleton = [p.skeleton[2]!, p.skeleton[0]!, p.skeleton[1]!];
    const out = await resolveDayDriveLegs(p, stub().legs, fast);
    assert.equal(out.skeleton.find((d) => d.day === 2)!.startLeg?.fromName, "平江客栈");
    assert.equal(out.skeleton.find((d) => d.day === 1)!.startLeg, undefined);
  });

  it("多个景点：点串把它们按顺序全串上，首末仍是住处", async () => {
    const p = plan();
    p.skeleton[1]!.spots = [
      { name: "上午", ...at(31.4, 120.5) },
      { name: "傍晚", ...at(31.22, 120.7) },
    ];
    const { legs, chains } = stub();
    await resolveDayDriveLegs(p, legs, fast);
    assert.deepEqual(chains[1], [at(31.31, 120.62), at(31.4, 120.5), at(31.22, 120.7), at(31.31, 120.62)]);
  });
});

/**
 * [F-18-15][AC-18-11] 接线：确认路径在坐标回填之后、权限门之前算这一跳（读源码断言）。
 */
describe("接线的位置与红线", () => {
  const SRC = readFileSync(new URL("../src/graph/supervisor.ts", import.meta.url), "utf8");
  /**
   * 按**起止标记**取代码段，不按"锚点 ± N 个字符"。
   * 固定窗口的断言一加代码就随行号滑走，而它滑走时是**静默失效**，不是变红。
   */
  const between = (from: string, to: string) => {
    const a = SRC.indexOf(from);
    const b = SRC.indexOf(to, a);
    assert.ok(a > 0 && b > a, `取不到 ${from} … ${to} 这一段`);
    return SRC.slice(a, b);
  };

  it("在坐标回填之后、行前物品之前——要两端坐标，且必须在权限门之前", () => {
    const coords = SRC.indexOf("resolveTripPlanCoords(");
    const dayLegs = SRC.indexOf("resolveDayDriveLegs(planToCommit");
    const pretrip = SRC.indexOf("collectPretripItems(planToCommit)");
    const gate = SRC.indexOf("const updating = wantCommit &&");
    assert.ok(coords > 0 && dayLegs > 0 && pretrip > 0 && gate > 0);
    assert.ok(coords < dayLegs, "坐标先回填，否则两端没有经纬度");
    assert.ok(dayLegs < pretrip);
    assert.ok(dayLegs < gate, "弹窗批的与落库的必须是同一份数据");
  });

  it("吞异常：这个数算不出不该让车主的行程确认不了", () => {
    const block = between("resolveDayDriveLegs(planToCommit", '/*\n         * 行前物品');
    assert.match(block, /catch \(err\)/);
    assert.match(block, /day_legs 失败，行程照常确认/);
  });

  it("一次问一整天：带途经点 + withNavi，靠「到达途经地」切段", () => {
    const block = between("resolveDayDriveLegs(planToCommit", 'scope: "day-legs"');
    assert.match(block, /waypoints/);
    assert.match(block, /withNavi: true/);
    assert.match(block, /splitLegMinutes\(path\.steps, expected\)/);
  });

  it("切不出来就退回一段一个请求——**半套分段比没有分段更糟**", () => {
    const block = between("resolveDayDriveLegs(planToCommit", 'scope: "day-legs"');
    assert.match(block, /if \(split\) return split;/);
    assert.match(block, /for \(let i = 0; i \+ 1 < points\.length/);
  });

  it("留痕：填了几天写进 trace，不然线上只能靠猜", () => {
    assert.match(between('scope: "day-legs"', "catch (err)"), /start:[\s\S]*end:[\s\S]*days:/);
  });
});

/**
 * 限速只有一处：高德客户端出口上的闸门（`createAmapRateGate`）。
 *
 * 这一组是红线。调用点各写一份 `sleep` 的写法有两个后果，都在线上咬过人：
 * 一是三处互相不知道对方在发，叠起来随机超限；二是「先睡 350ms 再等 200ms 响应」
 * 两段串着付，有效速率 1.8 QPS，把 3 QPS 的天花板白用掉六成。
 */
describe("限速只有一处", () => {
  const SRC = readFileSync(new URL("../src/graph/subgraphs/itinerary.ts", import.meta.url), "utf8");
  const fnOf = (name: string) => {
    const from = SRC.indexOf(`export async function ${name}(`);
    assert.ok(from > 0, `${name} 没找到`);
    const to = SRC.indexOf("\nexport ", from + 10);
    return SRC.slice(from, to > 0 ? to : undefined);
  };

  it("resolveDayDriveLegs 里不再有任何 sleep / gapMs", () => {
    const body = fnOf("resolveDayDriveLegs");
    assert.ok(!/\bawait sleep\(/.test(body), "又把节流写回调用点了");
    assert.ok(!/gapMs/.test(body), "gapMs 该随节流一起搬走");
  });

  it("resolveTripPlanCoords 只剩「失败退一步」那一个 sleep，不是逐点间隔", () => {
    const body = fnOf("resolveTripPlanCoords");
    const sleeps = body.match(/await sleep\(/g) ?? [];
    assert.equal(sleeps.length, 1, `期望只有失败退避那一处，实际 ${sleeps.length} 处`);
    // 退避逐轮加长（限流多试几轮），所以是 retryDelayMs * attempt 而不是定值。
    assert.match(body, /await sleep\(retryDelayMs \* attempt\)/);
    assert.ok(!/gapMs/.test(body));
  });

  it("两处都在注释里指回客户端闸门——否则下一个人会以为这里忘了限速", () => {
    for (const name of ["resolveDayDriveLegs", "resolveTripPlanCoords"]) {
      assert.match(fnOf(name), /createAmapRateGate/, `${name} 没说清限速搬到哪去了`);
    }
  });
});
