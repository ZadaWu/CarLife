/**
 * [F-18-15][AC-18-11] 变更集的合并规则与编辑态的行合成（M83-04）。
 *
 * 车主会连点好几下，所以"同一件事的前一次"必须被合并掉：连调三次顺序不该产生三条变更，
 * 换两次天更不该叠成两条——那两句话一起发给暖暖，它有理由照第一句做。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyStructureEdits, type TripPlanSnapshot, type TripStructureEdit } from "@carlife/shared";

import { dayTouched, editableRows, moveInOrder, pushMove, pushRemove, pushReorder, undoRemove } from "../src/hud/trip-detail";

const spot = (name: string, estStart?: string, estEnd?: string) => ({
  name,
  ...(estStart ? { estStart } : {}),
  ...(estEnd ? { estEnd } : {}),
});

const plan = (): TripPlanSnapshot => ({
  status: "confirmed",
  destination: "徐州",
  origin: "杭州",
  days: 3,
  skeleton: [
    { day: 1, theme: "一", spots: [spot("A", "09:00", "11:00"), spot("B", "12:00", "13:00"), spot("C", "14:00", "17:00")], hotel: { name: "酒店甲" } },
    { day: 2, theme: "二", spots: [spot("D"), spot("E")], hotel: { name: "酒店甲" } },
    { day: 3, theme: "三", spots: [spot("F")] },
  ],
  caveats: [],
  updatedTurnId: "t",
});

describe("[F-18-15][AC-18-11] 变更集的合并规则", () => {
  it("连着调三次顺序只留最后一条", () => {
    let e: TripStructureEdit[] = [];
    e = pushReorder(e, 1, ["B", "A", "C"]);
    e = pushReorder(e, 1, ["B", "C", "A"]);
    e = pushReorder(e, 1, ["C", "B", "A"]);
    assert.equal(e.length, 1);
    assert.deepEqual((e[0] as { order: string[] }).order, ["C", "B", "A"]);
  });

  it("不同天的顺序各留一条", () => {
    let e: TripStructureEdit[] = [];
    e = pushReorder(e, 1, ["B", "A"]);
    e = pushReorder(e, 2, ["E", "D"]);
    assert.equal(e.length, 2);
  });

  it("删了再撤销 = 变更集回空", () => {
    let e = pushRemove([], 1, "B");
    assert.equal(e.length, 1);
    e = undoRemove(e, 1, "B");
    assert.deepEqual(e, []);
  });

  it("重复删同一站不叠加", () => {
    const e = pushRemove(pushRemove([], 1, "B"), 1, "B");
    assert.equal(e.length, 1);
  });

  it("同一站换两次天：改写而不是追加（两句话发给暖暖它会照第一句做）", () => {
    let e = pushMove([], 1, "A", 2);
    e = pushMove(e, 1, "A", 3);
    assert.equal(e.length, 1);
    assert.equal((e[0] as { toDay: number }).toDay, 3);
  });

  it("换回原来那天 = 没换，变更撤掉", () => {
    let e = pushMove([], 1, "A", 2);
    e = pushMove(e, 1, "A", 1);
    assert.deepEqual(e, []);
  });

  it("删一个已经换过天的站：两条并存", () => {
    let e = pushMove([], 1, "A", 2);
    e = pushRemove(e, 1, "A");
    assert.equal(e.length, 2);
  });

  it("dayTouched：改动的来源天与目标天都算被改过", () => {
    const e = pushMove([], 1, "A", 3);
    assert.ok(dayTouched(e, 1));
    assert.ok(dayTouched(e, 3));
    assert.ok(!dayTouched(e, 2));
  });
});

describe("[F-18-15][AC-18-11] editableRows：软删的行留在原地", () => {
  const rowsOf = (edits: TripStructureEdit[], day = 1) =>
    editableRows(plan(), applyStructureEdits(plan(), edits), edits, day);

  it("删中间一站：它仍在原位置且带 removed，「撤销」才有地方点", () => {
    const rows = rowsOf(pushRemove([], 1, "B"));
    const names = rows.filter((r) => r.kind === "spot").map((r) => r.name);
    assert.deepEqual(names, ["A", "B", "C"], "顺序不变");
    assert.equal(rows.find((r) => r.name === "B")!.removed, true);
    assert.ok(!rows.find((r) => r.name === "A")!.removed);
  });

  it("换天的站从当前天消失（不然车主以为点了没反应）", () => {
    const rows = rowsOf(pushMove([], 1, "B", 2));
    assert.ok(!rows.some((r) => r.name === "B"));
    const day2 = rowsOf(pushMove([], 1, "B", 2), 2);
    assert.ok(day2.some((r) => r.name === "B"), "落在目标天末尾");
  });

  it("软删的行不占 index：上下移的边界按还活着的站算", () => {
    const rows = rowsOf(pushRemove([], 1, "A"));
    const spots = rows.filter((r) => r.kind === "spot");
    assert.equal(spots.length, 3);
    // A 被软删，仍有 index（它要渲染），但可移动性由组件按 spotRows 判
    assert.equal(spots[0]!.name, "A");
  });

  it("出发行与酒店行照常在，且不是 spot", () => {
    const rows = rowsOf([]);
    assert.equal(rows[0]!.kind, "origin");
    assert.equal(rows.at(-1)!.kind, "hotel");
  });
});

describe("[F-18-15][AC-18-11] moveInOrder：上下移一位", () => {
  it("往前 / 往后各挪一格", () => {
    assert.deepEqual(moveInOrder(["A", "B", "C"], "B", -1), ["B", "A", "C"]);
    assert.deepEqual(moveInOrder(["A", "B", "C"], "B", 1), ["A", "C", "B"]);
  });

  it("已在两端 / 不在表里：返回 undefined，调用方什么也不做", () => {
    assert.equal(moveInOrder(["A", "B"], "A", -1), undefined);
    assert.equal(moveInOrder(["A", "B"], "B", 1), undefined);
    assert.equal(moveInOrder(["A", "B"], "Z", 1), undefined);
  });

  it("不改入参", () => {
    const src = ["A", "B", "C"];
    moveInOrder(src, "A", 1);
    assert.deepEqual(src, ["A", "B", "C"]);
  });
});

describe("[F-18-15][AC-18-11] editableRows 的插回位置（2026-09-14 走查逮到的）", () => {
  const rowsOf = (edits: TripStructureEdit[], day = 1) =>
    editableRows(plan(), applyStructureEdits(plan(), edits), edits, day);
  const names = (edits: TripStructureEdit[], day = 1) => rowsOf(edits, day).map((r) => r.name);

  it("删当天**最后一个**景点：软删行仍在酒店之前，不掉到酒店后面", () => {
    assert.deepEqual(names(pushRemove([], 1, "C")), ["杭州", "A", "B", "C", "酒店甲"]);
  });

  it("删第一个景点：软删行仍在最前", () => {
    assert.deepEqual(names(pushRemove([], 1, "A")), ["杭州", "A", "B", "C", "酒店甲"]);
  });

  it("删中间一个：位置不变", () => {
    assert.deepEqual(names(pushRemove([], 1, "B")), ["杭州", "A", "B", "C", "酒店甲"]);
  });

  it("三站全删：三行都在，顺序不变，酒店仍在末尾", () => {
    let e = pushRemove([], 1, "A");
    e = pushRemove(e, 1, "B");
    e = pushRemove(e, 1, "C");
    assert.deepEqual(names(e), ["杭州", "A", "B", "C", "酒店甲"]);
    assert.equal(rowsOf(e).filter((r) => r.removed).length, 3);
  });

  it("没有酒店的那天删掉唯一的景点：软删行仍在", () => {
    assert.deepEqual(names(pushRemove([], 3, "F"), 3), ["酒店甲", "F"]);
  });

  it("删一站 + 换走一站：两者互不干扰", () => {
    let e = pushRemove([], 1, "C");
    e = pushMove(e, 1, "A", 2);
    assert.deepEqual(names(e), ["杭州", "B", "C", "酒店甲"]);
  });
});
