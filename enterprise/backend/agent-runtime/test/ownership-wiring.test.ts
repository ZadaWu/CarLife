/**
 * 双路检索的**生产接线**单测（施工单 M8-02 收口）。
 *
 * 与 `dualpath.test.ts` 的分工：那边测合成逻辑（给定两路结果，判定与话术对不对），
 * 这边测**接线**——工具真的被调了吗、userId 真的传下去了吗、
 * 一路挂了整条链路会不会跟着挂。
 *
 * 走 mock 模式，不连 RAGFlow、不连 PG、不连 Ollama。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { setRagClient, setUsageStore } from "@carlife/tools";
import type { StoredTrip, TripStore } from "@carlife/memory";

import { runOwnershipDualPath } from "../src/graph/subgraphs/ownership";
import { branchFor, decideRoute } from "../src/graph/route";

const MOCK = { sessionId: "s1", agent: "ownership", mode: "mock" as const };
const REAL = { sessionId: "s1", agent: "ownership", mode: "real" as const };

/** 造一个有足够近期样本的 store，让⑥那一路真的可用。 */
function storeWith(n: number, now = Date.now()): TripStore {
  const rows: StoredTrip[] = Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    userId: "u1",
    startedAt: now - (i + 1) * 86_400_000,
    endedAt: now - (i + 1) * 86_400_000 + 3_600_000,
    distanceKm: 30,
    ambientTempC: i % 2 === 0 ? 2 : 20,
    observedRangeKm: i % 2 === 0 ? 260 : 400,
  }));
  return {
    async append() {},
    async range(userId, from, to) {
      return rows.filter((r) => r.userId === userId && r.endedAt >= from && r.endedAt <= to);
    },
  };
}

describe("双路接线：两路都拿到实质内容才算个性化", () => {
  it("mock 模式下两路齐备 → personalized", async () => {
    const r = await runOwnershipDualPath({ query: "冬天续航为什么掉这么多", userId: "u1", ctx: MOCK });
    assert.equal(r.personalized, true);
    assert.ok(r.rag.chunks.length > 0);
    assert.ok(r.usage.summary);
    assert.match(r.context, /这辆车的真实数据/);
  });

  it("**缺 userId → 只剩单路，明确降级**", async () => {
    const r = await runOwnershipDualPath({ query: "冬天续航为什么掉这么多", ctx: MOCK });
    assert.equal(r.personalized, false, "少一路就不能声称个性化");
    assert.ok(
      r.caveats.some((c) => c.includes("用户身份") || c.includes("用车数据")),
      "缺什么必须如实写进 caveats",
    );
    assert.match(r.context, /不要暗示这是针对这辆车的结论/);
  });

  it("**RAG 未接入不会让整条链路失败**——降级而不是崩", async () => {
    setRagClient(undefined); // 未配置 RAGFlow 的真实形态
    const r = await runOwnershipDualPath({ query: "胎压多少合适", userId: "u1", ctx: REAL });
    assert.equal(r.rag.ok, false);
    assert.equal(r.personalized, false);
    // 未接入是「检索失败」那一类，不是「知识库里没有」。
    assert.ok(r.caveats.some((c) => c.includes("检索说明书失败")));
  });

  it("⑥未接入同样降级，且与「没有数据」的话术不同", async () => {
    setUsageStore(undefined);
    const r = await runOwnershipDualPath({ query: "保养该做了吗", userId: "u1", ctx: REAL });
    assert.equal(r.usage.ok, false);
    assert.equal(r.personalized, false);
  });
});

