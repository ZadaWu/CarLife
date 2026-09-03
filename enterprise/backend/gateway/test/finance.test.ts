/**
 * 财务页接口（`GET /console/finance`）与五个供应商适配器。
 *
 * 盯得最紧的四条：
 *  1. **响应里绝不能出现密钥**——这一页要拿五家的凭据去打接口，
 *     顺手把 key 回显到明细里是最自然也最致命的一步（§8.2 A 类只写不读）。
 *  2. **拿不到确切数字就不许给数字**（`exact=false`）——高德那条永远是探针不是余量，
 *     渲染成"还剩多少"比不显示危险得多。
 *  3. **一家挂掉不能带塌整页**——五家并发，各自吞异常。
 *  4. **默认吃缓存**——高德探针本身消耗当日额度，做成"开一次页打一轮"就是自伤。
 *
 * 全部脱网：`fetch` 由外部注入。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

import {
  aliyunBills,
  amapQuota,
  deepseekBalance,
  ragflowBills,
  ragflowSubscription,
  recentPeriods,
  signVolc,
  volcengineBalance,
  volcengineBills,
  type FetchLike,
  type ProviderDeps,
} from "../src/console/finance-providers";
import { createFinanceRouter, levelFor } from "../src/console/finance";
import {
  bucketStart,
  emptyHistory,
  intervalMs,
  toApi,
  prune,
  recordSnapshot,
  saveHistory,
  type FinanceHistory,
} from "../src/console/finance-history";

/** 假凭据。刻意不长成任何真 key 的样子——check:secrets 扫的是全仓，测试文件也在内。 */
const FAKE_KEY = "placeholder-credential";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 钉死"现在"，账期倒推才有确定答案。 */
const NOW = new Date("2026-08-26T12:00:00Z");

function depsOf(
  env: Record<string, string>,
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): ProviderDeps {
  return {
    fetch: ((url, init) => Promise.resolve(handler(url, init))) as FetchLike,
    env: (k) => env[k],
    timeoutMs: 5_000,
    now: () => NOW,
  };
}

