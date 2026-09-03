/**
 * 联系方式两件套（施工单 M19-06）。
 *
 * 这份测试盯的是**明文不出这一层**与**改错了车主能发现**两件事：
 *
 *  1. `contact_lookup` 的返回值会原样进 LLM 上下文，而上下文会进检查点、进 trace。
 *     所以整个返回结构里**不能有完整号码**——不是"我们没打算放"，是断言它真的不在。
 *  2. `contact_update` 不过权限门（M19-06 D2），车主核对的唯一机会是那句
 *     "从尾号 8000 改成 5613"。所以 `previousTail` 必须回来。
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";

import type { MemberStore, VehicleMember, VehicleMemberInput } from "@carlife/memory";

import {
  contactLookupTool,
  contactUpdateTool,
  resolveContactSecret,
  setMemberStores,
  getTool,
  listForAgent,
  listExposableForMcp,
} from "../src/index";

const CTX = { sessionId: "s1", agent: "test-drive" as const, mode: "real" as const };

const base = (over: Partial<VehicleMember>): VehicleMember => ({
  id: "m-self",
  vin: "DEMO0SEED0MODELY1",
  ownerId: "u1",
  displayName: "阿东",
  relation: "本人",
  roles: ["driver"],
  needs: [],
  updatedAt: 0,
  ...over,
});

/** 内存版 MemberStore。`upsert` 按真实实现的语义**整条覆盖**。 */
function fakeStore(rows: VehicleMember[]): MemberStore & { rows: VehicleMember[] } {
  const store = {
    rows,
    async listByVehicle(ownerId: string, vin: string) {
      return rows.filter((r) => r.ownerId === ownerId && r.vin === vin);
    },
    async listByOwner(ownerId: string) {
      return rows.filter((r) => r.ownerId === ownerId);
    },
    async get(ownerId: string, id: string) {
      return rows.find((r) => r.ownerId === ownerId && r.id === id) ?? null;
    },
    async upsert(m: VehicleMemberInput) {
      const i = rows.findIndex((r) => r.id === m.id);
      const next = { ...(rows[i] ?? base({})), ...m, id: m.id ?? "new", updatedAt: 1 } as VehicleMember;
      if (i >= 0) rows[i] = next;
      else rows.push(next);
      return next;
    },
    async remove() {
      return null;
    },
  };
  return store;
}

const install = (rows: VehicleMember[]) => {
  const s = fakeStore(rows);
  setMemberStores(s, undefined as never);
  return s;
};

afterEach(() => setMemberStores(undefined, undefined as never));

describe("contact_lookup：只给尾号，明文一个字都不出去", () => {
  beforeEach(() => install([base({ phone: "13912345613" })]));

  it("缺省返回**车主本人**那条", async () => {
    const r = (await contactLookupTool.call({ userId: "u1" }, CTX)) as {
      data: { members: Array<{ displayName: string; phoneTail?: string }>; matchedBy: string };
    };
    assert.equal(r.data.matchedBy, "owner");
    assert.equal(r.data.members[0].displayName, "阿东");
    assert.equal(r.data.members[0].phoneTail, "5613");
  });

  it("**整个返回值里搜不到完整号码**——这是掩码这条路成立的前提", async () => {
    const r = await contactLookupTool.call({ userId: "u1" }, CTX);
    const dumped = JSON.stringify(r);
    assert.equal(dumped.includes("13912345613"), false, "明文号码泄进了工具返回值");
    assert.equal(dumped.includes("1391234"), false, "前七位也算泄露");
    assert.ok(dumped.includes("5613"));
  });

  it("按称呼/关系找人", async () => {
    install([base({}), base({ id: "m-mom", displayName: "妈妈", relation: "母亲", phone: "13800138000" })]);
    const r = (await contactLookupTool.call({ userId: "u1", who: "妈妈" }, CTX)) as {
      data: { members: Array<{ memberId: string }>; matchedBy: string };
    };
    assert.equal(r.data.matchedBy, "keyword");
    assert.equal(r.data.members[0].memberId, "m-mom");
  });

  it("**没登记号码的人 hasPhone=false**，不拿车主的号顶替", async () => {
    install([base({ phone: "13912345613" }), base({ id: "m-kid", displayName: "小宝", relation: "儿子" })]);
    const r = (await contactLookupTool.call({ userId: "u1", who: "小宝" }, CTX)) as {
      data: { members: Array<{ hasPhone: boolean; phoneTail?: string }> };
    };
    assert.equal(r.data.members[0].hasPhone, false);
    assert.equal(r.data.members[0].phoneTail, undefined);
  });

  it("**跨用户读不到**——归属过滤在 store 那一层，这里守住它没被绕过", async () => {
    const r = (await contactLookupTool.call({ userId: "u2" }, CTX)) as {
      data: { members: unknown[] };
    };
    assert.equal(r.data.members.length, 0);
  });

  it("未接入时抛 unconfigured，**话术拦住凭印象报号码**", async () => {
    setMemberStores(undefined, undefined as never);
    await assert.rejects(
      () => contactLookupTool.call({ userId: "u1" }, CTX),
      (e: Error & { category?: string }) => {
        assert.equal(e.category, "unconfigured");
        assert.match(e.message, /不要凭印象报手机号/);
        return true;
      },
    );
  });
});

