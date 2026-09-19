/**
 * 来源护照（施工单 M82-01）。
 *
 * 这里的集合相等断言是刻意的：新增一张来源表必须同时改常量与本测试，
 * 也就是必须经过一次"这张表能不能采"的显式判断。让测试跟着常量自动走
 * （遍历 SOURCE_PASSPORTS 断言它自己）等于没测。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  SOURCE_PASSPORTS,
  canCollect,
  canDisplay,
  displayModeOf,
  isAggregateOnly,
  isSimulated,
  passportOf,
} from "../src/passport";

/** M82-00 现状表列出的来源 + analysis.md §2 的三类不可采来源。 */
const EXPECTED_IDS = [
  "messages",
  "message_audio",
  "trips",
  "refuel_records",
  "maintenance_records",
  "repair_records",
  "trace_events",
  "guard_audit_logs",
  "vehicle_reminders",
  "devices",
  "config_item_revisions",
  "guard_setting_revisions",
  "job_runs",
  "user_flags",
  "elicitation_cooldowns",
  "mem0",
  "llm_usage",
  "audit_logs",
  "mocks.dealer",
  "mocks.repair",
  "mocks.insurance",
  "mocks.cabin",
];

test("护照覆盖的来源集合与总览声明一致", () => {
  assert.deepEqual([...SOURCE_PASSPORTS.map((p) => p.id)].sort(), [...EXPECTED_IDS].sort());
});

test("id 不重复——重复会让 passportOf 静默取到后一条", () => {
  assert.equal(new Set(SOURCE_PASSPORTS.map((p) => p.id)).size, SOURCE_PASSPORTS.length);
});

test("四个假第三方恒 collect = no 且标 simulated", () => {
  for (const id of ["mocks.dealer", "mocks.repair", "mocks.insurance", "mocks.cabin"]) {
    assert.equal(canCollect(id), false, id);
    assert.equal(isSimulated(id), true, id);
    assert.equal(passportOf(id)?.provenance, "simulated", id);
  }
});

test("messages 可采；未登记的来源默认不可采", () => {
  assert.equal(canCollect("messages"), true);
  assert.equal(passportOf("something_new"), null);
  assert.equal(canCollect("something_new"), false);
  assert.equal(displayModeOf("something_new"), "no");
});

test("elicitation_cooldowns 只能聚合、逐条不可显示（架构文档 §4.6 约束 4）", () => {
  assert.equal(isAggregateOnly("elicitation_cooldowns"), true);
  assert.equal(displayModeOf("elicitation_cooldowns"), "no");
  assert.equal(canDisplay("elicitation_cooldowns"), false);
});

test("message_audio 的显示档位是 replay-audited：能放，但每次记审计", () => {
  assert.equal(displayModeOf("message_audio"), "replay-audited");
  assert.equal(canDisplay("message_audio"), true);
  // 波形本体不进研究表——研究面只存引用。
  assert.equal(passportOf("message_audio")?.store, "no");
});

test("Mem0 是派生物不是证据层", () => {
  assert.equal(canCollect("mem0"), false);
  assert.equal(passportOf("mem0")?.analyze, "no");
});

test("没有任何来源允许 share——研究结论不出研究面", () => {
  for (const p of SOURCE_PASSPORTS) assert.equal(p.share, "no", p.id);
});