describe("⑥那一路真的读到了用户的数据（不是 mock 顶上的）", () => {
  it("接上真实 store 后 summary 来自流水", async () => {
    setUsageStore(storeWith(20));
    setRagClient({
      async retrieve() {
        return [{ content: "低温下电池可用容量下降", source: { document: "说明书" }, score: 0.9 }];
      },
    });
    const r = await runOwnershipDualPath({ query: "冬天续航", userId: "u1", ctx: REAL });
    assert.equal(r.personalized, true);
    assert.equal(r.usage.summary?.sampleSize, 20, "样本量来自真实流水条数");
    // 低温与常温分别统计——双路检索靠这组对比说话（§6 示例）。
    assert.ok((r.usage.summary?.lowTempRangeKm ?? 0) < (r.usage.summary?.mildTempRangeKm ?? 0));
  });

  it("**样本不足时给理由不给数字**——不足的数据不能拿来下个性化结论", async () => {
    setUsageStore(storeWith(2));
    const r = await runOwnershipDualPath({ query: "冬天续航", userId: "u1", ctx: REAL });
    assert.equal(r.usage.summary, undefined, "不可用时 summary 必须是 undefined");
    assert.match(r.usage.unusableReason ?? "", /2 条/);
    assert.equal(r.personalized, false);
  });

  it("跨用户不串：换个 userId 就读不到", async () => {
    setUsageStore(storeWith(20));
    const r = await runOwnershipDualPath({ query: "冬天续航", userId: "someone-else", ctx: REAL });
    assert.equal(r.usage.summary, undefined);
  });
});

describe("路由：用车类问题要能到 ownership", () => {
  const intent = { goal: "", constraints: [], context: "", riskBoundary: "" };

  for (const q of ["冬天续航掉得厉害正常吗", "胎压打多少", "说明书上怎么说"]) {
    it(`「${q}」→ ownership`, () => {
      assert.equal(decideRoute(intent, q).agent, "ownership");
    });
  }

  it("**「该保养了吗」改判 service**（F-03）——此前判 ownership 与数据集划分矛盾", () => {
    // 内部开发指引 的判据：保养手册在 repair-kb，不在 vehicle-manuals；
    // "保养是售后的业务面（周期推算、预约、工单），不是'这个功能怎么用'"。
    // 判到 ownership 会去搜说明书，而那里根本没有保养周期表——
    // 后果不是报错，是"答得很顺但没有出处"。
    // 两者现在共用 ownershipDual 节点，改的只是查哪个知识库。
    assert.equal(decideRoute(intent, "该保养了吗").agent, "service");
  });

  it("**出行类优先**：「去黄山要充几次电」是行程问题，不是用车咨询", () => {
    // 出行类里也会出现续航、充电这些词。规则顺序保证不会被拽到双路检索上。
    // M13-13：出行一律进行程规划，单程与多天不再分叉。
    assert.equal(decideRoute(intent, "明天去黄山要充几次电").agent, "itinerary");
  });

  it("其余仍走通用应答", () => {
    assert.equal(decideRoute(intent, "你好").agent, "general");
  });
});

describe("车型限定：不知道是哪辆车时必须说出来（F-23-07）", () => {
  it("**未限定车型 → caveats 里如实标注**", async () => {
    setUsageStore(storeWith(20));
    setRagClient({
      async retrieve() {
        return [{ content: "低温下电池可用容量下降", source: { document: "某款车的说明书" }, score: 0.9 }];
      },
    });
    // 不传 vehicleModel：知识库里同时有多款车的手册，
    // 此时引用的出处可能来自另一款车——不说这句，用户会把它当成针对自己车的结论。
    const r = await runOwnershipDualPath({ query: "冬天续航", userId: "u1", ctx: REAL });
    assert.ok(
      r.caveats.some((c) => c.includes("可能不是你这一款车")),
      "有出处不等于出处是对的那一款车",
    );
  });

  it("限定了车型就不该再出现这句", async () => {
    setUsageStore(storeWith(20));
    setRagClient({
      async retrieve(a) {
        assert.equal(a.vehicleModel, "Model 3", "车型要一路传到检索层");
        return [{ content: "低温下电池可用容量下降", source: { document: "Model3_车主手册.pdf" }, score: 0.9 }];
      },
    });
    const r = await runOwnershipDualPath({
      query: "冬天续航",
      userId: "u1",
      vehicleModel: "Model 3",
      ctx: REAL,
    });
    assert.ok(!r.caveats.some((c) => c.includes("可能不是你这一款车")));
    assert.equal(r.personalized, true);
  });

  it("零命中时不叠加这句——没检索到东西就谈不上出处对不对", async () => {
    setUsageStore(storeWith(20));
    setRagClient({ async retrieve() { return []; } });
    const r = await runOwnershipDualPath({ query: "冬天续航", userId: "u1", ctx: REAL });
    assert.ok(r.caveats.some((c) => c.includes("没有检索到")));
    assert.ok(!r.caveats.some((c) => c.includes("可能不是你这一款车")));
  });
});

