/**
 * 售后理赔预取的接线测试（施工单 M96-03，ACR-041 第 2 步）。
 *
 * # 这里守的是"表了态就真的查了"
 *
 * `repairContextNeeds` 的模型分支此前在线上是死的——`runRepairContext` 从没被传过 intent
 * （ADR-010 的形状：判断者的输入里没有它需要的事实）。本文件从两头钉住：
 *  1. 读源码：supervisor 调 `runRepairContext` 时带 `intent: state.intent`；
 *  2. 跑函数：给了 `insurance_claim` / `claim_materials` / `entitlement` 就分别落到
 *     `claim_advisor` / `claim_checklist` / 权益词条，且估损与事故类型来自意图不来自原话。
 *
 * 后端用进程内 stub（不打 HTTP），与 `shared/tools/test/claim-tools.test.ts` 同一套。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  claimChecklistFor,
  setInsuranceBackend,
  setRepairBackend,
  type InsuranceBackend,
  type InsurancePolicy,
  type RepairBackend,
} from "@carlife/tools";

import { ENTITLEMENT_ENTRIES, ENTITLEMENT_GUIDE_MAX_LINES, renderEntitlementGuideContext } from "../src/graph/entitlement-guide";
import { buildChatGraph } from "../src/graph/supervisor";
import type { ChatStreamer } from "../src/llm";
import { renderClaimAdvisorContext, renderClaimChecklistContext, runRepairContext } from "../src/graph/subgraphs/ownership";

const VIN = "DEM00SEED0M0DELY1";
const CTX = { sessionId: "test", mode: "real" as const, agent: "service" };

const POLICY: InsurancePolicy = {
  policyId: "PL-1",
  vin: VIN,
  insurer: "示例财险（模拟）",
  product: "车损 + 交强",
  validFrom: "2026-03-01",
  validTo: "2027-02-28",
  coverages: [{ type: "vehicle_damage", limit: 250000, deductible: 500 }],
  status: "active",
  vehicle: { brand: "Tesla", model: "Model Y", modelYear: 2023 },
  plan: { insurer: "示例财险（模拟）", channel: "brand-broker", spu: "新能源商业险", sku: "SLCX-NEV-CD-500" },
  contractYear: 2026,
  annualPremium: 6800,
  claimsThisPolicyYear: 0,
};

/** 记录工具层实际收到的入参——断言"估损来自意图"就看这里。 */
const seen: { precheck: unknown[]; forecast: unknown[] } = { precheck: [], forecast: [] };

function insuranceStub(): InsuranceBackend {
  return {
    policies: async () => ({ vin: VIN, policies: [POLICY], matched: 1 }),
    precheck: async (a) => {
      seen.precheck.push(a);
      return {
        covered: true,
        coveredAmount: a.quote.total - 500,
        selfPayAmount: 500,
        deductible: 500,
        breakdown: [],
        policyId: "PL-1",
        disclaimer: "模拟测算，实际以保险公司核定为准",
        ruleNote: "事故类按保额覆盖减免赔额",
      };
    },
    forecast: async (a) => {
      seen.forecast.push(a);
      return {
        policyId: "PL-1",
        claimsThisPolicyYear: 0,
        claimsAfterThis: 1,
        currentPremium: 6800,
        nextYearPremium: 6800,
        nextYearIfNoClaim: 5848,
        delta: 952,
        commercialFactor: 1,
        compulsoryFactor: 1,
        renewalRisk: false,
        ruleNote: "本年度已出险 0 次，再报一次按 1 次档",
        disclaimer: "模拟测算，实际以保险公司核定为准",
      };
    },
  };
}

function repairStub(): RepairBackend {
  const stub: Partial<RepairBackend> = {
    history: async (vin: string) => ({ vin, records: [], known: false }),
    stations: async () => ({ stations: [], matched: 0 }),
    slots: async () => ({ slots: [] }),
    // 没有进行中的报价单——advisor 只能靠意图层给的估损
    quotes: async (a: { vin: string }) => ({ vin: a.vin, quotes: [], matched: 0 }),
  };
  return stub as RepairBackend;
}

afterEach(() => {
  setRepairBackend(undefined);
  setInsuranceBackend(undefined);
  seen.precheck.length = 0;
  seen.forecast.length = 0;
});

