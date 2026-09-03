/**
 * `energy_gap` 补能缺口测算（施工单 M26-06，F-54-02，AC-54-3/5/6）。
 *
 * 三条负向断言是重点，且都属于"错了也不报错"：
 *  - 写死的能耗常数（"500 公里 80 升"是举例，不是可硬编码的值）；
 *  - 够的时候硬塞一次停靠（同行的老人小孩要多等一次）；
 *  - 单位静默换算（升与百分之几之间没有通用换算，换一个就是凭空捏造缺口）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";

import { computeEnergyGap, energyGapTool } from "../src/energy-gap";
import { ToolError } from "../src/external";
import { getTool, listExposableForMcp, listForAgent } from "../src/registry";

const measured = (value: number, unit: "L" | "%" = "L") =>
  ({ value, unit, source: "measured" as const, sampleSize: 3, windowDays: 180 });

describe("energy_gap：够 / 不够 / 恰好", () => {
  it("不够时给出需求、余量、缺口，且缺口为正", () => {
    const r = computeEnergyGap({
      distanceKm: 500,
      consumption: measured(8.6),
      currentLevel: { value: 20, unit: "L" },
    });
    assert.equal(r.demand, 43);
    assert.equal(r.remaining, 20);
    assert.equal(r.gap, 23);
    assert.equal(r.sufficient, false);
    assert.equal(r.unit, "L");
  });

  it("**够的时候补能次数是 0，不是「保险起见来一次」**", () => {
    const r = computeEnergyGap({
      distanceKm: 200,
      consumption: measured(8.6),
      currentLevel: { value: 50, unit: "L" },
    });
    assert.equal(r.sufficient, true);
    assert.equal(r.refillCount, 0);
    assert.ok((r.gap ?? 0) <= 0);
    assert.ok(r.basis.some((b) => /多 \d/.test(b)), "要说清还富余多少");
  });

  it("恰好持平算够（gap === 0）", () => {
    const r = computeEnergyGap({
      distanceKm: 100,
      consumption: measured(10),
      currentLevel: { value: 10, unit: "L" },
    });
    assert.equal(r.gap, 0);
    assert.equal(r.sufficient, true);
    assert.equal(r.refillCount, 0);
  });

  it("知道一次能补多少才给次数；不知道就明说不知道", () => {
    const base = {
      distanceKm: 900,
      consumption: measured(8.6),
      currentLevel: { value: 10, unit: "L" as const },
    };
    const withCap = computeEnergyGap({ ...base, capacity: { value: 50, unit: "L" } });
    assert.equal(withCap.refillCount, 2, "缺 67.4 升、一次 50 升 → 两次");

    const without = computeEnergyGap(base);
    assert.equal(without.refillCount, undefined);
    assert.ok(without.basis.some((b) => b.includes("没法说要补几次")));
  });
});

describe("energy_gap：缺什么就说缺什么，不给伪数值", () => {
  it("没有能耗口径 → **不给需求量**，只说缺什么", () => {
    const r = computeEnergyGap({ distanceKm: 500, currentLevel: { value: 20, unit: "L" } });
    assert.equal(r.demand, undefined);
    assert.equal(r.gap, undefined);
    assert.deepEqual(r.missing, ["这辆车的百公里能耗（⑥ 实测与厂商标称都拿不到）"]);
  });

  it("没有余量 → 给需求量与区间，但**不给缺口、不猜够不够**", () => {
    const r = computeEnergyGap({ distanceKm: 500, consumption: measured(8.6) });
    assert.equal(r.demand, 43);
    assert.ok(r.demandRange);
    assert.equal(r.gap, undefined);
    assert.equal(r.sufficient, undefined, "不知道够不够就是不知道");
    assert.deepEqual(r.missing, ["当前能源余量"]);
  });

  it("里程非法 → 什么都不算", () => {
    assert.deepEqual(computeEnergyGap({ distanceKm: 0 }).missing, ["本次行程里程"]);
  });

  it("**单位混用直接抛，不静默换算**——升与百分之几之间没有通用换算", () => {
    assert.throws(
      () =>
        computeEnergyGap({
          distanceKm: 500,
          consumption: measured(8.6, "L"),
          currentLevel: { value: 40, unit: "%" },
        }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.category, "invalid");
        assert.match(e.message, /不做静默换算/);
        return true;
      },
    );
  });
});

describe("energy_gap：口径与区间", () => {
  it("实测与标称给出不同宽度的区间，且**标称必须说出是标称**", () => {
    const m = computeEnergyGap({ distanceKm: 500, consumption: measured(8.6) });
    const r = computeEnergyGap({
      distanceKm: 500,
      consumption: { value: 8.6, unit: "L", source: "rated" },
    });
    const width = (x?: [number, number]) => (x ? x[1] - x[0] : 0);
    assert.ok(width(r.demandRange) > width(m.demandRange), "标称的区间必须更宽");
    assert.ok(r.basis.some((b) => b.includes("不是你的实测值")));
    assert.ok(m.basis.some((b) => b.includes("实测")));
  });

  it("纯电走百分比，单位一路带到底", () => {
    const r = computeEnergyGap({
      distanceKm: 300,
      consumption: measured(25, "%"),
      currentLevel: { value: 60, unit: "%" },
      capacity: { value: 100, unit: "%" },
    });
    assert.equal(r.unit, "%");
    assert.equal(r.demand, 75);
    assert.equal(r.gap, 15);
    assert.equal(r.refillCount, 1);
  });

  it("永远给区间，不给一个点", () => {
    const r = computeEnergyGap({ distanceKm: 500, consumption: measured(8.6) });
    assert.ok(r.demandRange && r.demandRange[0] < r.demandRange[1]);
  });
});

describe("energy_gap：一个能耗常数都不许写死（AC-54-3）", () => {
  it("**真实路径**里没有裸露的能耗/需求量数字常量", () => {
    const src = fs.readFileSync(new URL("../src/energy-gap.ts", import.meta.url), "utf8");
    /*
     * 只扫 `computeEnergyGap` 这一段——**mock 里的数字是允许的**：
     * 四件套会把它标成 `source.kind = "mock"`，不会被当成真实数据
     * （`usage_profile` 的 mock 同样给了具体的日均里程）。
     * 真正要挡的是"真实路径上有一个写死的能耗"，那种数字会被当真。
     */
    const begin = src.indexOf("export function computeEnergyGap");
    const end = src.indexOf("export const energyGapTool");
    assert.ok(begin > 0 && end > begin);
    const body = src
      .slice(begin, end)
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("*") && !l.trimStart().startsWith("//"))
      .join("\n");
    // 需求描述里那句"500 公里 80 升"是举例，不该出现在实现里。
    for (const needle of ["80", "500", "16", "7.9", "8.6"]) {
      assert.equal(
        new RegExp(`(?<![.\\d])${needle}(?![.\\d])`).test(body),
        false,
        `真实路径里不该出现常数 ${needle}`,
      );
    }
  });

  it("换一台车、换一段里程，结果就不同（说明它真的在算）", () => {
    const a = computeEnergyGap({ distanceKm: 500, consumption: measured(8.6) }).demand;
    const b = computeEnergyGap({ distanceKm: 500, consumption: measured(12.4) }).demand;
    const c = computeEnergyGap({ distanceKm: 300, consumption: measured(8.6) }).demand;
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });
});

