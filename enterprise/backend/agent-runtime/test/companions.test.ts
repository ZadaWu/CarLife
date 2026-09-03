/**
 * 同行者硬约束的自动带入（施工单 M17-05，F-46-10）。
 *
 * 三条负向/边界是本组的重点：否定要挡住、软失败不能拖垮本轮、轨迹里不能有称呼。
 * 匹配规则单独导出就是为了能被逐条断言——埋在闭包里的判定，
 * 缺陷只会表现为"方案里少了一条约束"，没人会归因到这里。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MemberStore, UserFlagStore, VehicleMember } from "@carlife/memory";

import {
  constraintsFromMembers,
  hasRegisteredMembers,
  matchCompanions,
  maybeCompanionGuidance,
  mentionsCompanion,
  mergeConstraints,
  renderCompanionProvenance,
  resolveCompanionConstraints,
  setCompanionFlagStore,
} from "../src/graph/companions";

const VIN = "LSJA24U91NS123123";
const OWNER = "u-1";

const member = (over: Partial<VehicleMember>): VehicleMember => ({
  id: "m-1",
  vin: VIN,
  ownerId: OWNER,
  displayName: "妈妈",
  roles: ["passenger"],
  needs: [],
  updatedAt: 0,
  ...over,
});

const MOM = member({ id: "m-mom", displayName: "妈", relation: "母亲", needs: ["motion_sickness", "restroom"] });
const KID = member({ id: "m-kid", displayName: "小满", needs: ["child_seat", "restroom"] });

function store(rows: VehicleMember[], fail = false): MemberStore {
  return {
    async listByVehicle() {
      if (fail) throw new Error("db down");
      return rows;
    },
    async listByOwner() {
      if (fail) throw new Error("db down");
      return rows;
    },
    async get() {
      return null;
    },
    async upsert() {
      throw new Error("not used");
    },
    async remove() {
      return null;
    },
  };
}

describe("同行者匹配：确定性规则", () => {
  it("称呼命中就算提到（按登记的称呼与关系两种叫法找）", () => {
    const byName = matchCompanions([MOM], "国庆带我妈和孩子去黄山");
    assert.equal(byName.length, 1);
    assert.equal(byName[0].excluded, false);
    const byRelation = matchCompanions([member({ displayName: "老太太", relation: "母亲" })], "带母亲出去玩");
    assert.equal(byRelation.length, 1);
  });

  it("**不做同义词推断**：没登记过的叫法匹配不上", () => {
    // 猜"妈"="老妈"看起来贴心，但猜错时带入的是别人的约束。
    assert.equal(matchCompanions([member({ displayName: "老妈" })], "带我妈去").length, 0);
  });

  it("否定在称呼之后 6 字内 → 本轮排除", () => {
    for (const text of ["这次我妈不去", "我妈这次不去了", "我妈留在家"]) {
      const m = matchCompanions([MOM], text);
      assert.equal(m[0]?.excluded, true, `应当排除：${text}`);
    }
  });

  it("**宁可漏挡也不错挡**：前置否定一律不算排除", () => {
    // "上次没带我妈，这次带上"——前置窗口会把上一次的否定算到这一轮头上，
    // 所以规则只看称呼之后。代价是"别带我妈了"这种前置否定会漏挡（下面那条）：
    // 漏挡时用户再说一遍就好，错挡则让档案变成甩不掉的默认值。
    assert.equal(matchCompanions([MOM], "上次没带我妈，这次带上")[0]?.excluded, false);
  });

  it("已知漏挡：否定在称呼**之前**时挡不住（刻意的取舍，见上一条）", () => {
    assert.equal(matchCompanions([MOM], "别带我妈了")[0]?.excluded, false);
  });
});

describe("约束生成：文案只有一处", () => {
  it("晕车带得动单段时长，儿童座椅带得动停靠时长", () => {
    const list = constraintsFromMembers(matchCompanions([MOM, KID], "带我妈和小满去黄山"));
    const texts = list.map((c) => c.text);
    assert.ok(texts.some((t) => t.includes("单段")));
    assert.ok(texts.some((t) => t.includes("抱下车")));
  });

  it("同一条约束来自两个人时不重复，但出处两个都留下", () => {
    // 妈与小满都需要卫生间
    const list = constraintsFromMembers(matchCompanions([MOM, KID], "带我妈和小满去黄山"));
    const restroom = list.filter((c) => c.need === "restroom");
    assert.equal(restroom.length, 2, "出处要留两个");
    const rendered = renderCompanionProvenance(list)!;
    assert.equal(rendered.split("正规卫生间").length - 1, 1, "同一条约束在提示词里只出现一次");
    assert.match(rendered, /妈、小满/);
  });

  it("被排除的人不产出任何约束", () => {
    const list = constraintsFromMembers(matchCompanions([MOM], "这次我妈不去，我们两个人"));
    assert.deepEqual(list, []);
  });
});

describe("合并进 intent.constraints", () => {
  it("档案条目排在原话之后", () => {
    const merged = mergeConstraints(["预算三千以内"], constraintsFromMembers(matchCompanions([MOM], "带我妈去")));
    assert.equal(merged[0], "预算三千以内");
    assert.ok(merged.length > 1);
  });

  it("原话已经说了同一件事就不重复添加", () => {
    const fromMembers = constraintsFromMembers(matchCompanions([MOM], "带我妈去"));
    const already = fromMembers[0].text;
    const merged = mergeConstraints([already], fromMembers);
    assert.equal(merged.filter((c) => c === already).length, 1);
  });
});

describe("软失败：读不到名单不拖垮本轮", () => {
  it("store 抛错 → 返回空数组，不抛出去", async () => {
    const out = await resolveCompanionConstraints(store([MOM], true), OWNER, "带我妈去黄山");
    assert.deepEqual(out, []);
  });

  it("未注入 store / 缺 userId → 空数组", async () => {
    assert.deepEqual(await resolveCompanionConstraints(undefined, OWNER, "带我妈去"), []);
    assert.deepEqual(await resolveCompanionConstraints(store([MOM]), undefined, "带我妈去"), []);
  });

  it("正常路径能取到约束", async () => {
    const out = await resolveCompanionConstraints(store([MOM]), OWNER, "带我妈去黄山");
    assert.equal(out.length, 2);
    assert.equal(out[0].memberId, "m-mom");
    assert.equal(out[0].displayName, "妈");
  });

  it("`hasRegisteredMembers` 读失败按'登记过'处理——宁可不引导也不误催", async () => {
    assert.equal(await hasRegisteredMembers(store([], true), OWNER), true);
    assert.equal(await hasRegisteredMembers(store([]), OWNER), false);
    assert.equal(await hasRegisteredMembers(store([MOM]), OWNER), true);
  });
});

describe("出处渲染：让方案说得出这条约束来自谁", () => {
  it("每条带「来自：」，并要求本轮原话优先", () => {
    const rendered = renderCompanionProvenance(
      constraintsFromMembers(matchCompanions([MOM], "带我妈去")),
    )!;
    assert.match(rendered, /来自：妈/);
    assert.match(rendered, /原话优先于档案/);
  });

  it("没有带入时不产出任何提示词", () => {
    assert.equal(renderCompanionProvenance([]), undefined);
  });
});

describe("一次性引导（AC-46-12）", () => {
  function flagStore(): UserFlagStore & { flags: Set<string> } {
    const flags = new Set<string>();
    return {
      flags,
      async has(userId, flag) {
        return flags.has(`${userId}:${flag}`);
      },
      async set(userId, flag) {
        flags.add(`${userId}:${flag}`);
      },
    };
  }

  it("没名单 + 提到同行者 → 引导一次，第二次不再出现", async () => {
    setCompanionFlagStore(flagStore());
    const args = { userText: "国庆带我妈去黄山", hasMembers: false, userId: OWNER };
    const first = await maybeCompanionGuidance(args);
    assert.ok(first);
    assert.match(first, /常用人员/);
    assert.equal(await maybeCompanionGuidance(args), undefined);
  });

  it("已经有名单 → 不引导", async () => {
    setCompanionFlagStore(flagStore());
    assert.equal(
      await maybeCompanionGuidance({ userText: "带我妈去", hasMembers: true, userId: OWNER }),
      undefined,
    );
  });

  it("没提同行者 → 不引导", async () => {
    setCompanionFlagStore(flagStore());
    assert.equal(
      await maybeCompanionGuidance({ userText: "帮我查下天气", hasMembers: false, userId: OWNER }),
      undefined,
    );
  });

  it("缺 userId → 不引导也不记", async () => {
    const flags = flagStore();
    setCompanionFlagStore(flags);
    assert.equal(
      await maybeCompanionGuidance({ userText: "带我妈去", hasMembers: false }),
      undefined,
    );
    assert.equal(flags.flags.size, 0);
  });

  it("flag 读写失败 → 不引导且**不置位**（不烧掉唯一一次机会）", async () => {
    setCompanionFlagStore({
      async has() {
        throw new Error("pg down");
      },
      async set() {},
    });
    assert.equal(
      await maybeCompanionGuidance({ userText: "带我妈去", hasMembers: false, userId: OWNER }),
      undefined,
    );
  });

  it("同行者线索词覆盖常见叫法", () => {
    for (const t of ["带我妈", "家里老人", "孩子要上厕所", "带家人出去"]) {
      assert.equal(mentionsCompanion(t), true, t);
    }
    assert.equal(mentionsCompanion("帮我导航到公司"), false);
  });
});
