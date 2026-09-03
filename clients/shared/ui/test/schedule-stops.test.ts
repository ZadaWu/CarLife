/**
 * M34-02：scheduleStops 消费模型时段的三态。
 * 整天一票制：全带用模型时段、全缺回退推算、半缺整天回退——
 * 半天可信半天推算的混排比全推算更难读（与 merge 侧 dayTimesValid 同一取向）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scheduleStops, type RouteLeg } from "../src/map/trip-route";

const leg = (minutes: number): RouteLeg => ({ path: [], durationS: minutes * 60 });

describe("scheduleStops 模型时段三态", () => {
  it("全带：直接用模型时段（夜游 19:30 不再被排到上午）", () => {
    const out = scheduleStops(
      [
        { day: 1, kind: "spot", estStart: "09:30", estEnd: "11:30" },
        { day: 1, kind: "spot", estStart: "19:30", estEnd: "21:00" },
      ],
      [leg(20)],
    );
    assert.deepEqual(out, [
      { arrive: "09:30", depart: "11:30" },
      { arrive: "19:30", depart: "21:00" },
    ]);
  });

  it("全缺：回退现行推算（旧行程渲染与现状一致）", () => {
    const out = scheduleStops(
      [
        { day: 1, kind: "spot" },
        { day: 1, kind: "spot" },
      ],
      [leg(30)],
    );
    // 09:00 起，spot 停 90 分钟，段间 30 分钟车程
    assert.deepEqual(out, [
      { arrive: "09:00", depart: "10:30" },
      { arrive: "11:00", depart: "12:30" },
    ]);
  });

  it("半缺：整天回退，不混排", () => {
    const out = scheduleStops(
      [
        { day: 1, kind: "spot", estStart: "09:30", estEnd: "11:30" },
        { day: 1, kind: "spot" },
      ],
      [leg(30)],
    );
    assert.deepEqual(out, [
      { arrive: "09:00", depart: "10:30" },
      { arrive: "11:00", depart: "12:30" },
    ]);
  });

  it("按天独立判定：D1 用模型时段，D2 回退推算", () => {
    const out = scheduleStops(
      [
        { day: 1, kind: "spot", estStart: "09:30", estEnd: "11:30" },
        { day: 2, kind: "spot" },
      ],
      [leg(30)],
    );
    assert.deepEqual(out[0], { arrive: "09:30", depart: "11:30" });
    assert.deepEqual(out[1], { arrive: "09:00", depart: "10:30" }); // 换天重置 09:00
  });

  it("模型时段天里的 hotel 不猜时间（只留 Day 徽标）", () => {
    const out = scheduleStops(
      [
        { day: 1, kind: "spot", estStart: "09:30", estEnd: "11:30" },
        { day: 1, kind: "hotel" },
      ],
      [leg(20)],
    );
    assert.deepEqual(out[1], {});
  });

  it("模型时段天与回退天共存：D1 用模型时段；唯一缺的 leg 是跨天对，不连坐 D2 的推算（M34-03）", () => {
    const out = scheduleStops(
      [
        { day: 1, kind: "spot", estStart: "09:30", estEnd: "11:30" },
        { day: 2, kind: "spot" },
      ],
      [null],
    );
    assert.deepEqual(out[0], { arrive: "09:30", depart: "11:30" });
    assert.deepEqual(out[1], { arrive: "09:00", depart: "10:30" });
  });
});

// ── M34-03：分天切段 + 跨天段不参与 usable 判定 ─────────────────────

import { splitByDay } from "../src/map/trip-route";

describe("splitByDay（M34-03）", () => {
  it("4 天切 4 段，段内顺序保持；连住酒店归首日段尾", () => {
    const stops = [
      { day: 1, name: "a" },
      { day: 1, name: "b" },
      { day: 1, name: "hotel" },
      { day: 2, name: "c" },
      { day: 3, name: "d" },
      { day: 4, name: "e" },
      { day: 4, name: "f" },
    ];
    const segs = splitByDay(stops);
    assert.deepEqual(
      segs.map((s) => s.map((x) => x.name)),
      [["a", "b", "hotel"], ["c"], ["d"], ["e", "f"]],
    );
  });

  it("单点天成独立段；空输入回空", () => {
    assert.deepEqual(splitByDay([{ day: 3, name: "x" }]).length, 1);
    assert.deepEqual(splitByDay([]), []);
  });
});

describe("scheduleStops 跨天段判定（M34-03）", () => {
  it("跨天对为 null 不再废掉整体推算（分天后跨天段恒不规划）", () => {
    const out = scheduleStops(
      [
        { day: 1, kind: "spot" },
        { day: 1, kind: "spot" },
        { day: 2, kind: "spot" },
      ],
      [leg(30), null, leg(10)],
    );
    assert.deepEqual(out[0], { arrive: "09:00", depart: "10:30" });
    assert.deepEqual(out[1], { arrive: "11:00", depart: "12:30" });
    assert.deepEqual(out[2], { arrive: "09:00", depart: "10:30" }); // 换天重置
  });

  it("同天对为 null 仍整体不给（推算失真的既有纪律不变）", () => {
    const out = scheduleStops(
      [
        { day: 1, kind: "spot" },
        { day: 1, kind: "spot" },
      ],
      [null],
    );
    assert.deepEqual(out, [{}, {}]);
  });
});
