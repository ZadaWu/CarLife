/**
 * 走不走保险的净收益测算（施工单 M96-02，ACR-041 第 1 步）。
 *
 * # 车主问的从来不是流程，是算术
 *
 * "这个划痕走保险划算吗"——小额出险的次年保费涨幅常常超过赔款本身，而这笔账车主算不了：
 * 赔付侧的数在保险公司手里（/claims/precheck），涨价侧的规则在 NCD 系数里（/premium/forecast）。
 * 本工具把两侧凑到同一个回答里：赔付净额 − 次年保费增量 = 净收益，再给一个**倾向**。
 *
 * # 两种损失来源，必须标注
 *
 *   - `quote`：有进行中的维修报价单，复用 insurance_precheck 的取单函数——金额不经模型的手；
 *   - `user-estimate`：还没进厂，车主口述"大概两千块"。这是**用户给的数**，不是模型编的，
 *     来自意图层的 `estimatedLossCny` 字段（ADR-012），出参 `basis` 里明写"按车主口述估损，未经定损"。
 *   两者都没有 → 报错不估。一个编出来的损失数会让整个净收益变成假的。
 *
 * # 出参叫 leaning，不叫 decision
 *
 * 净收益为正倾向走保险、为负倾向自费、绝对值小于保费增量的 10% 两可。决定是车主的；
 * 措辞层另有"肯定能赔"的拦截（M96-03），这里只保证数与依据可追问。
 */

import { ToolError, defineExternalTool, type ExternalTool } from "./external";
import {
  fetchInProgressQuote,
  getInsuranceBackend,
  type InsurancePolicy,
  type PremiumForecast,
} from "./insurance-claims";

export type LossSource = "quote" | "user-estimate";
export type ClaimLeaning = "claim" | "self-pay" | "either";

/** 净收益绝对值小于保费增量的这个比例时判"两可"。 */
export const EITHER_BAND = 0.1;

export interface ClaimAdvisorArgs {
  vin: string;
  /** 车主口述的估损金额（元）——只在没有进行中报价单时用；由意图层从原话抽取，工具层不解析文本。 */
  estimatedLossCny?: number;
  /** 这一次事故是否有人伤——交强险因子由它决定。 */
  injury?: boolean;
}

export interface PolicyKey {
  insurer: string;
  channel?: string;
  sku?: string;
  contractYear?: number;
  vehicle?: { brand: string; model: string; modelYear: number };
}

export interface ClaimAdvice {
  lossSource: LossSource;
  /** 参与测算的损失金额（报价单合计或车主估损）。 */
  lossCny: number;
  payout: { covered: number; deductible: number; net: number };
  premium: {
    current: number;
    /** 报这一次案的次年保费。 */
    nextYear: number;
    /** 不报的次年保费——增量是两者之差，不是与今年比。 */
    nextYearIfNoClaim: number;
    delta: number;
    ruleNote: string;
    renewalRisk: boolean;
  };
  /** 赔付净额 − 次年保费增量。 */
  netBenefit: number;
  leaning: ClaimLeaning;
  /** 每条可追问的推算依据；第一条固定是业务主键句（设计定稿 D15）。 */
  basis: string[];
  policyKey: PolicyKey;
  disclaimer: string;
}

const CHANNEL_LABELS: Record<string, string> = {
  "brand-broker": "品牌经纪",
  dealer: "4S 代销",
  direct: "险企直销",
  platform: "平台",
};

export function policyKeyOf(policy: InsurancePolicy): PolicyKey {
  return {
    insurer: policy.plan?.insurer ?? policy.insurer,
    channel: policy.plan?.channel,
    sku: policy.plan?.sku,
    contractYear: policy.contractYear,
    vehicle: policy.vehicle,
  };
}

/** "按 示例财险 / 品牌经纪 / 2026 年款 Model Y / 2026 年签的保单算" */
export function policyKeySentence(key: PolicyKey): string {
  const parts = [key.insurer];
  if (key.channel) parts.push(CHANNEL_LABELS[key.channel] ?? key.channel);
  if (key.vehicle) parts.push(`${key.vehicle.modelYear} 年款 ${key.vehicle.brand} ${key.vehicle.model}`);
  if (key.contractYear) parts.push(`${key.contractYear} 年签`);
  return `按 ${parts.join(" / ")} 的保单算${key.sku ? `（${key.sku}）` : ""}——换渠道或换年签的保单条款可能不同`;
}

export function leaningOf(netBenefit: number, premiumDelta: number): ClaimLeaning {
  const band = Math.abs(premiumDelta) * EITHER_BAND;
  if (Math.abs(netBenefit) <= band) return "either";
  return netBenefit > 0 ? "claim" : "self-pay";
}

