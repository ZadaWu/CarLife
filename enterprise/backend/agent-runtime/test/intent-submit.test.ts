/**
 * [F-11-01] 意图四要素先认提交槽（ACR-047，`submit_intent`）；没有提交才退回正文里的裸 JSON。
 *
 * 白名单与取值校验两条来源共用一份（`parseIntentObject`）——表外的 route 在提交槽里同样进不来。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildIntentInstruction, parseIntent, parseIntentFrom } from "../src/graph/intent";

describe("[F-11-01] parseIntentFrom：提交槽优先", () => {
  it("有提交就用提交，正文里的 JSON 不看", () => {
    const i = parseIntentFrom({ goal: "订一份上海到黄山的五日行程", route: "itinerary", destinations: ["黄山"], tripLimits: { days: 5 } }, '{"goal":"正文里的另一句","route":"cabin"}', "原话");
    assert.equal(i.goal, "订一份上海到黄山的五日行程");
    assert.equal(i.route, "itinerary");
    assert.deepEqual(i.destinations, ["黄山"]);
    assert.deepEqual(i.tripLimits, { days: 5 });
    assert.equal(i.degraded, undefined);
  });

  it("没有提交（undefined / 非对象）→ 退回正文；正文也没有 → 降级", () => {
    const fromText = parseIntentFrom(undefined, '{"goal":"去黄山","route":"itinerary"}', "原话");
    assert.equal(fromText.goal, "去黄山");
    const degraded = parseIntentFrom("not-an-object", "只有寒暄", "原话");
    assert.equal(degraded.goal, "原话");
    assert.equal(degraded.degraded, true);
  });

  it("提交槽里表外的 route / action 同样当没给——两条来源同一份白名单", () => {
    const i = parseIntentFrom({ goal: "x", route: "flying-car", action: "落库" }, "", "原话");
    assert.equal(i.route, undefined);
    assert.equal(i.action, undefined);
    assert.deepEqual(parseIntent('{"goal":"x","route":"flying-car"}', "原话").route, undefined);
  });

  it("意图指令点名 submit_intent，并给没有工具的离线桩留了裸 JSON 那条路", () => {
    const text = buildIntentInstruction(undefined, false);
    assert.match(text, /工具表里有 `submit_intent` 就必须调用它/);
    assert.match(text, /把 JSON 写在正文里不算交/);
    assert.match(text, /没有这个工具时（离线桩）才直接输出那个 JSON 对象/);
  });
});
