/**
 * [F-18-05][F-13-05] 续航评估的结论走提交槽（ACR-047，`submit_range_assessment`）。
 *
 * 此前 ownership 分支的产出在多天行程这条链上根本没被读：余量与 findings 原地蒸发。
 * 现在余量进求解器（minRangeMarginPct 的 violation 终于有输入），basis / 样本 / 补能次数进 findings，
 * 给不出记入 missing。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { energySubmitDirective } from "../src/graph/energy";
import { mergeItinerary } from "../src/graph/subgraphs/itinerary";
import type { BranchResult } from "../src/graph/fanout";
import { legsFrom } from "./helpers/drive-legs";

const INPUT = { goal: "去黄山", constraints: [], userText: "去黄山玩五天", turnId: "t-1", energyType: "bev" as const };
const sub = (agent: string, submission: unknown): BranchResult => ({ agent, status: "ok", text: "", startedAt: 0, endedAt: 1, submission });
const TOUR = sub("tour-task", { destination: "黄山", days: [{ day: 1, theme: "到达", area: "屯溪", spots: [{ name: "黎阳in巷" }] }] });
const DRIVE = sub("drive-task", { legs: legsFrom([300], [], [1], { origin: "上海", destination: "屯溪" }) });

describe("[F-18-05] 续航评估经 submit_range_assessment 进汇聚", () => {
  it("measured 带数字 → findings 里有一行续航评估（basis / 样本 / 补能次数），分支 findings 也带上", () => {
    const out = mergeItinerary(
      [TOUR, DRIVE, sub("ownership-task", { basis: "measured", rangeMarginPct: -190, sampleSize: 53, windowDays: 30, chargeStopsNeeded: 2, findings: ["近 30 天 53 条实测"] })],
      INPUT,
      ["tour", "drive"],
    );
    assert.ok(out.findings.some((f) => /续航评估（按实测画像，53 条样本 \/ 近 30 天）：到达时余量约 -190%；沿途约需补能 2 次/.test(f)), out.findings.join("|"));
    assert.ok(out.findings.includes("近 30 天 53 条实测"));
  });

  it("[F-13-05] 余量低于意图给的下限 → violation 显式呈现（这条判据此前没有输入）", () => {
    const out = mergeItinerary(
      [TOUR, DRIVE, sub("ownership-task", { basis: "estimated", rangeMarginPct: 5 })],
      { ...INPUT, tripLimits: { minRangeMarginPct: 20 } },
      ["tour", "drive"],
    );
    assert.ok(out.violations.some((v) => /5%.*20%/.test(v)), out.violations.join("|"));
  });

  it("unavailable → 记入 missing，不编数字", () => {
    const out = mergeItinerary([TOUR, DRIVE, sub("ownership-task", { basis: "unavailable", findings: ["没有实测续航"] })], INPUT, ["tour", "drive"]);
    assert.ok(out.missing.some((m) => /续航余量这次给不出/.test(m)));
    assert.ok(!out.findings.some((f) => /续航评估（/.test(f)));
    assert.ok(out.findings.includes("没有实测续航"));
  });

  it("ownership 没交（只有散文）→ 什么都不加，也不报错", () => {
    const out = mergeItinerary([TOUR, DRIVE, { agent: "ownership-task", status: "ok", text: "续航这块…", startedAt: 0, endedAt: 1 }], INPUT, ["tour", "drive"]);
    assert.ok(!out.findings.some((f) => /续航评估（/.test(f)));
  });
});

describe("[F-18-05] energySubmitDirective：三档都以提交收尾，给不出就 unavailable", () => {
  it("纯电 / 插电要数字；燃油没读数与未知能源不给数字字段", () => {
    assert.match(energySubmitDirective("bev"), /submit_range_assessment/);
    assert.match(energySubmitDirective("bev"), /rangeMarginPct/);
    assert.match(energySubmitDirective("phev"), /measured/);
    const icev = energySubmitDirective("icev");
    assert.match(icev, /unavailable/);
    assert.doesNotMatch(icev, /rangeMarginPct/);
    const unknown = energySubmitDirective(undefined);
    assert.match(unknown, /unavailable/);
    assert.doesNotMatch(unknown, /rangeMarginPct/);
    assert.match(energySubmitDirective("icev", { status: "live", fuelPercent: 40 } as never), /estimated/);
  });
});
