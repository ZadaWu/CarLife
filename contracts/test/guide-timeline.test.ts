/**
 * 导览时间轴投影（M36-02）。守两件事：顺序是确定性规则（停车 → 必玩序 → 餐饮/
 * 休息/厕所 → 离场补能），以及**不造占位**——没名字的泛提示不进轴、全空进全空出。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { guideBriefToTimeline, type GuideBrief } from "../src/domain/guide";

const BASE: GuideBrief = {
  spot: "普陀山",
  spots: [],
  comfort: [],
  caveats: [],
  findings: [],
  branchSources: { access: "submission", spots: "submission", comfort: "submission" },
  sourcesVerified: { matched: 0, claimed: 0 },
  generatedAt: "2026-08-28T00:00:00Z",
};

test("完整简报：停车在首、必玩按序、餐饮休息随后、补能收尾，序号连续", () => {
  const brief: GuideBrief = {
    ...BASE,
    access: {
      parking: [
        { name: "码头停车场", toGate: "步行5分钟乘轮渡" },
        { name: "备选车场" },
      ],
      charging: [{ name: "国网充电站" }],
      refuel: [{ name: "中石化加油站" }],
    },
    spots: [
      { name: "普济寺", mustSee: "全山最大古刹", kind: "spot" },
      { name: "来了就好石碑", reason: "合照点", kind: "photo" },
    ],
    comfort: [
      { kind: "toilet", note: "到处有开水" }, // 无名字的泛提示：进栏目不进轴
      { kind: "food", name: "普济寺斋堂", note: "11:30 开餐" },
      { kind: "pitfall", name: "码头兜售", note: "勿理" }, // pitfall 是提醒不是站点
      { kind: "rest", name: "索道站休息亭", note: "可歇脚" },
    ],
  };
  const t = guideBriefToTimeline(brief);
  assert.deepEqual(
    t.map((e) => [e.index, e.kind, e.name]),
    [
      [1, "parking", "码头停车场"],
      [2, "spot", "普济寺"],
      [3, "photo", "来了就好石碑"],
      [4, "food", "普济寺斋堂"],
      [5, "rest", "索道站休息亭"],
      [6, "charging", "国网充电站"],
      [7, "refuel", "中石化加油站"],
    ],
  );
  assert.equal(t[0]!.note, "步行5分钟乘轮渡");
  assert.equal(t[1]!.note, "全山最大古刹", "spot 的 note 先取 mustSee");
  assert.equal(t[2]!.note, "合照点", "没有 mustSee 时退回 reason");
});

test("只有 access/comfort（spots 缺席）：时间轴仍有停车与休憩桩", () => {
  const t = guideBriefToTimeline({
    ...BASE,
    access: { parking: [{ name: "P1" }], charging: [], refuel: [] },
    comfort: [{ kind: "food", name: "斋堂", note: "有斋饭" }],
  });
  assert.deepEqual(
    t.map((e) => e.kind),
    ["parking", "food"],
  );
});

test("全空简报：空数组，不造占位站点", () => {
  assert.deepEqual(guideBriefToTimeline(BASE), []);
});