describe("contact_update：改完要能被核对", () => {
  it("**回报改动前后的尾号**——不过权限门，这是他核对的唯一机会", async () => {
    install([base({ phone: "13800138000" })]);
    const r = (await contactUpdateTool.call(
      { userId: "u1", memberId: "m-self", phone: "13912345613" },
      CTX,
    )) as { data: { previousTail?: string; phoneTail: string; result: string } };
    assert.equal(r.data.previousTail, "8000");
    assert.equal(r.data.phoneTail, "5613");
    assert.equal(r.data.result, "replaced");
  });

  it("第一次登记 result=added，没有 previousTail", async () => {
    install([base({})]);
    const r = (await contactUpdateTool.call(
      { userId: "u1", memberId: "m-self", phone: "13912345613" },
      CTX,
    )) as { data: { previousTail?: string; result: string } };
    assert.equal(r.data.result, "added");
    assert.equal(r.data.previousTail, undefined);
  });

  it("**语音说的中文数字也认**——车机上这是常态", async () => {
    const s = install([base({})]);
    await contactUpdateTool.call(
      { userId: "u1", memberId: "m-self", phone: "我手机号码是幺三九幺二三四五六幺三" },
      CTX,
    );
    assert.equal(s.rows[0].phone, "13912345613");
  });

  it("**认不出完整号码就拒收**，不补位不猜", async () => {
    install([base({})]);
    await assert.rejects(
      () => contactUpdateTool.call({ userId: "u1", memberId: "m-self", phone: "尾号5613" }, CTX),
      (e: Error) => {
        assert.match(e.message, /不要补位/);
        return true;
      },
    );
  });

  it("**编的 memberId 被拒**，并点名该用哪个工具去查", async () => {
    install([base({})]);
    await assert.rejects(
      () => contactUpdateTool.call({ userId: "u1", memberId: "我编的", phone: "13912345613" }, CTX),
      (e: Error) => {
        assert.match(e.message, /contact_lookup/);
        return true;
      },
    );
  });

  it("**跨用户改不了**——按不存在处理", async () => {
    install([base({})]);
    await assert.rejects(() =>
      contactUpdateTool.call({ userId: "u2", memberId: "m-self", phone: "13912345613" }, CTX),
    );
  });

  it("**不能把人的档案洗掉**：改号码不动称呼、角色、出行需求", async () => {
    const s = install([base({ displayName: "妈妈", relation: "母亲", roles: ["passenger"], needs: ["motion_sickness"] })]);
    await contactUpdateTool.call({ userId: "u1", memberId: "m-self", phone: "13912345613" }, CTX);
    assert.equal(s.rows[0].displayName, "妈妈");
    assert.deepEqual(s.rows[0].roles, ["passenger"]);
    assert.deepEqual(s.rows[0].needs, ["motion_sickness"]);
  });

  it("号码没变时 result=unchanged，**不产生一次无谓的写**", async () => {
    const s = install([base({ phone: "13912345613" })]);
    let writes = 0;
    const orig = s.upsert.bind(s);
    s.upsert = async (m) => {
      writes += 1;
      return orig(m);
    };
    const r = (await contactUpdateTool.call(
      { userId: "u1", memberId: "m-self", phone: "139 1234 5613" },
      CTX,
    )) as { data: { result: string } };
    assert.equal(r.data.result, "unchanged");
    assert.equal(writes, 0);
  });
});

describe("resolveContactSecret：真号只走这条内部路", () => {
  it("取得到真号（**它不是工具，模型够不着**）", async () => {
    install([base({ phone: "13912345613" })]);
    assert.deepEqual(await resolveContactSecret("u1", "m-self"), {
      name: "阿东",
      phone: "13912345613",
    });
  });

  it("**没有注册成工具**——注册了上面那一整套掩码就白做了", () => {
    assert.equal(getTool("resolveContactSecret"), undefined);
    assert.equal(getTool("contact_secret"), undefined);
  });

  it("没登记号码时返回 undefined，不返回一个空号", async () => {
    install([base({})]);
    assert.equal(await resolveContactSecret("u1", "m-self"), undefined);
  });
});

describe("注册表与 ACL", () => {
  it("三个 Agent 拿得到（试驾 / 售后 / 座舱）", () => {
    for (const agent of ["test-drive", "service", "cabin"] as const) {
      const names = listForAgent(agent).map((t) => t.name);
      assert.ok(names.includes("contact_lookup"), `${agent} 缺 contact_lookup`);
      assert.ok(names.includes("contact_update"), `${agent} 缺 contact_update`);
    }
  });

  it("**buying / trip 拿不到**——他们没有登记联系方式的业务面", () => {
    for (const agent of ["buying", "trip"] as const) {
      const names = listForAgent(agent).map((t) => t.name);
      assert.equal(names.includes("contact_update"), false, `${agent} 不该能改手机号`);
    }
  });

  it("两个都是只读档，不进权限门（M19-06 D2）", () => {
    assert.equal(getTool("contact_lookup")!.sensitive, false);
    assert.equal(getTool("contact_update")!.sensitive, false);
  });

  it("**不对外经 MCP 暴露**（声明与筛选规则两处一致）", () => {
    const exposed = listExposableForMcp().map((t) => t.name);
    for (const n of ["contact_lookup", "contact_update"]) {
      assert.equal(getTool(n)!.mcpExposable, false);
      assert.equal(exposed.includes(n), false, `${n} 漏进了 MCP 暴露表`);
    }
  });

  it("**轨迹里没有称呼、没有号码**", () => {
    const lookup = getTool("contact_lookup")!.traceSummary?.({ who: "妈妈", userId: "u1" } as never);
    assert.equal(lookup, "by-keyword");
    const update = getTool("contact_update")!.traceSummary?.({
      memberId: "m-self-abcdefgh",
      phone: "13912345613",
    } as never);
    assert.equal(update!.includes("13912345613"), false);
    assert.match(update!, /^member=/);
  });
});
