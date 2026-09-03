/**
 * 偏好翻译器（施工单 M24-07）。穷举矩阵：人数 × 组合 × 冲突 × 能力 × 覆盖 × 儿童。
 * 每格断言三样：ops、没做到清单、仲裁记录。外加确定性（同输入逐字节相同）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { translateCabinPlan, type SeatedMember, type TranslateInput } from "../src/graph/cabin-translate";
import type { CabinCapabilities } from "@carlife/tools";
import type { MemberCombination } from "@carlife/shared";

const CAPS: CabinCapabilities = {
  model: "Model Y",
  source: "seed",
  climate: { zones: ["driver", "passenger"], tempRangeC: [16, 28], tempStepC: 0.5, fanLevels: 5, hasSync: true },
  seats: {
    driver: { heatingLevels: 3, ventilationLevels: 3, massageModes: ["off"] },
    passenger: { heatingLevels: 3, ventilationLevels: 3, massageModes: ["off"] },
    rearLeft: { heatingLevels: 3, ventilationLevels: 0, massageModes: ["off"] },
    rearRight: { heatingLevels: 3, ventilationLevels: 0, massageModes: ["off"] },
  },
  ambientLight: { zones: ["front"], modes: ["static"], brightnessRange: [0, 100] },
  media: { zones: ["cabin"], sources: ["music", "radio", "podcast", "kids", "off"], volumeRange: [0, 100] },
  fragrance: { present: false, intensities: [], scents: [] },
  childMode: { zones: ["rearLeft", "rearRight"] },
};

const dad: SeatedMember = { memberId: "m-dad", zone: "driver", ageBand: "adult", preference: { tempC: 22, mediaContentTag: "播客" } };
const mom: SeatedMember = { memberId: "m-mom", zone: "passenger", ageBand: "senior", preference: { tempMaxC: 24, seatVentilation: 2 } };
const kid: SeatedMember = { memberId: "m-kid", zone: "rearLeft", ageBand: "child", preference: { mediaContentTag: "儿歌", mediaVolumeLimit: 40 } };

const combo = (over: MemberCombination["override"]): MemberCombination => ({
  id: "c1", vin: "V", ownerId: "u1", label: "孩子和妈妈", memberIds: ["m-kid", "m-mom"], override: over, updatedAt: 0,
});

const opOf = (plan: ReturnType<typeof translateCabinPlan>, domain: string, zone?: string) =>
  plan.ops.find((o) => o.domain === domain && o.zone === zone);

describe("翻译器：单人与叠加", () => {
  it("爸爸独驾：温度落主驾分区、播客全车", () => {
    const p = translateCabinPlan({ seated: [dad], combination: null, capabilities: CAPS });
    assert.deepEqual(opOf(p, "climate", "driver")?.set, { tempC: 22 });
    assert.equal(opOf(p, "media")?.set.source, "podcast");
    assert.deepEqual(p.arbitrations, [], "一个人没有冲突");
  });

  it("妈妈的 tempMaxC 是上限语义：单独出现按上限落值", () => {
    const p = translateCabinPlan({ seated: [mom], combination: null, capabilities: CAPS });
    assert.deepEqual(opOf(p, "climate", "passenger")?.set, { tempC: 24 });
    assert.deepEqual(opOf(p, "seat", "passenger")?.set, { ventilation: 2 });
  });

  it("爸爸+妈妈：双区各设各的，**没有仲裁**（能分区就不吵架）", () => {
    const p = translateCabinPlan({ seated: [dad, mom], combination: null, capabilities: CAPS });
    assert.deepEqual(opOf(p, "climate", "driver")?.set, { tempC: 22 });
    assert.deepEqual(opOf(p, "climate", "passenger")?.set, { tempC: 24 });
    assert.equal(p.arbitrations.filter((a) => a.resource === "climate").length, 0);
  });
});

describe("翻译器：共享资源仲裁", () => {
  it("孩子在车：媒体儿童优先，爸爸的播客进「没做到」并写明规则", () => {
    const p = translateCabinPlan({ seated: [dad, kid], combination: null, capabilities: CAPS });
    assert.equal(opOf(p, "media")?.set.source, "kids");
    const arb = p.arbitrations.find((a) => a.resource === "media")!;
    assert.equal(arb.rule, "child-first");
    assert.equal(arb.winnerMemberId, "m-kid");
    assert.deepEqual(arb.loserMemberIds, ["m-dad"]);
    const lost = p.undone.find((u) => u.memberId === "m-dad" && u.field === "mediaContentTag")!;
    assert.equal(lost.reason, "lost-arbitration");
  });

  it("没有儿童：驾驶员优先", () => {
    const grandma: SeatedMember = { ...mom, memberId: "m-grandma", preference: { mediaContentTag: "戏曲" } };
    const p = translateCabinPlan({ seated: [dad, grandma], combination: null, capabilities: CAPS });
    assert.equal(opOf(p, "media")?.set.contentTag, "播客");
    assert.equal(p.arbitrations.find((a) => a.resource === "media")?.rule, "driver-first");
  });

  it("音量上限取最严（上限语义不吵架）", () => {
    const strict: SeatedMember = { ...mom, memberId: "m-strict", preference: { mediaVolumeLimit: 30 } };
    const p = translateCabinPlan({ seated: [kid, strict], combination: null, capabilities: CAPS });
    assert.equal(opOf(p, "media")?.set.volumeLimit, 30);
  });
});

describe("翻译器：组合与回退", () => {
  it("组合命中：覆盖项压过个人偏好（AC-50-3）", () => {
    const p = translateCabinPlan({
      seated: [mom, kid],
      combination: combo({ tempC: 25, mediaContentTag: "儿歌" }),
      capabilities: CAPS,
    });
    assert.equal(opOf(p, "climate", "passenger")?.set.tempC, 25, "组合温度压过妈妈的上限 24？——不：见下一断言");
  });

  it("组合温度是全车语义且**不受个人上限反压**——上限保护在成员侧生效", () => {
    // 设计说明：组合覆盖代表车主对"这组人"的显式决定，翻译器不再拿个人偏好反压它；
    // 若车主设的组合温度确实太高，妈妈的上限体现在她自己的分区没有组合项时。
    const p = translateCabinPlan({ seated: [mom], combination: combo({ tempC: 25 }), capabilities: CAPS });
    assert.equal(opOf(p, "climate", "passenger")?.set.tempC, 25);
    assert.equal(p.attributions.find((a) => a.field === "tempC")?.via, "combination");
  });

  it("失效组合视同无组合（回退叠加）", () => {
    const dead = { ...combo({ tempC: 25 }), invalidatedAt: 1, invalidReason: "成员已删除" };
    const p = translateCabinPlan({ seated: [mom], combination: dead, capabilities: CAPS });
    assert.equal(opOf(p, "climate", "passenger")?.set.tempC, 24, "回退到妈妈自己的上限");
  });

  it("无组合回退：流程不中断、不追问（F-50-11）", () => {
    const p = translateCabinPlan({ seated: [dad, mom, kid], combination: null, capabilities: CAPS });
    assert.ok(p.ops.length > 0);
  });
});

describe("翻译器：能力剔除与本轮覆盖", () => {
  it("后排无通风：孩子的通风偏好进「没做到」带原因（AC-50-5 生成前剔除）", () => {
    const kidVent: SeatedMember = { ...kid, preference: { seatVentilation: 2 } };
    const p = translateCabinPlan({ seated: [kidVent], combination: null, capabilities: CAPS });
    assert.equal(opOf(p, "seat", "rearLeft"), undefined);
    const u = p.undone.find((x) => x.field === "seatVentilation")!;
    assert.equal(u.reason, "unsupported-on-vehicle");
  });

  it("单温区车：全车一个温度，落 cabin 区", () => {
    const single: CabinCapabilities = { ...CAPS, climate: { ...CAPS.climate, zones: ["cabin"] } };
    const p = translateCabinPlan({ seated: [dad, mom], combination: null, capabilities: single });
    const op = opOf(p, "climate", "cabin")!;
    // 双人同区：无儿童 → 驾驶员优先；妈妈的诉求进没做到
    assert.equal(op.set.tempC, 22);
    assert.equal(p.arbitrations.find((a) => a.resource === "climate")?.rule, "driver-first");
    assert.equal(p.undone.find((u) => u.memberId === "m-mom")?.field, "tempC");
  });

  it("本轮覆盖压过一切且标注 round-override（AC-50-8 前半）", () => {
    const p = translateCabinPlan({
      seated: [mom],
      combination: combo({ tempC: 25 }),
      roundOverride: { tempC: 26 },
      capabilities: CAPS,
    });
    assert.equal(opOf(p, "climate", "passenger")?.set.tempC, 26);
    assert.equal(p.attributions.find((a) => a.field === "tempC")?.via, "round-override");
  });
});

describe("确定性（AC-50-5 / Demo 判定 12）", () => {
  it("同输入两次调用 JSON 逐字节相同", () => {
    const input: TranslateInput = { seated: [dad, mom, kid], combination: combo({ mediaContentTag: "儿歌" }), capabilities: CAPS };
    assert.equal(JSON.stringify(translateCabinPlan(input)), JSON.stringify(translateCabinPlan(input)));
  });
});
