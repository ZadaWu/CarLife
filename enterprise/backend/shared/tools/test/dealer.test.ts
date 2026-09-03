/**
 * 经销商四件套（施工单 M19-02）。
 *
 * 这份测试盯的是**编不出来**与**未接入要说未接入**两件事：
 *
 *  1. `test_drive_book` 的入参里没有 `storeName`、没有自由时间——
 *     在此之前 `appointment` 收三个自由字符串，"深圳南山特斯拉中心"就是那么来的。
 *  2. 没配后端时抛 `unconfigured` 而**不是返回空**——空结果会被上层当成
 *     "这个城市没有店"，那是错误信息（`ragflow_retrieve` 的先例）。
 *     这条同时是 Demo 判定第 7 条：当场 kill 掉门店系统，助手要说"没连通"。
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  dealerStoresTool,
  dealerSlotsTool,
  dealerPricingTool,
  testDriveBookTool,
  setDealerBackend,
  listForAgent,
  getTool,
  ToolError,
  createDealerAppointmentBackend,
  type DealerBackend,
} from "../src/index";

const CTX = { sessionId: "s1", agent: "buying" as const, mode: "real" as const };
const CONTACT = { name: "林先生", phone: "13800138000" };

const fake = (over: Partial<DealerBackend> = {}): DealerBackend => ({
  async stores() {
    return {
      stores: [
        {
          storeId: "sz-nanshan-exp",
          name: "深圳南山体验店",
          type: "experience",
          city: "深圳",
          district: "南山区",
          address: "科苑南路 2888 号",
        },
      ],
      matched: 1,
    };
  },
  async slots() {
    return {
      slots: [{ slotId: "sz-nanshan-exp_2026-08-14_10_u05bqh", startAt: "x", endAt: "y", remaining: 1 }],
    };
  },
  async pricing() {
    return { model: "Model 3", currency: "CNY", trims: [{ trim: "后轮驱动版", priceCny: 235_500, rangeKm: 634, seats: 5 }] };
  },
  async book() {
    return {
      orderId: "TD-000001",
      storeId: "sz-nanshan-exp",
      storeName: "深圳南山体验店",
      model: "Model Y",
      startAt: "x",
      status: "confirmed",
      disclosed: ["称呼", "手机号"],
    };
  },
  ...over,
});

afterEach(() => setDealerBackend(undefined));

describe("未接入要说「未接入」，不是返回空", () => {
  beforeEach(() => setDealerBackend(undefined));

  it("四个工具一律抛 unconfigured", async () => {
    for (const [tool, args] of [
      [dealerStoresTool, { model: "Model Y" }],
      [dealerSlotsTool, { storeId: "s", model: "Model Y" }],
      [dealerPricingTool, { model: "Model 3" }],
      [testDriveBookTool, { storeId: "s", slotId: "x", model: "Model Y", contact: CONTACT }],
    ] as const) {
      await assert.rejects(
        () => (tool as { call: (a: unknown, c: unknown) => Promise<unknown> }).call(args, CTX),
        (e: Error & { category?: string }) => {
          assert.equal(e.category, "unconfigured", `${tool.name} 应报未接入`);
          return true;
        },
      );
    }
  });

  it("**服务被 kill 掉时同样拦住编门店名**（真跑发现：这条走的是 upstream 不是 unconfigured）", async () => {
    setDealerBackend(
      fake({
        async stores() {
          throw new ToolError("dealer_stores", "upstream", "门店系统连不上（fetch failed）——不要报出任何门店名或时间", true);
        },
      }),
    );
    await assert.rejects(
      () => dealerStoresTool.call({ model: "Model Y" }, CTX),
      (e: Error) => {
        assert.match(e.message, /不要报出任何门店名/);
        return true;
      },
    );
  });

  it("**报错话术要拦住模型编门店名**", async () => {
    await assert.rejects(
      () => dealerStoresTool.call({ model: "Model Y" }, CTX),
      (e: Error) => {
        assert.match(e.message, /不要报出任何门店名/);
        return true;
      },
    );
  });
});

/**
 * `test_drive_book` 的字段表。
 *
 * 它带 `.refine()`（contact 与 memberId 二选一，M19-06），于是顶层是 ZodEffects，
 * `.shape` 得从 `_def.schema` 里取。**不要图省事改成 `safeParse` 探测**——
 * 那测的是"塞进去会不会被丢掉"，与"我们有没有声明它"是两件事，两条都要有。
 */
