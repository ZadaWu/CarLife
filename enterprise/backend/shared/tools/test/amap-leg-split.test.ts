/**
 * [F-18-15][AC-18-11] 一次带途经点的驾车请求，怎么拆回逐段时长。
 *
 * 背景：抽屉里「从酒店出发」「到酒店入住」两个时刻，原来一天要发两次高德请求
 * （`2×days − 1` 次），免费 key QPS=3，7 天就是 13 次。
 *
 * 实测过的事实（2026-09-15，真坐标 20 步响应）：高德 v5 驾车**不返回任何分段字段**——
 * `route` 只有 `origin/destination/taxi_cost/paths`，`path` 只有 `distance/restriction/cost/steps`，
 * `paths` 是备选路线而不是分段。唯一的途经点边界信号是 `show_fields` 带上 `navi` 之后
 * 每个 step 的 `navi.assistant_action`：「到达途经地」「到达目的地」。
 * 所以切分只能靠**按标记累加 step 时长**，这个文件锁住那段算法。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createAmapClient,
  splitLegMinutes,
  AMAP_WAYPOINT_MARK,
  AMAP_DESTINATION_MARK,
} from "../src/amap";

const step = (durationS: number, assistantAction?: string) => ({ durationS, assistantAction });

describe("[F-18-15][AC-18-11] splitLegMinutes：按「到达途经地」切段", () => {
  it("真实响应的形状：20 步、两个途经点 → 三段 8/5/11 分钟", () => {
    /* 实测那一趟的 step 时长与标记位置（索引 4、10 是途经地，19 是目的地）。 */
    const steps = [
      step(120), step(90), step(140), step(123), step(7, AMAP_WAYPOINT_MARK),
      step(60), step(50), step(80), step(50), step(47), step(1, AMAP_WAYPOINT_MARK),
      step(100), step(90), step(110), step(80), step(70), step(90), step(60), step(33),
      step(3, AMAP_DESTINATION_MARK),
    ];
    assert.deepEqual(splitLegMinutes(steps, 3), [8, 5, 11]);
  });

  it("**分段之和等于全程**，不能凭空多出或漏掉一段的时间", () => {
    const steps = [step(300), step(0, AMAP_WAYPOINT_MARK), step(600), step(0, AMAP_DESTINATION_MARK)];
    const total = steps.reduce((a, s) => a + s.durationS, 0);
    const legs = splitLegMinutes(steps, 2)!;
    assert.deepEqual(legs, [5, 10]);
    assert.equal(legs.reduce((a, b) => a + b, 0), Math.round(total / 60));
  });

  it("单段（没有途经点）也切得出来，只靠「到达目的地」", () => {
    assert.deepEqual(splitLegMinutes([step(400), step(80, AMAP_DESTINATION_MARK)], 1), [8]);
  });

  it("末尾没有任何标记时，剩下的 step 仍算作最后一段", () => {
    assert.deepEqual(splitLegMinutes([step(300), step(0, AMAP_WAYPOINT_MARK), step(600)], 2), [5, 10]);
  });

  it("标记数对不上期望段数 → undefined。**半套分段比没有分段更糟**", () => {
    const steps = [step(300), step(600, AMAP_DESTINATION_MARK)];
    assert.equal(splitLegMinutes(steps, 3), undefined, "只切出 1 段却要 3 段：宁可退回逐段请求");
    assert.equal(splitLegMinutes([step(60, AMAP_WAYPOINT_MARK), step(60, AMAP_WAYPOINT_MARK), step(60, AMAP_DESTINATION_MARK)], 2), undefined, "切出 3 段却只要 2 段");
  });

  it("一个标记都没有（忘了 withNavi）→ undefined，而不是把全程当成第一段", () => {
    assert.equal(splitLegMinutes([step(300), step(600)], 2), undefined);
  });

  it("空 steps / 期望段数非法 → undefined", () => {
    assert.equal(splitLegMinutes([], 1), undefined);
    assert.equal(splitLegMinutes([step(60, AMAP_DESTINATION_MARK)], 0), undefined);
  });

  it("不认识的 assistant_action 不当边界（「进入隧道」之类不是到达事件）", () => {
    const steps = [step(300, "进入隧道"), step(300, AMAP_DESTINATION_MARK)];
    assert.deepEqual(splitLegMinutes(steps, 1), [10]);
  });

  it("标记的字面量就是这两个词——改了它就切不出段，所以钉住", () => {
    assert.equal(AMAP_WAYPOINT_MARK, "到达途经地");
    assert.equal(AMAP_DESTINATION_MARK, "到达目的地");
  });
});

