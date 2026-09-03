/**
 * 按人聚合、按人检索与级联删除（施工单 M17-02，F-46-05~08、F-46-12）。
 *
 * 这一组用内存版 `TripStore` 替身——它测的是**口径与降级语义**，
 * 不是存储对不对（后者在 `enterprise/backend/shared/db/test/vehicle-member.test.ts` 与真库测试里）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  aggregateCompanion,
  assessCompanionUsability,
  MAX_STALE_DAYS,
  MIN_SAMPLE,
} from "../src/usage-telemetry/summary";
import {
  ingestTrip,
  validateTrip,
  TripValidationError,
  type StoredTrip,
  type TripInput,
  type TripMemberFilter,
  type TripStore,
} from "../src/usage-telemetry/ingest";
import {
  loadCompanionProfile,
  loadMemberUsageProfile,
  memberProfileFallback,
} from "../src/usage-telemetry/query";
import { removeMemberCascade, type MemberProfilePurger } from "../src/member-cascade";
import type { MemberStore, VehicleMember } from "../src/member-store";

const NOW = Date.UTC(2026, 7, 12, 12);
const DAY = 86_400_000;
const VIN = "LSJA24U91NS777777";
const OWNER = "u-owner";

function memoryStore(seed: Array<TripInput & { id: string }> = []): TripStore & {
  rows: Array<TripInput & { id: string }>;
} {
  const rows = [...seed];
  return {
    rows,
    async append(t) {
      const i = rows.findIndex((r) => r.id === t.id);
      if (i >= 0) rows[i] = t;
      else rows.push(t);
    },
    async range(userId, fromMs, toMs, vin?: string, member?: TripMemberFilter) {
      return rows.filter(
        (r) =>
          r.userId === userId &&
          r.endedAt >= fromMs &&
          r.endedAt <= toMs &&
          (!vin || r.vin === vin) &&
          (!member?.driverMemberId || r.driverMemberId === member.driverMemberId) &&
          (!member?.passengerMemberId ||
            (r.passengerMemberIds ?? []).includes(member.passengerMemberId)),
      ) as StoredTrip[];
    },
    async clearMemberAttribution(ownerId, memberId) {
      let n = 0;
      for (const r of rows) {
        if (r.userId !== ownerId) continue;
        if (r.driverMemberId === memberId) {
          r.driverMemberId = undefined;
          n += 1;
        } else if ((r.passengerMemberIds ?? []).includes(memberId)) {
          r.passengerMemberIds = (r.passengerMemberIds ?? []).filter((x) => x !== memberId);
          n += 1;
        }
      }
      return n;
    },
  };
}

function trip(id: string, daysAgo: number, extra: Partial<TripInput> = {}): TripInput & { id: string } {
  const endedAt = NOW - daysAgo * DAY;
  return {
    id,
    userId: OWNER,
    vin: VIN,
    startedAt: endedAt - 3_600_000,
    endedAt,
    distanceKm: 30,
    roadType: "city",
    ...extra,
  };
}

function memberStore(list: VehicleMember[]): MemberStore {
  const rows = [...list];
  return {
    async listByVehicle(ownerId, vin) {
      return rows.filter((m) => m.ownerId === ownerId && m.vin === vin);
    },
    async listByOwner(ownerId) {
      return rows.filter((m) => m.ownerId === ownerId);
    },
    async get(ownerId, id) {
      return rows.find((m) => m.ownerId === ownerId && m.id === id) ?? null;
    },
    async upsert() {
      throw new Error("not used");
    },
    async remove(ownerId, id) {
      const i = rows.findIndex((m) => m.ownerId === ownerId && m.id === id);
      if (i < 0) return null;
      rows.splice(i, 1);
      return id;
    },
  };
}

const MEMBER_A: VehicleMember = {
  id: "m-a",
  vin: VIN,
  ownerId: OWNER,
  displayName: "老婆",
  roles: ["driver"],
  needs: [],
  updatedAt: 0,
};
const MEMBER_B: VehicleMember = {
  id: "m-b",
  vin: VIN,
  ownerId: OWNER,
  displayName: "妈",
  roles: ["passenger"],
  needs: ["motion_sickness"],
  updatedAt: 0,
};

describe("流水归属：校验（F-46-05）", () => {
  it("归属字段类型不对直接拒绝", () => {
    assert.throws(
      () => validateTrip({ ...trip("t", 1), driverMemberId: 42 as never }),
      TripValidationError,
    );
    assert.throws(
      () => validateTrip({ ...trip("t", 1), passengerMemberIds: "m-a" as never }),
      TripValidationError,
    );
  });

  it("带归属却不指明车辆 → 拒绝（名单是挂在车上的）", async () => {
    const store = memoryStore();
    await assert.rejects(
      ingestTrip(store, "t1", { ...trip("t1", 1), vin: undefined, driverMemberId: "m-a" }),
      /必须指明车辆/,
    );
  });

  it("归属指向不属于这辆车的成员 → 拒绝，不静默抹掉", async () => {
    const store = memoryStore();
    await assert.rejects(
      ingestTrip(store, "t1", { ...trip("t1", 1), driverMemberId: "m-x" }, { members: memberStore([MEMBER_A]) }),
      /不是这辆车的常用人员/,
    );
  });

  it("未注入 MemberStore 时跳过归属校验（⑥不该因人员表不可用而写不进去）", async () => {
    const store = memoryStore();
    await ingestTrip(store, "t1", { ...trip("t1", 1), driverMemberId: "m-a" });
    assert.equal(store.rows.length, 1);
  });
});

describe("按人聚合：空归属不计入任何人（F-46-05 约束 2）", () => {
  it("3 条空归属 + 2 条归 A → A 的样本是 2，判定不可用", async () => {
    const store = memoryStore([
      trip("n1", 1),
      trip("n2", 2),
      trip("n3", 3),
      trip("a1", 4, { driverMemberId: "m-a" }),
      trip("a2", 5, { driverMemberId: "m-a" }),
    ]);
    const p = await loadMemberUsageProfile(store, OWNER, "m-a", NOW);
    assert.equal(p.summary.sampleSize, 2);
    assert.equal(p.verdict.usable, false);
    assert.match(p.verdict.reason ?? "", /2 条/);
  });

  it("样本够就可用，日均里程等于手算值", async () => {
    const store = memoryStore(
      Array.from({ length: MIN_SAMPLE }, (_, i) =>
        trip(`a${i}`, i + 1, { driverMemberId: "m-a", distanceKm: 30 }),
      ),
    );
    const p = await loadMemberUsageProfile(store, OWNER, "m-a", NOW, 30);
    assert.equal(p.verdict.usable, true);
    assert.equal(p.summary.sampleSize, MIN_SAMPLE);
    assert.equal(Math.round(p.summary.avgDailyKm * 10) / 10, Math.round((MIN_SAMPLE * 30) / 30 * 10) / 10);
    assert.equal(p.scope, "member");
  });
});

describe("按人检索：双重限定（F-46-07）", () => {
  it("缺 ownerId 或 memberId 直接抛", async () => {
    const store = memoryStore();
    await assert.rejects(loadMemberUsageProfile(store, "", "m-a", NOW), /ownerId 为空/);
    await assert.rejects(loadMemberUsageProfile(store, OWNER, "", NOW), /memberId 为空/);
  });

  it("以 A 的 id 取不到 B 的流水", async () => {
    const store = memoryStore([
      trip("a1", 1, { driverMemberId: "m-a" }),
      trip("b1", 2, { driverMemberId: "m-b" }),
    ]);
    const p = await loadMemberUsageProfile(store, OWNER, "m-a", NOW);
    assert.equal(p.summary.sampleSize, 1);
  });
});

describe("乘车人：只给频次与时段，不给里程（F-46-06）", () => {
  it("同行画像里没有 avgDailyKm 这类字段", async () => {
    const store = memoryStore([
      trip("r1", 1, { passengerMemberIds: ["m-b"] }),
      trip("r2", 2, { passengerMemberIds: ["m-b"] }),
    ]);
    const p = await loadCompanionProfile(store, OWNER, "m-b", NOW);
    assert.equal(p.summary.sampleSize, 2);
    assert.equal("avgDailyKm" in p.summary, false);
    assert.equal("commonChargeHours" in p.summary, false);
  });

  it("同行画像的可用阈值与整车同源（复用 assessUsability）", () => {
    const s = aggregateCompanion(
      Array.from({ length: MIN_SAMPLE }, (_, i) => ({
        startedAt: NOW - (i + 1) * DAY,
        endedAt: NOW - (i + 1) * DAY + 3_600_000,
        distanceKm: 10,
      })),
      NOW,
    );
    assert.equal(assessCompanionUsability(s).usable, true);
    const stale = aggregateCompanion(
      [
        {
          startedAt: NOW - (MAX_STALE_DAYS + 5) * DAY,
          endedAt: NOW - (MAX_STALE_DAYS + 5) * DAY,
          distanceKm: 10,
        },
      ],
      NOW,
    );
    assert.equal(assessCompanionUsability(stale).usable, false);
    assert.match(assessCompanionUsability(stale).reason ?? "", /过期/);
  });
});

describe("回落到整车口径是显式的（F-46-08）", () => {
  it("人员不可用时返回 scope=vehicle，不冒充个人结论", async () => {
    const store = memoryStore([
      ...Array.from({ length: 6 }, (_, i) => trip(`w${i}`, i + 1)),
      trip("a1", 1, { driverMemberId: "m-a" }),
    ]);
    const p = await memberProfileFallback(store, OWNER, "m-a", NOW);
    assert.equal(p.scope, "vehicle");
    assert.equal(p.verdict.usable, true);
  });

  it("人员本身够用时不回落", async () => {
    const store = memoryStore(
      Array.from({ length: MIN_SAMPLE }, (_, i) => trip(`a${i}`, i + 1, { driverMemberId: "m-a" })),
    );
    const p = await memberProfileFallback(store, OWNER, "m-a", NOW);
    assert.equal(p.scope, "member");
  });
});

describe("[F-46-04][AC-46-9] 级联删除：删干净且可重入（F-46-12）", () => {
  function purger(items: Array<{ id: string; metadata: Record<string, unknown> }>): MemberProfilePurger & {
    items: typeof items;
  } {
    return {
      items,
      async getAll() {
        return { results: items };
      },
      async delete(id: string) {
        const i = items.findIndex((x) => x.id === id);
        if (i >= 0) items.splice(i, 1);
      },
    };
  }

  it("先删画像、再清归属、最后删档案；行程行保留", async () => {
    const store = memoryStore([
      trip("a1", 1, { driverMemberId: "m-a" }),
      trip("r1", 2, { passengerMemberIds: ["m-a", "m-b"] }),
    ]);
    const mem = purger([
      { id: "p1", metadata: { category: "usage_pattern", member_id: "m-a" } },
      { id: "p2", metadata: { category: "usage_pattern", member_id: "m-b" } },
      { id: "p0", metadata: { category: "usage_pattern" } },
    ]);
    const members = memberStore([MEMBER_A, MEMBER_B]);

    const res = await removeMemberCascade(members, mem, store, OWNER, "m-a");
    assert.equal(res.removed, "m-a");
    assert.equal(res.profilesDeleted, 1);
    assert.equal(res.tripsDetached, 2);

    // 画像：只删了她那一条，整车与 B 的都还在
    assert.deepEqual(mem.items.map((x) => x.id).sort(), ["p0", "p2"]);
    // 档案：没了
    assert.equal(await members.get(OWNER, "m-a"), null);
    // 行程：**行还在**，只是归属空了
    assert.equal(store.rows.length, 2);
    assert.equal(store.rows[0].driverMemberId, undefined);
    assert.deepEqual(store.rows[1].passengerMemberIds, ["m-b"]);
    // 按人检索：取不到任何残留
    const after = await loadMemberUsageProfile(store, OWNER, "m-a", NOW);
    assert.equal(after.summary.sampleSize, 0);
  });

  it("重复删除不报错（幂等）", async () => {
    const store = memoryStore();
    const mem = purger([]);
    const members = memberStore([MEMBER_A]);
    assert.equal((await removeMemberCascade(members, mem, store, OWNER, "m-a")).removed, "m-a");
    assert.equal((await removeMemberCascade(members, mem, store, OWNER, "m-a")).removed, null);
  });

  it("缺用户维度直接抛", async () => {
    const store = memoryStore();
    await assert.rejects(
      removeMemberCascade(memberStore([]), purger([]), store, "", "m-a"),
      /ownerId 为空/,
    );
  });
});
