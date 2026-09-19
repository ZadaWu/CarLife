/**
 * 系统变更事件（施工单 M82-01）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { deriveSystemEvents } from "../src/system-events";

const T0 = 1_757_000_000_000;

test("一条 ASR_ENGINE 变更 → 一条 config-change，summary 含新旧值", () => {
  const [ev] = deriveSystemEvents({
    configRevisions: [
      { id: "rev1", key: "ASR_ENGINE", at: T0, oldValue: "ark", newValue: "aliyun", secret: false },
    ],
  });
  assert.equal(ev.kind, "config-change");
  assert.equal(ev.key, "ASR_ENGINE");
  assert.match(ev.summary, /ark/);
  assert.match(ev.summary, /aliyun/);
  assert.equal(ev.sourceRef, "config_item_revisions:rev1");
});

test("密钥类只写「变更过」，值一个字符都不出现", () => {
  const [ev] = deriveSystemEvents({
    configRevisions: [
      { id: "rev2", key: "DEEPSEEK_API_KEY", at: T0, oldValue: "sk-old", newValue: "sk-secret-新值", secret: true },
    ],
  });
  assert.equal(ev.summary, "DEEPSEEK_API_KEY 变更过");
  assert.ok(!ev.summary.includes("sk-"));
});

test("「没记」与「是空串」分开——后者在「空 = 关闭」的配置项上是完全不同的事实", () => {
  const [notRecorded] = deriveSystemEvents({
    configRevisions: [{ id: "r", key: "MOCK_TTS_URL", at: T0, oldValue: null, newValue: "http://x", secret: false }],
  });
  assert.match(notRecorded.summary, /（未记录）/);

  const [emptyString] = deriveSystemEvents({
    configRevisions: [{ id: "r", key: "RESEARCH_RUNTIME_URL", at: T0, oldValue: "", newValue: "http://x", secret: false }],
  });
  assert.match(emptyString.summary, /（空）/);
  assert.ok(!emptyString.summary.includes("未记录"));
});

test("过长的值被截断——tooltip 不是日志", () => {
  const long = "x".repeat(200);
  const [ev] = deriveSystemEvents({
    configRevisions: [{ id: "r", key: "K", at: T0, oldValue: null, newValue: long, secret: false }],
  });
  assert.ok(ev.summary.length < 120);
  assert.match(ev.summary, /…/);
});

test("四类来源各成一类事件", () => {
  const evs = deriveSystemEvents({
    configRevisions: [{ id: "c", key: "K", at: T0 + 3, oldValue: "a", newValue: "b", secret: false }],
    guardRevisions: [{ id: "g", key: "hard_ban", at: T0 + 2, summary: "新增一条硬禁" }],
    kbSyncRuns: [{ id: "j", job: "kb-sync", at: T0 + 1, dataset: "repair-kb", ok: true }],
    deployMarks: [{ id: "d", at: T0, summary: "上线 M82-01" }],
    codebookLocks: [{ version: "v0.1", at: T0 + 4 }],
  });
  assert.deepEqual(evs.map((e) => e.kind), [
    "deploy",
    "kb-sync",
    "guard-policy-change",
    "config-change",
    "codebook-lock",
  ]);
});

test("同刻事件按 sourceRef 稳定排序——两次生成的快照要逐字节相同", () => {
  const input = {
    deployMarks: [
      { id: "b", at: T0, summary: "B" },
      { id: "a", at: T0, summary: "A" },
    ],
  };
  const first = deriveSystemEvents(input).map((e) => e.sourceRef);
  const second = deriveSystemEvents(input).map((e) => e.sourceRef);
  assert.deepEqual(first, second);
  assert.deepEqual(first, ["deploy_mark:a", "deploy_mark:b"]);
});

test("什么都不给就是空数组，不抛", () => {
  assert.deepEqual(deriveSystemEvents({}), []);
});
