/**
 * mem0 遥测缺省关（施工单 M95-04）——纯函数那一半。
 * "import client 之后环境变量已设好"那条在 `mem0-telemetry-import-order.test.ts`：它不能与本文件
 * 同进程，因为这里静态 import 了 `../src/mem0-telemetry`，副作用已经跑过、模块已缓存。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyMem0TelemetryDefault } from "../src/mem0-telemetry";

describe("applyMem0TelemetryDefault（M95-04）", () => {
  it("未设 → 补成 \"false\"", () => {
    const env: { MEM0_TELEMETRY?: string } = {};
    assert.equal(applyMem0TelemetryDefault(env), "false");
    assert.equal(env.MEM0_TELEMETRY, "false");
  });

  it("已设（哪怕是 true）→ 原样保留，只补缺省不强制", () => {
    const env = { MEM0_TELEMETRY: "true" };
    assert.equal(applyMem0TelemetryDefault(env), "true");
    assert.equal(env.MEM0_TELEMETRY, "true");
  });
});
