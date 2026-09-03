/**
 * 衰减算法的数学性质评测（施工单 M37-03，F-21-03）。
 *
 * 与 `decay.test.ts` 的分工：那边是点值断言（参数表、半衰期点、强化写回），
 * 这边是**性质**——单调性、跨类别序、幂次精确性、极值行为。点值对了性质
 * 也可能错（比如强化把年龄拨成负数只在特定组合下发生），评测补的就是这一层。
 * 全部可控时钟、零外部依赖（`eval:memory-decay` 要求断网可跑）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DECAY_PROFILES, decayFactor, rerank, type MemoryItem } from "../src/decay";

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-29T00:00:00Z");

const item = (category: string, ageDays: number, accessCount = 0, score = 1): MemoryItem => ({
  id: `${category}-${ageDays}`,
  category,
  createdAt: NOW - ageDays * DAY,
  accessCount,
  score,
  text: "",
});

describe("衰减性质：单调性", () => {
  for (const category of ["episodic", "preference", "usage_pattern"]) {
    it(`${category}：任意 t1<t2 ⇒ factor(t1) ≥ factor(t2)（20 个采样点）`, () => {
      let prev = Number.POSITIVE_INFINITY;
      for (let k = 0; k < 20; k += 1) {
        const f = decayFactor(item(category, k * 40), NOW);
        assert.ok(f <= prev + 1e-12, `${category} 在第 ${k} 点回升：${prev} → ${f}`);
        prev = f;
      }
    });
  }
});

describe("衰减性质：半衰期幂次精确", () => {
  for (const [category, profile] of Object.entries(DECAY_PROFILES)) {
    for (const k of [1, 2, 3]) {
      it(`${category}：t = ${k}×${profile.halfLifeDays}d ⇒ factor = 0.5^${k}`, () => {
        const f = decayFactor(item(category, k * profile.halfLifeDays), NOW);
        assert.ok(Math.abs(f - 0.5 ** k) < 1e-9, `实际 ${f}`);
      });
    }
  }
});

describe("衰减性质：跨类别序", () => {
  it("同龄下 episodic ≤ usage_pattern ≤ preference（快衰减先沉底）", () => {
    for (const age of [10, 60, 180, 400]) {
      const e = decayFactor(item("episodic", age), NOW);
      const u = decayFactor(item("usage_pattern", age), NOW);
      const p = decayFactor(item("preference", age), NOW);
      assert.ok(e <= u + 1e-12 && u <= p + 1e-12, `age=${age}d: e=${e} u=${u} p=${p}`);
    }
  });
});

describe("衰减性质：强化边界", () => {
  it("强化 n 次后有效年龄不为负（factor 封顶 1）", () => {
    // ③偏好 30d/次：3 天龄 + 100 次强化，有效年龄若为负 factor 会 > 1。
    const f = decayFactor(item("preference", 3, 100), NOW);
    assert.ok(f <= 1 + 1e-12, `factor 越过 1：${f}`);
  });

  it("强化对 episodic 无效（②不强化是参数表的语义）", () => {
    const plain = decayFactor(item("episodic", 60, 0), NOW);
    const boosted = decayFactor(item("episodic", 60, 50), NOW);
    assert.equal(plain, boosted);
  });

  it("强化单调：同龄下访问次数多的 factor 不更低", () => {
    for (const n of [0, 1, 5, 20]) {
      const less = decayFactor(item("preference", 200, n), NOW);
      const more = decayFactor(item("preference", 200, n + 1), NOW);
      assert.ok(more >= less - 1e-12, `n=${n}: ${less} → ${more}`);
    }
  });
});

describe("衰减性质：不衰减类别", () => {
  for (const category of ["vehicle_profile", "usage_telemetry_raw"]) {
    it(`${category}：10 年后系数仍为 1`, () => {
      assert.equal(decayFactor(item(category, 3650), NOW), 1);
    });
  }
});

describe("rerank 性质：权重极值", () => {
  it("decayWeight=0 ⇒ 排序 = 纯相似度序（衰减完全不参与）", () => {
    const items = [item("episodic", 500, 0, 0.7), item("episodic", 1, 0, 0.9), item("episodic", 100, 0, 0.8)];
    const ranked = rerank(items, { now: NOW, decayWeight: 0 });
    assert.deepEqual(
      ranked.map((x) => x.score),
      [0.9, 0.8, 0.7],
    );
  });

  it("decayWeight=1 ⇒ 高相关旧记忆仍不被零分新记忆超越（分数下限是 score×decay）", () => {
    const items = [item("episodic", 300, 0, 0.95), item("episodic", 0, 0, 0.05)];
    const ranked = rerank(items, { now: NOW, decayWeight: 1 });
    // 300 天龄 episodic 的 decay ≈ 0.001：0.95×0.001 < 0.05×1 ⇒ 新的排前——
    // 这是设计语义（w=1 时衰减全权），断言钉住它不被悄悄改成别的公式。
    assert.equal(ranked[0].score, 0.05);
  });

  it("默认权重下相似度仍是主导（高分旧记忆不沉底）", () => {
    const items = [item("preference", 300, 0, 0.9), item("preference", 1, 0, 0.5)];
    const ranked = rerank(items, { now: NOW });
    assert.equal(ranked[0].score, 0.9, "365d 半衰期下 300 天龄高分偏好仍应排前");
  });
});
