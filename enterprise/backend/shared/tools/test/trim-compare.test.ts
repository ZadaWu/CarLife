/**
 * 配置摊开、对齐与差异（施工单 M21-02，F-47-02 / F-47-03 / F-47-04 / F-47-11）。
 *
 * # 这一组盯的是「差异有没有机会被模型复述」
 *
 * "续航 +126km""价格 +25000" 这类数一旦交给模型说，就会错在一个看起来很自然的地方，
 * 而它带着正确的出处。所以这里断言的是**代码算出来的那个数**，
 * 以及"算不了的时候有没有安静地给一个 Infinity 出去"。
 *
 * # 另一半盯的是「有没有偷偷排个名」
 *
 * 返回值的类型里不该存在 score / rank / recommended——
 * 有这个字段，早晚有人把它渲染成星星。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  alignAcrossModels,
  diffRows,
  priceFloorOf,
  setDealerBackend,
  trimCompareTool,
  ToolError,
  getTool,
  listForAgent,
  type DealerBackend,
  type DealerTrim,
  type TrimRow,
} from "../src/index";

const CTX = { sessionId: "s1", agent: "buying" as const, mode: "real" as const };

/** 与 `mocks/dealer/data/models.json` 的种子逐字一致。 */
const SEED: Record<string, DealerTrim[]> = {
  "Model 3": [
    { trim: "后轮驱动版", priceCny: 235_500, rangeKm: 634, seats: 5 },
    { trim: "长续航后轮驱动版", priceCny: 259_500, rangeKm: 753, seats: 5 },
    { trim: "长续航全轮驱动版", priceCny: 285_500, rangeKm: 713, seats: 5 },
  ],
  "Model Y": [
    { trim: "后轮驱动版", priceCny: 263_500, rangeKm: 593, seats: 5 },
    { trim: "长续航后轮驱动版", priceCny: 288_500, rangeKm: 719, seats: 5 },
    { trim: "长续航全轮驱动版", priceCny: 313_500, rangeKm: 719, seats: 5 },
    { trim: "Model Y L", priceCny: 339_000, rangeKm: 751, seats: 6 },
  ],
  Cybertruck: [
    { trim: "全轮驱动版", rangeKm: 515, seats: 5 },
    { trim: "Cyberbeast", rangeKm: 515, seats: 5 },
  ],
};

const fake = (table: Record<string, DealerTrim[]> = SEED): DealerBackend =>
  ({
    async stores() {
      return { stores: [], matched: 0 };
    },
    async slots() {
      return { slots: [] };
    },
    async pricing(a: { model: string }) {
      return { model: a.model, currency: "CNY", trims: table[a.model] ?? [] };
    },
    async book() {
      throw new Error("本测试不下单");
    },
  }) as DealerBackend;

const run = async (args: { models: string[]; trims?: string[]; priceFloorCny?: number }) =>
  (await trimCompareTool.call(args, CTX)).data;

beforeEach(() => setDealerBackend(fake()));
afterEach(() => setDealerBackend(undefined));

describe("同车型配置摊开（F-47-02）", () => {
  it("摊开全部配置，按指导价升序", async () => {
    const r = await run({ models: ["Model Y"] });
    assert.equal(r.rows.length, 4);
    assert.deepEqual(
      r.rows.map((x) => x.trim),
      ["后轮驱动版", "长续航后轮驱动版", "长续航全轮驱动版", "Model Y L"],
    );
    assert.equal(r.alignment, "same-model");
    assert.equal((await run({ models: ["Model 3"] })).rows.length, 3);
  });

  it("同车型是相邻两档成对——「升一级多花多少」", async () => {
    const r = await run({ models: ["Model Y"] });
    assert.equal(r.pairs.length, 3);
    assert.equal(r.pairs[0].left.trim, "后轮驱动版");
    assert.equal(r.pairs[0].right.trim, "长续航后轮驱动版");
  });

  it("只看指定配置时不摊开其余的", async () => {
    const r = await run({ models: ["Model Y"], trims: ["后轮驱动版", "Model Y L"] });
    assert.deepEqual(
      r.rows.map((x) => x.trim),
      ["后轮驱动版", "Model Y L"],
    );
  });

  it("车型在报价系统里没有配置 → 如实进 missingModels", async () => {
    const r = await run({ models: ["迈锐宝"] });
    assert.deepEqual(r.missingModels, ["迈锐宝"]);
    assert.equal(r.rows.length, 0);
  });

  it("未接入报价系统时抛 unconfigured，不返回空表", async () => {
    setDealerBackend(undefined);
    await assert.rejects(
      () => run({ models: ["Model Y"] }),
      (err: unknown) => err instanceof ToolError && /未接入/.test((err as ToolError).message),
    );
  });

  it("一个车型都没给就是入参错误", async () => {
    await assert.rejects(() => run({ models: [] }), ToolError);
  });
});

