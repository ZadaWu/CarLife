/**
 * ④车辆档案与保养推算单测（施工单 M7-04）。零依赖、不连库。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_INTERVAL_KM,
  forecastMaintenance,
  isValidVin,
  usableRate,
} from "../src/vehicle-store";

const day = (n: number) => Date.UTC(2026, 0, n);

describe("VIN 校验", () => {
  it("17 位合法 VIN 通过", () => {
    assert.equal(isValidVin("LSVAA49P4E2123456"), true);
  });

  it("含 I/O/Q 的不通过——它们与 1/0 易混，标准里就排除了", () => {
    assert.equal(isValidVin("LSVAA49P4E2I23456"), false);
    assert.equal(isValidVin("LSVAA49P4E2O23456"), false);
  });

  it("长度不对不通过（把手输错的挡在门外）", () => {
    assert.equal(isValidVin("LSVAA49P4E212345"), false);
  });
});

describe("保养推算（F-17-01）", () => {
  it("结合⑥日均里程给出到期天数——**只用④就是按固定里程提醒**", () => {
    const f = forecastMaintenance(
      {
        odometerKm: 18_000,
        maintenanceIntervalKm: 10_000,
        maintenance: [{ at: day(1), odometerKm: 10_000, items: "常规", source: "4S" }],
      },
      { rate: usableRate(40, true) },
    );
    assert.equal(f.remainingKm, 2_000);
    assert.ok(Math.abs((f.etaDays ?? 0) - 50) < 1e-9);
    assert.equal(f.degraded, false);
  });

  it("同样的车、不同日均里程 → 到期时间差一个量级（这正是要结合⑥的理由）", () => {
    const base = {
      odometerKm: 18_000,
      maintenanceIntervalKm: 10_000,
      maintenance: [{ at: day(1), odometerKm: 10_000, items: "常规", source: "4S" }],
    };
    const heavy = forecastMaintenance(base, { rate: usableRate(165, true) }); // 高鹏：6 万公里/年
    const light = forecastMaintenance(base, { rate: usableRate(41, true) }); // 陈书雅：1.5 万公里/年
    assert.ok((light.etaDays ?? 0) > (heavy.etaDays ?? 0) * 3);
  });

  it("**日均里程未知时不给到期估计**，且依据里写明", () => {
    const f = forecastMaintenance({
      odometerKm: 18_000,
      maintenanceIntervalKm: 10_000,
      maintenance: [{ at: day(1), odometerKm: 10_000, items: "常规", source: "4S" }],
    });
    assert.equal(f.etaDays, undefined);
    assert.ok(f.basis.some((b) => b.includes("不给到期时间估计")));
  });

  it("无保养记录 / 无周期 → 降级并标注是通用值（F-17-09）", () => {
    const f = forecastMaintenance({ odometerKm: 5_000, maintenance: [] }, { rate: usableRate(40, true) });
    assert.equal(f.degraded, true);
    assert.ok(f.basis.some((b) => b.includes("通用参考")));
    assert.ok(f.basis.some((b) => b.includes("没有上次保养记录")));
  });

  it("已超期时 remainingKm 为负——不把它夹到 0 掩盖问题", () => {
    const f = forecastMaintenance(
      {
        odometerKm: 21_000,
        maintenanceIntervalKm: 10_000,
        maintenance: [{ at: day(1), odometerKm: 10_000, items: "常规", source: "4S" }],
      },
      { rate: usableRate(40, true) },
    );
    assert.ok(f.remainingKm < 0, "超期要能看出来");
  });

  it("推算依据随结果交付——用户会问这个数怎么来的", () => {
    const f = forecastMaintenance({ odometerKm: 1, maintenance: [] });
    assert.ok(f.basis.length >= 3);
  });

  it("默认周期是显式常量，不是散落的魔法数", () => {
    assert.equal(DEFAULT_INTERVAL_KM, 10_000);
  });
});
