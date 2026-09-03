/**
 * `appointment` 的权限门接线（施工单 A2，FL-27 F-27-07/08）。
 *
 * 这里测的不是工具本身（那在 `enterprise/backend/shared/tools/test/new-tools.test.ts`），
 * 而是**它有没有真的挂在 §8.4 的链路上**——此前 `appointment.ts` 是空壳且
 * 未注册，"敏感工具会过权限门"这句话对它根本无从验证。
 *
 * 三条断言各自对应一种会静默出事的形态：
 *  1. 裁决 deny → **动作不执行**（不是执行完再报错）；
 *  2. 权限门未装配 → **拒绝**而不是放行（fail-closed）；
 *  3. 只读工具（charging/car_catalog）→ **根本不调**权限门，零额外往返。
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { PassThrough } from "node:stream";
import type { ServerResponse } from "node:http";

import {
  handleToolsRequest,
  setGuardGate,
  setSessionResolver,
  TOOLS_INVOKE_PATH,
} from "../src/tools-endpoint";
import { GuardGate, CONFIRM_REQUIRED_TOOLS } from "../src/guard/http-endpoint";
import { INTERRUPT_POINTS, listInterruptPoints } from "../src/graph/interrupts";

/** 收集响应的最小 ServerResponse 替身。 */
function fakeRes(): { res: ServerResponse; body: () => unknown; status: () => number } {
  const chunks: string[] = [];
  let status = 0;
  const stream = new PassThrough() as unknown as ServerResponse;
  stream.writeHead = ((code: number) => {
    status = code;
    return stream;
  }) as ServerResponse["writeHead"];
  stream.end = ((chunk?: unknown) => {
    if (typeof chunk === "string") chunks.push(chunk);
    return stream;
  }) as ServerResponse["end"];
  (stream as { setHeader: unknown }).setHeader = () => stream;
  return {
    res: stream,
    body: () => (chunks.length ? JSON.parse(chunks.join("")) : undefined),
    status: () => status,
  };
}

/** 构造一个带 body 的伪请求。 */
function fakeReq(payload: unknown) {
  const req = new PassThrough();
  req.end(JSON.stringify(payload));
  return Object.assign(req, { method: "POST", url: TOOLS_INVOKE_PATH }) as never;
}

const APPOINTMENT_ARGS = {
  kind: "test_drive",
  storeId: "S1",
  storeName: "某某门店",
  at: "2026-09-01T10:00:00+08:00",
  contact: { name: "林先生", phone: "13800138000" },
  subject: "某车型",
};

describe("appointment 挂在权限门上（F-27-07/08）", () => {
  beforeEach(() => {
    // pi 侧 session → CarLife session + agent。appointment 挂 buying / service。
    setSessionResolver(() => ({ carlifeSessionId: "s-1", agent: "buying" }));
  });

  it("裁决 deny 时**动作不执行**——不是执行完再报错", async () => {
    let checked = false;
    setGuardGate({
      check: async (input) => {
        checked = true;
        assert.equal(input.tool, "appointment");
        // 摘要要能让用户看懂在批准什么
        assert.match(input.summary, /预约/);
        return { decision: "deny", reason: "用户拒绝了本次预约" };
      },
    } as never);

    const r = fakeRes();
    await handleToolsRequest(
      fakeReq({ name: "appointment", args: APPOINTMENT_ARGS, agent: "buying" }),
      r.res,
    );
    assert.equal(checked, true, "敏感工具必须过权限门");
    const body = r.body() as { ok: boolean; decision?: string };
    assert.equal(body.ok, false);
    assert.equal(body.decision, "deny");
    // 没有 orderId 即证明没下单
    assert.equal(JSON.stringify(body).includes("orderId"), false, "拒绝时不得产生订单");
  });

  it("allow 时才真正下单，且返回的是外发**字段名**不是手机号", async () => {
    setGuardGate({ check: async () => ({ decision: "allow" }) } as never);
    const r = fakeRes();
    await handleToolsRequest(
      fakeReq({ name: "appointment", args: APPOINTMENT_ARGS, agent: "buying" }),
      r.res,
    );
    const body = r.body() as { ok: boolean; result?: { data?: { orderId: string; disclosed: string[] } } };
    assert.equal(body.ok, true);
    assert.ok(body.result?.data?.orderId, "allow 后应产生订单号");
    assert.deepEqual(body.result?.data?.disclosed, ["称呼", "手机号"]);
    assert.equal(
      JSON.stringify(body).includes("13800138000"),
      false,
      "响应里不该回显完整手机号",
    );
  });

  it("**权限门未装配时拒绝**，不是放行（fail-closed）", async () => {
    setGuardGate(undefined as never);
    const r = fakeRes();
    await handleToolsRequest(
      fakeReq({ name: "appointment", args: APPOINTMENT_ARGS, agent: "buying" }),
      r.res,
    );
    const body = r.body() as { ok: boolean; error?: string };
    assert.equal(body.ok, false);
    assert.match(String(body.error), /权限门未装配/);
  });

  it("只读工具不调权限门——零额外往返（§8.4 第三行）", async () => {
    let checked = false;
    setGuardGate({
      check: async () => {
        checked = true;
        return { decision: "allow" };
      },
    } as never);
    setSessionResolver(() => ({ carlifeSessionId: "s-1", agent: "trip" }));

    const r = fakeRes();
    await handleToolsRequest(
      fakeReq({
        name: "charging",
        agent: "trip",
        mode: "mock",
        args: { route: [{ lat: 22.5, lon: 114 }, { lat: 25, lon: 114 }], rangeKm: 400, startSoc: 0.9 },
      }),
      r.res,
    );
    assert.equal(checked, false, "charging 是只读工具，不该产生权限门往返");
  });

  it("Agent 不匹配时直接 403——pi 侧发来不属于它的工具名要拒", async () => {
    setGuardGate({ check: async () => ({ decision: "allow" }) } as never);
    // 用车助手没有 appointment（它挂 buying / service）
    setSessionResolver(() => ({ carlifeSessionId: "s-1", agent: "ownership" }));

    const r = fakeRes();
    await handleToolsRequest(
      fakeReq({ name: "appointment", args: APPOINTMENT_ARGS, agent: "ownership" }),
      r.res,
    );
    assert.equal(r.status(), 403);
  });
});

