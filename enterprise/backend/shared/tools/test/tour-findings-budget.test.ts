/**
 * [F-13-02] tour 的 findings 卡篇幅（M77 走查追修）。
 *
 * 真跑 turn-ca37586e：一份三天行程的 submit_tour_days 参数 2845 字，findings 占 1324 字（46%）。
 * 其中 226 字把 weather 刚返回的三天六城温度又抄一遍、221 字把 route_audit 的结论又叙述一遍——
 * 而这些编排层本来就有：drive 的 findings 里是 map_route 实查的「177.4km / 124 分钟 / 78 元」，
 * 比 tour 写的「直线约 163–173km」还准。tour 那 8.4 秒生成里有三四秒花在这上面。
 *
 * 天气是例外：只有 tour 查，行程快照的 weather 字段是 HUD 用的、注释写明「不来自行程」，
 * narrator 拿到的天气只来自 findings。所以不是不许写，是压成一句影响。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeForPi, getTool } from "../src/registry";

const schema = () => getTool("submit_tour_days")!.schema;
const base = { days: [{ day: 1, theme: "a", spots: [{ name: "濠河" }] }] };

describe("[F-13-02] findings 最多三条", () => {
  it("三条通过，四条当场打回——模型在场时就能自己收敛", () => {
    assert.ok(schema().safeParse({ ...base, findings: ["a", "b", "c"] }).success);
    assert.equal(schema().safeParse({ ...base, findings: ["a", "b", "c", "d"] }).success, false);
  });

  it("不填照旧可以（没什么取舍要说时不必硬凑）", () => {
    assert.ok(schema().safeParse(base).success);
    assert.ok(schema().safeParse({ ...base, findings: [] }).success);
  });

  it("发给 pi 的 schema 里带着上限与「只写判断」的说明——模型看得到才管得住", () => {
    const d = describeForPi("tour").find((t) => t.name === "submit_tour_days")!;
    const f = (d.parameters as any).properties.findings;
    const arr = f.anyOf ? f.anyOf[0] : f;   // 可选字段被包成「原类型 或 null」
    assert.equal(arr.maxItems, 3, JSON.stringify(f).slice(0, 160));
    assert.match(arr.description, /只写/);
    assert.match(arr.description, /里程|路况|车次|房价/);
  });

  it("提示词与 schema 说的是同一件事（两处漂了模型只会听其中一处）", async () => {
    const { loadAgentPrompt } = await import("../../../agent-runtime/src/acp-client/agent-prompt");
    const p = loadAgentPrompt("tour");
    assert.match(p, /最多三条/);
    assert.match(p, /不要写/);
  });
});
