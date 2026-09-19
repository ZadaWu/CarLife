/**
 * 造数生成器（施工单 M82-03）。
 *
 * 全部断言都跑在**计划**上（纯对象，不碰库）——这正是把"算计划"与"写库"
 * 分开的理由：确定性与分布这两件最容易悄悄坏掉的事，能在几毫秒内验完。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SEED_SEGMENTS, SCENES, TOTAL_OWNERS } from "./seed/personas";
import { SCENE_TEMPLATES, templateCount } from "./seed/templates";
import { DEFAULT_SEED, generateSeedPlan, statsOf } from "./seed/generate";
import { assertLocalDatabase, stratifiedSample } from "./seed";

/** 固定"现在"：`generateSeedPlan` 不许读时钟，测试也就不需要容忍时间漂移。 */
const NOW = 1_800_000_000_000;

const plan = generateSeedPlan({ now: NOW });
const stats = statsOf(plan);

describe("[M82-03] 造数：确定性", () => {
  it("同种子两次生成逐字节相同", () => {
    const a = JSON.stringify(generateSeedPlan({ seed: DEFAULT_SEED, now: NOW }));
    const b = JSON.stringify(generateSeedPlan({ seed: DEFAULT_SEED, now: NOW }));
    assert.equal(a, b);
  });

  it("换种子会换出另一批语料——否则 --seed 是个摆设", () => {
    const a = JSON.stringify(generateSeedPlan({ seed: DEFAULT_SEED, now: NOW }));
    const c = JSON.stringify(generateSeedPlan({ seed: DEFAULT_SEED + 1, now: NOW }));
    assert.notEqual(a, c);
  });

  it("messageId / turnId 由种子推出，两次生成对得上（gold set 靠它对回来）", () => {
    const a = generateSeedPlan({ now: NOW }).turns.map((t) => t.turnId);
    const b = generateSeedPlan({ now: NOW }).turns.map((t) => t.turnId);
    assert.deepEqual(a, b);
    assert.equal(new Set(a).size, a.length, "turnId 不许重复");
  });
});

describe("[M82-03] 造数：规模够不够（总览判定 #3）", () => {
  it("≥ 60 车主 / ≥ 60 台车 / ≥ 1,000 轮 / ≥ 800 趟", () => {
    assert.ok(stats.owners >= 60, `车主 ${stats.owners}`);
    assert.ok(stats.vehicles >= 60, `车辆 ${stats.vehicles}`);
    assert.ok(stats.turns >= 1000, `轮次 ${stats.turns}`);
    assert.ok(stats.trips >= 800, `行程 ${stats.trips}`);
  });

  it("车主数与分群声明一致", () => {
    assert.equal(stats.owners, TOTAL_OWNERS);
    assert.equal(stats.vehicles, TOTAL_OWNERS, "每人一台车");
  });

  it("scale 只缩轮次与行程，不缩车主——缩了分群会塌", () => {
    const half = statsOf(generateSeedPlan({ now: NOW, scale: 0.5 }));
    assert.equal(half.owners, stats.owners);
    assert.ok(half.turns < stats.turns);
    assert.ok(half.trips < stats.trips);
  });
});

describe("[M82-03] 造数：分布要撑得起镜头", () => {
  it("恰有一个群 < 10 台车，留给小单元抑制", () => {
    const small = Object.entries(stats.vehiclesBySegment).filter(([, n]) => n < 10);
    assert.equal(small.length, 1, `实际 ${JSON.stringify(stats.vehiclesBySegment)}`);
    assert.equal(small[0][0], "maintenance-outsourced");
    assert.equal(small[0][1], 9);
  });

  it("低温行程的续航折减比落在 0.70–0.75", () => {
    assert.ok(stats.coldFoldRatio.count > 0, "得有低温行程");
    assert.ok(stats.coldFoldRatio.min >= 0.7, `最小 ${stats.coldFoldRatio.min}`);
    assert.ok(stats.coldFoldRatio.max <= 0.75, `最大 ${stats.coldFoldRatio.max}`);
  });

  it("长途群真的有 > 200 km 的行程", () => {
    assert.ok(stats.longTrips >= 50, `实际 ${stats.longTrips} 趟`);
  });

  it("家庭共用群约 30% 的行程不知道谁开的（空 ≠ 车主）", () => {
    assert.ok(
      stats.familyDriverUnknownRatio > 0.2 && stats.familyDriverUnknownRatio < 0.4,
      `实际 ${(stats.familyDriverUnknownRatio * 100).toFixed(1)}%`,
    );
  });

  it("五个场景都有语料，且反例句占比在 5%–20%", () => {
    for (const s of SCENES) assert.ok(stats.scenes[s] > 0, `场景 ${s} 没有语料`);
    assert.ok(
      stats.counterRatio > 0.05 && stats.counterRatio < 0.2,
      `反例占比 ${(stats.counterRatio * 100).toFixed(1)}%——主题必须保留反例成员`,
    );
  });

  it("每个场景 ≥ 20 句模板", () => {
    for (const s of SCENES) assert.ok(templateCount(s) >= 20, `${s} 只有 ${templateCount(s)} 句`);
  });
});

