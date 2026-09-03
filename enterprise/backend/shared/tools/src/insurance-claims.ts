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
  };
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

      const repair = getRepairBackend();
      if (!repair) {
        throw new ToolError(
          "insurance_precheck",
          "unconfigured",
          "维修系统未接入，拿不到报价单——理赔预检需要正在维修的报价单，请如实告知车主",
          false,
        );
      }
      const { quotes } = await repair.quotes({ vin, status: "in_progress" });
      if (quotes.length === 0) {
        throw new ToolError(
          "insurance_precheck",
          "invalid",
          "这辆车当前没有进行中的维修报价单——没有报价单就没有测算对象，请如实告知车主（不要凭维修项目名自行估价）",
          false,
        );
      }
      const quote = quotes[0];
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
