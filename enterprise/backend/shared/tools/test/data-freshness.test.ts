/**
 * `data_freshness` 工具（施工单 M26-02，F-53-03）。
 *
 * 本组盯四件"写错了也不报错"的事：
 *  1. **未接入 ≠ 没有数据**——混成一类会让"系统坏了"被说成"你很久没开车了"；
 *  2. **⑥ 未接入不整体失败**——一路缺就整体报错，等于让"没接"表现成"这辆车查不到"；
 *  3. **查不到档案给 `notFound` 而不是空报告**——空报告会被上游当成"三项都新鲜"；
 *  4. **ACL 与 MCP 边界**——它是用户私有数据，多给一个 Agent 不会有任何东西变红。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { TripStore, VehicleProfile, VehicleStore } from "@carlife/memory";

import { dataFreshnessTool, setFreshnessThresholds } from "../src/data-freshness";
import { ToolError } from "../src/external";
import { listExposableForMcp, listForAgent } from "../src/registry";
import { setUsageStore } from "../src/usage-profile";
import { setVehicleStore } from "../src/vehicle-profile";

const DAY = 86_400_000;
const OWNER = "u-m26-02";
const VIN = "LSJA24U91NS654321";

function profile(over: Partial<VehicleProfile> = {}): VehicleProfile {
  return {
    vin: VIN,
    ownerId: OWNER,
    model: "增程 SUV",
    modelYear: 2022,
    purchasedAt: Date.UTC(2022, 2, 1),
    odometerKm: 186_000,
    maintenance: [],
    repairs: [],
    updatedAt: 0,
    ...over,
  };
}

function vehicleStore(p: VehicleProfile | null): VehicleStore {
  return {
    async get(vin) {
      return p && p.vin === vin ? p : null;
    },
    async listByOwner(ownerId) {
      return p && p.ownerId === ownerId ? [p] : [];
    },
    async upsert() {},
    async setDefault() {
      throw new Error("not used");
    },
    async appendMaintenance() {
      throw new Error("not used");
    },
    async appendRepair() {
      throw new Error("not used");
    },
    async advanceOdometer() {
      throw new Error("not used");
    },
  };
}

/** 一条 N 天前的行程流水。 */
const tripStore = (endedDaysAgo: number[]): TripStore => ({
  async append() {},
  async range(userId, from, to) {
    if (userId !== OWNER) return [];
    return endedDaysAgo
      .map((d, i) => ({
        id: `t${i}`,
        userId: OWNER,
        vin: VIN,
        startedAt: Date.now() - d * DAY - 3_600_000,
        endedAt: Date.now() - d * DAY,
        distanceKm: 40,
      }))
      .filter((t) => t.endedAt >= from && t.endedAt <= to) as never;
  },
});

/** `ExternalTool.call` 返回 `{ data, source }` 四件套，这里只要 data。 */
const call = async (args: Record<string, unknown>) =>
  (await dataFreshnessTool.call(args as never, { mode: "real" })).data;
const item = (data: { items: Array<{ item: string }> }, name: string) => {
  const f = data.items.find((i) => i.item === name);
  assert.ok(f, `缺 ${name}`);
  return f as never as { item: string; verdict: string; reason: string; staleDays?: number };
};

beforeEach(() => {
  setVehicleStore(undefined);
  setUsageStore(undefined);
  setFreshnessThresholds(undefined);
});

describe("data_freshness：未接入 ≠ 没有数据", () => {
  it("④ 未注入时报 unconfigured，而不是返回一份「都新鲜」的空报告", async () => {
    await assert.rejects(call({ userId: OWNER }), (e: unknown) => {
      assert.ok(e instanceof ToolError);
      assert.equal(e.category, "unconfigured");
      assert.match(e.message, /未接入/);
      return true;
    });
  });

  it("⑥ 未接入时**不整体失败**：④ 两项照常，⑥ 那项标 unknown 且说清是系统没接", async () => {
    setVehicleStore(vehicleStore(profile({ odometerAt: Date.now() - 97 * DAY })));
    const d = await call({ userId: OWNER });
    assert.equal(item(d, "odometer").verdict, "stale");
    const u = item(d, "usageTrips");
    assert.equal(u.verdict, "unknown");
    assert.match(u.reason, /未接入/);
    assert.match(u.reason, /不是这辆车没有行程/);
    assert.equal(u.staleDays, undefined);
  });

  it("⑥ 接入但一条流水都没有 → stale「还没有任何用车流水」（这是用户状态，不是系统故障）", async () => {
    setVehicleStore(vehicleStore(profile({ odometerAt: Date.now() - 1 * DAY })));
    setUsageStore(tripStore([]));
    const d = await call({ userId: OWNER });
    const u = item(d, "usageTrips");
    assert.equal(u.verdict, "stale");
    assert.match(u.reason, /还没有任何用车流水/);
  });
});

