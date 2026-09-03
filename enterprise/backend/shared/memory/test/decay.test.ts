/**
 * 按类衰减 re-rank 单测（施工单 M7-01，§7 薄封装第 2 件事）。零依赖、不连 Mem0。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DECAY_PROFILES, decayFactor, rerank, reinforce, type MemoryItem } from "../src/decay";
import { MEMORY_TAXONOMY } from "../src/taxonomy";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const item = (over: Partial<MemoryItem> = {}): MemoryItem => ({
  id: "m1",
  category: "episodic",
  createdAt: NOW,
  score: 0.9,
  text: "某条记忆",
  ...over,
});

describe("衰减参数按 §7 表", () => {
  it("三类的半衰期分别是 30 / 365 / 180 天", () => {
    assert.equal(DECAY_PROFILES.episodic.halfLifeDays, 30);
    assert.equal(DECAY_PROFILES.preference.halfLifeDays, 365);
    assert.equal(DECAY_PROFILES.usage_pattern.halfLifeDays, 180);
  });

  it("**只有③⑥有访问强化**，②没有——一年前的排队情况不该越查越牢", () => {
    assert.equal(DECAY_PROFILES.preference.reinforceOnAccess, true);
    assert.equal(DECAY_PROFILES.usage_pattern.reinforceOnAccess, true);
    assert.equal(DECAY_PROFILES.episodic.reinforceOnAccess, false);
  });
});

describe("衰减系数", () => {
  it("刚写入时为 1", () => {
    assert.equal(decayFactor(item(), NOW), 1);
  });

  it("恰好一个半衰期后为 0.5", () => {
    const f = decayFactor(item({ createdAt: NOW - 30 * DAY }), NOW);
    assert.ok(Math.abs(f - 0.5) < 1e-9);
  });

  it("③偏好衰减远慢于②情景——同样 30 天后差一个量级", () => {
    const ep = decayFactor(item({ category: "episodic", createdAt: NOW - 30 * DAY }), NOW);
    const pref = decayFactor(item({ category: "preference", createdAt: NOW - 30 * DAY }), NOW);
    assert.ok(pref > ep * 1.8, `偏好 ${pref} 应显著高于情景 ${ep}`);
  });

  it("**未登记的类别不衰减**——宁可不衰减，也不按猜出来的半衰期衰减", () => {
    assert.equal(decayFactor(item({ category: "vehicle_profile", createdAt: NOW - 1000 * DAY }), NOW), 1);
  });

  it("访问强化把有效年龄往回拨，但**不能拨成负数**（否则比新记忆还新）", () => {
    const old = item({ category: "preference", createdAt: NOW - 10 * DAY, accessCount: 100 });
    const f = decayFactor(old, NOW);
    assert.ok(f <= 1, `强化后系数不得超过 1，实际 ${f}`);
    assert.ok(Math.abs(f - 1) < 1e-9, "年龄被拨到 0，系数应为 1");
  });

  it("访问强化确实提升了权重", () => {
    const base = item({ category: "preference", createdAt: NOW - 400 * DAY });
    const used = { ...base, accessCount: 5 };
    assert.ok(decayFactor(used, NOW) > decayFactor(base, NOW));
  });
});

describe("re-rank", () => {
  it("同等相似度下新的排前面", () => {
    const older = item({ id: "old", createdAt: NOW - 120 * DAY });
    const newer = item({ id: "new", createdAt: NOW });
    assert.equal(rerank([older, newer], { now: NOW })[0].id, "new");
  });

  it("**相似度仍是主导**——高度相关的旧记忆不会被彻底沉底", () => {
    const relevantOld = item({ id: "old", createdAt: NOW - 60 * DAY, score: 0.95 });
    const irrelevantNew = item({ id: "new", createdAt: NOW, score: 0.2 });
    assert.equal(
      rerank([irrelevantNew, relevantOld], { now: NOW })[0].id,
      "old",
      "衰减是降低陈旧信息权重，不是只看新的",
    );
  });

  it("decayWeight=0 时退化为纯相似度排序", () => {
    const old = item({ id: "old", createdAt: NOW - 300 * DAY, score: 0.9 });
    const fresh = item({ id: "new", createdAt: NOW, score: 0.8 });
    assert.equal(rerank([fresh, old], { now: NOW, decayWeight: 0 })[0].id, "old");
  });

  it("不改动入参数组（纯函数）", () => {
    const items = [item({ id: "a" }), item({ id: "b", createdAt: NOW - 90 * DAY })];
    const before = items.map((i) => i.id);
    rerank(items, { now: NOW });
    assert.deepEqual(items.map((i) => i.id), before);
  });
});

describe("访问强化写回", () => {
  it("③偏好被访问后计数加一", () => {
    const r = reinforce(item({ category: "preference" }), NOW);
    assert.equal(r.accessCount, 1);
    assert.equal(r.lastAccessedAt, NOW);
  });

  it("②情景不强化——原样返回", () => {
    const src = item({ category: "episodic" });
    assert.equal(reinforce(src, NOW), src);
  });
});

describe("六类接入进度（M7-06，供运营记忆页）", () => {
  it("六类齐全且 id 唯一", () => {
    assert.equal(MEMORY_TAXONOMY.length, 6);
    assert.equal(new Set(MEMORY_TAXONOMY.map((c) => c.id)).size, 6);
  });

  it("**taxonomy 里不得出现接线状态**——它会过期，而过期的状态说明比没有更糟", () => {
    // 这里曾有 `connected: false` 写死在 ②③④⑤⑥ 上。等到它们真接上时，
    // 没人回来改，运营页就照着渲染出"未接入：Mem0 尚未部署"——
    // 而 Mem0 早就在跑了。状态只能来自运行时，静态文件里不留第二份副本。
    for (const c of MEMORY_TAXONOMY) {
      assert.ok(
        !("connected" in c),
        `${c.id} 又有了 connected：接线状态只能由 /console/memory/overview 自报`,
      );
    }
  });

  it("note 只描述这一类**是什么**，不断言接没接", () => {
    for (const c of MEMORY_TAXONOMY) {
      assert.ok(
        !/未接入|尚未部署|已接入/.test(c.note),
        `${c.id} 的 note 里含接入状态判断：「${c.note}」`,
      );
    }
  });

  it("每类都写了存放位置与衰减策略——§7 分治写错就是架构错误", () => {
    for (const c of MEMORY_TAXONOMY) {
      assert.ok(c.storage.length > 0, `${c.id} 缺 storage`);
      assert.ok(c.decay.length > 0, `${c.id} 缺 decay`);
    }
  });
});