describe("供应商适配器", () => {
  it("DeepSeek：取 CNY 那本账，附带可发起请求标记", async () => {
    const account = await deepseekBalance(
      depsOf({ DEEPSEEK_API_KEY: FAKE_KEY }, () =>
        jsonRes({
          is_available: true,
          balance_infos: [
            { currency: "USD", total_balance: "1.00" },
            { currency: "CNY", total_balance: "62.03", granted_balance: "0.00", topped_up_balance: "62.03" },
          ],
        }),
      ),
    );
    assert.equal(account.status, "ok");
    assert.equal(account.exact, true);
    assert.equal(account.amount, 62.03);
    assert.equal(account.currency, "CNY");
    assert.ok(!JSON.stringify(account).includes(FAKE_KEY), "响应里不得出现 API key");
  });

  it("DeepSeek：is_available=false 时即使有余额也要说出来", async () => {
    const account = await deepseekBalance(
      depsOf({ DEEPSEEK_API_KEY: FAKE_KEY }, () =>
        jsonRes({ is_available: false, balance_infos: [{ currency: "CNY", total_balance: "0.01" }] }),
      ),
    );
    assert.match(account.note ?? "", /不可用/);
  });

  it("缺凭据是 unconfigured，不是 failed —— 两者的处置动作不一样", async () => {
    const account = await deepseekBalance(depsOf({}, () => jsonRes({})));
    assert.equal(account.status, "unconfigured");
    assert.equal(account.amount, undefined);
  });

  it("上游 5xx 不抛异常，降级成 failed 并留下原因", async () => {
    const account = await deepseekBalance(
      depsOf({ DEEPSEEK_API_KEY: FAKE_KEY }, () => jsonRes({ error: "boom" }, 503)),
    );
    assert.equal(account.status, "failed");
    assert.match(account.error ?? "", /503/);
  });

  it("火山引擎：没有 AK/SK 时明说 ARK_API_KEY 顶替不了", async () => {
    const account = await volcengineBalance(depsOf({ ARK_API_KEY: FAKE_KEY }, () => jsonRes({})));
    assert.equal(account.status, "unconfigured");
    assert.match(account.note ?? "", /ARK_API_KEY/);
  });

  it("火山引擎：签名 v4 的密钥派生是四段且结果稳定", () => {
    const input = {
      accessKeyId: "AKLTtest",
      secretAccessKey: "shhh",
      region: "cn-beijing",
      service: "billing",
      host: "open.volcengineapi.com",
      query: "Action=QueryBalanceAcct&Version=2022-01-01",
      xDate: "20260826T101530Z",
    };
    const a = signVolc(input);
    const b = signVolc(input);
    assert.equal(a.authorization, b.authorization, "同一输入必须得到同一签名");
    assert.match(a.authorization, /^HMAC-SHA256 Credential=AKLTtest\/20260826\/cn-beijing\/billing\/request, /);
    assert.match(a.authorization, /SignedHeaders=host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/);
    // 空 body 的 sha256——签名与规范请求都依赖它，写死当回归锚点
    assert.equal(a.contentSha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("火山引擎：API 层错误（HTTP 200 里的 Error）也算失败", async () => {
    const account = await volcengineBalance(
      depsOf({ VOLC_ACCESSKEY: "ak", VOLC_SECRETKEY: "sk" }, () =>
        jsonRes({ ResponseMetadata: { Error: { Code: "SignatureDoesNotMatch", Message: "bad" } } }),
      ),
    );
    assert.equal(account.status, "failed");
    assert.match(account.error ?? "", /SignatureDoesNotMatch/);
  });

  it("RAGFlow：订阅制不给金额，给剩余天数；快到期转 warn", async () => {
    const endTime = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const account = await ragflowSubscription(
      depsOf({ RAGFLOW_BASE_URL: "https://cloud.ragflow.io/", RAGFLOW_API_KEY: FAKE_KEY }, (url) => {
        assert.equal(url, "https://cloud.ragflow.io/v1/billing/subscription", "尾斜杠要被吃掉");
        return jsonRes({
          code: 0,
          data: {
            plan_name: "Starter",
            subscription_status: "active",
            payment_state: "paid",
            start_time: "2026-08-10T02:45:10Z",
            end_time: endTime,
            quota_points: 5000,
          },
        });
      }),
    );
    assert.equal(account.status, "ok");
    assert.equal(account.kind, "subscription");
    assert.equal(account.amount, undefined, "订阅制不该被塞一个假余额");
    assert.equal(account.level, "warn");
  });

  it("RAGFlow：欠费/失效直接 danger", async () => {
    const account = await ragflowSubscription(
      depsOf({ RAGFLOW_BASE_URL: "https://cloud.ragflow.io", RAGFLOW_API_KEY: FAKE_KEY }, () =>
        jsonRes({
          code: 0,
          data: {
            plan_name: "Starter",
            subscription_status: "past_due",
            payment_state: "unpaid",
            payment_required: true,
            end_time: new Date(Date.now() + 300 * 86_400_000).toISOString(),
          },
        }),
      ),
    );
    assert.equal(account.level, "danger");
  });

  it("高德：探针成功也只报「未触顶」，exact 恒为 false", async () => {
    const account = await amapQuota(
      depsOf({ AMAP_SERVER_KEY: FAKE_KEY }, (url) => {
        assert.ok(url.startsWith("https://restapi.amap.com/v3/geocode/geo"));
        return jsonRes({ status: "1", info: "OK", infocode: "10000" });
      }),
    );
    assert.equal(account.status, "ok");
    assert.equal(account.exact, false, "高德不开放余量查询，任何时候都不许声称精确");
    assert.equal(account.amount, undefined);
    assert.ok(!JSON.stringify(account).includes(FAKE_KEY), "探针 URL 里的 key 不得回显");
  });

  it("高德：日额度触顶要报 danger 并说清后果", async () => {
    const account = await amapQuota(
      depsOf({ AMAP_SERVER_KEY: FAKE_KEY }, () =>
        jsonRes({ status: "0", info: "DAILY_QUERY_OVER_LIMIT", infocode: "10003" }),
      ),
    );
    assert.equal(account.status, "failed");
    assert.equal(account.level, "danger");
    assert.match(account.error ?? "", /当日访问量/);
  });

  it("高德：10009 直指「两把 key 填反了」", async () => {
    const account = await amapQuota(
      depsOf({ AMAP_SERVER_KEY: FAKE_KEY }, () =>
        jsonRes({ status: "0", info: "INVALID_USER_SCODE", infocode: "10009" }),
      ),
    );
    assert.match(account.note ?? "", /不能互换/);
  });
});

describe("账单适配器", () => {
  it("recentPeriods 用 UTC 分量倒推，跨年不出错", () => {
    assert.deepEqual(recentPeriods(NOW, 3), ["2026-08", "2026-07", "2026-06"]);
    assert.deepEqual(recentPeriods(new Date("2026-01-15T00:00:00Z"), 3), ["2026-01", "2025-12", "2025-11"]);
    // 月初 UTC 零点：本地时区往前推会算成上个月，这条就是钉那个坑
    assert.equal(recentPeriods(new Date("2026-03-01T00:00:00Z"), 1)[0], "2026-03");
  });

  it("火山：同账期同产品的多条结算记录合并成一行", async () => {
    const page = await volcengineBills(
      depsOf({ VOLC_ACCESSKEY: "ak", VOLC_SECRETKEY: "sk" }, (url) => {
        if (!url.includes("BillPeriod=2026-08")) return jsonRes({ Result: { List: [] } });
        return jsonRes({
          Result: {
            List: [
              // 实测形态：TTS 因结算方式不同被拆成两行
              { BillPeriod: "2026-08", ProductZh: "语音合成", PayableAmount: "28.00", PaidAmount: "28.00", UnpaidAmount: "0.00" },
              { BillPeriod: "2026-08", ProductZh: "语音合成", PayableAmount: "131.83", PaidAmount: "94.98", UnpaidAmount: "36.85" },
              { BillPeriod: "2026-08", ProductZh: "对象存储", PayableAmount: "0.00", PaidAmount: "0.00", UnpaidAmount: "0.00" },
            ],
          },
        });
      }),
    );
    assert.equal(page.status, "ok");
    const tts = page.rows.filter((r) => r.item === "语音合成");
    assert.equal(tts.length, 1, "同产品必须合并成一行");
    assert.equal(tts[0].amount, 159.83);
    assert.equal(tts[0].status, "未付 ¥36.85");
    // 金额降序：花得最多的排最前
    assert.equal(page.rows[0].item, "语音合成");
    assert.equal(page.rows.find((r) => r.item === "对象存储")?.status, "无费用");
  });

  it("火山：应付 0 但原价不为 0 要说明是被抵扣的，不能只留一个光秃秃的 0.00", async () => {
    const page = await volcengineBills(
      depsOf({ VOLC_ACCESSKEY: "ak", VOLC_SECRETKEY: "sk" }, (url) =>
        url.includes("BillPeriod=2026-08")
          ? jsonRes({
              Result: {
                List: [
                  { ProductZh: "对象存储-资源包", OriginalBillAmount: "37.14", PayableAmount: "0.00", PaidAmount: "0.00", UnpaidAmount: "0.00" },
                ],
              },
            })
          : jsonRes({ Result: { List: [] } }),
      ),
    );
    assert.equal(page.rows[0].amount, 0);
    assert.match(page.rows[0].note ?? "", /原价 ¥37\.14，已抵扣/);
  });

  it("火山：响应里的付款人真实姓名不得进表格", async () => {
    const page = await volcengineBills(
      depsOf({ VOLC_ACCESSKEY: "ak", VOLC_SECRETKEY: "sk" }, () =>
        jsonRes({
          Result: {
            List: [
              {
                BillPeriod: "2026-08",
                ProductZh: "语音合成",
                PayableAmount: "1.00",
                PayerUserName: "某某某",
                PayerCustomerName: "某某某某",
                OwnerUserName: "某某",
              },
            ],
          },
        }),
      ),
    );
    const text = JSON.stringify(page);
    assert.ok(!text.includes("某某"), "上游带出来的人名字段一个都不该透传");
  });

  it("火山：缺凭据时是 unconfigured，不是空表", async () => {
    const page = await volcengineBills(depsOf({}, () => jsonRes({})));
    assert.equal(page.status, "unconfigured");
    assert.equal(page.rows.length, 0);
    assert.match(page.coverage, /近 3 个账期/);
  });

  it("阿里云：账期用请求时那个——响应项里的 BillingCycle 是空的", async () => {
    const page = await aliyunBills(
      depsOf({ Aliyun_AccessKey_ID: "id", Aliyun_AccessKey_Secret: "sec" }, (url) => {
        const cycle = /BillingCycle=([\d-]+)/.exec(url)?.[1];
        if (cycle !== "2026-08") return jsonRes({ Success: true, Data: { Items: { Item: [] } } });
        return jsonRes({
          Success: true,
          Data: {
            Items: {
              Item: [
                { ProductName: "AI 安全护栏", PretaxAmount: 8.09, CashAmount: 0, SubscriptionType: "PayAsYouGo" },
                { ProductName: "数据管理", PretaxAmount: 10.31, CashAmount: 0, SubscriptionType: "PayAsYouGo" },
              ],
            },
          },
        });
      }),
    );
    assert.equal(page.status, "ok");
    assert.equal(page.rows.length, 2);
    assert.equal(page.rows[0].period, "2026-08");
    assert.equal(page.rows[0].item, "数据管理", "同期内按金额降序");
    assert.equal(page.rows[0].status, "按量付费");
    assert.equal(page.rows[0].note, undefined, "现金 0 不该写成「现金支付 ¥0.00」");
  });

  it("阿里云：接口报错降级成 failed，不是空表", async () => {
    const page = await aliyunBills(
      depsOf({ Aliyun_AccessKey_ID: "id", Aliyun_AccessKey_Secret: "sec" }, () =>
        jsonRes({ Success: false, Code: "Forbidden.RAM", Message: "no permission" }),
      ),
    );
    assert.equal(page.status, "failed");
    assert.match(page.error ?? "", /Forbidden\.RAM/);
  });

  it("RAGFlow：只有一张发票，金额留空不编", async () => {
    const page = await ragflowBills(
      depsOf({ RAGFLOW_BASE_URL: "https://cloud.ragflow.io", RAGFLOW_API_KEY: FAKE_KEY }, () =>
        jsonRes({
          code: 0,
          data: {
            plan_name: "Starter",
            start_time: "2026-08-10T02:45:10Z",
            end_time: "2026-09-10T02:45:10Z",
            payment_state: "paid",
            invoice_url: "https://invoice.stripe.com/i/xxx",
          },
        }),
      ),
    );
    assert.equal(page.rows.length, 1);
    assert.equal(page.rows[0].amount, undefined, "订阅接口不回金额，反推价格就是编造");
    assert.equal(page.rows[0].link, "https://invoice.stripe.com/i/xxx");
  });
});

describe("levelFor", () => {
  const t = { warnCny: 50, dangerCny: 10 };
  const base = {
    id: "x",
    label: "x",
    kind: "balance" as const,
    status: "ok" as const,
    exact: true,
    detail: [],
    consoleUrl: "",
    durationMs: 1,
  };

  it("按阈值分档", () => {
    assert.equal(levelFor({ ...base, amount: 100 }, t), "ok");
    assert.equal(levelFor({ ...base, amount: 50 }, t), "warn");
    assert.equal(levelFor({ ...base, amount: 9 }, t), "danger");
  });

  it("不精确或没数字的一律不评级——凭空评级就是编造", () => {
    assert.equal(levelFor({ ...base, exact: false, amount: 3 }, t), undefined);
    assert.equal(levelFor({ ...base }, t), undefined);
  });

  it("适配器已定的等级优先（订阅制不看金额）", () => {
    assert.equal(levelFor({ ...base, kind: "subscription", level: "danger", amount: 999 }, t), "danger");
  });
});

describe("GET /console/finance", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    // 只留 DeepSeek 一家有凭据：其余四家走 unconfigured，测试不碰网络
    for (const k of [
      "VOLC_ACCESSKEY",
      "VOLC_SECRETKEY",
      "Aliyun_AccessKey_ID",
      "Aliyun_AccessKey_Secret",
      "RAGFLOW_BASE_URL",
      "RAGFLOW_API_KEY",
      "AMAP_SERVER_KEY",
    ]) {
      delete process.env[k];
    }
    process.env.DEEPSEEK_API_KEY = FAKE_KEY;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  function appWith(
    role: "admin" | "ops" | null,
    fetchImpl: FetchLike,
    stateFile: string | null = null, // 测试默认关持久化——不关的话每跑一次都往 var/ 写文件
  ) {
    const app = express();
    app.use((req, _res, next) => {
      if (role) (req as express.Request & { console?: unknown }).console = { subject: `t-${role}`, role };
      next();
    });
    app.use(createFinanceRouter({ fetch: fetchImpl, stateFile }));
    return app;
  }

  async function get(app: express.Express, path: string) {
    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: r.status, text: await r.text() };
    } finally {
      server.close();
    }
  }

  it("ops 拿不到余额（403），未登录 401", async () => {
    const stub: FetchLike = () => Promise.resolve(jsonRes({}));
    assert.equal((await get(appWith("ops", stub), "/console/finance")).status, 403);
    assert.equal((await get(appWith(null, stub), "/console/finance")).status, 401);
  });

  it("admin 拿到五家的快照，且响应里没有任何密钥", async () => {
    const stub: FetchLike = () =>
      Promise.resolve(jsonRes({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "62.03" }] }));
    const r = await get(appWith("admin", stub), "/console/finance");
    assert.equal(r.status, 200);
    const body = JSON.parse(r.text) as { accounts: Array<{ id: string; status: string }>; cached: boolean };
    assert.deepEqual(
      body.accounts.map((a) => a.id).sort(),
      ["aliyun", "amap", "deepseek", "ragflow", "volcengine"],
    );
    assert.equal(body.accounts.find((a) => a.id === "deepseek")?.status, "ok");
    assert.equal(body.accounts.find((a) => a.id === "amap")?.status, "unconfigured");
    assert.ok(!r.text.includes(FAKE_KEY), "快照里不得出现任何密钥");
  });

  it("默认吃缓存：第二次请求不再打上游", async () => {
    let calls = 0;
    const stub: FetchLike = () => {
      calls += 1;
      return Promise.resolve(jsonRes({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "1" }] }));
    };
    const app = appWith("admin", stub);
    await get(app, "/console/finance");
    const first = calls;
    const second = await get(app, "/console/finance");
    assert.equal(calls, first, "缓存期内不得重复请求上游（高德探针要花当日额度）");
    assert.equal((JSON.parse(second.text) as { cached: boolean }).cached, true);
  });

  it("账单：DeepSeek / 高德返回 unsupported 而不是空数组", async () => {
    const stub: FetchLike = () => Promise.resolve(jsonRes({}));
    for (const id of ["deepseek", "amap"]) {
      const r = await get(appWith("admin", stub), `/console/finance/bills/${id}`);
      assert.equal(r.status, 200);
      const b = JSON.parse(r.text) as { status: string; rows: unknown[]; note?: string; consoleUrl: string };
      assert.equal(b.status, "unsupported", `${id} 必须明说"查不了"，空数组会被读成"没花钱"`);
      assert.equal(b.rows.length, 0);
      assert.ok(b.note && b.note.length > 0, "不支持时必须给出原因");
      assert.ok(b.consoleUrl.length > 0, "查不了就得能跳去人工看");
    }
  });

  it("账单：不存在的账户 404", async () => {
    const stub: FetchLike = () => Promise.resolve(jsonRes({}));
    assert.equal((await get(appWith("admin", stub), "/console/finance/bills/nope")).status, 404);
  });

  it("账单：ops 同样被挡在外面", async () => {
    const stub: FetchLike = () => Promise.resolve(jsonRes({}));
    assert.equal((await get(appWith("ops", stub), "/console/finance/bills/aliyun")).status, 403);
  });

  it("账单：按账户各自缓存，切回来不重复打上游", async () => {
    process.env.Aliyun_AccessKey_ID = "id";
    process.env.Aliyun_AccessKey_Secret = "sec";
    let calls = 0;
    const stub: FetchLike = () => {
      calls += 1;
      return Promise.resolve(jsonRes({ Success: true, Data: { Items: { Item: [] } } }));
    };
    const app = appWith("admin", stub);
    await get(app, "/console/finance/bills/aliyun");
    assert.equal(calls, 3, "3 个账期各打一次");
    const again = await get(app, "/console/finance/bills/aliyun");
    assert.equal(calls, 3, "缓存期内不得重复请求");
    assert.equal((JSON.parse(again.text) as { cached: boolean }).cached, true);
  });

  it("账单：接口通但这段时间没账单 —— rows 空且 status=ok，与 unsupported 分得开", async () => {
    process.env.Aliyun_AccessKey_ID = "id";
    process.env.Aliyun_AccessKey_Secret = "sec";
    const stub: FetchLike = () => Promise.resolve(jsonRes({ Success: true, Data: { Items: { Item: [] } } }));
    const r = await get(appWith("admin", stub), "/console/finance/bills/aliyun");
    const b = JSON.parse(r.text) as { status: string; rows: unknown[]; coverage: string };
    assert.equal(b.status, "ok");
    assert.equal(b.rows.length, 0);
    assert.match(b.coverage, /近 3 个账期/, "空态得说清查的是哪段时间");
  });

  it("stored=1：没有历史时 204，不打上游", async () => {
    let calls = 0;
    const stub: FetchLike = () => {
      calls += 1;
      return Promise.resolve(jsonRes({}));
    };
    const app = appWith("admin", stub);
    assert.equal((await get(app, "/console/finance?stored=1")).status, 204);
    assert.equal((await get(app, "/console/finance/bills/aliyun?stored=1")).status, 204);
    assert.equal(calls, 0, "stored 路径任何时候都不许打上游");
  });

  it("stored=1：有历史时秒回上次快照并标 stored，不打上游", async () => {
    let calls = 0;
    const stub: FetchLike = () => {
      calls += 1;
      return Promise.resolve(jsonRes({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "1" }] }));
    };
    const app = appWith("admin", stub);
    await get(app, "/console/finance"); // 先真实采集一轮
    const upstream = calls;
    const r = await get(app, "/console/finance?stored=1");
    assert.equal(r.status, 200);
    const b = JSON.parse(r.text) as { stored?: boolean; cached: boolean; accounts: unknown[] };
    assert.equal(b.stored, true);
    assert.equal(b.accounts.length, 5);
    assert.equal(calls, upstream, "stored 路径不得追加上游调用");
  });

  it("落盘后换一个路由实例（=网关重启），stored=1 仍能给出上次的余额与账单", async () => {
    process.env.Aliyun_AccessKey_ID = "id";
    process.env.Aliyun_AccessKey_Secret = "sec";
    const file = join(tmpdir(), `finance-state-${process.pid}-${Date.now()}.json`);
    const stub: FetchLike = (url) =>
      Promise.resolve(
        url.includes("business.aliyuncs.com") && url.includes("QueryBillOverview")
          ? jsonRes({ Success: true, Data: { Items: { Item: [{ ProductName: "AI 安全护栏", PretaxAmount: 8.09, SubscriptionType: "PayAsYouGo" }] } } })
          : jsonRes({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "62.03" }] }),
      );

    try {
      const first = appWith("admin", stub, file);
      await get(first, "/console/finance");
      await get(first, "/console/finance/bills/aliyun");

      // 新实例 = 重启后的网关。fetch 桩换成会炸的：证明水化的数据不来自上游。
      const boom: FetchLike = () => Promise.reject(new Error("重启后不该有任何上游调用"));
      const second = appWith("admin", boom, file);

      const snap = await get(second, "/console/finance?stored=1");
      assert.equal(snap.status, 200);
      const sb = JSON.parse(snap.text) as { stored?: boolean; accounts: Array<{ id: string; amount?: number }> };
      assert.equal(sb.stored, true);
      assert.equal(sb.accounts.find((a) => a.id === "deepseek")?.amount, 62.03);

      const bills = await get(second, "/console/finance/bills/aliyun?stored=1");
      assert.equal(bills.status, 200);
      const bb = JSON.parse(bills.text) as { stored?: boolean; rows: Array<{ item: string }> };
      assert.equal(bb.stored, true);
      assert.equal(bb.rows[0]?.item, "AI 安全护栏");
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("状态文件损坏时按空白启动，不抛也不留着坏文件", async () => {
    const file = join(tmpdir(), `finance-broken-${process.pid}-${Date.now()}.json`);
    writeFileSync(file, "{ 这不是 JSON");
    try {
      const stub: FetchLike = () => Promise.resolve(jsonRes({}));
      const app = appWith("admin", stub, file);
      assert.equal((await get(app, "/console/finance?stored=1")).status, 204, "坏文件应按空白处理");
      assert.ok(!existsSync(file), "坏文件应被改名留证，不再占着正名");
    } finally {
      rmSync(file, { force: true });
      for (const f of readdirSync(tmpdir()).filter((f) => f.startsWith(`finance-broken-${process.pid}`))) {
        rmSync(join(tmpdir(), f), { force: true });
      }
    }
  });

  it("强制刷新每分钟 4 次，第 5 次 429", async () => {
    const stub: FetchLike = () =>
      Promise.resolve(jsonRes({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "1" }] }));
    const app = appWith("admin", stub);
    for (let i = 0; i < 4; i++) {
      assert.equal((await get(app, "/console/finance?refresh=1")).status, 200, `第 ${i + 1} 次应放行`);
    }
    assert.equal((await get(app, "/console/finance?refresh=1")).status, 429);
  });
});

