/**
 * `vehicle_member` 工具与 PII 边界（施工单 M17-03，F-46-09/13/14）。
 *
 * 两条**负向**断言是本组的重点：返回体里没有可用来打分的字段、
 * 轨迹与错误消息里没有称呼。它们守的是提示词守不住的那部分。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { MemberStore, TripStore, VehicleMember } from "@carlife/memory";

import { getTool, listExposableForMcp, listForAgent } from "../src/registry";
import { setMemberStores, vehicleMemberTool } from "../src/vehicle-member";
import { ToolError } from "../src/external";

const NOW = Date.UTC(2026, 7, 12, 12);
const DAY = 86_400_000;
const OWNER = "u-1";
const VIN = "LSJA24U91NS888888";

const MOM: VehicleMember = {
  id: "m-mom",
  vin: VIN,
  ownerId: OWNER,
  displayName: "妈妈",
  relation: "母亲",
  roles: ["passenger"],
  ageBand: "senior",
  needs: ["motion_sickness", "restroom"],
  updatedAt: 0,
};
const WIFE: VehicleMember = {
  id: "m-wife",
  vin: VIN,
  ownerId: OWNER,
  displayName: "老婆",
  roles: ["driver"],
  needs: [],
  updatedAt: 0,
};

function stores(tripRows: Array<Record<string, unknown>> = []) {
  const members: MemberStore = {
    async listByVehicle(ownerId, vin) {
      return ownerId === OWNER && vin === VIN ? [MOM, WIFE] : [];
    },
    async listByOwner(ownerId) {
      return ownerId === OWNER ? [MOM, WIFE] : [];
    },
    async get(ownerId, id) {
      return ownerId === OWNER ? ([MOM, WIFE].find((m) => m.id === id) ?? null) : null;
    },
    async upsert() {
      throw new Error("not used");
    },
    async remove() {
      return null;
    },
  };
  const trips: TripStore = {
    async append() {},
    async range(userId, from, to, vin, member) {
      return tripRows.filter(
        (r) =>
          r.userId === userId &&
          (r.endedAt as number) >= from &&
          (r.endedAt as number) <= to &&
          (!vin || r.vin === vin) &&
          (!member?.driverMemberId || r.driverMemberId === member.driverMemberId) &&
          (!member?.passengerMemberId ||
            ((r.passengerMemberIds as string[]) ?? []).includes(member.passengerMemberId)),
      ) as never;
    },
  };
  return { members, trips };
}

const ride = (i: number, who: "driver" | "passenger", id: string) => ({
  id: `t${i}`,
  userId: OWNER,
  vin: VIN,
  startedAt: NOW - (i + 1) * DAY - 3_600_000,
  endedAt: NOW - (i + 1) * DAY,
  distanceKm: 30,
  roadType: "city",
  ...(who === "driver" ? { driverMemberId: id } : { passengerMemberIds: [id] }),
});

const call = (args: Record<string, unknown>) =>
  vehicleMemberTool.call(args as never, { mode: "real" });

describe("vehicle_member：未接入 ≠ 没数据", () => {
  beforeEach(() => setMemberStores(undefined, undefined, () => NOW));

  it("未注入 store 时报 unconfigured，而不是返回空名单", async () => {
    await assert.rejects(call({ userId: OWNER, action: "list" }), (e: unknown) => {
      assert.ok(e instanceof ToolError);
      assert.equal(e.category, "unconfigured");
      return true;
    });
  });
});

describe("vehicle_member：list", () => {
  beforeEach(() => {
    const s = stores();
    setMemberStores(s.members, s.trips, () => NOW);
  });

  it("needs 同时给 key 与中文标签", async () => {
    const r = await call({ userId: OWNER, action: "list", vin: VIN });
    const mom = (r.data as { members: Array<Record<string, unknown>> }).members[0];
    assert.deepEqual(mom.needs, ["motion_sickness", "restroom"]);
    assert.deepEqual(mom.needLabels, ["晕车", "需卫生间"]);
    assert.deepEqual(mom.roleLabels, ["常乘"]);
  });

  it("跨用户读不到（store 侧的归属由 M17-01 守，工具不绕过它）", async () => {
    const r = await call({ userId: "someone-else", action: "list", vin: VIN });
    assert.deepEqual((r.data as { members: unknown[] }).members, []);
  });
});

describe("vehicle_member：profile —— 不足只给理由", () => {
  it("样本 2 条 → usable:false，理由带条数，且**没有任何数字字段**", async () => {
    const s = stores([ride(0, "driver", WIFE.id), ride(1, "driver", WIFE.id)]);
    setMemberStores(s.members, s.trips, () => NOW);
    const r = await call({ userId: OWNER, action: "profile", memberId: WIFE.id });
    const d = r.data as Record<string, unknown>;
    assert.equal(d.usable, false);
    assert.match(String(d.reason), /2 条/);
    assert.equal("facts" in d && d.facts !== undefined, false, "不可用时一个数字都不给");
  });

  it("名单里没有这个人 → 明说，不给一份默认画像", async () => {
    const s = stores();
    setMemberStores(s.members, s.trips, () => NOW);
    const r = await call({ userId: OWNER, action: "profile", memberId: "m-ghost" });
    const d = r.data as Record<string, unknown>;
    assert.equal(d.usable, false);
    assert.match(String(d.reason), /没有这个人/);
  });

  it("乘车人给同行次数，**不给日均里程**", async () => {
    const s = stores(Array.from({ length: 6 }, (_, i) => ride(i, "passenger", MOM.id)));
    setMemberStores(s.members, s.trips, () => NOW);
    const r = await call({ userId: OWNER, action: "profile", memberId: MOM.id });
    const d = r.data as { usable: boolean; facts: Record<string, unknown> };
    assert.equal(d.usable, true);
    assert.equal(d.facts.ridesAlong, 6);
    assert.equal("avgDailyKm" in d.facts, false);
  });

  it("回落到整车口径时 scope=vehicle（调用方据此说明这是整车数据）", async () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `w${i}`,
        userId: OWNER,
        vin: VIN,
        startedAt: NOW - (i + 1) * DAY,
        endedAt: NOW - (i + 1) * DAY,
        distanceKm: 20,
      })),
      ride(0, "driver", WIFE.id),
    ];
    const s = stores(rows);
    setMemberStores(s.members, s.trips, () => NOW);
    const r = await call({ userId: OWNER, action: "profile", memberId: WIFE.id });
    assert.equal((r.data as { scope: string }).scope, "vehicle");
  });
});

describe("vehicle_member：history —— 没有就说没有", () => {
  it("无关联记录返回 found:false 与理由，而不是空数组", async () => {
    const s = stores();
    setMemberStores(s.members, s.trips, () => NOW);
    const r = await call({ userId: OWNER, action: "history", memberId: MOM.id });
    const d = r.data as Record<string, unknown>;
    assert.equal(d.found, false);
    assert.match(String(d.reason), /没有.*记录/);
  });

  it("有记录时按时间倒序，并标出是开的还是坐的", async () => {
    const s = stores([ride(0, "driver", WIFE.id), ride(3, "passenger", WIFE.id)]);
    setMemberStores(s.members, s.trips, () => NOW);
    const r = await call({ userId: OWNER, action: "history", memberId: WIFE.id });
    const d = r.data as { found: boolean; trips: Array<{ at: number; as: string }> };
    assert.equal(d.found, true);
    assert.equal(d.trips.length, 2);
    assert.ok(d.trips[0].at > d.trips[1].at);
    assert.deepEqual(
      d.trips.map((t) => t.as),
      ["driver", "passenger"],
    );
  });
});

describe("vehicle_member：负向 —— 不打分、不漏称呼", () => {
  it("任何返回体的键集合里都没有评分类字段", async () => {
    const s = stores(Array.from({ length: 6 }, (_, i) => ride(i, "driver", WIFE.id)));
    setMemberStores(s.members, s.trips, () => NOW);
    for (const action of ["list", "profile", "history"] as const) {
      const r = await call({ userId: OWNER, action, vin: VIN, memberId: WIFE.id });
      const keys = JSON.stringify(r.data).match(/"[a-zA-Z_]+":/g) ?? [];
      assert.equal(
        keys.some((k) => /score|rating|grade|level|risk/i.test(k)),
        false,
        `${action} 的返回体里出现了可用来打分的字段：${keys.join(",")}`,
      );
    }
  });

  it("traceSummary 只有动作与成员 id 前缀，没有称呼", () => {
    const reg = getTool("vehicle_member");
    assert.ok(reg?.traceSummary);
    const line = reg.traceSummary({ action: "profile", memberId: "m-wife-1234567890" } as never);
    assert.match(line, /profile/);
    assert.match(line, /member=m-wife-1/);
    assert.equal(line.includes("老婆"), false);
    assert.equal(line.includes("妈妈"), false);
  });

  it("错误消息用 id 不用称呼", async () => {
    const s = stores();
    setMemberStores(s.members, s.trips, () => NOW);
    await assert.rejects(call({ userId: OWNER, action: "profile" }), (e: unknown) => {
      assert.ok(e instanceof ToolError);
      assert.equal(e.message.includes("妈妈"), false);
      assert.match(e.message, /memberId/);
      return true;
    });
  });
});

describe("vehicle_member：ACL 与 MCP", () => {
  it("ownership / trip / cabin 有它，buying / service 没有", () => {
    for (const agent of ["ownership", "trip", "cabin"] as const) {
      assert.ok(
        listForAgent(agent).some((t) => t.name === "vehicle_member"),
        `${agent} 应当能用 vehicle_member`,
      );
    }
    for (const agent of ["buying", "service"] as const) {
      assert.equal(
        listForAgent(agent).some((t) => t.name === "vehicle_member"),
        false,
        `${agent} 不该拿到他人 PII`,
      );
    }
  });

  it("不经 MCP 对外暴露（声明与筛选规则两处一致）", () => {
    assert.equal(getTool("vehicle_member")?.mcpExposable, false);
    assert.equal(
      listExposableForMcp().some((t) => t.name === "vehicle_member"),
      false,
    );
  });

  it("是只读工具，不进权限门", () => {
    assert.equal(getTool("vehicle_member")?.sensitive, false);
  });
});
