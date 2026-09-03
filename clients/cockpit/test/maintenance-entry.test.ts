/**
 * 记一笔表单逻辑测试（施工单 M29-03）。
 * [F-23-03][AC-23-3] 校验与网关一致；[F-23-11][AC-23-9] 来源可分辨的展示。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sourceLabel, validateMaintenanceEntry } from "../src/features/ownership/records-logic";

describe("表单校验（与网关同一套规则）[F-23-03][AC-23-3]", () => {
  const ok = { at: Date.UTC(2026, 7, 20), odometerKm: 15_000, items: "机油机滤" };
  it("合法输入通过", () => {
    assert.equal(validateMaintenanceEntry(ok), null);
  });
  it("未来日期拒绝", () => {
    assert.match(validateMaintenanceEntry({ ...ok, at: Date.now() + 86_400_000 })!, /未来/);
  });
  it("越界里程拒绝；负数拒绝", () => {
    assert.ok(validateMaintenanceEntry({ ...ok, odometerKm: 2_000_001 }));
    assert.ok(validateMaintenanceEntry({ ...ok, odometerKm: -1 }));
  });
  it("空 items 拒绝（纯空白同）", () => {
    assert.ok(validateMaintenanceEntry({ ...ok, items: "   " }));
  });
});

describe("来源展示 [F-23-11][AC-23-9]", () => {
  it("受控词表翻译成人话", () => {
    assert.equal(sourceLabel("owner-manual"), "您手动记录的");
    assert.equal(sourceLabel("owner-stated"), "您告诉我的");
    assert.equal(sourceLabel("dealer"), "门店记录");
  });
  it("历史自由文本原样保留——读侧兼容不迁移（M26-04 纪律）", () => {
    assert.equal(sourceLabel("门店"), "门店");
    assert.equal(sourceLabel("模拟（demo:seed）"), "模拟（demo:seed）");
  });
});

describe("VIN 输入校验（M29-04，与网关同一条正则）[F-23-05][AC-23-2]", () => {
  it("合法 17 位通过；小写归一化后通过", async () => {
    const { validateVinInput } = await import("../src/features/ownership/records-logic");
    assert.equal(validateVinInput("LSVAA49P4E2008921"), null);
    assert.equal(validateVinInput("lsvaa49p4e2008921"), null);
  });
  it("长度不对说出当前位数；含 I/O/Q 拒绝；空拒绝", async () => {
    const { validateVinInput } = await import("../src/features/ownership/records-logic");
    assert.match(validateVinInput("LSV123")!, /6 位/);
    assert.ok(validateVinInput("LSVAA49POE2008921"));
    assert.ok(validateVinInput("  "));
  });
});