describe("[M96-03] supervisor 把意图传给了预取", () => {
  it("runRepairContext 的调用处带 intent: state.intent（ADR-010：判断者手里要有事实）", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/graph/supervisor.ts", import.meta.url)), "utf8");
    const call = src.slice(src.indexOf("runRepairContext({"), src.indexOf("runRepairContext({") + 400);
    // M101-04 起传的是本轮 intent 与跨轮 `claimFacts` 的合并结果——`state.intent` 仍在里面，
    // 只是不再是唯一来源。断言放宽到"这一跳吃到了 state.intent"，不钉死写法。
    assert.match(call, /intent:\s*mergeClaimFacts\(state\.intent,\s*state\.claimFacts\)/, "supervisor 调 runRepairContext 时没传 intent——模型分支又是死的");
  });
});

describe("[M96-03] 理赔那一路：insurance_claim → claim_advisor", () => {
  it("估损来自意图层的 estimatedLossCny，原话里的「两千」不参与", async () => {
    setInsuranceBackend(insuranceStub());
    setRepairBackend(repairStub());
    const out = await runRepairContext({
      query: "这个划痕走保险划算吗，大概两千块",
      vin: VIN,
      ctx: CTX,
      intent: { secondaryIntents: ["insurance_claim"], estimatedLossCny: 2000 },
    });
    assert.ok(out);
    assert.match(out, /【走不走保险（模拟测算）】/);
    assert.match(out, /车主口述估损，未经定损 2000 元/);
    assert.match(out, /赔付净额 1500 元/);
    assert.match(out, /报这一次多交 952 元/);
    assert.match(out, /净收益 = 1500 − 952 = 548 元 → 倾向走保险/);
    // 业务主键句（D15）随 basis[0] 进上下文
    assert.match(out, /示例财险（模拟）/);
    assert.match(out, /2023 年款 Tesla Model Y \/ 2026 年签/);
    // 两句免责都在
    assert.match(out, /模拟测算，实际以保险公司核定为准/);
    assert.match(out, /【测算说明】/);
    assert.match(out, /倾向不是决定/);
    // 没有报价单时 advisor 不走 precheck，赔付按保单免赔额从估损直接算（2000 − 500 = 1500）；
    // 上面那句 1500 元成立，就证明 2000 是意图给的数，不是原话里抠的。
    assert.equal(seen.precheck.length, 0);
    assert.equal(seen.forecast.length, 1);
  });

  it("没报价单也没估损 → 工具报「算不了」，话术原样进块，不编数", async () => {
    setInsuranceBackend(insuranceStub());
    setRepairBackend(repairStub());
    const out = await runRepairContext({
      query: "走保险划算吗",
      vin: VIN,
      ctx: CTX,
      intent: { secondaryIntents: ["insurance_claim"] },
    });
    assert.ok(out);
    assert.match(out, /【走不走保险（模拟测算）】/);
    assert.doesNotMatch(out, /净收益 =/);
    assert.match(out, /模拟测算，实际以保险公司核定为准/);
  });

  it("人伤（accidentType=injury）传给保费预测的 injury", async () => {
    setInsuranceBackend(insuranceStub());
    setRepairBackend(repairStub());
    await runRepairContext({
      query: "撞了人走保险明年涨多少",
      vin: VIN,
      ctx: CTX,
      intent: { secondaryIntents: ["insurance_claim"], estimatedLossCny: 8000, accidentType: "injury" },
    });
    assert.equal((seen.forecast[0] as { injury?: boolean }).injury, true);
  });

  it("没有 VIN：理赔那一路如实说缺档案，不调工具", async () => {
    setInsuranceBackend(insuranceStub());
    setRepairBackend(repairStub());
    const out = await runRepairContext({
      query: "走保险划算吗",
      ctx: CTX,
      intent: { secondaryIntents: ["insurance_claim"], estimatedLossCny: 2000 },
    });
    assert.ok(out);
    assert.match(out, /缺 VIN/);
    assert.equal(seen.precheck.length, 0);
  });
});

