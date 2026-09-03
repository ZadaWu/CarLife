/**
 * 「对话里定了行程就展示出来」的防退化断言。
 *
 * 用户走查（2026-09-02）：会话详情的「最终行程（落库）」一栏显示"无可画的点序"，
 * 而库里那份行程带着坐标——页面是在行程确认前打开的，之后没刷新。
 * 这里守三条：列表行带行程芯片；详情有整份"已确定的行程"；对比面板会随会话更新重取。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { tripChipText } from "../src/pages/sessions/trip-chip";

const PAGE = readFileSync(join(process.cwd(), "src/pages/sessions/index.tsx"), "utf8");
const RC = readFileSync(join(process.cwd(), "src/pages/sessions/RouteCompare.tsx"), "utf8");

describe("列表与详情头", () => {
  it("列表行在有行程时渲染芯片，已取消的也显示（不改写历史）", () => {
    assert.match(PAGE, /s\.trip && \(/);
    assert.match(PAGE, /行程已取消/);
    assert.match(PAGE, /已定行程/);
  });

  it("详情头上的元信息里有「行程」一行", () => {
    assert.match(PAGE, /<dt>行程<\/dt>/);
  });

  it("芯片文案：目的地 · 天数 · 出发日", () => {
    const base = { planId: "p", status: "confirmed" as const, days: 1, committedAt: "", themes: [], destination: "嘉兴" };
    assert.equal(tripChipText({ ...base, startDate: "2026-09-03" }), "嘉兴 · 1 天 · 9/3 出发");
    assert.equal(tripChipText(base), "嘉兴 · 1 天");
  });
});

describe("已确定的行程 + 对比面板的刷新", () => {
  it("对比面板先画整份落库行程（PlanCard），再画三列对比", () => {
    assert.match(RC, /finalPlan && <PlanCard plan=\{finalPlan\} \/>/);
    assert.match(RC, /已确定的行程/);
    assert.match(RC, /已取消的行程/);
  });

  it("行程按天列站点、住宿与提醒；预计时段带「预计」", () => {
    for (const t of ["rc-plan-spots", "rc-plan-hotel", "notes", "预计 ${"]) assert.ok(RC.includes(t), `缺 ${t}`);
  });

  it("会话更新与窗口回焦点时重取，且有手动刷新", () => {
    assert.match(RC, /refreshKey/);
    assert.match(RC, /addEventListener\("focus"/);
    assert.match(RC, />\s*刷新\s*</);
    assert.match(PAGE, /<RouteCompare sessionId=\{sessionId\} refreshKey=\{meta\?\.lastMessageAt \?\? 0\} \/>/);
  });
});
