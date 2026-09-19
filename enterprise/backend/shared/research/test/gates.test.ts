/**
 * 四道硬门（施工单 M82-01）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { anyGateFailed, evaluateGates, levelCeilingOf, type GateInput } from "../src/gates";

const ok = (over: Partial<GateInput> = {}): GateInput => ({
  sourceIds: ["messages", "trips"],
  population: { owners: 62, vehicles: 61, turns: 1204 },
  denominatorVisible: true,
  counterEvidenceSearched: true,
  codebookLocked: true,
  agreement: 0.78,
  importanceBasis: "mention",
  axes: ["need", "pain", "scene", "emotion"],
  undeliverable: false,
  ...over,
});

test("四项齐备时全 pass，等级天花板到 validated", () => {
  const g = evaluateGates(ok());
  assert.equal(g.rights.status, "pass");
  assert.equal(g.evidence.status, "pass");
  assert.equal(g.measurement.status, "pass");
  assert.equal(g.safety.status, "pass");
  assert.equal(anyGateFailed(g), false);
  assert.equal(levelCeilingOf(g), "validated");
});

test("观察总体 5 台车 → evidence 降级（不是 fail：n/N 仍然是真的）", () => {
  const g = evaluateGates(ok({ population: { owners: 5, vehicles: 5, turns: 40 } }));
  assert.equal(g.evidence.status, "degraded");
  assert.match(g.evidence.reason, /5 台车/);
  assert.equal(anyGateFailed(g), false);
  assert.equal(levelCeilingOf(g), "candidate");
});

test("分母不可显示 → evidence fail：没有分母的 n 无法解读", () => {
  assert.equal(evaluateGates(ok({ denominatorVisible: false })).evidence.status, "fail");
});

test("反例没检索过只降级——有证据，只是只找了支持的那一半", () => {
  assert.equal(evaluateGates(ok({ counterEvidenceSearched: false })).evidence.status, "degraded");
});

test("codebook 未锁 → measurement fail", () => {
  const g = evaluateGates(ok({ codebookLocked: false }));
  assert.equal(g.measurement.status, "fail");
  assert.equal(levelCeilingOf(g), "signal");
});

test("一致率低于 0.7 → measurement fail；未测也 fail", () => {
  assert.equal(evaluateGates(ok({ agreement: 0.69 })).measurement.status, "fail");
  assert.equal(evaluateGates(ok({ agreement: null })).measurement.status, "fail");
  assert.equal(evaluateGates(ok({ agreement: 0.7 })).measurement.status, "pass");
});

test("重要度口径未声明 → measurement 降级（象限图退化为散点）", () => {
  const g = evaluateGates(ok({ importanceBasis: null }));
  assert.equal(g.measurement.status, "degraded");
  assert.match(g.measurement.reason, /散点/);
});

test("codebook 含 health 轴 → safety fail", () => {
  const g = evaluateGates(ok({ axes: ["need", "health"] }));
  assert.equal(g.safety.status, "fail");
  assert.match(g.safety.reason, /health/);
});

test("阶层与性格推断同样 fail，大小写不敏感", () => {
  assert.equal(evaluateGates(ok({ axes: ["Class"] })).safety.status, "fail");
  assert.equal(evaluateGates(ok({ axes: ["personality"] })).safety.status, "fail");
});

test("硬禁范畴是 degraded 不是 fail——需求是真的，只是永远不能满足", () => {
  const g = evaluateGates(ok({ undeliverable: true }));
  assert.equal(g.safety.status, "degraded");
  assert.match(g.safety.reason, /不可交付/);
  // 判 fail 会让它从图上消失，而消失的表现就是半年后有人再提一次。
  assert.equal(anyGateFailed(g), false);
});

test("来源含 mock → rights fail", () => {
  const g = evaluateGates(ok({ sourceIds: ["messages", "mocks.dealer"] }));
  assert.equal(g.rights.status, "fail");
  assert.match(g.rights.reason, /mocks\.dealer/);
});

test("来源未登记护照 → rights fail（默认拒绝）", () => {
  assert.equal(evaluateGates(ok({ sourceIds: ["brand_new_table"] })).rights.status, "fail");
});

test("collect ≠ yes 的已登记来源同样 fail（llm_usage 不是需求证据）", () => {
  const g = evaluateGates(ok({ sourceIds: ["messages", "llm_usage"] }));
  assert.equal(g.rights.status, "fail");
  assert.match(g.rights.reason, /collect/);
});