describe("[M96-03] 材料那一路：claim_materials → claim_checklist", () => {
  it("事故类型来自意图；两条时限原样进块", async () => {
    const out = await runRepairContext({
      query: "撞了别人的车要准备什么",
      vin: VIN,
      ctx: CTX,
      intent: { secondaryIntents: ["claim_materials"], accidentType: "two_party" },
    });
    assert.ok(out);
    assert.match(out, /【出险材料与时限（公开资料整理）】/);
    assert.match(out, /双方事故/);
    assert.match(out, /48 小时/);
    assert.match(out, /定损/);
    assert.doesNotMatch(out, /缺省按单方事故/);
  });

  it("没说清事故类型 → 缺省单方并明说是缺省，让模型追问", async () => {
    const out = await runRepairContext({
      query: "出险了要准备什么材料",
      vin: VIN,
      ctx: CTX,
      intent: { secondaryIntents: ["claim_materials"] },
    });
    assert.ok(out);
    assert.match(out, /这是缺省按单方事故给的/);
  });

  it("材料清单不需要 VIN——没建档也能给", async () => {
    const out = await runRepairContext({
      query: "出险了要准备什么材料",
      ctx: CTX,
      intent: { secondaryIntents: ["claim_materials"] },
    });
    assert.ok(out);
    assert.match(out, /【出险材料与时限/);
    assert.doesNotMatch(out, /缺 VIN/);
  });
});

describe("[M96-03] 权益那一路：entitlement → 代码内词条", () => {
  it("五个入口都在，末尾固定「系统里没有余额账」，不超过行数上限", () => {
    const s = renderEntitlementGuideContext();
    const lines = s.split("\n");
    assert.ok(lines.length <= ENTITLEMENT_GUIDE_MAX_LINES, `${lines.length} 行超上限`);
    assert.equal(ENTITLEMENT_ENTRIES.length, 5);
    for (const e of ENTITLEMENT_ENTRIES) assert.match(s, new RegExp(e.where.slice(0, 6)));
    // ACR-043 起「险企那一类」不在这一段——它由保单段给真实次数。
    assert.match(s, /主机厂与门店赠送的系统里没有账/);
    assert.match(s, /主机厂与门店那两类不要报任何次数或额度/);
    assert.match(s, /以上面「险企权益（保单载明）」段为准/);
  });

  it("模型表了 entitlement 就给词条，且不需要 VIN", async () => {
    const out = await runRepairContext({
      query: "我这保险送几次救援",
      ctx: CTX,
      intent: { secondaryIntents: ["entitlement"] },
    });
    assert.ok(out);
    assert.match(out, /【权益去哪查/);
    assert.doesNotMatch(out, /缺 VIN/);
  });
});

