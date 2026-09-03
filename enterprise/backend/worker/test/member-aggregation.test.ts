/**
 * 按人聚合（施工单 M17-02，F-46-06/12）。
 *
 * 三条负向断言是本组的重点，它们各自对应一种"看起来正常但结论是错的"结局：
 * 画像文本里出现称呼、删掉的人被下一轮聚合复活、乘车人被算出日均里程。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  runAggregation,
  renderMemberProfileText,
  renderCompanionProfileText,
  type AggregationDeps,
} from "../src/usage-aggregation";

const NOW = 1_770_000_000_000;
const ctx = { from: NOW - 3_600_000, to: NOW, isCatchUp: false };

const summary = (over: Record<string, unknown> = {}) =>
  ({
    windowDays: 30,
    avgDailyKm: 42.5,
    commonChargeHours: [22],
    dominantRoadType: "city" as const,
    sampleSize: 12,
    staleDays: 1,
    derivation: ["12 趟行程合计 1275km / 30 天"],
    ...over,
  }) as never;

const companion = (over: Record<string, unknown> = {}) =>
  ({
    windowDays: 30,
    sampleSize: 6,
    commonHours: [8, 18],
    staleDays: 2,
    derivation: ["同行趟数 = 窗口内 6 条带该成员的行程"],
    ...over,
  }) as never;

/** 只装配整车那半边；按人的部分由每个用例自己补。 */
function baseDeps(over: Partial<AggregationDeps> = {}): AggregationDeps {
  return {
    activeUserIds: async () => ["u1"],
    loadProfile: async () => ({ summary: summary() }),
    clearProfiles: async () => 0,
    writeProfile: async () => {},
    now: () => NOW,
    ...over,
  };
}

describe("按人聚合：画像文本里不能出现称呼（F-46-13 / 约束 1）", () => {
  it("驾驶人画像只带成员标识与角色词", () => {
    const text = renderMemberProfileText("m-abc", summary());
    assert.equal(text.includes("妈"), false);
    assert.equal(text.includes("老婆"), false);
    assert.match(text, /m-abc/);
    assert.match(text, /该驾驶人/);
  });

  it("同行画像同样只带标识，且**不含里程口径**", () => {
    const text = renderCompanionProfileText("m-b", companion());
    assert.match(text, /m-b/);
    assert.match(text, /同行 6 次/);
    assert.equal(/日均里程|公里/.test(text), false, "乘客没开车，给她一个里程数会被当成她开的");
  });
});

describe("按人聚合：写入与清理", () => {
  it("常驾人写驾驶画像，常乘人写同行画像，metadata 带 member_id 与 scope", async () => {
    const writes: Array<{ id: string; scope: string; text: string }> = [];
    await runAggregation(
      ctx,
      baseDeps({
        listMembers: async () => [
          { id: "m-a", roles: ["driver"] },
          { id: "m-b", roles: ["passenger"] },
        ],
        loadMemberProfile: async () => ({ summary: summary() }),
        loadCompanion: async () => ({ summary: companion() }),
        clearMemberProfiles: async () => 0,
        writeMemberProfile: async (_u, id, scope, text) => {
          writes.push({ id, scope, text });
        },
      }),
    );
    assert.deepEqual(
      writes.map((w) => `${w.id}:${w.scope}`),
      ["m-a:driver", "m-b:passenger"],
    );
  });

  it("既常驾又常乘的人两份都写，且只清一次（不互相删掉对方）", async () => {
    let cleared = 0;
    const writes: string[] = [];
    await runAggregation(
      ctx,
      baseDeps({
        listMembers: async () => [{ id: "m-w", roles: ["driver", "passenger"] }],
        loadMemberProfile: async () => ({ summary: summary() }),
        loadCompanion: async () => ({ summary: companion() }),
        clearMemberProfiles: async () => {
          cleared += 1;
          return 1;
        },
        writeMemberProfile: async (_u, _id, scope) => {
          writes.push(scope);
        },
      }),
    );
    assert.deepEqual(writes, ["driver", "passenger"]);
    assert.equal(cleared, 1, "清两次会把刚写好的驾驶画像删掉");
  });

  it("**只对现存成员算**——删掉的人不会被旧流水复活", async () => {
    const writes: string[] = [];
    await runAggregation(
      ctx,
      baseDeps({
        // 名单里已经没有 m-gone 了，即使流水里还留着它的归属也不该产出画像
        listMembers: async () => [{ id: "m-a", roles: ["driver"] }],
        loadMemberProfile: async () => ({ summary: summary() }),
        clearMemberProfiles: async () => 0,
        writeMemberProfile: async (_u, id) => {
          writes.push(id);
        },
      }),
    );
    assert.deepEqual(writes, ["m-a"]);
  });

  it("成员样本为 0 不写画像（同整车那条）", async () => {
    let wrote = false;
    await runAggregation(
      ctx,
      baseDeps({
        listMembers: async () => [{ id: "m-a", roles: ["driver"] }],
        loadMemberProfile: async () => ({ summary: summary({ sampleSize: 0 }) }),
        clearMemberProfiles: async () => 0,
        writeMemberProfile: async () => {
          wrote = true;
        },
      }),
    );
    assert.equal(wrote, false);
  });

  it("未装配按人依赖时整车聚合照常（向后兼容）", async () => {
    const r = await runAggregation(ctx, baseDeps());
    assert.equal(r.changed, 1);
    assert.equal(r.failures.length, 0);
  });
});
