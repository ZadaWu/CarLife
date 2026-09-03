/**
 * 外部供应商的「还有多少钱／还有多少额度」适配器。
 *
 * 为什么单独一层：五家供应商没有一家的口径是一样的——
 *   DeepSeek   预付余额，一次 GET 带 Bearer 就有；
 *   阿里云     预付余额，但要 RPC v1（HMAC-SHA1）签名；
 *   火山引擎   预付余额，要签名 v4（HMAC-SHA256，四段派生密钥）；
 *   RAGFlow    不是余额是**订阅**，关心的是 status/payment_state/到期日；
 *   高德       既不是余额也不是订阅，是**每日免费调用量**，而且官方压根
 *              没有查余量的接口（"配额信息请在控制台-流量分析-配额管理页面查看"）。
 *
 * 把它们各自的形态硬压成一个数字会说谎——所以统一的是**结构**（`FinanceAccount`），
 * 不是口径：每条自己带 `kind` 与 `exact`，前端据此决定说"余额 45.84"还是
 * "余量不可查，去控制台看"。`exact=false` 是本文件最重要的一个字段：
 * 高德那条永远是 false，任何时候都不许把它渲染成一个看起来精确的余量。
 *
 * 全部适配器只依赖注入进来的 `fetch` 与 `env`，因此可以脱网单测（见 finance.test.ts）。
 */

import { createHash, createHmac, randomUUID } from "node:crypto";

export type FinanceStatus = "ok" | "unconfigured" | "failed";

/** 余额健康度。阈值见 `finance.ts` 的 `thresholds()`，可用环境变量改。 */
export type FinanceLevel = "ok" | "warn" | "danger";

export interface FinanceDetail {
  label: string;
  value: string;
}

export interface FinanceAccount {
  id: string;
  label: string;
  /** balance=预付余额；subscription=订阅制；quota=按日免费额度 */
  kind: "balance" | "subscription" | "quota";
  status: FinanceStatus;
  /** 可用余额（kind=balance 时有意义）。缺省表示"这家不给数字"。 */
  amount?: number;
  currency?: string;
  /**
   * 上面那个数字是不是**供应商给的确切值**。
   * 高德恒为 false：它只能证明"key 现在还能用"，证明不了"还剩多少次"。
   */
  exact: boolean;
  level?: FinanceLevel;
  detail: FinanceDetail[];
  /** 给人看的一句话：为什么是这个状态、下一步该做什么。 */
  note?: string;
  /** 控制台直达链接——数字不够时人得能一键跳过去看。 */
  consoleUrl: string;
  durationMs: number;
  /** 失败时的原因（已剔除密钥）。 */
  error?: string;
  /** 这家有没有账单接口。由注册表回填，前端据此决定默认选中谁。 */
  billsSupported?: boolean;
}

/**
 * 账单的一行。五家的账单粒度天差地别（火山按产品按月、阿里云按产品按月、
 * RAGFlow 只有一张 Stripe 发票），所以这里只留**所有家都答得上来**的五列，
 * 各自的特色字段压进 `status` / `note` 这两条文字里，不给表加只有一家填得满的列。
 */
export interface FinanceBill {
  /** 账期或发生时间：`2026-08` / `2026-08-25` */
  period: string;
  /** 项目：产品名、套餐名 */
  item: string;
  /** 应付金额。缺省表示"这家不给金额"，前端要显示 `-` 而不是 0。 */
  amount?: number;
  currency: string;
  /** 已结清 / 欠 ¥36.85 / 按量付费 …… */
  status?: string;
  note?: string;
  /** 发票等外链 */
  link?: string;
}

export type BillsStatus = "ok" | "unsupported" | "unconfigured" | "failed";

