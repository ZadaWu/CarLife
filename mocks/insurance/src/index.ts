/**
 * mock-insurance —— 假装是保险公司的系统（施工单 M41-02）。
 *
 * 与 mock-dealer/mock-repair 同一套存在理由与硬约束：**能被当场 kill 掉**、
 * 不 import 本仓业务包、不连存储、全响应 `provenance:"simulated"`。
 *
 * 它与 mock-repair 的配合发生在工具层（总览决策 5：两个假系统互不调用）：
 * 工具层拿 mock-repair 的维修报价单喂给 /claims/precheck，得到
 * "保险覆盖多少、自费多少"。测算规则写死且响应自述（ruleNote）——
 * 使用者追问"这个数怎么算的"时，答案就在响应里。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyItem, CATEGORY_REASONS, type ItemCategory } from "./classify";

const PORT = Number(process.env.MOCK_INSURANCE_PORT ?? 8798);
const PROVENANCE = "simulated" as const;
const DISCLAIMER = "模拟测算，实际以保险公司核定为准";
const RULE_NOTE = "事故类按保额覆盖减免赔额；保养磨损类不在车损险范围";

export interface Coverage {
  type: string;
  limit: number;
  deductible: number;
}

export interface Policy {
  policyId: string;
  vin: string;
  insurer: string;
  product: string;
  validFrom: string;
  validTo: string;
  coverages: Coverage[];
  status: "active" | "expired";
}

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

function loadPolicies(): Policy[] {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, "policies.json"), "utf8")) as { policies: Policy[] };
  if (!Array.isArray(raw.policies)) throw new Error("policies.json 里没有 policies 数组——种子坏了要在启动时炸");
  return raw.policies;
}

export const POLICIES: Policy[] = loadPolicies();

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify({ ...(body as object), provenance: PROVENANCE });
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function activePolicyOf(vin: string): Policy | undefined {
  // status 与有效期都看：种子改错一处时另一处兜底，脱保判定不靠单一字段。
  const today = new Date().toISOString().slice(0, 10);
  return POLICIES.find((p) => p.vin === vin && p.status === "active" && p.validFrom <= today && today <= p.validTo);
}

interface PrecheckItem {
  name: string;
  partsFee: number;
  laborFee: number;
}

interface BreakdownRow {
  name: string;
  category: ItemCategory;
  covered: boolean;
  amount: number;
  reason: string;
}

function handlePolicies(url: URL, res: ServerResponse): void {
  const vin = url.searchParams.get("vin");
  if (!vin) return json(res, 400, { error: "vin_required" });
  const policies = POLICIES.filter((p) => p.vin === vin);
  // 空数组是事实（这辆车没在本司投保），不是错误。
  json(res, 200, { vin, policies, matched: policies.length });
}

async function handlePrecheck(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJson(req)) as {
    vin?: string;
    quote?: { items?: PrecheckItem[]; total?: number };
    incident?: string;
  };
  if (!body.vin) return json(res, 400, { error: "vin_required" });
  const items = body.quote?.items;
  if (!Array.isArray(items) || items.length === 0) return json(res, 400, { error: "quote_items_required" });

  const total = typeof body.quote?.total === "number" ? body.quote.total : items.reduce((s, i) => s + i.partsFee + i.laborFee, 0);

  const policy = activePolicyOf(body.vin);
  const damage = policy?.coverages.find((c) => c.type === "vehicle_damage");
  if (!policy || !damage) {
    // 脱保/未投保如实说——给一个假的"能报销"比说"查不到"危害大得多。
    return json(res, 200, {
      covered: false,
      coveredAmount: 0,
      selfPayAmount: total,
      deductible: 0,
      breakdown: [],
      reason: policy ? "保单不含车损险，无法报销维修费用" : "该车辆无在保的车损保单（未投保或已脱保）",
      disclaimer: DISCLAIMER,
      ruleNote: RULE_NOTE,
    });
  }

  const breakdown: BreakdownRow[] = items.map((i) => {
    const category = classifyItem(i.name);
    const amount = i.partsFee + i.laborFee;
    return { name: i.name, category, covered: category === "accident", amount, reason: CATEGORY_REASONS[category] };
  });

  const accidentSum = breakdown.filter((b) => b.covered).reduce((s, b) => s + b.amount, 0);
  // 覆盖 = 事故条目合计 − 免赔额，封在 [0, 保额] 区间；自费 = 总额 − 覆盖。
  const coveredAmount = Math.min(Math.max(0, accidentSum - damage.deductible), damage.limit);
  const covered = coveredAmount > 0;

  json(res, 200, {
    covered,
    coveredAmount,
    selfPayAmount: total - coveredAmount,
    deductible: damage.deductible,
    breakdown,
    policyId: policy.policyId,
    disclaimer: DISCLAIMER,
    ruleNote: RULE_NOTE,
  });
}

export function createInsuranceServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

      if (req.method === "GET" && url.pathname === "/health") {
        // 数字要打出来：种子没加载成功时，"起来了"和"起来了但是空的"看起来一样。
        return json(res, 200, { ok: true, policies: POLICIES.length });
      }
      if (req.method === "GET" && url.pathname === "/policies") return handlePolicies(url, res);
      if (req.method === "POST" && url.pathname === "/claims/precheck") return void (await handlePrecheck(req, res));

      json(res, 404, { error: "not_found", path: url.pathname });
    } catch (err) {
      json(res, 500, { error: "internal", detail: err instanceof Error ? err.message : String(err) });
    }
  });
}
