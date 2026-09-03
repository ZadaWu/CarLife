/**
 * 出发导航的乘车人约束（施工单 M66-02）。复用 companions.ts 的匹配，这里只钉三件事：
 * party 命中带谁、否定不带、没命中退到全部乘客并说出来；以及读失败不抛。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MemberStore, VehicleMember } from "@carlife/memory";

import {
  UNSPECIFIED_PARTY_CAVEAT,
  navConstraintsFromMembers,
  resolveNavConstraints,
} from "../src/graph/nav-constraints";

const member = (over: Partial<VehicleMember> & Pick<VehicleMember, "id" | "displayName" | "needs">): VehicleMember => ({
  vin: "VIN1",
  ownerId: "u1",
  roles: ["passenger"],
  updatedAt: 0,
  ...over,
});

const MOM = member({ id: "m1", displayName: "妈", relation: "母亲", needs: ["motion_sickness"] });
const KID = member({ id: "m2", displayName: "小宝", needs: ["restroom", "child_seat"] });
const DRIVER = member({ id: "m3", displayName: "老公", roles: ["driver"], needs: ["fatigue"] });

describe("navConstraintsFromMembers", () => {
  it("[F-46-10][AC-46-5] party 命中「带我妈」→ 晕车约束，maxLegMinutes=90，出处是「妈」", () => {
    const r = navConstraintsFromMembers([MOM, KID, DRIVER], "带我妈去杭州");
    assert.equal(r.maxLegMinutes, 90);
    assert.equal(r.constraints.length, 1);
    assert.deepEqual(r.constraints[0].from, ["妈"]);
    assert.match(r.constraints[0].text, /晕车/);
    assert.deepEqual(r.needs, ["motion_sickness"]);
    assert.deepEqual(r.caveats, []);
  });

  it("[F-46-10][AC-46-5] 「这次我妈不去」→ 否定：她的约束不带；谁在车上仍未知 → 退到其余乘客并写 caveat", () => {
    const r = navConstraintsFromMembers([MOM, KID], "这次我妈不去");
    assert.ok(r.caveats.includes(UNSPECIFIED_PARTY_CAVEAT));
    assert.ok(!r.constraints.some((c) => /晕车/.test(c.text)), "被排除的人不带入");
    assert.ok(r.constraints.some((c) => /卫生间/.test(c.text)), "其余乘客照样带入");
    assert.equal(r.maxLegMinutes, undefined, "晕车的 90 分钟上限随她一起不带入");
    // 名单里只有她一个人：排除之后没人 → 空约束、无 caveat（没什么可说的）
    const only = navConstraintsFromMembers([MOM], "这次我妈不去");
    assert.deepEqual(only.constraints, []);
    assert.deepEqual(only.caveats, []);
  });

  it("party 空 → 全部**乘客**（司机不算）带入，同一条约束合并出处", () => {
    const r = navConstraintsFromMembers([MOM, KID, DRIVER, member({ id: "m4", displayName: "爸", needs: ["motion_sickness"] })], undefined);
    assert.ok(r.caveats.includes(UNSPECIFIED_PARTY_CAVEAT));
    const sick = r.constraints.find((c) => /晕车/.test(c.text));
    assert.deepEqual(sick?.from, ["妈", "爸"]);
    assert.ok(r.constraints.some((c) => /卫生间/.test(c.text)));
    assert.ok(!r.constraints.some((c) => /疲劳/.test(c.text)), "司机的 needs 不进乘车人约束");
    assert.equal(r.maxLegMinutes, 90);
  });

  it("没有任何乘客 → 空约束、无上限、无 caveat", () => {
    const r = navConstraintsFromMembers([DRIVER], "带我妈");
    assert.deepEqual(r.constraints, []);
    assert.equal(r.maxLegMinutes, undefined);
    assert.deepEqual(r.caveats, []);
  });
});

describe("resolveNavConstraints", () => {
  const store = (impl: Partial<MemberStore>): MemberStore => impl as MemberStore;

  it("有 vin 走 listByVehicle，无 vin 走 listByOwner", async () => {
    const calls: string[] = [];
    const s = store({
      listByVehicle: async (_o, vin) => {
        calls.push(`vehicle:${vin}`);
        return [MOM];
      },
      listByOwner: async () => {
        calls.push("owner");
        return [KID];
      },
    });
    const a = await resolveNavConstraints(s, "u1", "带我妈", "VIN1");
    assert.equal(a.maxLegMinutes, 90);
    const b = await resolveNavConstraints(s, "u1", "带小宝");
    assert.ok(b.constraints.some((c) => /卫生间/.test(c.text)));
    assert.deepEqual(calls, ["vehicle:VIN1", "owner"]);
  });

  it("[F-46-10][AC-46-12] store 抛错 → 空约束 + caveat，不抛；未注入 / 无 userId → 空且无 caveat（无档案不阻塞规划）", async () => {
    const bad = store({
      listByOwner: async () => {
        throw new Error("db down");
      },
    });
    const r = await resolveNavConstraints(bad, "u1", "带我妈");
    assert.deepEqual(r.constraints, []);
    assert.equal(r.caveats.length, 1);
    assert.deepEqual(await resolveNavConstraints(undefined, "u1", "x"), { constraints: [], needs: [], caveats: [] });
    assert.deepEqual(await resolveNavConstraints(bad, "", "x"), { constraints: [], needs: [], caveats: [] });
  });
});