describe("[M101-03] 险企权益从保单读（ACR-043）", () => {
  const withServices = (services: InsurancePolicy["valueAddedServices"], over: Partial<InsurancePolicy> = {}) => {
    setInsuranceBackend({
      ...insuranceStub(),
      policies: async () => ({ vin: VIN, policies: [{ ...POLICY, ...over, valueAddedServices: services }], matched: 1 }),
    });
  };

  const ask = () =>
    runRepairContext({
      query: "我这保险送几次救援",
      vin: VIN,
      ctx: CTX,
      intent: { secondaryIntents: ["entitlement"] },
    });

  it("**有 VIN 且保单载明 → 给真实次数**，数来自工具返回不是编的", async () => {
    // 这一条是整份 ACR-043 的意义：原来这句的应答是"具体几次我这边查不到"，
    // 而次数就写在我们自己手里的那张保单上。
    withServices([
      { code: "roadside_rescue", name: "道路救援", quotaKind: "count", total: 3, used: 1, periodKind: "policy_year", conditions: ["单程 100 公里内", "不含过路过桥费与物料费"] },
      { code: "car_wash", name: "免费洗车", quotaKind: "count", total: 6, used: 2, periodKind: "policy_year", conditions: ["限合作门店"] },
    ]);
    const out = (await ask())!;
    assert.match(out, /【险企权益（保单载明）】/);
    assert.match(out, /道路救援：共 3次 \/ 已用 1次 \/ 剩 2次，到 2027-02-28 随保单失效/);
    assert.match(out, /免费洗车：共 6次 \/ 已用 2次 \/ 剩 4次/);
    assert.match(out, /不含过路过桥费与物料费/);
    // 查询入口仍在：主机厂与门店那两类本仓没有账。
    assert.match(out, /【权益去哪查/);
  });

  it("保单在保但没载明这一栏 → 说「没载明」而不是「查不到」——车主据此做的下一步不同", async () => {
    withServices(undefined);
    const out = (await ask())!;
    assert.match(out, /没有载明增值服务/);
    assert.doesNotMatch(out, /剩 \d/);
  });

  it("保单已到期 → 说随保单失效，不报任何剩余次数", async () => {
    withServices(
      [{ code: "roadside_rescue", name: "道路救援", quotaKind: "count", total: 3, used: 0, periodKind: "policy_year", conditions: [] }],
      { status: "expired", validTo: "2025-01-01" },
    );
    const out = (await ask())!;
    assert.match(out, /已于 2025-01-01 到期/);
    assert.doesNotMatch(out, /剩 3/);
  });

  it("**已用超过总数 → 说数据异常，不出负数也不裁成 0**——两者都是替保险公司下结论", async () => {
    withServices([
      { code: "roadside_rescue", name: "道路救援", quotaKind: "count", total: 2, used: 3, periodKind: "policy_year", conditions: [] },
    ]);
    const out = (await ask())!;
    assert.match(out, /数据异常，以保险公司为准/);
    assert.doesNotMatch(out, /剩 -1/);
    assert.doesNotMatch(out, /剩 0/);
  });

  it("不限次的写「不限次」，不编一个总数", async () => {
    withServices([
      { code: "designated_driver", name: "代驾服务", quotaKind: "unlimited", periodKind: "policy_year", conditions: ["仅限市区"] },
    ]);
    assert.match((await ask())!, /代驾服务：不限次/);
  });

  it("保险系统连不通 → 如实说没连通，**不静默退回「去哪查」**", async () => {
    setInsuranceBackend({
      ...insuranceStub(),
      policies: async () => {
        throw new Error("保险系统连不上");
      },
    });
    const out = (await ask())!;
    assert.match(out, /查保单失败/);
    assert.match(out, /保险系统没连通/);
  });

  it("没有 VIN 时不调保单，上下文与改动前逐字相同", async () => {
    withServices([
      { code: "roadside_rescue", name: "道路救援", quotaKind: "count", total: 3, used: 1, periodKind: "policy_year", conditions: [] },
    ]);
    const out = (await runRepairContext({
      query: "我这保险送几次救援",
      ctx: CTX,
      intent: { secondaryIntents: ["entitlement"] },
    }))!;
    assert.equal(out, renderEntitlementGuideContext());
  });
});

describe("[M96-03] 渲染是纯函数，措辞纪律断言到句子级", () => {
  it("advisor 出错：错误话术进块，免责仍在", () => {
    const s = renderClaimAdvisorContext({ error: "[claim_advisor] 保险系统连不上——如实告知" });
    assert.match(s, /保险系统连不上/);
    assert.match(s, /模拟测算，实际以保险公司核定为准/);
  });

  it("advisor 拒保风险：单独一行提示，且放在净收益之后", () => {
    const s = renderClaimAdvisorContext({
      lossSource: "quote",
      lossCny: 1200,
      payout: { covered: 700, deductible: 500, net: 700 },
      premium: { current: 3200, nextYear: 5600, nextYearIfNoClaim: 4000, delta: 1600, ruleNote: "第 3 次", renewalRisk: true },
      netBenefit: -900,
      leaning: "self-pay",
      basis: ["按 示例财险 经 品牌经纪 承保的 2021 款 Model 3 · 2026 年签约保单算"],
      disclaimer: "模拟测算，实际以保险公司核定为准",
    });
    assert.match(s, /进行中的维修报价单 1200 元/);
    assert.match(s, /倾向自费/);
    assert.match(s, /拒保风险阈值/);
    assert.ok(s.indexOf("净收益") < s.indexOf("拒保风险阈值"));
  });

  it("checklist 出错：错误话术进块", () => {
    const s = renderClaimChecklistContext({ error: "[claim_checklist] x" }, false);
    assert.match(s, /\[claim_checklist\] x/);
  });
});

/**
 * 整图两轮（M101-04）。真跑 M96-05 的症状是第二句「那要准备什么材料」退回缺省单方事故、
 * 再问一遍车主上一句刚说过的事——因为估损与事故类型只活在本轮 `args.intent`。
 * 这里用 `buildChatGraph` 缺省的 MemorySaver 同 `thread_id` 跑三轮，钉住跨轮那条通道。
 */