/**
 * 请求串与解析：`withNavi` 是这套切分的开关，默认不能改其它调用方的请求。
 */
describe("[F-18-15] driving 的 withNavi 与 assistant_action 解析", () => {
  function client(body: unknown) {
    const calls: string[] = [];
    const fetchImpl = (async (input: URL | RequestInfo) => {
      calls.push(String(input));
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    return { amap: createAmapClient({ key: "k", fetchImpl }), calls };
  }

  const BODY = {
    status: "1",
    infocode: "10000",
    route: {
      paths: [
        {
          distance: "12000",
          cost: { duration: "1404" },
          steps: [
            { instruction: "直行", step_distance: "5000", cost: { duration: "480" }, navi: { assistant_action: "到达途经地" } },
            { instruction: "右转", step_distance: "3000", cost: { duration: "288" }, navi: { assistant_action: "到达途经地" } },
            { instruction: "到达", step_distance: "4000", cost: { duration: "636" }, navi: { assistant_action: "到达目的地" } },
          ],
        },
      ],
    },
  };

  it("withNavi:true 才带 navi；途经点进 waypoints 用分号连", async () => {
    const { amap, calls } = client(BODY);
    await amap.driving({
      origin: { lat: 31.31, lon: 120.62 },
      destination: { lat: 31.29, lon: 120.62 },
      waypoints: [{ lat: 31.35, lon: 120.57 }, { lat: 31.32, lon: 120.63 }],
      withNavi: true,
    });
    const url = calls[0]!;
    assert.match(url, /show_fields=cost%2Cpolyline%2Ctmcs%2Cnavi/);
    assert.match(url, /waypoints=120\.57%2C31\.35%3B120\.63%2C31\.32/);
  });

  it("不传 withNavi 时请求串一字不变——其它调用方不该被这次改动波及", async () => {
    const { amap, calls } = client(BODY);
    await amap.driving({ origin: { lat: 31.31, lon: 120.62 }, destination: { lat: 31.29, lon: 120.62 } });
    assert.match(calls[0]!, /show_fields=cost%2Cpolyline%2Ctmcs(&|$)/);
    assert.ok(!calls[0]!.includes("navi"), "默认不要 navi");
    assert.ok(!calls[0]!.includes("waypoints"), "没有途经点就不带这个参数");
  });

  it("解析出 assistantAction，接上切分就是三段 8/5/11", async () => {
    const { amap } = client(BODY);
    const path = await amap.driving({
      origin: { lat: 31.31, lon: 120.62 },
      destination: { lat: 31.29, lon: 120.62 },
      waypoints: [{ lat: 31.35, lon: 120.57 }, { lat: 31.32, lon: 120.63 }],
      withNavi: true,
    });
    assert.deepEqual(path.steps.map((s) => s.assistantAction), [
      AMAP_WAYPOINT_MARK,
      AMAP_WAYPOINT_MARK,
      AMAP_DESTINATION_MARK,
    ]);
    assert.deepEqual(splitLegMinutes(path.steps, 3), [8, 5, 11]);
  });

  it("响应里没有 navi 字段时，assistantAction 不存在（而不是空串）", async () => {
    const bare = { ...BODY, route: { paths: [{ ...BODY.route.paths[0]!, steps: [{ instruction: "直行", step_distance: "5000", cost: { duration: "480" } }] }] } };
    const { amap } = client(bare);
    const path = await amap.driving({ origin: { lat: 1, lon: 1 }, destination: { lat: 2, lon: 2 } });
    assert.ok(!("assistantAction" in path.steps[0]!));
  });
});