describe("[M82-03] 造数：语料本身就该是干净的", () => {
  const PHONE = /\b1[3-9]\d{9}\b/;
  const VIN17 = /\b[A-HJ-NPR-Z0-9]{17}\b/;

  it("模板里没有手机号 / VIN 形状——脱敏是第二层，不是第一层", () => {
    for (const s of SCENES) {
      for (const u of SCENE_TEMPLATES[s]) {
        assert.ok(!PHONE.test(u.text), `${s}: ${u.text}`);
        assert.ok(!VIN17.test(u.text), `${s}: ${u.text}`);
      }
    }
  });

  it("生成出来的话语同样干净", () => {
    for (const t of plan.turns) {
      assert.ok(!PHONE.test(t.userText), t.userText);
      assert.ok(!VIN17.test(t.userText), t.userText);
    }
  });

  it("话语像 ASR 转写：不带句号逗号", () => {
    const withPunct = plan.turns.filter((t) => /[，。？！]/.test(t.userText));
    assert.equal(withPunct.length, 0, `有 ${withPunct.length} 句带标点，例如「${withPunct[0]?.userText}」`);
  });

  it("语音轮才有 asrEngine，文字轮恒为 null", () => {
    for (const t of plan.turns) {
      if (t.source === "voice") assert.equal(t.asrEngine, "ark", t.turnId);
      else assert.equal(t.asrEngine, null, t.turnId);
    }
  });

  it("VIN 是 17 位且含字母（过得了 pii.ts 的字符集）", () => {
    for (const v of plan.vehicles) {
      assert.equal(v.vin.length, 17, v.vin);
      assert.match(v.vin, /^[A-HJ-NPR-Z0-9]{17}$/, v.vin);
      assert.match(v.vin, /[A-HJ-NPR-Z]/, v.vin);
    }
    assert.equal(new Set(plan.vehicles.map((v) => v.vin)).size, plan.vehicles.length, "VIN 不许撞");
  });

  it("少量轮次带 guard 拦截，boundary 角色才有真实语料", () => {
    const denied = plan.turns.filter((t) => t.guardDenied).length;
    assert.ok(denied > 0 && denied / plan.turns.length < 0.1, `拦截轮 ${denied} / ${plan.turns.length}`);
  });
});

describe("[M82-03] 造数：时间铺在过去 90 天", () => {
  it("轮次与行程的时刻都落在窗内", () => {
    for (const t of plan.turns) {
      assert.ok(t.ts >= plan.window.from && t.ts <= plan.window.to, `轮 ${t.turnId} 在窗外`);
    }
    for (const t of plan.trips) {
      assert.ok(t.endedAt >= plan.window.from && t.endedAt <= plan.window.to, `趟 ${t.id} 在窗外`);
      assert.ok(t.startedAt < t.endedAt, `趟 ${t.id} 起止倒置`);
    }
  });

  it("跨度确实接近 90 天，不是全挤在一天", () => {
    const ts = plan.turns.map((t) => t.ts);
    const spanDays = (Math.max(...ts) - Math.min(...ts)) / 86_400_000;
    assert.ok(spanDays > 80, `实际跨度 ${spanDays.toFixed(1)} 天`);
  });
});

describe("[M82-03] 造数：闸与工具", () => {
  it("拒绝对非本机库造数", () => {
    assert.throws(() => assertLocalDatabase("postgresql://u:p@db.prod.internal:5432/carlife"), /拒绝对非本机库造数/);
    assert.throws(() => assertLocalDatabase(undefined), /缺少 DATABASE_URL/);
  });

  it("本机地址放行", () => {
    assert.doesNotThrow(() => assertLocalDatabase("postgresql://carlife:x@localhost:55433/carlife"));
    assert.doesNotThrow(() => assertLocalDatabase("postgresql://carlife:x@127.0.0.1:55433/carlife"));
  });

  it("分层抽样：小层也抽得到，且两次抽样结果相同", () => {
    const items = [
      ...Array.from({ length: 100 }, (_, i) => ({ k: "big", i })),
      ...Array.from({ length: 3 }, (_, i) => ({ k: "small", i })),
    ];
    const picked = stratifiedSample(items, (x) => x.k, 10);
    assert.equal(picked.length, 10);
    assert.ok(picked.some((x) => x.k === "small"), "小层一条都没抽到——按比例分配就会这样");
    assert.deepEqual(picked, stratifiedSample(items, (x) => x.k, 10));
  });

  it("分群声明本身自洽：id 不重复、权重为正", () => {
    assert.equal(new Set(SEED_SEGMENTS.map((s) => s.id)).size, SEED_SEGMENTS.length);
    for (const s of SEED_SEGMENTS) {
      assert.ok(s.owners > 0, s.id);
      assert.ok(s.scenes.length > 0, s.id);
      for (const w of s.scenes) assert.ok(w.weight > 0, `${s.id}/${w.scene}`);
    }
  });
});
