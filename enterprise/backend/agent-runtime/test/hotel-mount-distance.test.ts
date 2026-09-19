/**
 * [F-13-05] 酒店挂载改按距离挑最近的（M77 走查追修）。
 *
 * 缺口判定已按距离，挂载若仍比片区标签，一条链就是两套标准。真跑 turn-16cb903b：
 * 按距离发现第 3 天 8 公里内没酒店 → 追发 → 模型交回标着「崇川区双龙路」的三家 →
 * 挂载按名字挑中「南通滨江洲际酒店」，离第 3 天 11.15 公里，比它顶掉的那家（8.15）还远。
 * 坐标全部取自那一轮 poi_search 的真实返回。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeItinerary, HOTEL_GAP_KM_DEFAULT } from "../src/graph/subgraphs/itinerary";
import type { BranchResult } from "../src/graph/fanout";

const 绿博园 = { lat: 32.024341, lon: 120.966632 };   // 第 3 天唯一的点
const 濠河   = { lat: 32.014345, lon: 120.867057 };
const 诺富特 = { lat: 32.012403, lon: 120.881304 };   // 离绿博园 8.15km
const 全季   = { lat: 32.015239, lon: 120.8594 };     // 离绿博园 10.16km
const 滨江洲际 = { lat: 31.96025, lon: 120.875635 };  // 离绿博园 11.15km，标签却写「崇川区双龙路」
const book = new Map(Object.entries({
  "洲际绿博园": 绿博园, "南通濠河风景名胜区": 濠河,
  "南通中心雅高诺富特酒店": 诺富特, "全季酒店(电视塔店)": 全季, "南通滨江洲际酒店": 滨江洲际,
}));
const coordOf = (n?: string) => (n ? book.get(n) : undefined);
const opts = { coordOf, maxKm: HOTEL_GAP_KM_DEFAULT };

const br = (agent: string, submission: unknown): BranchResult =>
  ({ agent, status: "ok", text: "", submission, startedAt: 0, endedAt: 1 }) as never;
const INPUT = { goal: "南通三天", constraints: [], userText: "南通三天", energyType: undefined, plan: undefined, turnId: "t" } as never;
const tour = (days: unknown[]) => br("tour-task", { destination: "南通", days });
const hotels = (list: unknown[]) => br("hotel-task", { hotels: list });
const run = (days: unknown[], list: unknown[]) =>
  mergeItinerary([tour(days), hotels(list)], INPUT, ["tour", "hotel"], opts).plan;

describe("[F-13-05] 挂载按距离", () => {
  it("真跑 turn-16cb903b：标签对得上但更远的那家，不再被挑中", () => {
    // 末尾补一个回家日：最后一天不挂酒店（见下面那条用例），被检查的是第 1 天。
    const plan = run(
      [
        { day: 1, area: "崇川区双龙路", spots: [{ name: "洲际绿博园" }] },
        { day: 2, area: "返程", spots: [] },
      ],
      [
        { name: "南通中心雅高诺富特酒店", area: "濠河风景区/崇川市区" },
        { name: "南通滨江洲际酒店", area: "崇川区双龙路" },   // 名字对得上，却更远
      ],
    );
    // 两家都超 8km，谁也不算"对上"；但挑最近的（8.15）而不是标签像的（11.15）
    assert.equal(plan.skeleton[0]!.hotel?.name, "南通中心雅高诺富特酒店");
    assert.match(plan.caveats.join("\n"), /约 8 公里，不在同一片区/);
  });

  it("阈值内挑最近的，且不进 caveat", () => {
    const plan = run(
      [{ day: 1, area: "x", spots: [{ name: "南通濠河风景名胜区" }] }, { day: 2, area: "返程", spots: [] }],
      [{ name: "全季酒店(电视塔店)", area: "a" }, { name: "南通中心雅高诺富特酒店", area: "b" }],
    );
    assert.equal(plan.skeleton[0]!.hotel?.name, "全季酒店(电视塔店)");   // 濠河→全季 0.74km，→诺富特 1.36km
    assert.equal(plan.caveats.length, 0);
  });

  it("**连住优先**：前一天那家仍在阈值内，就不为了近几百米换一家", () => {
    const plan = run(
      [
        { day: 1, area: "x", spots: [{ name: "南通濠河风景名胜区" }] },
        { day: 2, area: "x", spots: [{ name: "南通濠河风景名胜区" }] },
        { day: 3, area: "返程", spots: [] },
      ],
      [{ name: "南通中心雅高诺富特酒店", area: "a" }, { name: "全季酒店(电视塔店)", area: "b" }],
    );
    // 第 1 天挑最近的全季；第 2 天全季仍在阈值内 → 连住，哪怕诺富特也够近
    assert.equal(plan.skeleton[0]!.hotel?.name, "全季酒店(电视塔店)");
    assert.equal(plan.skeleton[1]!.hotel?.name, "全季酒店(电视塔店)");
  });

  it("tour 标了换住宿日（lodging）→ 不再连住，按今天的点重挑", () => {
    const plan = run(
      [
        { day: 1, area: "x", spots: [{ name: "南通濠河风景名胜区" }] },
        { day: 2, area: "y", spots: [{ name: "洲际绿博园" }], lodging: { strategy: "checkin-evening" } },
        { day: 3, area: "返程", spots: [] },
      ],
      [{ name: "全季酒店(电视塔店)", area: "a" }, { name: "南通中心雅高诺富特酒店", area: "b" }],
    );
    assert.equal(plan.skeleton[0]!.hotel?.name, "全季酒店(电视塔店)");
    /*
     * 第 2 天离绿博园：诺富特 8.15 < 全季 10.16，两家都超阈值。
     *
     * **改判了（INC-0155）**：从前这里沿用前一天的全季，理由写的是"连住语义"——
     * 可这条用例的标题就是「不再连住，按今天的点重挑」，而本文件第一条用例
     * 早已确立"两家都超阈值时挑最近的"。同一个文件里两套标准，只因为
     * `prevPick` 在不在。放着不管的后果在真跑里出现过：一份温州的行程沿用了
     * 「青岛八大关锦绣园酒店」，caveat 自己写着离行程点 893 公里。
     * 现在两者都超阈值时比距离，近的赢；caveat 照发，车主仍看得见这天没对上片区。
     */
    assert.equal(plan.skeleton[1]!.hotel?.name, "南通中心雅高诺富特酒店");
    assert.match(plan.caveats.join("\n"), /第2天.*约 8 公里，不在同一片区/);
  });

  it("坐标不全 → 退回老判据（比片区标签），行为不比今天差", () => {
    const plan = mergeItinerary(
      [tour([{ day: 1, area: "濠河一带", spots: [{ name: "没查过的点" }] }, { day: 2, area: "返程", spots: [] }]),
       hotels([{ name: "别处的酒店", area: "狼山" }, { name: "濠河边的酒店", area: "濠河一带" }])],
      INPUT, ["tour", "hotel"], { coordOf: () => undefined },
    ).plan;
    assert.equal(plan.skeleton[0]!.hotel?.name, "濠河边的酒店");
    assert.equal(plan.caveats.length, 0);
  });

  it("不传 opts 的老调用方式仍然可用（测试与离线档）", () => {
    const plan = mergeItinerary(
      [tour([{ day: 1, area: "a", spots: [{ name: "p" }] }, { day: 2, area: "返程", spots: [] }]), hotels([{ name: "h", area: "a" }])],
      INPUT, ["tour", "hotel"],
    ).plan;
    assert.equal(plan.skeleton[0]!.hotel?.name, "h");
  });

  it("**最后一天不挂酒店**——那天回家，不在目的地过夜（体检早就按这条判）", () => {
    const plan = run(
      [
        { day: 1, area: "x", spots: [{ name: "南通濠河风景名胜区" }] },
        { day: 2, area: "x", spots: [{ name: "南通濠河风景名胜区" }] },
      ],
      [{ name: "全季酒店(电视塔店)", area: "a" }],
    );
    assert.ok(plan.skeleton[0]!.hotel, "第 1 天要有");
    assert.equal(plan.skeleton[1]!.hotel, undefined, "最后一天不该有——弹窗上那条「同前一晚」就是这么来的");
  });

  it("单天行程一个酒店都不挂：当天去当天回", () => {
    const plan = run([{ day: 1, area: "x", spots: [{ name: "南通濠河风景名胜区" }] }], [{ name: "全季酒店(电视塔店)", area: "a" }]);
    assert.equal(plan.skeleton[0]!.hotel, undefined);
  });
});
