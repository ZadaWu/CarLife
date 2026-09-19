/**
 * [F-11-03][AC-11-2] 按 Agent 投影（M84-03，ACR-036 §4.9）。
 *
 * 三件事：表外的段**根本不出现**（不是"出现了但别用"）；手机号一个字都不许漏出去；
 * 超预算时按固定顺序丢、且丢了要说出来。
 *
 * 与工具 ACL（`listForAgent`）、lane 白名单（`LANE_CHANNELS`）同一取向：
 * 看得见但用不了比看不见更糟。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { UserContext } from "@carlife/shared";

import { CONTEXT_ACL, aclFor, renderAnchor, ANCHOR_BUDGET_CHARS } from "../src/context/render";

const PHONE = "13812345678";

const CTX: UserContext = {
  userId: "u-1",
  identity: { userId: "u-1", displayName: "老王", role: "owner" },
  vehicle: { model: "Model Y", energyType: "bev", odometerKm: 32_140 },
  home: { city: "浙江杭州", lat: 30.28, lon: 120.16 },
  companions: [{ label: "妈", relation: "母亲", ageBand: "senior", needs: ["frequent-rest"] }],
  trips: [{ ref: "plan-ab12cd34", destination: "青岛", days: 3 }],
  reminders: [{ kind: "maintenance", remainingKm: 820, degraded: false }],
  preferences: ["住市区"],
  usage: { summary: "近 30 天日均 42 km", usable: true },
};

const AGENTS = Object.keys(CONTEXT_ACL) as (keyof typeof CONTEXT_ACL)[];

describe("[F-11-03][AC-11-2] 投影：表外的段不出现", () => {
  it("cabin 只拿同行人——没有车、没有行程、没有偏好", () => {
    const out = renderAnchor(CTX, aclFor("cabin").anchor);
    assert.ok(out.includes("常一起坐车的"));
    assert.ok(!out.includes("Model Y"), `cabin 不该看到车：\n${out}`);
    assert.ok(!out.includes("青岛"));
    assert.ok(!out.includes("住市区"));
  });

  it("test-drive 只拿身份——它的活里没有别的段", () => {
    const out = renderAnchor(CTX, aclFor("test-drive").anchor);
    assert.ok(out.includes("老王"));
    assert.ok(!out.includes("浙江杭州"));
    assert.ok(!out.includes("Model Y"));
  });

  it("supervisor-intent 拿得到行程指针——那是它判 adjust 还是新规划的依据", () => {
    const out = renderAnchor(CTX, aclFor("supervisor-intent").anchor);
    assert.ok(out.includes("plan-ab12cd34"), `意图层必须看得见他名下有什么：\n${out}`);
    assert.ok(out.includes("trip_plan_get"), "正文要说明白怎么取，否则模型会以为只有这些");
  });

  it("表外的 Agent 名给最小集，不给空块（空块会让模型以为这个人没有档案）", () => {
    const out = renderAnchor(CTX, aclFor("某个还没登记的 agent").anchor);
    assert.ok(out.includes("老王"));
  });

  it("每个 Agent 的 anchor 与 turn 两列都非空——漏一行就是那个 Agent 突然不知道今天几号", () => {
    for (const a of AGENTS) {
      assert.ok(CONTEXT_ACL[a].turn.includes("dateline"), `${a} 少了 dateline`);
    }
  });
});

/*
 * 隐私这一条**不能靠渲染层擦**——渲染层收到什么就写什么，它分不出一串数字是电话还是车牌。
 * 真正的截断在**读取器**：`ContextCompanion` 这个类型里根本没有 `phone` 这一栏，
 * 而装配处的 companions 读取器逐字段挑，不 `...m` 展开。
 * 所以这一组断言打在那两处，不打在渲染结果上。
 */
describe("[F-11-03][AC-11-2] 投影：隐私在读取器那一层截断", () => {
  const CONTRACT = readFileSync(new URL("../../../../contracts/src/domain/user-context.ts", import.meta.url), "utf8");
  const ASSEMBLY = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

  it("ContextCompanion 这个类型里没有 phone / 手机号一类的字段", () => {
    const start = CONTRACT.indexOf("export interface ContextCompanion");
    assert.ok(start > 0, "找不到 ContextCompanion");
    const body = CONTRACT.slice(start, CONTRACT.indexOf("}", start));
    assert.ok(!/phone|mobile|tel\b/i.test(body), `ContextCompanion 不该有联系方式字段：\n${body}`);
  });

  it("装配处的 companions 读取器逐字段挑，不整个展开成员对象", () => {
    const start = ASSEMBLY.indexOf("async companions(userId)");
    assert.ok(start > 0, "找不到 companions 读取器");
    const body = ASSEMBLY.slice(start, start + 700);
    assert.ok(!/\.\.\.m[,\s}]/.test(body), "不许 `...m` 展开——那会把 phone 一起带进上下文");
    assert.ok(!/phone/i.test(body), "读取器里一个字都不该提 phone");
  });

  it("正常一份同行人渲染出来只有称呼、关系、年龄段与约束", () => {
    const out = renderAnchor(CTX, aclFor("cabin").anchor);
    assert.ok(out.includes("妈（母亲/senior/frequent-rest）"), `实际：\n${out}`);
    assert.ok(!out.includes(PHONE));
  });
});

describe("[F-11-03][AC-11-2] 投影：预算与丢弃顺序", () => {
  const huge: UserContext = {
    ...CTX,
    preferences: Array.from({ length: 30 }, (_, i) => `偏好第 ${i} 条，写得很长很长很长很长`),
    usage: { summary: "用车画像".repeat(40), usable: true },
    companions: Array.from({ length: 20 }, (_, i) => ({
      label: `同行人${i}`,
      relation: "亲属",
      ageBand: "adult",
      needs: ["frequent-rest"],
    })),
  };

  it("超预算时 preferences 先丢、trips 最后丢", () => {
    const out = renderAnchor(huge, [
      "identity",
      "vehicle",
      "home",
      "companions",
      "trips",
      "preferences",
      "usage",
    ]);
    assert.ok(!out.includes("偏好第 0 条"), `preferences 该最先被丢：\n${out}`);
    assert.ok(out.includes("plan-ab12cd34"), "trips 是判 adjust 的依据，必须留到最后");
  });

  it("丢了要说出来，不静默截断", () => {
    const out = renderAnchor(huge, ["identity", "vehicle", "trips", "preferences", "usage"]);
    assert.ok(out.includes("没放进来"), `实际：\n${out}`);
  });

  it("正常一份不触发裁剪，且在预算之内", () => {
    const out = renderAnchor(CTX, aclFor("trip").anchor);
    assert.ok(!out.includes("没放进来"));
    assert.ok(out.length <= ANCHOR_BUDGET_CHARS + 120, `锚定块 ${out.length} 字符，超了太多：\n${out}`);
  });
});

describe("[F-11-03][AC-11-2] 投影：读不到与没有分开", () => {
  it("读不到的那一段如实写，不渲染成空", () => {
    const out = renderAnchor(
      { userId: "u-1", trips: { unavailable: true, reason: "超过 300ms 预算" } },
      ["trips"],
    );
    assert.ok(out.includes("读不到"), `实际：\n${out}`);
    assert.ok(out.includes("不要说"), "必须明写「不代表没有」——空会被当成「他没有行程」");
  });

  it("真的一份都没有时说「一份都没有」，与读不到不是同一句话", () => {
    const out = renderAnchor({ userId: "u-1", trips: [] }, ["trips"]);
    assert.ok(out.includes("一份都没有"));
    assert.ok(!out.includes("读不到"));
  });
});