describe("路由：售后与购车（M8-05 / M9-02 的入口）", () => {
  const intent = { goal: "", constraints: [], context: "", riskBoundary: "" };

  for (const q of ["刹车有异响", "仪表盘亮了个黄灯", "底下好像漏油", "去 4S 店能索赔吗"]) {
    it(`「${q}」→ service`, () => {
      assert.equal(decideRoute(intent, q).agent, "service");
    });
  }

  it("**售后优先于用车咨询**：「刹车异响」不是日常用车问题", () => {
    // "这辆车刹车有异响"同时含售后词与用车词。规则顺序保证它落在售后。
    assert.equal(decideRoute(intent, "我这辆车刹车有异响").agent, "service");
  });

  for (const q of ["预算 20 万买什么车", "这两款车对比一下", "落地价大概多少"]) {
    it(`「${q}」→ buying`, () => {
      assert.equal(decideRoute(intent, q).agent, "buying");
    });
  }

  // 下面这组断言的是**图里的那条边**，不是被它调用的函数。
  // 区别很实在：本文件底下"售后走同一条双路"那条测试一直是绿的，
  // 而 `service` 当时根本走不到 `ownershipDual`——它直接调了 runOwnershipDualPath。
  // 测在函数上只能证明函数对，证明不了有人调它。
  it("路由到 service 必须落在双路节点上（不是直接去 answer）", () => {
    assert.equal(branchFor({ agent: "service" }), "ownershipDual");
  });

  it("ownership 与 service 落在同一个节点——知识库切换在节点内部按 ctx.agent 做", () => {
    assert.equal(branchFor({ agent: "ownership" }), branchFor({ agent: "service" }));
  });

  it("出行走行程规划节点（含旧值 trip）；general 与未知目标直接应答", () => {
    assert.equal(branchFor({ agent: "itinerary" }), "itineraryPlan");
    // `trip` 是 M13-13 之前的路由值，历史检查点里还会有——必须映到同一个节点，
    // 否则一次重放会把老会话落到"未知目标"，表现为答非所问。
    assert.equal(branchFor({ agent: "trip" }), "itineraryPlan");
    assert.equal(branchFor({ agent: "general" }), "answer");
    assert.equal(branchFor(undefined), "answer");
  });

  it("**购车与座舱各有自己的节点，不与用车共用**", () => {
    // 购车没有第二路（车还没买），座舱连知识库都没有。
    // 硬套双路只会多出一句"未能读取你的用车数据"——在这两个语境里毫无意义。
    assert.equal(branchFor({ agent: "buying" }), "buyingCatalog");
    assert.equal(branchFor({ agent: "cabin" }), "cabinCompanion");
    assert.notEqual(branchFor({ agent: "buying" }), branchFor({ agent: "ownership" }));
  });

  it("售后走同一条双路，只是换了知识库", async () => {
    setUsageStore(storeWith(20));
    setRagClient({
      async retrieve(a) {
        // 隔离由 datasetsForAgent 在 enterprise/backend/shared/rag 里强制；这里断言 agent 被如实传下去。
        assert.equal(a.agent, "service");
        return [{ content: "刹车片磨损到极限会产生金属摩擦声", source: { document: "维修知识库" }, score: 0.9 }];
      },
    });
    const r = await runOwnershipDualPath({
      query: "刹车异响",
      userId: "u1",
      ctx: { sessionId: "s1", agent: "service", mode: "real" },
    });
    assert.equal(r.personalized, true, "售后同样需要「这辆车」的真实数据");
  });
});
