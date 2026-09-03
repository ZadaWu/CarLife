/**
 * 常用人员端点（施工单 M17-04，F-46-11）。
 *
 * 盯四件事：
 *  1. **空名单是 200 不是 404**——还没登记是常态，404 会让端上反复告警；
 *  2. **跨用户一律 404**，且被害者的记录必须还在；
 *  3. **删除幂等**——重试与双端同时删都会走到"已经没了"；
 *  4. **审计只记 id，不记称呼**——他人 PII 不进日志。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import type {
  MemberStore,
  TripStore,
  VehicleMember,
  VehicleProfile,
  VehicleStore,
} from "@carlife/memory";

import { createVehicleMemberRouter } from "../src/http/vehicle-member";

const VIN = "LSJA24U91NS999999";
const OWNER = "demo-user";
const OTHER = "other-user";

function vehicleStore(): VehicleStore {
  const car = (vin: string, ownerId: string): VehicleProfile => ({
    vin,
    ownerId,
    model: "测试车",
    modelYear: 2024,
    purchasedAt: 0,
    odometerKm: 1,
    maintenance: [],
    repairs: [],
    updatedAt: 0,
  });
  return {
    async get(vin) {
      if (vin === VIN) return car(VIN, OWNER);
      if (vin === "LSJA24U91NS000000") return car("LSJA24U91NS000000", OTHER);
      return null;
    },
    async listByOwner() {
      return [];
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

function memberStore(seed: VehicleMember[] = []) {
  const rows = [...seed];
  const store: MemberStore = {
    async listByVehicle(ownerId, vin) {
      return rows.filter((m) => m.ownerId === ownerId && m.vin === vin);
    },
    async listByOwner(ownerId) {
      return rows.filter((m) => m.ownerId === ownerId);
    },
    async get(ownerId, id) {
      return rows.find((m) => m.ownerId === ownerId && m.id === id) ?? null;
    },
    async upsert(m) {
      const row: VehicleMember = {
        id: m.id ?? `m-${rows.length + 1}`,
        vin: m.vin,
        ownerId: m.ownerId,
        displayName: m.displayName,
        relation: m.relation,
        roles: m.roles,
        ageBand: m.ageBand,
        needs: m.needs,
        note: m.note,
        updatedAt: 0,
      };
      const i = rows.findIndex((x) => x.id === row.id);
      if (i >= 0) rows[i] = row;
      else rows.push(row);
      return row;
    },
    async remove(ownerId, id) {
      const i = rows.findIndex((m) => m.ownerId === ownerId && m.id === id);
      if (i < 0) return null;
      rows.splice(i, 1);
      return id;
    },
  };
  return { store, rows };
}

const tripStore: TripStore = {
  async append() {},
  async range() {
    return [];
  },
  async clearMemberAttribution() {
    return 0;
  },
};

function appWith(userId: string | null, members: MemberStore, audit?: (e: unknown) => void) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = userId ?? undefined;
    next();
  });
  app.use(
    createVehicleMemberRouter({
      members,
      vehicles: vehicleStore(),
      trips: tripStore,
      audit: audit as never,
    }),
  );
  return app;
}

async function call(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

const MOM: VehicleMember = {
  id: "m-mom",
  vin: VIN,
  ownerId: OWNER,
  displayName: "妈妈",
  roles: ["passenger"],
  ageBand: "senior",
  needs: ["motion_sickness"],
  updatedAt: 0,
};

describe("[F-46-11][AC-46-3] GET /v1/vehicles/:vin/members", () => {
  it("未鉴权 401", async () => {
    const r = await call(appWith(null, memberStore().store), "GET", `/v1/vehicles/${VIN}/members`);
    assert.equal(r.status, 401);
  });

  it("**空名单是 200 `{members:[]}`**，不是 404", async () => {
    const r = await call(appWith(OWNER, memberStore().store), "GET", `/v1/vehicles/${VIN}/members`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.members, []);
  });

  it("车不属于我 → 404，不泄露它是否存在", async () => {
    const r = await call(
      appWith(OWNER, memberStore().store),
      "GET",
      "/v1/vehicles/LSJA24U91NS000000/members",
    );
    assert.equal(r.status, 404);
  });
});

describe("[F-46-11][AC-46-3] POST /v1/vehicles/:vin/members", () => {
  it("新增返回 201 并带回落库后的成员", async () => {
    const { store } = memberStore();
    const r = await call(appWith(OWNER, store), "POST", `/v1/vehicles/${VIN}/members`, {
      displayName: "妈",
      roles: ["passenger"],
      needs: ["motion_sickness", "restroom"],
      ageBand: "senior",
    });
    assert.equal(r.status, 201);
    assert.equal((r.body.member as VehicleMember).displayName, "妈");
  });

  it("词表外的 needs → 400 且指出是哪一项", async () => {
    const r = await call(appWith(OWNER, memberStore().store), "POST", `/v1/vehicles/${VIN}/members`, {
      displayName: "妈",
      roles: ["passenger"],
      needs: ["晕车"],
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, "needs");
    assert.match(String(r.body.detail), /词表 key/);
  });

  it("角色为空 → 400（至少要说清 TA 是开车还是坐车）", async () => {
    const r = await call(appWith(OWNER, memberStore().store), "POST", `/v1/vehicles/${VIN}/members`, {
      displayName: "妈",
      roles: [],
      needs: [],
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, "roles");
  });

  it("改别人的成员 → 404，且对方记录仍在", async () => {
    const { store, rows } = memberStore([MOM]);
    const r = await call(appWith(OTHER, store), "POST", "/v1/vehicles/LSJA24U91NS000000/members", {
      id: MOM.id,
      displayName: "篡改",
      roles: ["driver"],
      needs: [],
    });
    // 车就不属于他，先在车这一层挡住
    assert.equal(r.status, 404);
    assert.equal(rows[0].displayName, "妈妈");
  });

  it("带一个不存在的 id → 404（不静默新建）", async () => {
    const r = await call(appWith(OWNER, memberStore().store), "POST", `/v1/vehicles/${VIN}/members`, {
      id: "m-ghost",
      displayName: "妈",
      roles: ["passenger"],
      needs: [],
    });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "member_not_found");
  });
});

describe("[F-46-11][AC-46-3] DELETE /v1/vehicles/:vin/members/:id", () => {
  it("删除成功返回 removed:true，再删一次 removed:false（幂等，不是 404）", async () => {
    const { store } = memberStore([MOM]);
    const app = appWith(OWNER, store);
    const first = await call(app, "DELETE", `/v1/vehicles/${VIN}/members/${MOM.id}`);
    assert.equal(first.status, 200);
    assert.equal(first.body.removed, true);
    const second = await call(app, "DELETE", `/v1/vehicles/${VIN}/members/${MOM.id}`);
    assert.equal(second.status, 200);
    assert.equal(second.body.removed, false);
  });

  it("跨用户删除删不掉（车这一层就 404），记录仍在", async () => {
    const { store, rows } = memberStore([MOM]);
    const r = await call(appWith(OTHER, store), "DELETE", `/v1/vehicles/${VIN}/members/${MOM.id}`);
    assert.equal(r.status, 404);
    assert.equal(rows.length, 1);
  });
});

describe("审计：只记 id 与动作，不记称呼", () => {
  it("增删两条审计里都取不到称呼", async () => {
    const seen: string[] = [];
    const { store } = memberStore([MOM]);
    const app = appWith(OWNER, store, (e) => seen.push(JSON.stringify(e)));
    await call(app, "POST", `/v1/vehicles/${VIN}/members`, {
      displayName: "妈妈",
      roles: ["passenger"],
      needs: [],
    });
    await call(app, "DELETE", `/v1/vehicles/${VIN}/members/${MOM.id}`);
    assert.equal(seen.length, 2);
    for (const line of seen) {
      assert.equal(line.includes("妈妈"), false, `审计里出现了称呼：${line}`);
      assert.match(line, /member\.(create|delete)/);
    }
  });
});