describe("跨车型对齐（F-47-03）", () => {
  it("有同名配置 → 按配置名对齐，且成对的两边同名", async () => {
    const r = await run({ models: ["Model 3", "Model Y"] });
    assert.equal(r.alignment, "trim-name");
    assert.ok(r.pairs.length >= 3);
    for (const p of r.pairs) assert.equal(p.left.trim, p.right.trim);
    assert.match(r.alignmentNote, /配置名相同/);
  });

  it("没有同名配置 → 退到指导价接近度，并在口径说明里讲清「不是同一档」", () => {
    const left: TrimRow[] = [{ model: "A", trim: "甲", priceCny: 200_000 }];
    const right: TrimRow[] = [
      { model: "B", trim: "乙", priceCny: 500_000 },
      { model: "B", trim: "丙", priceCny: 210_000 },
    ];
    const r = alignAcrossModels(left, right);
    assert.equal(r.alignment, "price-proximity");
    assert.equal(r.pairs[0].right.trim, "丙");
  });

  it("一边没有人民币价 → 对不上，且**不编配对**", async () => {
    const r = await run({ models: ["Model Y", "Cybertruck"] });
    assert.equal(r.alignment, "none");
    assert.deepEqual(r.pairs, []);
    assert.match(r.alignmentNote, /没有硬凑配对/);
  });

  it("价格接近度是 1:1 的，同一行不会被用两次", () => {
    const left: TrimRow[] = [
      { model: "A", trim: "甲", priceCny: 200_000 },
      { model: "A", trim: "乙", priceCny: 201_000 },
    ];
    const right: TrimRow[] = [
      { model: "B", trim: "丙", priceCny: 202_000 },
      { model: "B", trim: "丁", priceCny: 900_000 },
    ];
    const r = alignAcrossModels(left, right);
    const used = r.pairs.map((p) => p.right.trim);
    assert.equal(new Set(used).size, used.length);
  });
});

describe("逐项差异与差价归因（F-47-04）", () => {
  it("差值与手算一致", () => {
    const a: TrimRow = { model: "Model Y", trim: "后轮驱动版", priceCny: 263_500, rangeKm: 593, seats: 5 };
    const b: TrimRow = { model: "Model Y", trim: "长续航后轮驱动版", priceCny: 288_500, rangeKm: 719, seats: 5 };
    const p = diffRows(a, b);
    assert.equal(p.diffs.find((d) => d.field === "priceCny")?.delta, 25_000);
    assert.equal(p.diffs.find((d) => d.field === "rangeKm")?.delta, 126);
    assert.equal(p.diffs.find((d) => d.field === "seats")?.delta, 0);
    // 25000 / 126 = 198.412…
    assert.equal(p.marginalPricePerKm, 198.41);
  });

  it("续航差为 0 时不给边际价格——除零会渲染成「每公里贵 ∞ 元」", () => {
    const a: TrimRow = { model: "Model Y", trim: "长续航后驱", priceCny: 288_500, rangeKm: 719 };
    const b: TrimRow = { model: "Model Y", trim: "长续航全驱", priceCny: 313_500, rangeKm: 719 };
    const p = diffRows(a, b);
    assert.equal(p.marginalPricePerKm, undefined);
    for (const d of p.diffs) {
      if (d.delta !== undefined) assert.ok(Number.isFinite(d.delta));
    }
  });

  it("差值有一个是负的就不给边际价格——它不是「边际价格」", () => {
    // 实测（真调 mock-dealer）：Model Y 后驱比 Model 3 后驱贵 28,000 却少 41km，
    // 公式给出 -682.93 元/km——语法正确，读起来毫无意义。
    const p = diffRows(
      { model: "Model 3", trim: "后轮驱动版", priceCny: 235_500, rangeKm: 634 },
      { model: "Model Y", trim: "后轮驱动版", priceCny: 263_500, rangeKm: 593 },
    );
    assert.equal(p.diffs.find((d) => d.field === "priceCny")?.delta, 28_000);
    assert.equal(p.diffs.find((d) => d.field === "rangeKm")?.delta, -41);
    assert.equal(p.marginalPricePerKm, undefined);
  });

  it("缺项写「资料中未提及」，不给 delta、不推算", () => {
    const a: TrimRow = { model: "Cybertruck", trim: "全轮驱动版", rangeKm: 515 };
    const b: TrimRow = { model: "Cybertruck", trim: "Cyberbeast", rangeKm: 515 };
    const p = diffRows(a, b);
    const price = p.diffs.find((d) => d.field === "priceCny");
    assert.equal(price?.delta, undefined);
    assert.equal(price?.note, "资料中未提及");
    assert.equal(p.marginalPricePerKm, undefined);
  });

  it("返回值里没有 NaN / Infinity", () => {
    const p = diffRows(
      { model: "A", trim: "甲", priceCny: 1, rangeKm: 0 },
      { model: "B", trim: "乙", priceCny: 2, rangeKm: 0 },
    );
    const flat = JSON.stringify(p);
    assert.doesNotMatch(flat, /Infinity|NaN|null/);
  });
});

