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
import { forecastPremium } from "./ncd";

const PORT = Number(process.env.MOCK_INSURANCE_PORT ?? 8798);
const PROVENANCE = "simulated" as const;
const DISCLAIMER = "模拟测算，实际以保险公司核定为准";
const RULE_NOTE = "事故类按保额覆盖减免赔额；保养磨损类不在车损险范围";
/** `/policies` 自述：增值服务的数从哪来、什么时候失效。 */
const VALUE_ADDED_NOTE = "增值服务次数为保单载明，随保单年度失效，不跨年累计";

export interface Coverage {
  type: string;
  limit: number;
  deductible: number;
}

/**
 * 保单的业务主键（M96-02，设计定稿 D15）：同一辆车换一年签、换渠道买、换一个 SKU，
 * 条款 / 免赔 / 附加险 / 赠送权益都可能不同。只按 VIN 挂会把不同合同的规则混成一份，
 * 所以每张保单带全这组键，响应里回显，让车主知道算的是哪一份。
 */
export interface PolicyVehicle {
  brand: string;
  model: string;
  modelYear: number;
}

export interface PolicyPlan {
  insurer: string;
  /** 销售渠道：brand-broker 品牌经纪 / dealer 4S 代销 / direct 险企直销 / platform 平台。 */
  channel: "brand-broker" | "dealer" | "direct" | "platform";
  spu: string;
  sku: string;
}

/**
 * 险企随保单赠送的增值服务（ACR-043）。
 *
 * # 为什么它在保单里，而不是"车主自己报一个数"
 *
 * 设计定稿 D7 把三类权益（主机厂 / 险企 / 门店）一律定成用户自报。对险企这一类是错的：
 * **次数就写在保单的特约条款里，而保单在我们手里**（`insurance_policy` 一直在 service 的 ACL 内）。
 * 向拿着权威源的那一方要数，是 ADR-010 的同一条纪律。
 * 主机厂与门店的权益本仓没有接口，那两类才继续走"去哪查"的入口 + 三期的自报台账。
 *
 * `periodKind` 目前只有 `policy_year` 一档，**刻意不预建**另外两档
 * （品牌充电额度的按月不累计、质保救援的期内不限次）：本仓没有主机厂接口，
 * 建了也没有东西往里填，等三期接上再加。
 */
export type ValueAddedServiceCode =
  | "roadside_rescue"
  | "designated_driver"
  | "car_wash"
  | "annual_inspection_agent"
  | "charging_credit"
  | "pickup_delivery";

const VALUE_ADDED_CODES: readonly ValueAddedServiceCode[] = [
  "roadside_rescue",
  "designated_driver",
  "car_wash",
  "annual_inspection_agent",
  "charging_credit",
  "pickup_delivery",
];

export interface ValueAddedService {
  code: ValueAddedServiceCode;
  /** 保单上的中文叫法，直接给车主看。 */
  name: string;
  quotaKind: "count" | "amount" | "unlimited";
  /** `count` / `amount` 必填；`unlimited` 不给。 */
  total?: number;
  /** 已用；缺省按 0。**这是险企侧的账，不是车主自报**。 */
  used?: number;
  /** `amount` 用，如"元"。 */
  unit?: string;
  /** 失效方式。`policy_year` = 随保单年度清零，保单不续即失效，不跨年累计。 */
  periodKind: "policy_year";
  /** 权益成立的前提（"单程 100 公里内""不含过路过桥费"）——**不是备注，是条件**。 */
  conditions: string[];
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
  /** 业务主键三段（M96-02）。旧种子可缺省，缺省时响应里不回显。 */
  vehicle?: PolicyVehicle;
  plan?: PolicyPlan;
  contractYear?: number;
  /** 年保费（元）——保费浮动预测的基数；缺省时 /premium/forecast 只给因子不给金额。 */
  annualPremium?: number;
  /** 本保单年度已出险次数（不含正在问的这一次）；缺省按 0。 */
  claimsThisPolicyYear?: number;
  /** 保单载明的增值服务（ACR-043）。旧种子可缺省，缺省时响应里不回显。 */
  valueAddedServices?: ValueAddedService[];
}

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