describe("[M101-04] 理赔事实跨轮：第二句不再问一遍车主刚说过的事", () => {
  const BASE = { goal: "出险咨询", constraints: [], context: "", riskBoundary: "", riskCategory: "none", route: "service" };

  /** 按轮次依次吐意图 JSON 的假模型；应答那一跳把 prompt 记下来供断言。 */
  function streamerFor(intents: Array<Record<string, unknown>>, prompts: string[]): ChatStreamer {
    let turn = 0;
    return async function* (messages, hooks) {
      if (hooks?.agent === "supervisor-intent") {
        yield JSON.stringify({ ...BASE, ...(intents[turn++] ?? {}) });
        return;
      }
      prompts.push(messages.map((x) => x.content).join("\n"));
      yield "[答]";
    };
  }

  async function threeTurns(): Promise<string[]> {
    setInsuranceBackend(insuranceStub());
    setRepairBackend(repairStub());
    const prompts: string[] = [];
    const graph = buildChatGraph(
      streamerFor(
        [
          // ① 车主把两件事都说了
          { secondaryIntents: ["insurance_claim"], estimatedLossCny: 2000, accidentType: "single_vehicle" },
          // ② 只问材料，两栏都没再说一遍——正是出问题的那一轮
          { secondaryIntents: ["claim_materials"] },
          // ③ 更正事故类型：新值必须盖掉通道里的旧值
          { secondaryIntents: ["claim_materials"], accidentType: "two_party" },
        ],
        prompts,
      ),
      { enableIntent: true },
    );
    const cfg = { configurable: { thread_id: "claim-facts-1", userId: "u1", emit: { onDelta: () => {} } } };
    for (const q of ["这个划痕走保险划算吗，大概两千块", "那要准备什么材料", "其实我是撞了别人的车"]) {
      await graph.invoke({ messages: [{ role: "user", content: q }] }, cfg);
    }
    return prompts;
  }

  it("[F-20-02] 第二轮沿用上一轮的单方事故，**不再标「缺省」也不再追问**", async () => {
    const prompts = await threeTurns();
    const second = prompts[1] ?? "";
    assert.match(second, /【出险材料与时限（公开资料整理）】/);
    assert.match(second, /单方事故/);
    assert.doesNotMatch(second, /缺省按单方事故/, "第二轮又把车主刚说过的事当成没说——跨轮通道没接上");
  });

  it("[F-20-02] 第三轮车主更正 → 新值覆盖通道里的旧值", async () => {
    const prompts = await threeTurns();
    const third = prompts[2] ?? "";
    assert.match(third, /双方或多方事故/);
    assert.doesNotMatch(third, /缺省按单方事故/);
  });
});

describe("[M101-04] 材料段的答复预算：先说关键几样，其余数出条数", () => {
  it("[F-20-02] essentials 单列、其余按 materials − essentials 数出 N，全量仍在块里", async () => {
    const out = (await runRepairContext({
      query: "撞了别人的车要准备什么",
      vin: VIN,
      ctx: CTX,
      intent: { secondaryIntents: ["claim_materials"], accidentType: "two_party" },
    }))!;
    const checklist = claimChecklistFor("two_party");
    const restCount = checklist.materials.length - checklist.essentials.length;

    assert.match(out, /- 先备齐这几样：/);
    assert.match(out, new RegExp(`- 其余还有 ${restCount} 项（车主追问时再逐条给）：`));
    assert.match(out, new RegExp(`还有 ${restCount} 项，要我逐条念吗`));
    assert.match(out, /全段不超过 300 字/);

    // 压缩靠段结构，不靠删信息——追问时模型得答得上，所以全量材料一条不少。
    for (const m of checklist.materials) assert.ok(out.includes(m), `材料「${m}」被渲染段丢了`);
    // 两条时限仍然原样，且排在关键材料之前（车主先知道"什么时候之前"才有用）。
    assert.ok(out.indexOf("时限（事后无法补救）") < out.indexOf("先备齐这几样"));
  });

  it("essentials 不重复出现在「其余」里——同一样东西说两遍等于没压缩", async () => {
    const out = (await runRepairContext({
      query: "自己撞墙上了要准备什么",
      vin: VIN,
      ctx: CTX,
      intent: { secondaryIntents: ["claim_materials"], accidentType: "single_vehicle" },
    }))!;
    const rest = out.split("- 其余还有")[1]?.split("\n")[0] ?? "";
    for (const e of claimChecklistFor("single_vehicle").essentials) {
      assert.ok(!rest.includes(e), `essentials「${e}」又出现在「其余」那一行里`);
    }
  });
});
