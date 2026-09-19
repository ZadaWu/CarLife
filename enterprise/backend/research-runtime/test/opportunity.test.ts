/**
 * Synthesizer、ODS 与出口判定（施工单 M82-06）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MockLanguageModelV1 } from "ai/test";

import {
  BOUNDARY_REQUIRED_PHRASE,
  InsightBoundaryError,
  synthesize,
  type SynthesizeInput,
} from "../src/opportunity/insight";
import { AFTERSALES_CODES, componentsOf, outletOf, scoreOpportunity, type OpportunitySignals } from "../src/opportunity/opportunity";
import type { ResearchModel } from "../src/llm";

const PKG = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const card = (over: Record<string, string> = {}) => ({
  claim: "低温下车主会在出门前反复确认剩余里程",
  explanation: "暖风与电池低温同时压低可用续航，仪表数字变化快，于是要反复看",
  evidence: "231 趟环境温度低于 5℃ 的行程里观测续航中位数比常温低 27%（n=231/1110）",
  meaning: "出门前的续航播报应当在低温下主动给出到目的地的余量，而不是只报数字",
  boundary: `仅在已授权车主的 66 台车、近 90 天窗口内成立，不代表市场`,
  updateCondition: "若低温样本扩到 500 趟后中位折减降到 15% 以内，本结论应收窄",
  ...over,
});

function fakeModel(payload: unknown): ResearchModel {
  const model = new MockLanguageModelV1({
    defaultObjectGenerationMode: "json",
    doGenerate: async () => ({
      rawCall: { rawPrompt: null, rawSettings: {} },
      finishReason: "stop" as const,
      usage: { promptTokens: 200, completionTokens: 120 },
      text: JSON.stringify(payload),
    }),
  });
  return { kind: "synth", agent: "research-synth", modelName: "deepseek", model };
}

const input: SynthesizeInput = {
  themeName: "冬天不敢开暖风",
  themeDefinition: "低温下为了保住续航而牺牲舒适",
  needPainCode: "cold-range-loss",
  examples: ["天一冷这个续航掉得也太快了吧", "开暖风续航直接少了三分之一"],
  counterExamples: ["其实入冬以后掉的比我想象中少一些"],
  behavioural: { summary: "231 趟低温行程观测续航中位数低 27%", present: true },
  systemEvents: ["ASR_ENGINE：ark → aliyun"],
  confidence: { coverage: 0.6, quality: 0.8, agreement: 0.7, triangulation: 1, freshness: 0.9 },
};

const deps = (m: ResearchModel) => ({ model: m, systemPrompt: "你是综合员。" });

describe("[M82-06] Synthesizer", () => {
  it("六栏齐 → 出卡，置信与 upgradeNeeds 一并给出", async () => {
    const res = await synthesize(
      input,
      deps(fakeModel({ card: card(), upgradeNeeds: ["把低温样本扩到 500 趟", "补一轮直询"] })),
    );
    assert.equal(res.card.claim.length > 0, true);
    for (const k of ["claim", "explanation", "evidence", "meaning", "boundary", "updateCondition"] as const) {
      assert.ok(res.card[k].length > 0, `${k} 空了`);
    }
    assert.ok(res.upgradeNeeds.length > 0);
    assert.ok(res.confidence.c > 0 && res.confidence.c < 1);
    assert.equal(res.confidence.lowest, "coverage");
  });

  it("boundary 不写「已授权车主」→ 拒绝落库", async () => {
    await assert.rejects(
      () =>
        synthesize(
          input,
          deps(fakeModel({ card: card({ boundary: "适用于全国新能源车主" }), upgradeNeeds: ["把低温样本扩到 500 趟"] })),
        ),
      (err: Error) => {
        assert.ok(err instanceof InsightBoundaryError);
        assert.match(err.message, /research_insight_boundary/);
        assert.match(err.message, new RegExp(BOUNDARY_REQUIRED_PHRASE));
        return true;
      },
    );
  });

  it("缺一栏（schema 校验）→ 抛", async () => {
    const broken = card() as Record<string, string>;
    delete broken.meaning;
    await assert.rejects(() => synthesize(input, deps(fakeModel({ card: broken, upgradeNeeds: ["把低温样本扩到 500 趟"] }))));
  });

  it("upgradeNeeds 为空 → 抛：没有「还缺什么」的卡片不能派活", async () => {
    await assert.rejects(() => synthesize(input, deps(fakeModel({ card: card(), upgradeNeeds: [] }))));
  });

  it("提示词里带上「置信最低的一项」，让 upgradeNeeds 有的放矢", () => {
    const prompt = readFileSync(join(PKG, "prompts", "synthesizer.md"), "utf8");
    assert.match(prompt, /upgradeNeeds/);
    assert.match(prompt, /可证伪/);
    assert.match(prompt, /已授权车主|观察总体/);
  });
});

describe("[M82-06] ODS 与出口", () => {
  const base: OpportunitySignals = {
    needPainCode: "cold-range-loss",
    mentionRate: 0.3,
    unresolvedRate: 0.4,
    frequency: 0.6,
    direction: "up",
    undeliverable: false,
    confidence: 0.7,
    hasServiceRecord: false,
  };

  it("硬禁 → R=1、score 0、没有出口", () => {
    const r = scoreOpportunity({ ...base, undeliverable: true });
    assert.equal(r.ods.r, 1);
    assert.equal(r.ods.score, 0);
    assert.equal(r.outlet, null, "硬禁的机会不该被派活——归到任何出口都会让 roadmap 反复捡起做不了的事");
  });

  it("售后出口：需求码在清单里且行为侧有保养/故障记录", () => {
    assert.equal(outletOf({ ...base, needPainCode: "service-interval", hasServiceRecord: true }), "aftersales");
    // 没有行为侧记录就不是售后线索——只是有人问了一句。
    assert.equal(outletOf({ ...base, needPainCode: "service-interval", hasServiceRecord: false }), "prompt");
    for (const c of AFTERSALES_CODES) {
      assert.equal(outletOf({ ...base, needPainCode: c, hasServiceRecord: true }), "aftersales", c);
    }
  });

  it("其余出口按码分派", () => {
    assert.equal(outletOf({ ...base, needPainCode: "feature-discovery" }), "kb");
    assert.equal(outletOf({ ...base, needPainCode: "nav-detour" }), "tool");
    assert.equal(outletOf({ ...base, needPainCode: "charger-availability" }), "tool");
  });

  it("置信直接乘进分数——证据不足的机会不该靠商业分排到前面", () => {
    const hi = scoreOpportunity({ ...base, confidence: 1 });
    const lo = scoreOpportunity({ ...base, confidence: 0.5 });
    assert.ok(Math.abs(lo.ods.score - hi.ods.score / 2) < 1e-9);
  });

  it("方向变差 → 差距分更高", () => {
    assert.ok(componentsOf({ ...base, direction: "up" }).g > componentsOf({ ...base, direction: "down" }).g);
  });

  it("E / S 是常量 0.5——它们要人来定，编一个数比留空更糟", () => {
    const c = componentsOf(base);
    assert.equal(c.e, 0.5);
    assert.equal(c.s, 0.5);
  });
});

describe("[M82-06] ODS 只排序，不写回", () => {
  it("opportunity 模块不 import 任何写入路径", () => {
    const src = readFileSync(join(PKG, "src", "opportunity", "opportunity.ts"), "utf8");
    // 分数不该能碰到计划文件、行程表或 docs。
    for (const forbidden of ["trip_plans", "tripPlan", "writeFile", "docs/", "fs"]) {
      assert.ok(!src.includes(forbidden), `opportunity.ts 引了 ${forbidden}——ODS 只排序，不写回任何计划`);
    }
  });
});