export interface FinanceBillPage {
  accountId: string;
  status: BillsStatus;
  rows: FinanceBill[];
  /** 查询覆盖的范围，空态文案要用它："近 3 个账期没有账单" */
  coverage: string;
  note?: string;
  error?: string;
  consoleUrl: string;
  durationMs: number;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProviderDeps {
  fetch: FetchLike;
  env: (key: string) => string | undefined;
  timeoutMs: number;
  /** 账期是按"现在"倒推的；注入是为了单测能钉住月份边界。 */
  now: () => Date;
}

/** 供应商侧偶发抖动不该让整页红——但也不该被静默吞掉，所以错误原文进 `error`。 */
function fail(base: Omit<FinanceAccount, "status" | "exact" | "durationMs">, err: unknown, startedAt: number): FinanceAccount {
  return {
    ...base,
    status: "failed",
    exact: false,
    durationMs: Date.now() - startedAt,
    error: err instanceof Error ? err.message : String(err),
  };
}

function unconfigured(
  base: Omit<FinanceAccount, "status" | "exact" | "durationMs">,
  note: string,
  startedAt: number,
): FinanceAccount {
  return { ...base, status: "unconfigured", exact: false, durationMs: Date.now() - startedAt, note };
}

/** 阿里云的金额字段带千分位（"1,234.56"），直接 Number() 会得到 NaN。 */
function money(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== "string") return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function withTimeout(deps: ProviderDeps, url: string, init: RequestInit = {}): Promise<Response> {
  return deps.fetch(url, { ...init, signal: AbortSignal.timeout(deps.timeoutMs) });
}

// ────────────────────────────────────────────────────────────── DeepSeek

export async function deepseekBalance(deps: ProviderDeps): Promise<FinanceAccount> {
  const started = Date.now();
  const base = {
    id: "deepseek",
    label: "DeepSeek（主力对话模型）",
    kind: "balance" as const,
    detail: [] as FinanceDetail[],
    consoleUrl: "https://platform.deepseek.com/usage",
  };

  const key = deps.env("DEEPSEEK_API_KEY");
  if (!key) return unconfigured(base, "未配置 DEEPSEEK_API_KEY", started);

  try {
    const res = await withTimeout(deps, "https://api.deepseek.com/user/balance", {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      is_available?: boolean;
      balance_infos?: Array<{
        currency?: string;
        total_balance?: string;
        granted_balance?: string;
        topped_up_balance?: string;
      }>;
    };
    // 账号可能同时有 CNY 与 USD 两本账；本项目只充人民币，取 CNY，取不到就取第一本。
    const infos = body.balance_infos ?? [];
    const info = infos.find((i) => i.currency === "CNY") ?? infos[0];
    const amount = money(info?.total_balance);

    return {
      ...base,
      status: "ok",
      exact: true,
      amount,
      currency: info?.currency ?? "CNY",
      durationMs: Date.now() - started,
      detail: [
        { label: "充值余额", value: info?.topped_up_balance ?? "-" },
        { label: "赠送余额", value: info?.granted_balance ?? "-" },
        { label: "可发起请求", value: body.is_available ? "是" : "否（余额不足或欠费）" },
      ],
      // is_available=false 时哪怕数字好看也要报警：它才是"现在能不能调"的真相。
      note: body.is_available === false ? "DeepSeek 已标记该账号不可用，对话会直接失败" : undefined,
    };
  } catch (err) {
    return fail(base, err, started);
  }
}

// ────────────────────────────────────────────────────────────── 阿里云 BSS（RPC v1 签名）

/** RPC v1 要求的百分号编码：与 encodeURIComponent 有三处差异，错一处签名就不过。 */
function rpcEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/\+/g, "%20")
    .replace(/\*/g, "%2A")
    .replace(/%7E/g, "~");
}

export function signAliyunRpc(params: Record<string, string>, accessKeySecret: string): string {
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${rpcEncode(k)}=${rpcEncode(params[k])}`)
    .join("&");
  const toSign = `GET&${rpcEncode("/")}&${rpcEncode(canonical)}`;
  // 签名密钥末尾那个 `&` 不是笔误，是 RPC v1 规定的。
  return createHmac("sha1", `${accessKeySecret}&`).update(toSign).digest("base64");
}

/**
 * 签好名发一次 RPC v1 GET。余额与账单共用，免得签名逻辑抄两份——
 * 那种抄写出错时的症状是"某一个接口签名不过"，排查成本极高。
 */
async function aliyunRpcGet(
  deps: ProviderDeps,
  accessKeyId: string,
  accessKeySecret: string,
  extra: Record<string, string>,
): Promise<Record<string, unknown>> {
  const params: Record<string, string> = {
    Format: "JSON",
    AccessKeyId: accessKeyId,
    SignatureMethod: "HMAC-SHA1",
    SignatureVersion: "1.0",
    SignatureNonce: randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...extra,
  };
  const signature = signAliyunRpc(params, accessKeySecret);
  const query = Object.keys(params)
    .sort()
    .map((k) => `${rpcEncode(k)}=${rpcEncode(params[k])}`)
    .join("&");
  const res = await withTimeout(deps, `https://business.aliyuncs.com/?${query}&Signature=${rpcEncode(signature)}`);
  const body = (await res.json()) as Record<string, unknown> & { Code?: string; Message?: string };
  if (!res.ok || body.Success === false) {
    throw new Error(`${body.Code ?? res.status}：${body.Message ?? "无数据"}`);
  }
  return body;
}

