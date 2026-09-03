/**
 * 能量读数的端上映射（M27；M65-01 随源码从 cockpit 搬到 @carlife/ui，用例同名同断言）。
 *
 * 这一层只有一件事值得测，但那件事很贵：**什么时候不许显示数字**。
 * 车机离线、未绑定、未接入，屏幕上都必须是"读不到"——显示成 0% 会让车主
 * 掉头去找充电桩，而车其实是满的。反过来也一样：真的 0% 不能被说成读不到。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { startEnergyPolling, toLiveEnergy } from "../src/hud/energy-source";

describe("能量读数映射", () => {
  it("bound + battery → 电量；充电中要传下去", () => {
    const r = toLiveEnergy({ state: "bound", energyType: "bev", battery: { percent: 63, rangeKm: 285, charging: true } });
    assert.deepEqual(r, { kind: "battery", percent: 63, rangeKm: 285, charging: true });
  });

  it("bound + fuel → 油量（燃油车不得报电量）", () => {
    const r = toLiveEnergy({ state: "bound", energyType: "icev", fuel: { percent: 48, rangeKm: 322 } });
    assert.deepEqual(r, { kind: "fuel", percent: 48, rangeKm: 322 });
  });

  it("插混两样都有时取电量——日常以电驱为主，且电先见底", () => {
    const r = toLiveEnergy({
      state: "bound",
      energyType: "phev",
      battery: { percent: 30, rangeKm: 90, charging: false },
      fuel: { percent: 70, rangeKm: 400 },
    });
    assert.equal(r.kind, "battery");
  });

  for (const state of ["offline", "unbound", "unconfigured"] as const) {
    it(`${state} → 读不到，且**不带任何数字**`, () => {
      const r = toLiveEnergy({ state, reason: "测试原因" });
      assert.equal(r.kind, "unavailable");
      assert.equal(r.reason, "测试原因");
      // 这条断言是本文件的重点：0% 与"读不到"在屏幕上必须分得开
      assert.equal("percent" in r, false, "读不到的时候给出百分比，等于把故障说成快没电了");
    });
  }

  it("bound 却两样都没有：不替车机选一个", () => {
    assert.equal(toLiveEnergy({ state: "bound", energyType: "bev" }).kind, "unavailable");
  });

  it("没有选中车辆时不轮询，也不报「读不到」", () => {
    const seen: unknown[] = [];
    let fetched = 0;
    const p = startEnergyPolling(null, (e) => seen.push(e), {
      fetchEnergyJson: async () => {
        fetched += 1;
        return "{}";
      },
    });
    p.stop();
    assert.deepEqual(seen, [undefined], "还没建档不是故障，不该显示读不到");
    assert.equal(fetched, 0);
  });

  it("拉取抛错也切读不到——不沿用上一次的数字（电量是快变量）", async () => {
    const seen: Array<{ kind: string }> = [];
    let call = 0;
    const p = startEnergyPolling(
      "VIN1",
      (e) => e && seen.push(e),
      {
        intervalMs: 5,
        fetchEnergyJson: async () => {
          call += 1;
          if (call === 1) {
            return JSON.stringify({ state: "bound", battery: { percent: 63, rangeKm: 285, charging: false } });
          }
          throw new Error("网关不可达");
        },
      },
    );
    await new Promise((r) => setTimeout(r, 40));
    p.stop();
    assert.equal(seen[0]?.kind, "battery");
    assert.ok(
      seen.some((e) => e.kind === "unavailable"),
      "断了之后必须切到读不到，而不是把 63% 一直挂着",
    );
  });
});