function loadPolicies(): Policy[] {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, "policies.json"), "utf8")) as { policies: Policy[] };
  if (!Array.isArray(raw.policies)) throw new Error("policies.json 里没有 policies 数组——种子坏了要在启动时炸");
  for (const p of raw.policies) assertValueAddedServices(p);
  return raw.policies;
}

/**
 * 种子坏了要在**启动时**炸，不要等车主问"还剩几次"时才发现（index.ts 文件头的纪律）。
 *
 * 手写校验不引 zod：四个假系统都零运行时依赖，一个可选数组字段不值一个依赖。
 */
export function assertValueAddedServices(p: Policy): void {
  const list = p.valueAddedServices;
  if (list === undefined) return;
  if (!Array.isArray(list)) throw new Error(`${p.policyId} 的 valueAddedServices 不是数组`);
  for (const s of list) {
    const at = `${p.policyId} 的增值服务 ${s?.code ?? "(无 code)"}`;
    if (!VALUE_ADDED_CODES.includes(s?.code)) throw new Error(`${at}：code 不在表内`);
    if (typeof s.name !== "string" || s.name.length === 0) throw new Error(`${at}：缺 name`);
    if (!Array.isArray(s.conditions)) throw new Error(`${at}：conditions 必须是数组`);
    if (s.periodKind !== "policy_year") throw new Error(`${at}：periodKind 目前只支持 policy_year`);
    if (s.quotaKind === "unlimited") {
      if (s.total !== undefined) throw new Error(`${at}：unlimited 不该有 total`);
      continue;
    }
    if (!Number.isInteger(s.total) || (s.total as number) < 0) throw new Error(`${at}：total 必须是非负整数`);
    const used = s.used ?? 0;
    if (!Number.isInteger(used) || used < 0) throw new Error(`${at}：used 必须是非负整数`);
    // 已用超过总数在真实险企那边可能因核销延迟出现，但**种子里出现就是写错了**。
    if (used > (s.total as number)) throw new Error(`${at}：used ${used} 超过 total ${s.total}`);
  }
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
  // 增值服务原样回传、不加工：算术（剩 = total − used）留给消费方，
  // 这里多算一步就会有两个地方声称自己知道"还剩几次"。
  json(res, 200, { vin, policies, matched: policies.length, valueAddedNote: VALUE_ADDED_NOTE });
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

/**
 * POST /premium/forecast（M96-02）：再报一次案，次年保费会变成多少。
 *
 * 入参只有 VIN 与是否人伤——保单、保费基数、已出险次数全部由本服务从种子取，
 * 模型手里没有任何金额可转述（与 /claims/precheck "报价单由工具层自取"同一条纪律）。
 * 脱保 / 未投保是 400 而不是编一个"没在保也能算"的数。
 */
async function handleForecast(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJson(req)) as { vin?: string; injury?: boolean };
  if (!body.vin) return json(res, 400, { error: "vin_required" });
  const policy = activePolicyOf(body.vin);
  if (!policy) return json(res, 400, { error: "no_active_policy", reason: "该车辆无在保保单（未投保或已脱保）" });

  const forecast = forecastPremium({ policy, injury: body.injury === true });
  json(res, 200, {
    ...forecast,
    // 回显业务主键：算的是哪一家、哪个渠道、哪个 SKU、哪一年签的保单（设计定稿 D15）。
    vehicle: policy.vehicle,
    plan: policy.plan,
    contractYear: policy.contractYear,
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
      if (req.method === "POST" && url.pathname === "/premium/forecast") return void (await handleForecast(req, res));

      json(res, 404, { error: "not_found", path: url.pathname });
    } catch (err) {
      json(res, 500, { error: "internal", detail: err instanceof Error ? err.message : String(err) });
    }
  });
}