export async function aliyunBalance(deps: ProviderDeps): Promise<FinanceAccount> {
  const started = Date.now();
  const base = {
    id: "aliyun",
    label: "阿里云（内容安全护栏 / DashScope）",
    kind: "balance" as const,
    detail: [] as FinanceDetail[],
    consoleUrl: "https://usercenter2.aliyun.com/finance/fund-management/balance-transactions",
  };

  // 变量名大小写不是我们定的：阿里云控制台导出的就是 `Aliyun_AccessKey_ID`，
  // 仓里 probe:aliyun-guard 也读这一对，不再另起一套名字。
  const id = deps.env("Aliyun_AccessKey_ID");
  const secret = deps.env("Aliyun_AccessKey_Secret");
  if (!id || !secret) {
    return unconfigured(base, "未配置 Aliyun_AccessKey_ID / Aliyun_AccessKey_Secret", started);
  }

  try {
    const body = await aliyunRpcGet(deps, id, secret, {
      Action: "QueryAccountBalance",
      Version: "2017-12-14",
    });
    const data = body.Data as
      | {
          AvailableAmount?: string;
          AvailableCashAmount?: string;
          CreditAmount?: string;
          MybankCreditAmount?: string;
          Currency?: string;
        }
      | undefined;
    if (!data) throw new Error("响应里没有 Data");

    return {
      ...base,
      status: "ok",
      exact: true,
      amount: money(data.AvailableAmount),
      currency: data.Currency ?? "CNY",
      durationMs: Date.now() - started,
      detail: [
        { label: "可用现金", value: data.AvailableCashAmount ?? "-" },
        { label: "信用额度", value: data.CreditAmount ?? "-" },
        { label: "网商银行额度", value: data.MybankCreditAmount ?? "-" },
      ],
    };
  } catch (err) {
    return fail(base, err, started);
  }
}

// ────────────────────────────────────────────────────────────── 火山引擎（签名 v4）

interface VolcSignInput {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  host: string;
  query: string;
  /** ISO basic 格式：20260826T101530Z。测试要能钉住它，所以由外面传。 */
  xDate: string;
}

/** 火山签名 v4：四段派生密钥 + 规范请求。导出是为了单测能钉住已知向量。 */
export function signVolc(input: VolcSignInput): { authorization: string; contentSha256: string } {
  const payloadHash = createHash("sha256").update("").digest("hex");
  const shortDate = input.xDate.slice(0, 8);
  const signedHeaders = "host;x-content-sha256;x-date";
  const canonicalRequest = [
    "GET",
    "/",
    input.query,
    `host:${input.host}`,
    `x-content-sha256:${payloadHash}`,
    `x-date:${input.xDate}`,
    "",
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${shortDate}/${input.region}/${input.service}/request`;
  const stringToSign = [
    "HMAC-SHA256",
    input.xDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  const hmac = (key: Buffer | string, data: string): Buffer =>
    createHmac("sha256", key).update(data).digest();
  const kDate = hmac(input.secretAccessKey, shortDate);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  return {
    authorization: `HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    contentSha256: payloadHash,
  };
}

/**
 * 签好名发一次火山 GET。`query` 必须是**已按字典序排好**的规范查询串——
 * 签名算的就是它，重排一次就对不上了，所以调用方直接传最终形态。
 */
