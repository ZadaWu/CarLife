/**
 * [F-11-10][AC-11-7] 次要意图：模型说了算，正则只在它没表态时兜底。
 *
 * 留档、保养推算、维修记录预取这三类门，此前各用一张正则表判字面
 * （「记录 / 留档 / 记下 + 档案 / 问诊」「保养 / 机油 / 首保」「修过 / 维修记录」）。
 * 与行程那六个处置判定栽的是同一个跟头：判据是字面的，而人的说法不是。
 *
 * 候选表是**封闭**的——让模型自由发挥会得到一堆同义异形的标签，下游没法用。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { claimFactsLine, parseIntent, SECONDARY_INTENTS } from "../src/graph/intent";
import { archiveIntent, wantsArchive } from "../src/graph/subgraphs/service";
import { isMaintenanceQuery, repairContextNeeds, wantsMaintenance } from "../src/graph/subgraphs/ownership";

describe("[F-11-10] 解析：白名单过滤", () => {
  it("表内的留下，表外的一律丢——下游拿它去比较永远不等", () => {
    const r = parseIntent('{"goal":"记一下","secondaryIntents":["archive","飞天遁地","maintenance"]}', "原话");
    assert.deepEqual(r.secondaryIntents, ["archive", "maintenance"]);
  });

  it("一个都没有就整栏不给——下游据此回落到字面判据", () => {
    assert.equal(parseIntent('{"goal":"随便聊聊"}', "x").secondaryIntents, undefined);
    assert.equal(parseIntent('{"goal":"x","secondaryIntents":[]}', "x").secondaryIntents, undefined);
    assert.equal(parseIntent('{"goal":"x","secondaryIntents":["乱写的"]}', "x").secondaryIntents, undefined);
  });

  it("候选表七项，加项时要同步改说明与吃它的那个门", () => {
    assert.deepEqual(
      [...SECONDARY_INTENTS],
      ["archive", "maintenance", "repair_history", "repair_quote", "insurance_claim", "claim_materials", "entitlement"],
    );
  });
});

describe("[M96-03] 出险估损与事故类型：从意图 JSON 取，不从原话抠（ADR-012）", () => {
  it("说了数就收整数；字符串数字也收；没说就缺席", () => {
    assert.equal(parseIntent('{"goal":"x","estimatedLossCny":2000}', "大概两千块").estimatedLossCny, 2000);
    assert.equal(parseIntent('{"goal":"x","estimatedLossCny":"1500.4"}', "x").estimatedLossCny, 1500);
    assert.equal(parseIntent('{"goal":"x"}', "大概两千块").estimatedLossCny, undefined, "原话里有数也不抠");
  });

  it("坏数一律当没给：0、负数、NaN、非数字串", () => {
    for (const v of ["0", "-300", '"abc"', "null", '"NaN"']) {
      assert.equal(parseIntent(`{"goal":"x","estimatedLossCny":${v}}`, "x").estimatedLossCny, undefined, `坏值 ${v}`);
    }
  });

  it("事故类型只收表内五个，表外丢弃", () => {
    assert.equal(parseIntent('{"goal":"x","accidentType":"two_party"}', "x").accidentType, "two_party");
    assert.equal(parseIntent('{"goal":"x","accidentType":"追尾"}', "x").accidentType, undefined);
  });
});

describe("[M101-04] 回喂意图层的出险事实行（ADR-010：判断者手里要有事实）", () => {
  it("[F-20-02] 两栏都有 → 两件事都讲出来，并交代「没提就不要给」", () => {
    const line = claimFactsLine({ estimatedLossCny: 2000, accidentType: "single_vehicle" })!;
    assert.match(line, /【本次出险已经说清的事实】/);
    assert.match(line, /估损约 2000 元/);
    assert.match(line, /单方事故/);
    // 不交代这一句，模型会把旧值当成本轮车主又说了一遍，更正就再也盖不掉。
    assert.match(line, /没提就不要给这两栏/);
    assert.match(line, /更正/);
  });

  it("[F-20-02] 只有一栏就只讲一栏；一栏都没有 → 整行不给（不给空壳）", () => {
    assert.match(claimFactsLine({ accidentType: "two_party" })!, /事故类型 双方事故（有对方车）/);
    assert.doesNotMatch(claimFactsLine({ accidentType: "two_party" })!, /估损/);
    assert.equal(claimFactsLine({}), undefined);
    assert.equal(claimFactsLine(undefined), undefined);
  });
});

describe("[F-11-10] 留档：正则认不出的说法靠模型", () => {
  it("「帮我存一下」正则不认，模型说了就认", () => {
    assert.equal(archiveIntent("帮我存一下"), false, "字面表确实漏");
    assert.equal(wantsArchive("帮我存一下", { secondaryIntents: ["archive"] }), true);
  });

  it("模型表了态但没给 archive → 不留档，哪怕原话里有「记录」二字", () => {
    assert.equal(wantsArchive("这个故障记录在手册第几页", { secondaryIntents: ["maintenance"] }), false);
  });

  it("模型没表态 → 字面判据原样接手", () => {
    assert.equal(wantsArchive("帮我把这次问诊记到档案里", undefined), true);
    assert.equal(wantsArchive("随便聊聊", undefined), false);
  });
});

describe("[F-11-10] 保养与维修预取", () => {
  it("保养：模型优先、正则兜底", () => {
    // 实测漏掉的说法（字面表只认 保养 / 机油 / 首保 / 到期 / 下次…进厂 / 该换…油滤）
    assert.equal(isMaintenanceQuery("车子是不是该打理打理了"), false, "字面表确实漏");
    assert.equal(wantsMaintenance("车子是不是该打理打理了", { secondaryIntents: ["maintenance"] }), true);
    assert.equal(wantsMaintenance("机油该换了吗", undefined), true);
  });

  const none = { history: false, quote: false, claim: false, materials: false, entitlement: false };

  it("维修五态：理赔命中时报价不重复给（自带报价单）", () => {
    const claim = repairContextNeeds("", { secondaryIntents: ["insurance_claim", "repair_quote"] });
    assert.deepEqual(claim, { ...none, claim: true });
    const quote = repairContextNeeds("", { secondaryIntents: ["repair_quote"] });
    assert.deepEqual(quote, { ...none, quote: true });
  });

  it("模型没表态时五态仍按字面判", () => {
    assert.deepEqual(repairContextNeeds("这车修过什么"), { ...none, history: true });
    assert.deepEqual(repairContextNeeds("保险能报多少"), { ...none, claim: true });
  });

  it("模型表了态但一项都不涉及维修 → 五态全 false，不白查", () => {
    assert.deepEqual(repairContextNeeds("这车修过什么", { secondaryIntents: ["archive"] }), none);
  });

  it("[M96-03] 材料与权益：模型表态优先，字面兜底", () => {
    assert.deepEqual(repairContextNeeds("", { secondaryIntents: ["claim_materials", "entitlement"] }), {
      ...none,
      materials: true,
      entitlement: true,
    });
    // 字面表认「报案 / 出险 / 拒赔 / 定损」与「权益 / 送几次 / 免费救援」
    assert.deepEqual(repairContextNeeds("出险了要准备什么材料"), { ...none, materials: true });
    assert.deepEqual(repairContextNeeds("报案有没有时限"), { ...none, materials: true });
    assert.deepEqual(repairContextNeeds("我的保险送几次免费救援"), { ...none, entitlement: true });
    // 字面表漏的说法：模型说了就认
    assert.equal(repairContextNeeds("碰了一下要不要报").materials, false, "字面表确实漏");
    assert.equal(repairContextNeeds("碰了一下要不要报", { secondaryIntents: ["claim_materials"] }).materials, true);
  });

  it("[M96-03] 走不走保险划不划算 → claim（字面兜底也认）", () => {
    assert.deepEqual(repairContextNeeds("这个划痕走保险划算吗"), { ...none, claim: true });
  });
});
