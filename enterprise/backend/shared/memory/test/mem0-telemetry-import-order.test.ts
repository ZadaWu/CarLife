/**
 * mem0 遥测缺省关（施工单 M95-04）——求值顺序那一半。
 *
 * 本文件**不得**静态 import `../src/client` 或 `../src/mem0-telemetry`：要验的正是
 * "第一次 import client 时，`./mem0-telemetry` 先于 `mem0ai/oss` 求值并把环境变量设好"。
 * node:test 每个文件独立进程，所以这里的模块缓存是干净的。
 */

import assert from "node:assert/strict";
import { it } from "node:test";

it("import client 之后 process.env.MEM0_TELEMETRY 是 \"false\"（副作用发生在 mem0ai 求值之前）", async () => {
  delete process.env.MEM0_TELEMETRY;
  await import("../src/client");
  assert.equal(process.env.MEM0_TELEMETRY, "false");
});