/**
 * 余额历史（`GET /console/finance/history`）—— 卡片曲线的数据源。
 *
 * 盯的是五件"错了也不报错、只是曲线在说另一个故事"的事：
 *  1. **只记拿到确切数字的账户**。高德 exact=false、RAGFlow 无余额口径，
 *     给它们记点等于把"查不到"画成"一直没变"。
 *  2. **一个采样周期一个点**。同一个桶里连点几次强制刷新不能变成几个点，
 *     否则那一段曲线会突然变密，看起来像波动。
 *  3. **过期的点要掉出去**。说的是"最近 7 天"，就不能混进第 8 天的点。
 *  4. **重启不重打**。开发机一天 `dev:restart` 十几次，每次启动都补一轮
 *     就等于把高德那条消耗当日额度的探针打十几次。
 *  5. **周期是唯一的旋钮**。桶宽、响应里的 `stepMs`、note 里那句话必须同源；
 *     散着写死的话改一次周期就会有几处开始说假话，而且不报错。
 */
describe("余额历史", () => {
  const saved = { ...process.env };
  const H = 3_600_000;
  const M = 60_000;

  beforeEach(() => {
    for (const k of [
      "DEEPSEEK_API_KEY",
      "Aliyun_AccessKey_ID",
      "Aliyun_AccessKey_Secret",
      "VOLC_ACCESSKEY",
      "RAGFLOW_API_KEY",
      "AMAP_SERVER_KEY",
    ]) {
      delete process.env[k];
    }
    process.env.DEEPSEEK_API_KEY = FAKE_KEY;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  type Accounts = Parameters<typeof recordSnapshot>[1];
  const acc = (over: Record<string, unknown>): Accounts =>
    [{ id: "deepseek", status: "ok", exact: true, currency: "CNY", ...over }] as unknown as Accounts;

  function historyApp(over: Parameters<typeof createFinanceRouter>[0]) {
    const app = express();
    app.use((req, _res, next) => {
      const role = (over as { role?: string }).role ?? "admin";
      (req as express.Request & { console?: unknown }).console = { subject: "t", role };
      next();
    });
    app.use(createFinanceRouter({ stateFile: null, ...over }));
    return app;
  }

  async function hit(app: express.Express, path: string) {
    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: r.status, text: await r.text() };
    } finally {
      server.close();
    }
  }

  it("只给「拿到确切数字」的账户记点——高德与 RAGFlow 一个点都没有", () => {
    const accounts = [
      { id: "deepseek", status: "ok", exact: true, amount: 50.06, currency: "CNY" },
      { id: "amap", status: "ok", exact: false, amount: 999, currency: "CNY" },
      { id: "ragflow", status: "ok", exact: true, currency: "USD" },
      { id: "volcengine", status: "failed", exact: true, amount: 3, currency: "CNY" },
    ] as unknown as Accounts;

    const h = recordSnapshot(emptyHistory(), accounts, Date.parse("2026-09-01T10:20:00Z"));
    assert.deepEqual(Object.keys(h.series), ["deepseek"], "exact=false / 无金额 / 失败的一律不记");
    assert.equal(h.series.deepseek[0].v, 50.06);
  });

  it("同一个采样桶内重复采集覆盖而不是追加——说好了一周期一个点", () => {
    const at = (min: number, sec = 0) =>
      Date.parse(`2026-09-01T10:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}Z`);
    // 默认 10 分钟：10:20:00 ~ 10:29:59 是同一个桶
    let h = recordSnapshot(emptyHistory(), acc({ amount: 50 }), at(20));
    h = recordSnapshot(h, acc({ amount: 49 }), at(25));
    h = recordSnapshot(h, acc({ amount: 48 }), at(29, 59));
    assert.equal(h.series.deepseek.length, 1, "同一个桶只留一个点");
    assert.equal(h.series.deepseek[0].v, 48, "留最新那个");

    h = recordSnapshot(h, acc({ amount: 47 }), at(30));
    assert.equal(h.series.deepseek.length, 2, "跨到下一个桶才是新的点");
    assert.equal(h.series.deepseek[1].h, at(30), "桶起点对齐到 :30，不是采集那一刻");
  });

  it("采样周期是唯一的旋钮：桶宽、stepMs、note 三处同源", () => {
    assert.equal(intervalMs(), 10 * M, "默认 10 分钟");
    assert.equal(bucketStart(Date.parse("2026-09-01T10:27:41Z")), Date.parse("2026-09-01T10:20:00Z"));

    process.env.CARLIFE_FINANCE_HISTORY_INTERVAL_MIN = "30";
    assert.equal(intervalMs(), 30 * M);
    assert.equal(bucketStart(Date.parse("2026-09-01T10:27:41Z")), Date.parse("2026-09-01T10:00:00Z"));
    const api = toApi(emptyHistory(), Date.parse("2026-09-01T10:27:41Z"));
    assert.equal(api.stepMs, 30 * M, "响应里的 stepMs 必须跟着改——前端的缺口阈值靠它");
    assert.match(api.note, /每 30 分钟/, "说明文字也得跟着改，否则页面开始说假话");
  });

  it("周期被夹在 [1 分钟, 1 天]，非法值退回默认而不是退回最激进的那一档", () => {
    const set = (v: string) => {
      process.env.CARLIFE_FINANCE_HISTORY_INTERVAL_MIN = v;
      return intervalMs();
    };
    // 1 分钟是下限：再密就是每账户 10080 个点，300px 宽的曲线画不出来，响应也传不动
    assert.equal(set("1"), 1 * M);
    assert.equal(set("0.4"), 1 * M, "四舍五入到 0 的也抬到下限，不许出现 0 造成除零");
    assert.equal(set("99999"), 24 * 60 * M, "上限一天一个点，再稀就不叫曲线了");

    // 0 / 负数 / 非数字都是"填错了"。**退回默认 10 分钟，不是退回下限**——
    // 一个手滑的 0 让上游调用量翻 10 倍，比曲线粗一点危险得多。
    for (const bad of ["0", "-5", "不是数字", ""]) {
      assert.equal(set(bad), 10 * M, `非法值 ${JSON.stringify(bad)} 应当退回默认`);
    }
  });

  it("超过 7 天的点掉出去——写着「最近 7 天」就不能混进第 8 天", () => {
    const now = Date.parse("2026-09-08T12:00:00Z");
    const h: FinanceHistory = {
      ...emptyHistory(),
      series: {
        deepseek: [
          { h: bucketStart(now - 8 * 24 * H), v: 90, c: "CNY" },
          { h: bucketStart(now - 3 * 24 * H), v: 60, c: "CNY" },
        ],
      },
    };
    const pruned = prune(h, now);
    assert.equal(pruned.series.deepseek.length, 1);
    assert.equal(pruned.series.deepseek[0].v, 60);
  });

  it("整条空掉的账户直接删 key，不留空数组", () => {
    const now = Date.parse("2026-09-08T12:00:00Z");
    const h: FinanceHistory = {
      ...emptyHistory(),
      series: { amap: [{ h: bucketStart(now - 30 * 24 * H), v: 1, c: "CNY" }] },
    };
    assert.deepEqual(Object.keys(prune(h, now).series), []);
  });

  it("接口：admin 拿到七天窗口与点位；ops 被挡", async () => {
    const file = join(tmpdir(), `fin-hist-${process.pid}-${Date.now()}.json`);
    const now = Date.parse("2026-09-08T12:34:00Z");
    saveHistory(file, {
      ...emptyHistory(),
      series: {
        deepseek: [
          { h: bucketStart(now - 20 * H), v: 52.4, c: "CNY" },
          { h: bucketStart(now - 1 * H), v: 50.06, c: "CNY" },
          { h: bucketStart(now - 9 * 24 * H), v: 99, c: "CNY" }, // 窗口外
        ],
      },
    });
    const stub: FetchLike = () => Promise.resolve(jsonRes({}));
    // historyTick=false：定时器一开就会去打注入的假 fetch，这条测的是读盘
    const base = { fetch: stub, historyFile: file, historyTick: false, now: () => now };

    try {
      assert.equal(
        (await hit(historyApp({ ...base, role: "ops" } as never), "/console/finance/history")).status,
        403,
        "余额历史同样是 admin 独有",
      );

      const r = await hit(historyApp(base), "/console/finance/history");
      assert.equal(r.status, 200);
      const body = JSON.parse(r.text) as {
        retentionDays: number;
        stepMs: number;
        from: number;
        to: number;
        series: Record<string, { currency: string; points: Array<{ t: number; v: number }> }>;
      };
      assert.equal(body.retentionDays, 7);
      assert.equal(body.stepMs, 10 * M, "采样周期随响应下发，前端不该自己写死一份");
      assert.ok(body.to - body.from >= 7 * 24 * H, "窗口至少覆盖 7 天");
      assert.equal(body.series.deepseek.points.length, 2, "第 9 天那个点不该出现在七天窗口里");
      assert.equal(body.series.deepseek.currency, "CNY");
      assert.deepEqual(body.series.deepseek.points.map((p) => p.v), [52.4, 50.06], "点必须按时间升序");
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("接口：没有历史时给空 series 而不是 404——「还没攒够」不是「接口坏了」", async () => {
    const stub: FetchLike = () => Promise.resolve(jsonRes({}));
    const r = await hit(
      historyApp({ fetch: stub, historyFile: null, historyTick: false }),
      "/console/finance/history",
    );
    assert.equal(r.status, 200);
    assert.deepEqual((JSON.parse(r.text) as { series: unknown }).series, {});
  });

  it("启动即补当前这个桶的点——不这么做，开发机每次重启都白等一个周期", async () => {
    const file = join(tmpdir(), `fin-tick-${process.pid}-${Date.now()}.json`);
    let calls = 0;
    const stub: FetchLike = () => {
      calls += 1;
      return Promise.resolve(
        jsonRes({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "7.5" }] }),
      );
    };
    const now = Date.parse("2026-09-08T12:00:00Z");
    const app = historyApp({ fetch: stub, historyFile: file, now: () => now });

    try {
      await new Promise((r) => setTimeout(r, 80)); // 等启动那一轮采集落盘
      assert.ok(calls > 0, "启动应当立刻采集一轮");
      const r = await hit(app, "/console/finance/history");
      const series = (JSON.parse(r.text) as { series: Record<string, { points: unknown[] }> }).series;
      assert.equal(series.deepseek.points.length, 1);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("同一个桶内重启不再打上游——桶已占，重启风暴最多花掉一轮额度", async () => {
    const file = join(tmpdir(), `fin-boot-${process.pid}-${Date.now()}.json`);
    let calls = 0;
    const stub: FetchLike = () => {
      calls += 1;
      return Promise.resolve(
        jsonRes({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "7.5" }] }),
      );
    };
    const now = Date.parse("2026-09-08T12:00:00Z");

    try {
      // 第一次"启动"
      historyApp({ fetch: stub, historyFile: file, now: () => now });
      await new Promise((r) => setTimeout(r, 80));
      const afterBoot = calls;
      assert.ok(afterBoot > 0);

      // 同一个 10 分钟桶内再"启动"两次：lastAttemptBucket 已经是这个桶，一次都不该再打
      historyApp({ fetch: stub, historyFile: file, now: () => now + 3 * M });
      historyApp({ fetch: stub, historyFile: file, now: () => now + 9 * M + 59_000 });
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(calls, afterBoot, "同一个采样桶内重启不得重复打上游");

      // 跨到下一个桶：该打了
      historyApp({ fetch: stub, historyFile: file, now: () => now + 10 * M });
      await new Promise((r) => setTimeout(r, 80));
      assert.ok(calls > afterBoot, "跨桶后应当采集新的一轮");
    } finally {
      rmSync(file, { force: true });
    }
  });
});