async function volcGet(
  deps: ProviderDeps,
  accessKeyId: string,
  secretAccessKey: string,
  query: string,
): Promise<Record<string, unknown>> {
  const host = "open.volcengineapi.com";
  const xDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const { authorization, contentSha256 } = signVolc({
    accessKeyId,
    secretAccessKey,
    region: "cn-beijing",
    service: "billing",
    host,
    query,
    xDate,
  });
  const res = await withTimeout(deps, `https://${host}/?${query}`, {
    headers: { host, "x-date": xDate, "x-content-sha256": contentSha256, authorization },
  });
  const body = (await res.json()) as Record<string, unknown> & {
    ResponseMetadata?: { Error?: { Code?: string; Message?: string } };
  };
  const apiErr = body.ResponseMetadata?.Error;
  // 火山把业务错误放在 HTTP 200 的 body 里也放在 4xx 里，两条都得看。
  if (apiErr?.Code) throw new Error(`${apiErr.Code}：${apiErr.Message ?? ""}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return body;
}

export async function volcengineBalance(deps: ProviderDeps): Promise<FinanceAccount> {
  const started = Date.now();
  const base = {
    id: "volcengine",
    label: "火山引擎（豆包 ASR / TTS）",
    kind: "balance" as const,
    detail: [] as FinanceDetail[],
    consoleUrl: "https://console.volcengine.com/finance/bill/",
  };

  // 注意：ARK_API_KEY 在这里没用。方舟的 API Key 只能调模型，
  // 查余额走的是账号级 OpenAPI，只认 AK/SK 签名——两把钥匙不能互相顶替。
  const ak = deps.env("VOLC_ACCESSKEY");
  const sk = deps.env("VOLC_SECRETKEY");
  if (!ak || !sk) {
    return unconfigured(
      base,
      "未配置 VOLC_ACCESSKEY / VOLC_SECRETKEY（费用 OpenAPI 只认账号 AK/SK，ARK_API_KEY 不适用）",
      started,
    );
  }

  try {
    const body = await volcGet(deps, ak, sk, "Action=QueryBalanceAcct&Version=2022-01-01");
    const result = body.Result as
      | {
          AvailableBalance?: string;
          CashBalance?: string;
          CreditLimit?: string;
          FreezeAmount?: string;
          ArrearsBalance?: string;
        }
      | undefined;
    if (!result) throw new Error("响应里没有 Result");

    const arrears = money(result.ArrearsBalance) ?? 0;
    return {
      ...base,
      status: "ok",
      exact: true,
      amount: money(result.AvailableBalance),
      currency: "CNY",
      durationMs: Date.now() - started,
      detail: [
        { label: "现金余额", value: result.CashBalance ?? "-" },
        { label: "冻结金额", value: result.FreezeAmount ?? "-" },
        { label: "欠费余额", value: result.ArrearsBalance ?? "-" },
        { label: "信用额度", value: result.CreditLimit ?? "-" },
      ],
      note: arrears > 0 ? "账号处于欠费状态，语音链路随时会被停服" : undefined,
    };
  } catch (err) {
    return fail(base, err, started);
  }
}

// ────────────────────────────────────────────────────────────── RAGFlow Cloud（订阅）

export async function ragflowSubscription(deps: ProviderDeps): Promise<FinanceAccount> {
  const started = Date.now();
  const base = {
    id: "ragflow",
    label: "RAGFlow Cloud（知识库检索）",
    kind: "subscription" as const,
    detail: [] as FinanceDetail[],
    consoleUrl: "https://cloud.ragflow.io/",
  };

  const baseUrl = deps.env("RAGFLOW_BASE_URL")?.replace(/\/+$/, "");
  const key = deps.env("RAGFLOW_API_KEY");
  if (!baseUrl || !key) return unconfigured(base, "未配置 RAGFLOW_BASE_URL / RAGFLOW_API_KEY", started);

  try {
    const res = await withTimeout(deps, `${baseUrl}/v1/billing/subscription`, {
      headers: { authorization: `Bearer ${key}` },
    });
    const body = (await res.json()) as {
      code?: number;
      message?: string;
      data?: {
        plan_name?: string;
        status?: string;
        subscription_status?: string;
        payment_state?: string;
        payment_required?: boolean;
        start_time?: string;
        end_time?: string;
        quota_points?: number;
        quota_storage?: number;
        quota_apps?: number;
        quota_members?: number;
        api_request_limit_per_minute?: number;
      };
    };
    if (!res.ok || body.code !== 0 || !body.data) {
      throw new Error(`code=${body.code ?? res.status} ${body.message ?? ""}`.trim());
    }

    const d = body.data;
    const active = (d.subscription_status ?? d.status) === "active";
    const paid = d.payment_state === "paid" && d.payment_required !== true;
    // 到期日是这条最该盯的数字：订阅制不会"越用越少"，只会某天突然到期。
    const endTime = d.end_time ? new Date(d.end_time) : undefined;
    const daysLeft =
      endTime && !Number.isNaN(endTime.getTime())
        ? Math.floor((endTime.getTime() - Date.now()) / 86_400_000)
        : undefined;

    return {
      ...base,
      status: "ok",
      exact: true,
      durationMs: Date.now() - started,
      level: !active || !paid ? "danger" : daysLeft !== undefined && daysLeft <= 7 ? "warn" : "ok",
      detail: [
        { label: "套餐", value: d.plan_name ?? "-" },
        { label: "订阅状态", value: `${d.subscription_status ?? d.status ?? "-"} / ${d.payment_state ?? "-"}` },
        { label: "本期", value: `${(d.start_time ?? "-").slice(0, 10)} → ${(d.end_time ?? "-").slice(0, 10)}` },
        { label: "剩余天数", value: daysLeft === undefined ? "-" : `${daysLeft} 天` },
        { label: "配额（点数/应用/成员）", value: `${d.quota_points ?? "-"} / ${d.quota_apps ?? "-"} / ${d.quota_members ?? "-"}` },
        { label: "存储配额", value: d.quota_storage ? `${(d.quota_storage / 1e9).toFixed(1)} GB` : "-" },
        { label: "接口限速", value: d.api_request_limit_per_minute ? `${d.api_request_limit_per_minute} 次/分` : "-" },
      ],
      note:
        !active || !paid
          ? "订阅未处于已付费的生效状态，双路检索里 RAGFlow 那一路会失效"
          : "订阅制无余额概念；到期不续订就是整条检索链断掉，看剩余天数",
    };
  } catch (err) {
    return fail(base, err, started);
  }
}

// ────────────────────────────────────────────────────────────── 高德（每日免费额度）

/** 高德错误码里与「额度」直接相关的那几个。其余错误按普通失败处理。 */
const AMAP_OVER_LIMIT: Record<string, string> = {
  "10003": "已超出当日访问量上限",
  "10004": "单位时间内访问过于频繁（QPS 超限）",
  "10044": "账号维度当日调用量已达上限",
  "10014": "服务已达并发上限",
};

export async function amapQuota(deps: ProviderDeps): Promise<FinanceAccount> {
  const started = Date.now();
  const base = {
    id: "amap",
    label: "高德地图 Web 服务（导航 / 天气 / 充电站）",
    kind: "quota" as const,
    detail: [] as FinanceDetail[],
    consoleUrl: "https://console.amap.com/dev/flow/basic",
  };

  const key = deps.env("AMAP_SERVER_KEY");
  if (!key) return unconfigured(base, "未配置 AMAP_SERVER_KEY", started);

  try {
    // 高德**没有**查询余量的开放接口（官方原话：配额信息请在控制台-流量分析-配额管理查看）。
    // 所以这里做的是"还能不能用"的探针，不是"还剩多少"的查询：
    // 用一次最便宜的地理编码换一个 infocode，超限时它会自己报出来。
    // 注意这一次探针本身也计入当日额度——所以路由层有缓存与限流，别做成刷新按钮直连。
    const url = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent("北京市朝阳区")}&key=${encodeURIComponent(key)}`;
    const res = await withTimeout(deps, url);
    const body = (await res.json()) as { status?: string; info?: string; infocode?: string };
    const code = body.infocode ?? "";

    if (code === "10000") {
      return {
        ...base,
        status: "ok",
        // 这里恒为 false，前端据此不显示任何数字——见文件头。
        exact: false,
        durationMs: Date.now() - started,
        level: "ok",
        detail: [
          { label: "服务 key 状态", value: "有效" },
          { label: "当日额度", value: "未耗尽（探针调用成功）" },
          { label: "余量查询接口", value: "官方未提供" },
        ],
        note: "高德不开放余量查询，只能在控制台-流量分析-配额管理里看当日消耗；此处仅证明 key 当前可用、未触顶",
      };
    }

    const overLimit = AMAP_OVER_LIMIT[code];
    return {
      ...base,
      status: "failed",
      exact: false,
      durationMs: Date.now() - started,
      level: "danger",
      detail: [
        { label: "infocode", value: code || "-" },
        { label: "info", value: body.info ?? "-" },
      ],
      error: overLimit ?? body.info ?? `infocode=${code}`,
      note: overLimit
        ? "额度已触顶，导航/天气/充电站这几类工具当前会失败"
        : code === "10009"
          ? "疑似把 JS API 的 key 填进了 AMAP_SERVER_KEY——两把 key 不能互换"
          : undefined,
    };
  } catch (err) {
    return fail(base, err, started);
  }
}