function bookShape(): Record<string, unknown> {
  const s = getTool("test_drive_book")!.schema as unknown as {
    shape?: Record<string, unknown>;
    _def?: { schema?: { shape: Record<string, unknown> } };
  };
  return s.shape ?? s._def!.schema!.shape;
}

describe("test_drive_book：入参只认 id", () => {
  beforeEach(() => setDealerBackend(fake()));

  it("缺 slotId → 拒收，且话术说清「必须来自查询」", async () => {
    await assert.rejects(
      () => testDriveBookTool.call({ storeId: "s", slotId: "", model: "Model Y", contact: CONTACT }, CTX),
      (e: Error) => {
        assert.match(e.message, /不能自己填/);
        return true;
      },
    );
  });

  it("**schema 里没有 storeName、没有自由时间**——这是防编的地基", () => {
    // `.refine()` 把 schema 包成 ZodEffects，`.shape` 在外层取不到。
    // 拆一层而不是绕过断言——这条守的是"防编的地基"，不能因为形状变了就不测了。
    const shape = bookShape();
    assert.equal("storeName" in shape, false, "有 storeName 模型就能编门店名");
    assert.equal("at" in shape, false, "有自由时间模型就能拍一个时段");
    assert.ok("storeId" in shape && "slotId" in shape);
  });

  it("**模型硬塞 storeName / at 会被 strip 掉**——光看 schema 形状证明不了这件事", () => {
    // zod 默认 strip 模式：多余键静默丢弃。断言它**真的没进去**，
    // 而不只是"我们没声明它"——两者差着一个运行时行为。
    const parsed = getTool("test_drive_book")!.schema.safeParse({
      storeId: "sz-nanshan-exp",
      slotId: "sz-nanshan-exp_2026-08-14_10_u05bqh",
      model: "Model Y",
      storeName: "深圳南山特斯拉中心",
      at: "2026-08-15T10:00:00+08:00",
      contact: CONTACT,
    });
    assert.equal(parsed.success, true);
    const keys = Object.keys(parsed.success ? parsed.data : {});
    assert.equal(keys.includes("storeName"), false, "编的门店名必须被丢掉，不能一路传到后端");
    assert.equal(keys.includes("at"), false, "拍的时间必须被丢掉");
    assert.deepEqual(keys.sort(), ["contact", "model", "slotId", "storeId"]);
  });

  it("手机号格式不对硬失败——号码错了门店打不通，用户以为约上了", async () => {
    await assert.rejects(() =>
      testDriveBookTool.call(
        { storeId: "s", slotId: "x", model: "Model Y", contact: { name: "林先生", phone: "1234" } },
        CTX,
      ),
    );
  });

  it("正常下单拿到 orderId", async () => {
    const r = (await testDriveBookTool.call(
      { storeId: "sz-nanshan-exp", slotId: "x", model: "Model Y", contact: CONTACT },
      CTX,
    )) as { data: { orderId: string } };
    assert.equal(r.data.orderId, "TD-000001");
  });

  it("**有副作用，绝不重试**——重试一次预约就是下两次单", async () => {
    let calls = 0;
    setDealerBackend(
      fake({
        async book() {
          calls += 1;
          throw new Error("upstream boom");
        },
      }),
    );
    await assert.rejects(() =>
      testDriveBookTool.call({ storeId: "s", slotId: "x", model: "Model Y", contact: CONTACT }, CTX),
    );
    assert.equal(calls, 1);
  });
});

