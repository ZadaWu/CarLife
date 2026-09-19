/**
 * M83-01：行程详情抽屉的结构变更（删站 / 换天 / 排序）。
 *
 * 这一组用例守的是同一件事：**屏上看到的、标题下写的、发给暖暖的，必须是同一份数据**。
 * 三者各算各的，漂移不会报错，只会让暖暖照着一份与车主所见不同的行程去改。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  adjustPlanIdOf,
  adjustStructurePrompt,
  applyStructureEdits,
  structureEditSummary,
  type TripPlanSnapshot,
  type TripStructureEdit,
} from "../src";

const spot = (name: string, estStart?: string, estEnd?: string) => ({ name, ...(estStart ? { estStart } : {}), ...(estEnd ? { estEnd } : {}) });

const plan = (): TripPlanSnapshot => ({
  status: "confirmed",
  destination: "徐州",
  days: 3,
  skeleton: [
    { day: 1, theme: "汉文化与纪念地", spots: [spot("徐州汉文化景区", "09:00", "11:30"), spot("水下兵马俑博物馆", "11:45", "13:30"), spot("淮海战役烈士纪念塔", "14:00", "17:00")], hotel: { name: "徐州开元名都大酒店" } },
    { day: 2, theme: "云龙山水", spots: [spot("云龙山索滑道", "09:00", "11:30"), spot("云龙湖旅游景区", "13:00", "16:30")], hotel: { name: "徐州开元名都大酒店" } },
    { day: 3, theme: "古城与夜市", spots: [spot("户部山古民居", "09:30", "11:30"), spot("戏马台", "12:00", "14:30"), spot("回龙窝网红打卡墙", "17:00", "19:00")] },
  ],
  legs: [{ day: 1, driveMinutes: 40 }],
  caveats: [],
  updatedTurnId: "t1",
});

const namesOf = (p: TripPlanSnapshot, day: number) => (p.skeleton.find((d) => d.day === day)?.spots ?? []).map((s) => s.name);

describe("[F-18-15][AC-18-11] applyStructureEdits", () => {
  it("删除：该天少一站，其余天不动，legs 作废，入参不被改写", () => {
    const before = plan();
    const after = applyStructureEdits(before, [{ kind: "remove", day: 1, spot: "水下兵马俑博物馆" }]);
    assert.deepEqual(namesOf(after, 1), ["徐州汉文化景区", "淮海战役烈士纪念塔"]);
    assert.deepEqual(namesOf(after, 2), namesOf(before, 2));
    assert.deepEqual(namesOf(after, 3), namesOf(before, 3));
    assert.equal(after.legs, undefined, "删站换天之后那份分段描述的路已经不存在");
    assert.equal(before.skeleton[0]!.spots.length, 3, "输入不可变");
    assert.equal(before.legs?.length, 1);
  });

  it("删除：同一天两个同名站只删第一处", () => {
    const p = plan();
    p.skeleton[1]!.spots = [spot("服务区", "09:00", "09:20"), spot("服务区", "15:00", "15:20")];
    const after = applyStructureEdits(p, [{ kind: "remove", day: 2, spot: "服务区" }]);
    const left = after.skeleton.find((d) => d.day === 2)!.spots;
    assert.equal(left.length, 1);
    assert.equal(left[0]!.estStart, "15:00", "留下的是第二处");
  });

  it("换天：从当前天消失、落在目标天末尾，且时间原样带走（端上不排时）", () => {
    const after = applyStructureEdits(plan(), [{ kind: "move", day: 2, spot: "云龙湖旅游景区", toDay: 3 }]);
    assert.deepEqual(namesOf(after, 2), ["云龙山索滑道"]);
    assert.deepEqual(namesOf(after, 3), ["户部山古民居", "戏马台", "回龙窝网红打卡墙", "云龙湖旅游景区"]);
    const moved = after.skeleton.find((d) => d.day === 3)!.spots.at(-1)!;
    assert.equal(moved.estStart, "13:00", "时间由暖暖重排，端上不动它");
    assert.equal(moved.estEnd, "16:30");
  });

  it("换天：目标天不存在就整条忽略，那一站留在原处（不能摘下来放不回去）", () => {
    const after = applyStructureEdits(plan(), [{ kind: "move", day: 2, spot: "云龙湖旅游景区", toDay: 9 }]);
    assert.deepEqual(namesOf(after, 2), ["云龙山索滑道", "云龙湖旅游景区"]);
  });

  it("排序：order 缺的按原相对顺序缀在后面，多的忽略", () => {
    const after = applyStructureEdits(plan(), [{ kind: "reorder", day: 3, order: ["戏马台", "不存在的地方"] }]);
    assert.deepEqual(namesOf(after, 3), ["戏马台", "户部山古民居", "回龙窝网红打卡墙"]);
  });

  it("混合变更：结果与输入顺序无关（先删、再换天、最后排序）", () => {
    const edits: TripStructureEdit[] = [
      { kind: "reorder", day: 3, order: ["回龙窝网红打卡墙", "戏马台", "户部山古民居"] },
      { kind: "move", day: 2, spot: "云龙湖旅游景区", toDay: 3 },
      { kind: "remove", day: 1, spot: "淮海战役烈士纪念塔" },
    ];
    const a = applyStructureEdits(plan(), edits);
    const b = applyStructureEdits(plan(), [...edits].reverse());
    assert.deepEqual(a, b);
    assert.deepEqual(namesOf(a, 1), ["徐州汉文化景区", "水下兵马俑博物馆"]);
    assert.deepEqual(namesOf(a, 3), ["回龙窝网红打卡墙", "戏马台", "户部山古民居", "云龙湖旅游景区"]);
  });

  it("酒店、主题、日期不进变更集", () => {
    const after = applyStructureEdits(plan(), [{ kind: "remove", day: 1, spot: "徐州汉文化景区" }]);
    assert.equal(after.skeleton[0]!.hotel?.name, "徐州开元名都大酒店");
    assert.equal(after.skeleton[0]!.theme, "汉文化与纪念地");
  });
});

describe("[F-18-15][AC-18-11] structureEditSummary", () => {
  it("空集没有文案（界面据此禁用「保存调整」）", () => {
    assert.deepEqual(structureEditSummary([]), { count: 0, text: "" });
  });

  it("三条变更写「已改 3 处」并点名时间由暖暖重排", () => {
    const s = structureEditSummary([
      { kind: "remove", day: 1, spot: "A" },
      { kind: "move", day: 2, spot: "B", toDay: 3 },
      { kind: "reorder", day: 3, order: ["C", "D"] },
    ]);
    assert.equal(s.count, 3);
    assert.ok(s.text.includes("已改 3 处"), s.text);
    assert.ok(s.text.includes("暖暖重排时间"), s.text);
  });
});

describe("[F-18-15][AC-18-11] adjustStructurePrompt", () => {
  const edits: TripStructureEdit[] = [
    { kind: "remove", day: 1, spot: "淮海战役烈士纪念塔" },
    { kind: "move", day: 2, spot: "云龙湖旅游景区", toDay: 3 },
    { kind: "reorder", day: 3, order: ["户部山古民居", "回龙窝网红打卡墙", "戏马台"] },
  ];

  it("服务端能从这句话取回 planId（端上协议不变）", () => {
    const text = adjustStructurePrompt("plan-abc12345", plan(), edits);
    assert.equal(adjustPlanIdOf(text), "plan-abc12345");
  });

  it("三种分句各出现一次，尾句点名重排时间", () => {
    const text = adjustStructurePrompt("plan-abc12345", plan(), edits);
    assert.ok(text.includes("第 1 天删除「淮海战役烈士纪念塔」"), text);
    assert.ok(text.includes("第 2 天的「云龙湖旅游景区」移到第 3 天"), text);
    assert.ok(text.includes("第 3 天顺序改为 户部山古民居 → 回龙窝网红打卡墙 → 戏马台"), text);
    assert.ok(text.endsWith("。请按这些变化重排每天的时间，其它不动，改完直接把这份行程定下来。"), text);
  });

  // 2026-09-14 真跑实测：尾句不带处置意图时，模型把改完的结果当草案收尾，
  // 确认弹窗不出现、库里那份原封不动——而车主刚按的是「保存调整」。
  it("尾句带上「定下来」，让这一轮走到确认弹窗（M83-05 实测）", () => {
    const text = adjustStructurePrompt("plan-abc12345", plan(), edits);
    assert.ok(text.includes("定下来"), text);
    // 「它确实命中了服务端的处置判定」在 agent-runtime 那侧验——契约包不 import 服务模块。
  });

  it("空集抛错，不拼一句让暖暖白跑一轮的话", () => {
    assert.throws(() => adjustStructurePrompt("plan-abc12345", plan(), []), /没有变更/);
  });

  it("分句条数与「已改 n 处」的 n 相等（两处只能有一份）", () => {
    const text = adjustStructurePrompt("plan-abc12345", plan(), edits);
    const body = text.slice(text.indexOf("：") + 1, text.lastIndexOf("。请按"));
    assert.equal(body.split("；").length, structureEditSummary(edits).count);
  });

  it("planId 短于 8 位时正则照旧不认（没有放宽既有形状）", () => {
    assert.equal(adjustPlanIdOf(adjustStructurePrompt("short", plan(), edits)), undefined);
  });
});