// ────────────────────────────────────────────────────────────── 账单

/**
 * 倒推最近 N 个账期（含当月），形如 `2026-08`。
 *
 * 用 UTC 分量而不是本地月份：账期是供应商定义的，我们只是把它当字符串键用，
 * 本地时区在月初/月末会算出隔壁月份，那时表格会莫名少一整期。
 */
export function recentPeriods(now: Date, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

/** 账单默认看几个账期。3 期足以覆盖"上个月是不是突然涨了"。 */
const BILL_PERIODS = 3;

function billsFail(accountId: string, consoleUrl: string, coverage: string, err: unknown, startedAt: number): FinanceBillPage {
  return {
    accountId,
    status: "failed",
    rows: [],
    coverage,
    consoleUrl,
    durationMs: Date.now() - startedAt,
    error: err instanceof Error ? err.message : String(err),
  };
}

// ── 火山引擎：ListBillOverviewByProd（按产品按月）

interface VolcBillRow {
  BillPeriod?: string;
  Product?: string;
  ProductZh?: string;
  PayableAmount?: string;
  PaidAmount?: string;
  UnpaidAmount?: string;
  OriginalBillAmount?: string;
}

export async function volcengineBills(deps: ProviderDeps): Promise<FinanceBillPage> {
  const started = Date.now();
  const consoleUrl = "https://console.volcengine.com/finance/bill/";
  const periods = recentPeriods(deps.now(), BILL_PERIODS);
  const coverage = `近 ${BILL_PERIODS} 个账期（${periods[periods.length - 1]} ~ ${periods[0]}）`;

  const ak = deps.env("VOLC_ACCESSKEY");
  const sk = deps.env("VOLC_SECRETKEY");
  if (!ak || !sk) {
    return {
      accountId: "volcengine",
      status: "unconfigured",
      rows: [],
      coverage,
      consoleUrl,
      durationMs: Date.now() - started,
      note: "未配置 VOLC_ACCESSKEY / VOLC_SECRETKEY",
    };
  }

  try {
    const pages = await Promise.all(
      periods.map(async (period) => {
        // Offset 是必填的——不给会得到 MissingParameter，而不是默认 0。
        const query = `Action=ListBillOverviewByProd&BillPeriod=${period}&Limit=100&Offset=0&Version=2022-01-01`;
        const body = await volcGet(deps, ak, sk, query);
        const list = (body.Result as { List?: VolcBillRow[] } | undefined)?.List ?? [];
        return { period, list };
      }),
    );

    /*
     * 同一个账期同一个产品，火山会因结算方式不同拆成多行（实测 TTS 就是两行）。
     * 表格里并排两行同名产品只会让人以为看重了，所以按 账期+产品 先合并再展示。
     * 注意**只取金额字段**：原始响应里还有付款人真实姓名，那些一个都不要带出来。
     */
    const merged = new Map<string, FinanceBill & { paid: number; unpaid: number; original: number }>();
    for (const { period, list } of pages) {
      for (const row of list) {
        const item = row.ProductZh ?? row.Product ?? "未知产品";
        const key = `${period}|${item}`;
        const cur = merged.get(key) ?? {
          period,
          item,
          amount: 0,
          currency: "CNY",
          paid: 0,
          unpaid: 0,
          original: 0,
        };
        cur.amount = (cur.amount ?? 0) + (money(row.PayableAmount) ?? 0);
        cur.paid += money(row.PaidAmount) ?? 0;
        cur.unpaid += money(row.UnpaidAmount) ?? 0;
        cur.original += money(row.OriginalBillAmount) ?? 0;
        merged.set(key, cur);
      }
    }

    const rows: FinanceBill[] = [...merged.values()]
      .map(({ paid, unpaid, original, ...bill }) => {
        const payable = bill.amount ?? 0;
        // 应付 0 但原价不是 0 = 被资源包/代金券抵掉了。
        // 不说这一句的话，表里那行 `0.00` 看起来像"这个产品没在用"。
        const discounted = original > payable ? `原价 ¥${original.toFixed(2)}，已抵扣` : undefined;
        return {
          ...bill,
          status: unpaid > 0 ? `未付 ¥${unpaid.toFixed(2)}` : payable > 0 ? "已结清" : "无费用",
          note: paid > 0 && unpaid > 0 ? `已付 ¥${paid.toFixed(2)}` : discounted,
        };
      })
      // 金额大的排前面，同期内一眼看出钱花在哪；跨期按账期倒序。
      .sort((a, b) => (a.period === b.period ? (b.amount ?? 0) - (a.amount ?? 0) : b.period.localeCompare(a.period)));

    return {
      accountId: "volcengine",
      status: "ok",
      rows,
      coverage,
      consoleUrl,
      durationMs: Date.now() - started,
      note: "按产品汇总的月账单；同产品的多条结算记录已合并",
    };
  } catch (err) {
    return billsFail("volcengine", consoleUrl, coverage, err, started);
  }
}

// ── 阿里云：QueryBillOverview（按产品按月）

export async function aliyunBills(deps: ProviderDeps): Promise<FinanceBillPage> {
  const started = Date.now();
  const consoleUrl = "https://usercenter2.aliyun.com/finance/expense-report/expense-overview";
  const periods = recentPeriods(deps.now(), BILL_PERIODS);
  const coverage = `近 ${BILL_PERIODS} 个账期（${periods[periods.length - 1]} ~ ${periods[0]}）`;

  const id = deps.env("Aliyun_AccessKey_ID");
  const secret = deps.env("Aliyun_AccessKey_Secret");
  if (!id || !secret) {
    return {
      accountId: "aliyun",
      status: "unconfigured",
      rows: [],
      coverage,
      consoleUrl,
      durationMs: Date.now() - started,
      note: "未配置 Aliyun_AccessKey_ID / Aliyun_AccessKey_Secret",
    };
  }

  try {
    const pages = await Promise.all(
      periods.map(async (period) => {
        const body = await aliyunRpcGet(deps, id, secret, {
          Action: "QueryBillOverview",
          Version: "2017-12-14",
          BillingCycle: period,
        });
        const items =
          (
            body.Data as
              | {
                  Items?: {
                    Item?: Array<{
                      ProductName?: string;
                      ProductCode?: string;
                      PretaxAmount?: number | string;
                      CashAmount?: number | string;
                      SubscriptionType?: string;
                    }>;
                  };
                }
              | undefined
          )?.Items?.Item ?? [];
        return { period, items };
      }),
    );

    const rows: FinanceBill[] = pages.flatMap(({ period, items }) =>
      items.map((it) => ({
        period,
        // 账单项里 BillingCycle 是空的，所以账期用请求时那个，别指望响应回填。
        item: it.ProductName ?? it.ProductCode ?? "未知产品",
        amount: money(it.PretaxAmount),
        currency: "CNY",
        status: it.SubscriptionType === "PayAsYouGo" ? "按量付费" : (it.SubscriptionType ?? undefined),
        // 只在"现金确实付了一部分、且与应付不等"时才提一句。
        // 现金 0（全部走账期后付）写成"现金支付 ¥0.00"是纯噪音。
        note: (() => {
          const cash = money(it.CashAmount) ?? 0;
          return cash > 0 && cash !== money(it.PretaxAmount) ? `现金支付 ¥${cash.toFixed(2)}` : undefined;
        })(),
      })),
    );
    rows.sort((a, b) => (a.period === b.period ? (b.amount ?? 0) - (a.amount ?? 0) : b.period.localeCompare(a.period)));

    return {
      accountId: "aliyun",
      status: "ok",
      rows,
      coverage,
      consoleUrl,
      durationMs: Date.now() - started,
      note: "按产品汇总的月账单（应付金额，未扣代金券前）",
    };
  } catch (err) {
    return billsFail("aliyun", consoleUrl, coverage, err, started);
  }
}

// ── RAGFlow：没有账单列表，只有当期订阅与一张 Stripe 发票

export async function ragflowBills(deps: ProviderDeps): Promise<FinanceBillPage> {
  const started = Date.now();
  const consoleUrl = "https://cloud.ragflow.io/";
  const coverage = "当前订阅周期";

  const baseUrl = deps.env("RAGFLOW_BASE_URL")?.replace(/\/+$/, "");
  const key = deps.env("RAGFLOW_API_KEY");
  if (!baseUrl || !key) {
    return {
      accountId: "ragflow",
      status: "unconfigured",
      rows: [],
      coverage,
      consoleUrl,
      durationMs: Date.now() - started,
      note: "未配置 RAGFLOW_BASE_URL / RAGFLOW_API_KEY",
    };
  }

  try {
    const res = await withTimeout(deps, `${baseUrl}/v1/billing/subscription`, {
      headers: { authorization: `Bearer ${key}` },
    });
    const body = (await res.json()) as {
      code?: number;
      data?: {
        plan_name?: string;
        start_time?: string;
        end_time?: string;
        payment_state?: string;
        invoice_url?: string;
        invoice_pdf_url?: string;
      };
    };
    if (!res.ok || body.code !== 0 || !body.data) throw new Error(`code=${body.code ?? res.status}`);

    const d = body.data;
    return {
      accountId: "ragflow",
      status: "ok",
      rows: [
        {
          period: (d.start_time ?? "").slice(0, 7) || coverage,
          item: `${d.plan_name ?? "订阅"} 套餐（${(d.start_time ?? "-").slice(0, 10)} → ${(d.end_time ?? "-").slice(0, 10)}）`,
          // 订阅接口不回金额，只回发票链接。凭 plan 名反推价格就是编造，宁可留空。
          amount: undefined,
          currency: "USD",
          status: d.payment_state ?? undefined,
          note: "金额见 Stripe 发票",
          link: d.invoice_url || d.invoice_pdf_url || undefined,
        },
      ],
      coverage,
      consoleUrl,
      durationMs: Date.now() - started,
      note: "RAGFlow Cloud 没有账单列表接口，只有当期订阅与一张 Stripe 发票",
    };
  } catch (err) {
    return billsFail("ragflow", consoleUrl, coverage, err, started);
  }
}

// ────────────────────────────────────────────────────────────── 注册表

export interface FinanceProvider {
  id: string;
  account: (deps: ProviderDeps) => Promise<FinanceAccount>;
  /** 有账单接口的才有这一项。 */
  bills?: (deps: ProviderDeps) => Promise<FinanceBillPage>;
  /**
   * 没有 `bills` 时**必须**说明为什么。
   * 空表格最怕的解读是"这段时间没花钱"——而真相往往是"这家压根不给查"，
   * 两者的处置动作完全不同，所以这句话是必填不是可选。
   */
  billsUnsupportedReason?: string;
  /** 不支持时把人送去哪儿人工看。 */
  billsConsoleUrl?: string;
}

export const FINANCE_PROVIDERS: FinanceProvider[] = [
  {
    id: "deepseek",
    account: deepseekBalance,
    billsUnsupportedReason:
      "DeepSeek 开放平台只提供 /user/balance，没有账单或流水接口（/user/transactions 等均 404）",
    billsConsoleUrl: "https://platform.deepseek.com/transactions",
  },
  { id: "volcengine", account: volcengineBalance, bills: volcengineBills },
  { id: "aliyun", account: aliyunBalance, bills: aliyunBills },
  { id: "ragflow", account: ragflowSubscription, bills: ragflowBills },
  {
    id: "amap",
    account: amapQuota,
    billsUnsupportedReason:
      "高德 Web 服务走免费额度，没有账单概念，也没有开放用量查询接口；消耗量只能在控制台-流量分析里看",
    billsConsoleUrl: "https://console.amap.com/dev/flow/basic",
  },
];