/**
 * 外发个人信息的端到端可见（施工单 M15-04，F-15-11 / AC-15-7）。
 *
 * 断的是三处，任何一处漏掉这块都是空的：
 *  ① 工具 → 权限门：`disclosures` 字段一直存在，但**从没被传过**；
 *  ② 权限门 → 端：协议里根本没有 disclosure 字段（M15-04 才加）；
 *  ③ 端上渲染：混在动作明细里等于没显示。
 * 这一组盯 ①，以及顺带收口的"摘要里不能有明文手机号"。
 */
describe("外发个人信息：从工具传到权限门（M15-04）", () => {
  beforeEach(() => {
    setSessionResolver(() => ({ carlifeSessionId: "s-1", agent: "buying" }));
  });

  const captureCheck = () => {
    const seen: Record<string, unknown>[] = [];
    setGuardGate({
      check: async (input: Record<string, unknown>) => {
        seen.push(input);
        return { decision: "allow" };
      },
    } as never);
    return seen;
  };

  it("**外发项传到了权限门**，且手机号是掩码值", async () => {
    const seen = captureCheck();
    await handleToolsRequest(
      fakeReq({ name: "appointment", args: APPOINTMENT_ARGS, agent: "buying" }),
      fakeRes().res,
    );
    const d = seen[0]?.disclosures as string[] | undefined;
    assert.ok(d, "disclosures 必须被传——不传的话弹窗上那一块永远是空的");
    assert.deepEqual(d, ["称呼：林先生", "手机号：138****8000"]);
    // 掩码在生成侧做完，端上只渲染。这里出现明文就说明有人另拼了一份。
    assert.equal(d!.join().includes("13800138000"), false);
  });

  it("**动作摘要里不能有明文手机号**——弹窗可能出现在车机大屏上", async () => {
    const seen = captureCheck();
    await handleToolsRequest(
      fakeReq({ name: "appointment", args: APPOINTMENT_ARGS, agent: "buying" }),
      fakeRes().res,
    );
    const summary = String(seen[0]?.summary ?? "");
    assert.equal(summary.includes("13800138000"), false, `摘要泄露了手机号：${summary}`);
    // 但摘要仍要说清楚在批什么（F-04-02）。
    assert.match(summary, /预约试驾/);
    assert.match(summary, /某某门店/);
  });

  it("`calendar` 不带 disclosures——它外发的不是个人信息给第三方", async () => {
    const seen = captureCheck();
    setSessionResolver(() => ({ carlifeSessionId: "s-1", agent: "ownership" }));
    await handleToolsRequest(
      fakeReq({
        name: "calendar",
        args: { op: "write", title: "出发", start: "2026-09-01T08:00:00+08:00" },
        agent: "ownership",
      }),
      fakeRes().res,
    );
    assert.equal(seen[0]?.disclosures, undefined, "查不到就不传，而不是塞一份空的进去");
  });
});