describe("data_freshness：查不到就明确说没有", () => {
  it("VIN 查不到 → notFound + 可执行的下一步，不是空报告", async () => {
    setVehicleStore(vehicleStore(null));
    const d = await call({ userId: OWNER, vin: "LSJA24U91NS000000" });
    assert.equal(d.notFound, true);
    assert.deepEqual(d.items, []);
    assert.deepEqual(d.suggested, []);
    assert.match(d.hint ?? "", /请先建档/);
  });

  it("车主名下一辆车都没有 → 同样 notFound", async () => {
    setVehicleStore(vehicleStore(null));
    const d = await call({ userId: OWNER });
    assert.equal(d.notFound, true);
    assert.equal(d.vin, null);
  });

  it("缺 userId 直接拒——跨用户混算是严重事故", async () => {
    setVehicleStore(vehicleStore(profile()));
    await assert.rejects(call({}), (e: unknown) => {
      assert.ok(e instanceof ToolError);
      assert.equal(e.category, "invalid");
      return true;
    });
  });
});

describe("data_freshness：逐项报告，不是一句「数据不足」", () => {
  beforeEach(() => {
    setVehicleStore(
      vehicleStore(
        profile({
          odometerAt: Date.now() - 97 * DAY,
          maintenance: [
            { at: Date.now() - 30 * DAY, odometerKm: 180_000, items: "小保养", source: "门店" },
          ],
        }),
      ),
    );
    setUsageStore(tripStore([2, 5, 9]));
  });

  it("三项各自给出结论、原因与所用阈值", async () => {
    const d = await call({ userId: OWNER });
    assert.equal(d.vin, VIN);
    assert.equal(item(d, "odometer").verdict, "stale");
    assert.equal(item(d, "lastService").verdict, "fresh");
    assert.equal(item(d, "usageTrips").verdict, "fresh");
    assert.deepEqual(d.suggested, ["odometer"]);
    assert.equal(d.thresholds.odometerDays, 60);
    for (const i of d.items) assert.ok(i.reason.length > 0, "每一项都要说得出原因");
  });

  it("阈值提供者热生效：不重启、不重新注入 store，改一次就变", async () => {
    assert.equal(item(await call({ userId: OWNER }), "odometer").verdict, "stale");
    setFreshnessThresholds(() => ({ odometerDays: 365 }));
    assert.equal(item(await call({ userId: OWNER }), "odometer").verdict, "fresh");
    setFreshnessThresholds(() => ({ odometerDays: 30 }));
    assert.equal(item(await call({ userId: OWNER }), "odometer").verdict, "stale");
  });

  it("阈值提供者抛错时回落保守默认——读不到配置不该让体检整个失败", async () => {
    setFreshnessThresholds(() => {
      throw new Error("配置源挂了");
    });
    const d = await call({ userId: OWNER });
    assert.equal(d.thresholds.odometerDays, 60);
    assert.equal(item(d, "odometer").verdict, "stale");
  });

  it("整份结果过一趟 JSON 之后仍然无歧义（没有会变成 null 的 Infinity）", async () => {
    setUsageStore(tripStore([]));
    const round = JSON.parse(JSON.stringify(await call({ userId: OWNER })));
    const u = round.items.find((i: { item: string }) => i.item === "usageTrips");
    assert.equal(u.verdict, "stale");
    assert.equal("staleDays" in u, false);
  });
});

describe("data_freshness：ACL 与 MCP 边界", () => {
  it("只给 ownership / service / trip 三个消费方", async () => {
    for (const a of ["ownership", "service", "trip"] as const) {
      assert.ok(
        listForAgent(a).some((t) => t.name === "data_freshness"),
        `${a} 应该有`,
      );
    }
    for (const a of ["supervisor", "buying", "cabin", "test-drive"] as const) {
      assert.equal(
        listForAgent(a).some((t) => t.name === "data_freshness"),
        false,
        `${a} 不该有`,
      );
    }
  });

  it("**不对外经 MCP 暴露**——用户私有数据（F-34-09 同档）", () => {
    assert.equal(
      listExposableForMcp().some((t) => t.name === "data_freshness"),
      false,
    );
  });
});

describe("data_freshness：mock 模式逐项混合", () => {
  it("mock 不给全 fresh——全新鲜会让上层永远走不到降级分支", async () => {
    const { data: d, source } = await dataFreshnessTool.call({ userId: OWNER } as never, {
      mode: "mock",
    });
    assert.equal(source.kind, "mock", "四件套要如实标注来源，不冒充真实数据");
    const verdicts = new Set(d.items.map((i) => i.verdict));
    assert.ok(verdicts.has("stale"), "要有 stale");
    assert.ok(verdicts.has("unknown"), "要有 unknown");
    assert.ok(verdicts.has("fresh"), "要有 fresh");
    assert.deepEqual(d.suggested, ["lastService", "odometer"]);
  });
});
