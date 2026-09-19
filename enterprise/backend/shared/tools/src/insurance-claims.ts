/**
 * 保险系统的后端与工具（施工单 M41-03，服务本体见 mocks/insurance）。
 *
 * # 与 insurance-quote.ts 是两回事
 *
 * `insurance_quote`（购车侧）是**买保险要花多少钱**的纯规则估算；
 * 本文件（售后侧）是**已有保单 + 正在维修的报价单，能报销多少**的理赔预检。
 * 混用会让模型拿投保估算回答理赔问题。
 *
 * # precheck 的报价单由工具层自己取，不收模型转述的金额
 *
 * `insurance_precheck` 只收 VIN：工具先从维修系统取该车 in_progress 报价单，
 * 再喂给保险系统测算。模型转述金额的每一跳都是编造机会——防编靠"金额根本
 * 不经过模型的手"（与 `resolveContactSecret` 真号不经模型是同一条纪律）。
 * 两个 mock 服务之间不互调（M41-00 决策 5），组合就发生在这里。
 */

import { ToolError, defineExternalTool, type ExternalTool } from "./external";
import { getRepairBackend, type RepairQuote } from "./repair";

export interface InsurancePolicy {
  policyId: string;
  vin: string;
  insurer: string;
  product: string;
  validFrom: string;
  validTo: string;
  coverages: Array<{ type: string; limit: number; deductible: number }>;
  status: string;
  /** 业务主键三段（M96-02，设计定稿 D15）：旧种子可缺省。 */
  vehicle?: { brand: string; model: string; modelYear: number };
  plan?: { insurer: string; channel: string; spu: string; sku: string };
  contractYear?: number;
  annualPremium?: number;
  claimsThisPolicyYear?: number;
  /**
   * 保单载明的增值服务（ACR-043）：救援 / 代驾 / 洗车 / 代年检 / 充电额度…
   *
   * **工具层原样透传，一个数都不算**——"还剩几次"这件事只有一个地方有资格回答，
   * 就是保单本身。这里的类型是假系统那份的复刻：`mocks/*` 与业务包零依赖（check:arch 守），
   * 不能 import 过来；两边形状改了要同步，判据写在 mocks/insurance/src/index.ts 的注释里。
   */
  valueAddedServices?: Array<{
    code: string;
    name: string;
    quotaKind: "count" | "amount" | "unlimited";
    total?: number;
    used?: number;
    unit?: string;
    periodKind: "policy_year";
    conditions: string[];
  }>;
}

/** POST /premium/forecast 的响应（M96-02）：再报一次案，次年保费变成多少。 */
export interface PremiumForecast {
  policyId: string;
  claimsThisPolicyYear: number;
  claimsAfterThis: number;
  currentPremium: number;
  /** 报了这一次案的次年保费。 */
  nextYearPremium: number;
  /** 不报这一次案的次年保费——增量与它比，不与今年比。 */
  nextYearIfNoClaim: number;
  /** nextYearPremium − nextYearIfNoClaim：报这一次案多交多少。 */
  delta: number;
  commercialFactor: number;
  compulsoryFactor: number;
  renewalRisk: boolean;
  ruleNote: string;
  disclaimer: string;
}

export interface PrecheckBreakdownRow {
  name: string;
  category: string;
  covered: boolean;
  amount: number;
  reason: string;
}

export interface PrecheckResult {
  covered: boolean;
  coveredAmount: number;
  selfPayAmount: number;
  deductible: number;
  breakdown: PrecheckBreakdownRow[];
  policyId?: string;
  reason?: string;
  disclaimer: string;
  ruleNote: string;
}

export interface InsuranceBackend {
  policies(vin: string): Promise<{ vin: string; policies: InsurancePolicy[]; matched: number }>;
  precheck(a: {
    vin: string;
    quote: { items: Array<{ name: string; partsFee: number; laborFee: number }>; total: number };
  }): Promise<PrecheckResult>;
  /** 再报一次案的次年保费预测（M96-02）。脱保 / 未投保由后端 400，这里原样抛 ToolError。 */
  forecast(a: { vin: string; injury?: boolean }): Promise<PremiumForecast>;
}

let backend: InsuranceBackend | undefined;

export function setInsuranceBackend(b: InsuranceBackend | undefined): void {
  backend = b;
}

export function getInsuranceBackend(): InsuranceBackend | undefined {
  return backend;
}