describe("中断点集中声明（F-04-10 / F-27-04）", () => {
  it("清单恰好一条 `guard.confirm`——新增中断点必须回来登记", () => {
    const points = listInterruptPoints();
    assert.equal(points.length, 1, `实际 ${points.map((p) => p.id).join(",")}`);
    assert.equal(points[0].id, "guard.confirm");
    assert.ok(points[0].features.includes("F-27-04"));
  });

  it("触发处引用的是清单里的 id——两处写死必然漂移", async () => {
    setSessionResolver(() => ({ carlifeSessionId: "s-1", agent: "buying" }));
    const gate = new GuardGate({ confirmTimeoutMs: 50 });
    const p = gate.check({ sessionId: "s-1", tool: "appointment", summary: "预约试驾" });
    const pending = gate.listPending();
    assert.equal(pending.length, 1);
    assert.ok(
      pending[0].interruptId.includes(INTERRUPT_POINTS.guardConfirm.id),
      `中断 id 里没有中断点标记：${pending[0].interruptId}`,
    );
    gate.resume(pending[0].interruptId, false);
    await p;
  });
});

/**
 * 试驾下单的权限门接线（施工单 M19-02）。
 *
 * 与 `appointment` 同一条链路，但它是**新工具**——
 * `CONFIRM_REQUIRED_TOOLS` 与 `DISCLOSURE_BUILDERS` 漏加任何一处，
 * 后果分别是「无确认下单」与「弹窗上外发块是空的」，而链路都看起来完全正常。
 */
describe("test_drive_book 挂在权限门上（M19-02）", () => {
  beforeEach(() => {
    setSessionResolver(() => ({ carlifeSessionId: "s-1", agent: "buying" }));
  });

  const BOOK_ARGS = {
    storeId: "sz-nanshan-exp",
    slotId: "sz-nanshan-exp_2026-08-14_10_u05bqh",
    model: "Model Y",
    contact: { name: "林先生", phone: "13800138000" },
  };

  const captureCheck = () => {
    const seen: Record<string, unknown>[] = [];
    setGuardGate({
      check: async (input: Record<string, unknown>) => {
        seen.push(input);
        return { decision: "allow" };
      },
    } as never);
    return seen;
  };

  it("**它在 CONFIRM_REQUIRED_TOOLS 里**——漏加就是自动放行、无确认下单", () => {
    assert.ok(CONFIRM_REQUIRED_TOOLS.has("test_drive_book"));
  });

  it("过权限门，且外发项是掩码值", async () => {
    const seen = captureCheck();
    await handleToolsRequest(
      fakeReq({ name: "test_drive_book", args: BOOK_ARGS, agent: "buying" }),
      fakeRes().res,
    );
    assert.equal(seen.length, 1, "敏感工具必须过权限门");
    assert.deepEqual(seen[0]?.disclosures, ["称呼：林先生", "手机号：138****8000"]);
    assert.equal(JSON.stringify(seen[0]?.disclosures).includes("13800138000"), false);
  });

  it("**动作摘要里不能有明文手机号**——弹窗会上车机大屏", async () => {
    const seen = captureCheck();
    await handleToolsRequest(
      fakeReq({ name: "test_drive_book", args: BOOK_ARGS, agent: "buying" }),
      fakeRes().res,
    );
    const summary = String(seen[0]?.summary ?? "");
    assert.equal(summary.includes("13800138000"), false, `摘要泄露了手机号：${summary}`);
    assert.match(summary, /预约试驾/);
  });

  it("deny 时**动作不执行**", async () => {
    setGuardGate({ check: async () => ({ decision: "deny", reason: "用户拒绝" }) } as never);
    const r = fakeRes();
    await handleToolsRequest(fakeReq({ name: "test_drive_book", args: BOOK_ARGS, agent: "buying" }), r.res);
    const body = r.body() as { ok: boolean };
    assert.equal(body.ok, false);
    assert.equal(JSON.stringify(body).includes("orderId"), false, "拒绝时不得产生订单");
  });

  it("**三个只读工具根本不调权限门**——零额外往返（§8.4 第三行）", async () => {
    let checked = false;
    setGuardGate({
      check: async () => {
        checked = true;
        return { decision: "allow" };
      },
    } as never);
    for (const name of ["dealer_stores", "dealer_slots", "dealer_pricing"]) {
      await handleToolsRequest(fakeReq({ name, args: { model: "Model Y", storeId: "s" }, agent: "buying" }), fakeRes().res);
    }
    assert.equal(checked, false);
  });
});
