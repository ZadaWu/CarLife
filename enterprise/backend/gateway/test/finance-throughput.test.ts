/**
 * 财务页的调用吞吐接口（`GET /console/finance/throughput/:accountId`）。
 *
 * 盯三条：
 *  1. **窗口与桶宽逐字沿用余额历史的**——两张图叠在同一张卡上，横轴必须是同一条；
 *  2. **估算与实测分开数**——经 pi-acp 的行按字符估 token，混进去不标就是把估的当成量的；
 *  3. **查库失败不回空数组**——空数组会被画成"7 天一次调用都没有"。
 * 全部脱库：仓储由外部注入，只收窄到 `throughput()` 一个方法。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import type { UsageThroughputQuery, UsageThroughputRow } from "@carlife/db";

import { createFinanceRouter } from "../src/console/finance";
import { bucketStart, intervalMs, RETENTION_MS } from "../src/console/finance-history";
import {
  THROUGHPUT_ACCOUNTS,
  foldThroughput,
  throughputSupported,
  toThroughputApi,
  totalsOf,
} from "../src/console/finance-throughput";

const NOW = Date.parse("2026-09-03T10:23:45Z");
const STEP = intervalMs();
const T0 = bucketStart(NOW, STEP) - 6 * STEP;

function row(over: Partial<UsageThroughputRow>): UsageThroughputRow {
  return {
    t: T0,
    provider: "deepseek",
    calls: 1,
    failed: 0,
    promptTokens: 100,
    completionTokens: 20,
    cacheHitTokens: 0,
    okDurationMs: 1000,
    okCompletionTokens: 20,
    ...over,
  };
}

describe("折桶", () => {
  const spec = THROUGHPUT_ACCOUNTS.deepseek;

  it("同一桶里直连与 pi-acp 两行折成一行，估算那部分单独数出来", () => {
    const buckets = foldThroughput(
      [
        row({ provider: "pi-acp", calls: 3, promptTokens: 300, failed: 1 }),
        row({ provider: "deepseek", calls: 2, promptTokens: 200 }),
      ],
      spec,
    );
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].calls, 5);
    assert.equal(buckets[0].estimatedCalls, 3, "只有 pi-acp 那 3 次是估算");
    assert.equal(buckets[0].failed, 1);
    assert.equal(buckets[0].promptTokens, 500);
  });

  it("输出按 t 升序——页面按第一个桶定横轴窗口", () => {
    const buckets = foldThroughput([row({ t: T0 + STEP }), row({ t: T0 })], spec);
    assert.deepEqual(
      buckets.map((b) => b.t),
      [T0, T0 + STEP],
    );
  });

  it("合计把失败与估算分别累加", () => {
    const buckets = foldThroughput(
      [row({ t: T0, provider: "pi-acp", calls: 2, failed: 2 }), row({ t: T0 + STEP, calls: 1 })],
      spec,
    );
    assert.deepEqual(totalsOf(buckets), { calls: 3, failed: 2, estimatedCalls: 2, promptTokens: 200, completionTokens: 40 });
  });

  it("响应里的 note 把桶宽与「我们自己记的账」说出来", () => {
    const api = toThroughputApi("deepseek", spec, [], { stepMs: STEP, from: 0, to: NOW });
    assert.match(api.note, new RegExp(`每 ${STEP / 60_000} 分钟一个桶`));
    assert.match(api.note, /llm_usage/);
    assert.equal(api.cached, false);
  });

  it("只有 DeepSeek 有吞吐口径——高德按次、RAGFlow 订阅制，不硬凑", () => {
    assert.equal(throughputSupported("deepseek"), true);
    for (const id of ["amap", "ragflow", "aliyun", "volcengine", "toString"]) {
      assert.equal(throughputSupported(id), false, id);
    }
  });
});

describe("接口", () => {
  type Usage = { throughput(q: UsageThroughputQuery): Promise<UsageThroughputRow[]> };

  function appWith(over: Parameters<typeof createFinanceRouter>[0], role = "admin") {
    const app = express();
    app.use((req, _res, next) => {
      (req as express.Request & { console?: unknown }).console = { subject: "t", role };
      next();
    });
    app.use(createFinanceRouter({ stateFile: null, historyTick: false, now: () => NOW, ...over }));
    return app;
  }

  async function hit(app: express.Express, path: string) {
    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    } finally {
      server.close();
    }
  }

  it("窗口与桶宽逐字沿用余额历史的，命中判据是 provider ∪ model 前缀", async () => {
    const seen: UsageThroughputQuery[] = [];
    const usage: Usage = {
      async throughput(q) {
        seen.push(q);
        return [row({ provider: "pi-acp", calls: 2 }), row({ provider: "deepseek" })];
      },
    };
    const r = await hit(appWith({ usage }), "/console/finance/throughput/deepseek");
    assert.equal(r.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].stepMs, STEP);
    assert.equal(seen[0].since.getTime(), bucketStart(NOW, STEP) - RETENTION_MS, "左端与余额历史的 from 相同");
    assert.equal(seen[0].until.getTime(), NOW);
    assert.deepEqual(seen[0].providers, ["deepseek"]);
    assert.equal(seen[0].modelPrefix, "deepseek");

    assert.equal(r.body.stepMs, STEP);
    assert.equal(r.body.from, bucketStart(NOW, STEP) - RETENTION_MS);
    assert.equal(r.body.to, NOW);
    const buckets = r.body.buckets as Array<Record<string, number>>;
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].calls, 3);
    assert.equal(buckets[0].estimatedCalls, 2);
  });

  it("60s 内吃缓存并如实标 cached；refresh=1 绕过", async () => {
    let n = 0;
    const usage: Usage = {
      async throughput() {
        n += 1;
        return [];
      },
    };
    const app = appWith({ usage });
    const a = await hit(app, "/console/finance/throughput/deepseek");
    const b = await hit(app, "/console/finance/throughput/deepseek");
    const c = await hit(app, "/console/finance/throughput/deepseek?refresh=1");
    assert.equal(n, 2);
    assert.equal(a.body.cached, false);
    assert.equal(b.body.cached, true);
    assert.equal(c.body.cached, false);
  });

  it("查库失败回 502 而不是空数组——空数组会被画成「7 天一次调用都没有」", async () => {
    const usage: Usage = {
      async throughput() {
        throw new Error("connection refused");
      },
    };
    const r = await hit(appWith({ usage }), "/console/finance/throughput/deepseek");
    assert.equal(r.status, 502);
    assert.equal(r.body.error, "throughput_failed");
  });

  it("没注入仓储 → 503；没有吞吐口径的账户 → 404；ops → 403", async () => {
    assert.equal((await hit(appWith({}), "/console/finance/throughput/deepseek")).status, 503);
    const usage: Usage = { throughput: async () => [] };
    assert.equal((await hit(appWith({ usage }), "/console/finance/throughput/amap")).status, 404);
    assert.equal((await hit(appWith({ usage }, "ops"), "/console/finance/throughput/deepseek")).status, 403);
  });
});