describe("注册表与 ACL", () => {
  it("购车顾问拿得到四件套", () => {
    const names = listForAgent("buying").map((t) => t.name);
    for (const n of ["dealer_stores", "dealer_slots", "dealer_pricing", "test_drive_book"]) {
      assert.ok(names.includes(n), `buying 缺 ${n}`);
    }
  });

  it("**只有 test_drive_book 是 sensitive**——其余三个只读，零额外往返", () => {
    assert.equal(getTool("test_drive_book")!.sensitive, true);
    for (const n of ["dealer_stores", "dealer_slots", "dealer_pricing"]) {
      assert.equal(getTool(n)!.sensitive, false, `${n} 不该过权限门`);
    }
  });

  it("下单不对外暴露（有副作用 + 外发个人信息，F-34-09）", () => {
    assert.equal(getTool("test_drive_book")!.mcpExposable, false);
    assert.equal(getTool("dealer_pricing")!.mcpExposable, true);
  });

  it("**轨迹摘要不记 contact**——审计里不该再存一份手机号", () => {
    const summary = getTool("test_drive_book")!.traceSummary?.({
      storeId: "sz-nanshan-exp",
      slotId: "x",
      contact: CONTACT,
    } as never);
    assert.ok(summary);
    assert.equal(summary!.includes("13800138000"), false);
    assert.equal(summary!.includes("林先生"), false);
  });
});

describe("后端错误要让模型看懂该回去重查", () => {
  it("slot_not_found → 话术点名 dealer_slots，且不可重试", async () => {
    let calls = 0;
    setDealerBackend(
      fake({
        async book() {
          calls += 1;
          throw new ToolError("test_drive_book", "invalid", "slot_not_found", false);
        },
      }),
    );
    await assert.rejects(() =>
      testDriveBookTool.call({ storeId: "s", slotId: "编的", model: "Model Y", contact: CONTACT }, CTX),
    );
    assert.equal(calls, 1, "编造的 slotId 重试一次还是编造的");
  });
});

/**
 * 维修预约换 dealer 后端（施工单 M19-05）。
 *
 * `appointment` 的 schema **一个字不改**——维修没有 slotId 概念。
 * 换的只是"这个 storeId 真不真"这一层，顺带堵上维修那边编门店的口子。
 */
describe("appointment 走门店系统（M19-05）", () => {
  const SERVICE_STORES = [{ storeId: "sz-baoan-svc", name: "深圳宝安服务中心" }];
  const mk = (over: Partial<Parameters<typeof createDealerAppointmentBackend>[0]> = {}) =>
    createDealerAppointmentBackend({
      async stores(a) {
        assert.equal(a.type, "service", "维修必须查服务中心，不是体验店");
        return { stores: SERVICE_STORES };
      },
      async book() {
        return { orderId: "SV-000001", status: "confirmed" };
      },
      ...over,
    });

  const ARGS = {
    kind: "service" as const,
    storeId: "sz-baoan-svc",
    storeName: "深圳宝安服务中心",
    at: "2026-09-01T10:00:00+08:00",
    contact: CONTACT,
    subject: "Model Y",
  };

  it("真实服务网点下单成功", async () => {
    const r = await mk().submit(ARGS);
    assert.equal(r.orderId, "SV-000001");
    assert.equal(r.status, "pending_store", "维修要门店回执，不当场 confirmed");
  });

  it("**编的 storeId → 抛错不静默**，并点名该用哪个工具去查", async () => {
    await assert.rejects(
      () => mk().submit({ ...ARGS, storeId: "我编的门店" }),
      (e: Error) => {
        assert.match(e.message, /dealer_stores/);
        assert.match(e.message, /不要自己填门店/);
        return true;
      },
    );
  });

  it("**拿体验店去做维修 → 同样被拒**（它不会报错，只会让车主白跑）", async () => {
    await assert.rejects(() => mk().submit({ ...ARGS, storeId: "sz-nanshan-exp" }));
  });

  it("维修用「门店+时间」拼幂等键——没有 slotId 这个概念", async () => {
    let seen = "";
    await mk({
      async book(a) {
        seen = a.slotId;
        return { orderId: "SV-1", status: "confirmed" };
      },
    }).submit(ARGS);
    assert.equal(seen, "sz-baoan-svc#2026-09-01T10:00:00+08:00");
  });
});
