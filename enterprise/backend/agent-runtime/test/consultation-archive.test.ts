/**
 * 问诊留档与一次性建档引导单测（施工单 M14-03，F-20-13 / F-23-12）。零依赖。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  archiveIntent,
  buildConsultationArchive,
  type ConsultationState,
} from "../src/graph/subgraphs/service";
import { maybeOnboardingGuidance, setUserFlagStore } from "../src/graph/subgraphs/ownership";
import { CONFIRM_REQUIRED_TOOLS } from "../src/guard/http-endpoint";

const consultation: ConsultationState = {
  symptom: "低速刹车有金属摩擦声",
  sessionId: "sess-m14",
  at: Date.UTC(2026, 7, 12),
  resolutionSummary: "建议先自查刹车片厚度，风险中等",
};

describe("留档意图门（F-20-13）", () => {
  it("明确要求记录的命中", () => {
    assert.equal(archiveIntent("帮我把这次问诊记录到档案里"), true);
    assert.equal(archiveIntent("把这次的维修情况记下来"), true);
    assert.equal(archiveIntent("留档一下这次问诊"), true);
  });

  it("普通问诊不命中——「记一下」误触发会覆盖真正的症状", () => {
    assert.equal(archiveIntent("我的车低速刹车有异响"), false);
    assert.equal(archiveIntent("刹车片多久换一次"), false);
  });
});

describe("留档计划组装（F-20-13）", () => {
  it("档案+问诊齐备 → ready，参数带 sessionId / source=问诊 / 风险标注", () => {
    const plan = buildConsultationArchive({
      profile: { vin: "LSVAA49P4E2123456", odometerKm: 21_000 },
      consultation: { ...consultation, riskLevel: "medium" },
    });
    assert.equal(plan.kind, "ready");
    if (plan.kind !== "ready") return;
    assert.equal(plan.writeArgs.op, "repair");
    assert.equal(plan.writeArgs.sessionId, "sess-m14", "原图靠会话句柄回看（F-20-13）");
    assert.equal(plan.writeArgs.source, "问诊");
    assert.match(plan.writeArgs.resolution ?? "", /中风险/);
    assert.ok(plan.disclosures.some((d) => d.includes("只追加")), "弹窗必须说清写入不可修改");
  });

  it("无风险分级时不编级别——resolution 里不出现风险字样", () => {
    const plan = buildConsultationArchive({
      profile: { vin: "LSVAA49P4E2123456", odometerKm: 21_000 },
      consultation,
    });
    assert.equal(plan.kind, "ready");
    if (plan.kind !== "ready") return;
    // 摘要原文里怎么说风险是模型的事；**不编的是我们外挂的分级标签**。
    assert.ok(!/【(低|中|高)风险】/.test(plan.writeArgs.resolution ?? ""));
  });

  it("无档案 → 跳过留档且话术指向建档（与 F-23-12 引导共用动作）", () => {
    const plan = buildConsultationArchive({ consultation });
    assert.equal(plan.kind, "no-profile");
    if (plan.kind !== "no-profile") return;
    assert.match(plan.note, /建档/);
  });

  it("无问诊内容 / 已留档 → 不重复写", () => {
    assert.equal(buildConsultationArchive({}).kind, "no-consultation");
    const again = buildConsultationArchive({
      profile: { vin: "LSVAA49P4E2123456", odometerKm: 21_000 },
      consultation: { ...consultation, archived: true },
    });
    assert.equal(again.kind, "no-consultation");
    if (again.kind === "no-consultation") assert.match(again.note, /已经留档/);
  });
});

describe("权限门集合（M14-03 堵洞）", () => {
  it("**vehicle_profile_write 必须在需确认集合里**——sensitive 不在集合=自动放行", () => {
    assert.ok(CONFIRM_REQUIRED_TOOLS.has("vehicle_profile_write"));
  });
});

describe("一次性建档引导（F-23-12）", () => {
  let flags: Map<string, Set<string>>;
  let failing: boolean;

  beforeEach(() => {
    flags = new Map();
    failing = false;
    setUserFlagStore({
      async has(userId, flag) {
        if (failing) throw new Error("db down");
        return flags.get(userId)?.has(flag) ?? false;
      },
      async set(userId, flag) {
        if (failing) throw new Error("db down");
        const set = flags.get(userId) ?? new Set();
        set.add(flag);
        flags.set(userId, set);
      },
    });
  });

  it("首次无档案 → 引导出现且标记置位；第二次 → 不再引导", async () => {
    const first = await maybeOnboardingGuidance({ hasProfile: false, userId: "u1" });
    assert.ok(first?.includes("建档"), "首次要引导");
    const second = await maybeOnboardingGuidance({ hasProfile: false, userId: "u1" });
    assert.equal(second, undefined, "一次性：第二轮不再引导");
  });

  it("有档案 → 不引导也不置标记（机会留给真没档案的时刻）", async () => {
    assert.equal(await maybeOnboardingGuidance({ hasProfile: true, userId: "u2" }), undefined);
    assert.equal(flags.has("u2"), false);
  });

  it("**无 userId → 不引导不置标记**——匿名会话引导了也白引导", async () => {
    assert.equal(await maybeOnboardingGuidance({ hasProfile: false }), undefined);
    assert.equal(flags.size, 0);
  });

  it("标记存储故障 → 本轮不引导但**不烧掉引导机会**", async () => {
    failing = true;
    assert.equal(await maybeOnboardingGuidance({ hasProfile: false, userId: "u3" }), undefined);
    failing = false;
    const next = await maybeOnboardingGuidance({ hasProfile: false, userId: "u3" });
    assert.ok(next, "存储恢复后仍能引导——故障那轮没有置位");
  });
});