describe("无人民币报价与价格下界（F-47-05 / F-47-06）", () => {
  it("Cybertruck 如实说无人民币报价，且全文不出现人民币金额", async () => {
    const r = await run({ models: ["Cybertruck"] });
    assert.equal(r.unpricedModels.length, 1);
    assert.match(r.unpricedModels[0].note, /本系统无人民币报价/);
    assert.match(r.unpricedModels[0].note, /不换算汇率/);
    for (const row of r.rows) assert.equal(row.priceCny, undefined);
    // 说明与行里都不许冒出一个换算过的价。
    assert.doesNotMatch(JSON.stringify(r.unpricedModels), /\d{5,}/);
  });

  it("任一配置行的价格不低于该车型最低配整车价", async () => {
    for (const model of ["Model 3", "Model Y"]) {
      const r = await run({ models: [model] });
      const floor = priceFloorOf(r.rows);
      assert.ok(floor !== undefined);
      for (const row of r.rows) {
        if (typeof row.priceCny !== "number") continue;
        assert.ok(row.priceCny >= floor, `${model} ${row.trim} ${row.priceCny} < ${floor}`);
      }
    }
  });

  it("下界由调用方给时，混进来的选装包被挡掉且不是静默丢弃", async () => {
    setDealerBackend(
      fake({
        "Model Y": [
          { trim: "后轮驱动版", priceCny: 263_500, rangeKm: 593, seats: 5 },
          // 选装包混进了报价系统：它比整车便宜。
          { trim: "特斯拉辅助驾驶", priceCny: 64_000, rangeKm: 0, seats: 0 },
        ],
      }),
    );
    const r = await run({ models: ["Model Y"], priceFloorCny: 263_500 });
    assert.deepEqual(
      r.rows.map((x) => x.trim),
      ["后轮驱动版"],
    );
    assert.equal(r.droppedRows.length, 1);
    assert.equal(r.droppedRows[0].trim, "特斯拉辅助驾驶");
    assert.match(r.droppedRows[0].reason, /不是一台车/);
  });

  it("下界必须来自外部——自己从返回里取最小值是循环论证", async () => {
    setDealerBackend(
      fake({
        "Model Y": [
          { trim: "后轮驱动版", priceCny: 263_500, rangeKm: 593, seats: 5 },
          { trim: "特斯拉辅助驾驶", priceCny: 64_000, rangeKm: 0, seats: 0 },
        ],
      }),
    );
    // 不给下界就不过滤。这条断言把"为什么不自己算"钉在这儿：
    // 自己算的话 64000 会成为下界，于是它永远挡不住自己。
    const r = await run({ models: ["Model Y"] });
    assert.equal(r.rows.length, 2);
    assert.deepEqual(r.droppedRows, []);
    assert.equal(priceFloorOf(r.rows), 64_000, "这正是循环论证的样子");
  });

  it("拿不到价格就没有下界——不臆造一个", () => {
    assert.equal(priceFloorOf([]), undefined);
    assert.equal(priceFloorOf([{ priceCny: undefined }]), undefined);
  });
});

describe("不做评分排名（F-47-11）", () => {
  it("返回值里不存在 score / rank / recommended 之类的字段", async () => {
    const r = await run({ models: ["Model 3", "Model Y"] });
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          walk(x);
        }
      }
    };
    walk(r);
    for (const banned of ["score", "rank", "ranking", "recommended", "stars", "rating"]) {
      assert.equal(keys.has(banned), false, `返回值里冒出了 ${banned}——早晚会被渲染成星星`);
    }
  });
});

describe("注册表接线", () => {
  it("trim_compare 是只读工具，挂在购车顾问名下", () => {
    const reg = getTool("trim_compare");
    assert.ok(reg);
    assert.equal(reg.sensitive, false);
    assert.deepEqual([...reg.agents], ["buying", "supervisor"]);
    assert.ok(listForAgent("buying").some((t) => t.name === "trim_compare"));
    // 其它业务 Agent 拿不到它。
    for (const agent of ["ownership", "trip", "cabin", "service"] as const) {
      assert.equal(listForAgent(agent).some((t) => t.name === "trim_compare"), false);
    }
  });

  it("轨迹概括只放车型与配置数，不放用户原话", () => {
    const reg = getTool("trim_compare");
    const summary = (reg?.traceSummary as ((a: unknown) => string) | undefined)?.({
      models: ["Model 3", "Model Y"],
      trims: ["后轮驱动版"],
    });
    assert.equal(summary, "models=Model 3/Model Y trims=1");
  });
});