export const claimAdvisorTool: ExternalTool<ClaimAdvisorArgs, ClaimAdvice> = defineExternalTool({
  name: "claim_advisor",
  provider: "mock-insurance",
  // 只读测算：无副作用、不外发个人信息——出去的只有 VIN、维修条目或估损数。
  sensitive: false,
  timeoutMs: 10_000,
  retries: 1,
  real: async (args) => {
    const vin = args.vin?.trim();
    if (!vin) throw new ToolError("claim_advisor", "invalid", "必须指定 VIN", false);
    const insurance = getInsuranceBackend();
    if (!insurance) {
      throw new ToolError(
        "claim_advisor",
        "unconfigured",
        "保险系统未接入（MOCK_INSURANCE_URL 未配置或服务未启动）——这次算不了走不走保险，请如实告知车主，不要报出任何保险金额",
        false,
      );
    }

    const { policies } = await insurance.policies(vin);
    const policy = policies.find((p) => p.status === "active");
    const damage = policy?.coverages.find((c) => c.type === "vehicle_damage");
    if (!policy || !damage) {
      throw new ToolError(
        "claim_advisor",
        "invalid",
        policy ? "保单不含车损险，这类损失走不了保险——请如实告知车主" : "该车辆无在保保单（未投保或已脱保），走不了保险——请如实告知车主",
        false,
      );
    }
    const key = policyKeyOf(policy);
    const basis: string[] = [policyKeySentence(key)];

    // ── 赔付侧：优先报价单（金额不经模型的手），其次车主口述估损 ──
    let lossSource: LossSource;
    let lossCny: number;
    let covered: number;
    const quote = await fetchInProgressQuote(vin);
    if (quote) {
      const pre = await insurance.precheck({ vin, quote: { items: quote.items, total: quote.total } });
      lossSource = "quote";
      lossCny = quote.total;
      covered = pre.coveredAmount;
      basis.push(`按进行中的维修报价单 ${quote.quoteId}（合计 ${quote.total} 元）做理赔预检：可赔 ${pre.coveredAmount} 元，免赔额 ${pre.deductible} 元已扣（${pre.ruleNote}）`);
    } else if (typeof args.estimatedLossCny === "number" && args.estimatedLossCny > 0) {
      // 没有报价单时按事故类整体算：估损无法逐条分类，只能整笔当事故损失。
      lossSource = "user-estimate";
      lossCny = args.estimatedLossCny;
      covered = Math.min(Math.max(0, lossCny - damage.deductible), damage.limit);
      basis.push(`按车主口述估损 ${lossCny} 元、未经定损：可赔 = min(${lossCny}, 保额 ${damage.limit}) − 免赔 ${damage.deductible} = ${covered}`);
    } else {
      throw new ToolError(
        "claim_advisor",
        "invalid",
        "没有进行中的维修报价单，也没有估损金额，算不了——请先定损，或告诉我大概损失金额",
        false,
      );
    }
    const net = covered;

    // ── 涨价侧：假系统按保单里的出险次数与年保费算 ──
    const forecast: PremiumForecast = await insurance.forecast({ vin, injury: args.injury === true });
    basis.push(
      `次年保费：不报 ${forecast.nextYearIfNoClaim} 元、报了 ${forecast.nextYearPremium} 元（今年 ${forecast.currentPremium} 元），` +
        `报这一次多交 ${forecast.delta} 元（${forecast.ruleNote}）`,
    );

    const netBenefit = net - forecast.delta;
    const leaning = leaningOf(netBenefit, forecast.delta);
    basis.push(
      `净收益 = 赔付净额 ${net} − 保费增量 ${forecast.delta} = ${netBenefit} 元` +
        (leaning === "either" ? "，两者相差在保费增量的 10% 以内，走不走都差不多" : leaning === "claim" ? "，倾向走保险" : "，倾向自费"),
    );
    if (forecast.renewalRisk) basis.push("出险次数已到拒保风险阈值，续保可能被拒保或加费——这一点比这一单的净收益更值得考虑");

    return {
      lossSource,
      lossCny,
      payout: { covered, deductible: damage.deductible, net },
      premium: {
        current: forecast.currentPremium,
        nextYear: forecast.nextYearPremium,
        nextYearIfNoClaim: forecast.nextYearIfNoClaim,
        delta: forecast.delta,
        ruleNote: forecast.ruleNote,
        renewalRisk: forecast.renewalRisk,
      },
      netBenefit,
      leaning,
      basis,
      policyKey: key,
      disclaimer: forecast.disclaimer,
    };
  },
});