describe("energy_gap / refuel_log：ACL 与 MCP 边界", () => {
  it("energy_gap 给出行/行车/用车/supervisor，不外泄给购车与座舱", () => {
    for (const a of ["trip", "drive", "ownership", "supervisor"] as const) {
      assert.ok(listForAgent(a).some((t) => t.name === "energy_gap"), `${a} 应该有`);
    }
    for (const a of ["buying", "cabin", "test-drive"] as const) {
      assert.equal(listForAgent(a).some((t) => t.name === "energy_gap"), false, `${a} 不该有`);
    }
  });

  it("refuel_log 给 ownership/trip/drive", () => {
    for (const a of ["ownership", "trip", "drive"] as const) {
      assert.ok(listForAgent(a).some((t) => t.name === "refuel_log"), `${a} 应该有`);
    }
    assert.equal(listForAgent("buying").some((t) => t.name === "refuel_log"), false);
  });

  it("两者都不对外经 MCP 暴露", () => {
    const names = listExposableForMcp().map((t) => t.name);
    assert.equal(names.includes("energy_gap"), false);
    assert.equal(names.includes("refuel_log"), false);
  });

  it("注册表 schema 挡得住负数与零", () => {
    const reg = getTool("refuel_log");
    assert.ok(reg);
    assert.equal(reg.schema.safeParse({ userId: "u", liters: -1, odometerKm: 100 }).success, false);
    assert.equal(reg.schema.safeParse({ userId: "u", liters: 40, odometerKm: 0 }).success, false);
    assert.equal(reg.schema.safeParse({ userId: "u", liters: 40, odometerKm: 186000 }).success, true);
  });
});

describe("energy_gap：mock 给「不够」而不是「够」", () => {
  it("够的那条分支不需要下游做事，用它当 mock 等于没测到贯通", async () => {
    const { data } = await energyGapTool.call({ distanceKm: 500 } as never, {
      sessionId: "s",
      agent: "trip",
      mode: "mock",
    });
    assert.equal(data.sufficient, false);
    assert.ok((data.gap ?? 0) > 0);
  });
});