function need(tool: string): InsuranceBackend {
  if (!backend) {
    throw new ToolError(
      tool,
      "unconfigured",
      "保险系统未接入（MOCK_INSURANCE_URL 未配置或服务未启动）——这次查不到保单与理赔测算，请如实告知车主，不要报出任何保险金额",
      false,
    );
  }
  return backend;
}

/** HTTP 后端。`baseUrl` 由装配层给。 */
export function createHttpInsuranceBackend(baseUrl: string): InsuranceBackend {
  const call = async (tool: string, path: string, init?: RequestInit): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, init);
    } catch (err) {
      throw new ToolError(
        tool,
        "upstream",
        `保险系统连不上（${err instanceof Error ? err.message : String(err)}）——` +
          "这次查不到保单与理赔测算，请如实告知车主保险系统没连通，**不要报出任何保险金额**",
        true,
      );
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return body;
    throw new ToolError(tool, res.status >= 500 ? "upstream" : "invalid", String(body.error ?? res.status), res.status >= 500);
  };

  return {
    async policies(vin) {
      return (await call("insurance_policy", `/policies?vin=${encodeURIComponent(vin)}`)) as {
        vin: string;
        policies: InsurancePolicy[];
        matched: number;
      };
    },
    async precheck(a) {
      return (await call("insurance_precheck", "/claims/precheck", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(a),
      })) as PrecheckResult;
    },
    async forecast(a) {
      return (await call("claim_advisor", "/premium/forecast", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(a),
      })) as PremiumForecast;
    },
  };
}

/**
 * 取这辆车**进行中**的维修报价单；没有维修系统或没有报价单都返回 undefined。
 *
 * 抽出来是给 claim_advisor 复用（M96-02）：取单只能有一份实现，
 * 否则"金额不经模型的手"这条纪律会在两处各漂一次。
 */
export async function fetchInProgressQuote(vin: string): Promise<RepairQuote | undefined> {
  const repair = getRepairBackend();
  if (!repair) return undefined;
  const { quotes } = await repair.quotes({ vin, status: "in_progress" });
  return quotes[0];
}

// ── 两个只读工具 ──────────────────────────────────────────────

export interface InsurancePolicyArgs {
  vin: string;
}

export const insurancePolicyTool: ExternalTool<
  InsurancePolicyArgs,
  { vin: string; policies: InsurancePolicy[]; matched: number }
> = defineExternalTool({
  name: "insurance_policy",
  provider: "mock-insurance",
  sensitive: false,
  timeoutMs: 5_000,
  retries: 2,
  real: async (args) => {
    if (!args.vin?.trim()) throw new ToolError("insurance_policy", "invalid", "必须指定 VIN", false);
    return need("insurance_policy").policies(args.vin.trim());
  },
});

export interface InsurancePrecheckArgs {
  vin: string;
}

export interface InsurancePrecheckOutput extends PrecheckResult {
  /** 参与测算的报价单（工具层自己取的那张），模型引用金额时以它为准。 */
  quote: Pick<RepairQuote, "quoteId" | "orderId" | "total" | "currency" | "items">;
}

export const insurancePrecheckTool: ExternalTool<InsurancePrecheckArgs, InsurancePrecheckOutput> =
  defineExternalTool({
    name: "insurance_precheck",
    provider: "mock-insurance",
    // 只读测算（无副作用、不外发个人信息——只有 VIN 与维修条目出去）。
    sensitive: false,
    timeoutMs: 8_000,
    retries: 1,
    real: async (args) => {
      const vin = args.vin?.trim();
      if (!vin) throw new ToolError("insurance_precheck", "invalid", "必须指定 VIN", false);

      if (!getRepairBackend()) {
        throw new ToolError(
          "insurance_precheck",
          "unconfigured",
          "维修系统未接入，拿不到报价单——理赔预检需要正在维修的报价单，请如实告知车主",
          false,
        );
      }
      const quote = await fetchInProgressQuote(vin);
      if (!quote) {
        throw new ToolError(
          "insurance_precheck",
          "invalid",
          "这辆车当前没有进行中的维修报价单——没有报价单就没有测算对象，请如实告知车主（不要凭维修项目名自行估价）",
          false,
        );
      }
      const result = await need("insurance_precheck").precheck({
        vin,
        quote: { items: quote.items, total: quote.total },
      });
      return {
        ...result,
        quote: {
          quoteId: quote.quoteId,
          orderId: quote.orderId,
          total: quote.total,
          currency: quote.currency,
          items: quote.items,
        },
      };
    },
  });
