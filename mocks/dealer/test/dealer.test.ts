/**
 * mock-dealer 的端点行为（施工单 M19-01）。
 *
 * 这份测试盯的不是"能不能返回数据"，而是**编不编得出来**：
 * 整个 Sprint 的防编设计建立在"`slotId` 编一个会被拒"这一行上。
 * 它松了，上游 schema 收得再紧也没用。
 *
 * 另一条主线是**可复现**：同一天同一店同一车型两次调用必须逐字相同。
 * 不然用户第一轮看到的时段，选完之后第二轮已经变了，而现象是
 * "你选的那个时段不存在"——排查方向完全不指向随机数。
 */

import assert from "node:assert/strict";
import { after, before, describe, it, beforeEach } from "node:test";
import type { Server } from "node:http";

import { createDealerServer, __resetBookings } from "../src/index";
import { generateSlots } from "../src/slots";

let server: Server;
let base = "";

before(async () => {
  server = createDealerServer();
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(() => server.close());
beforeEach(() => __resetBookings());

const get = async (path: string) => {
  const r = await fetch(`${base}${path}`);
  return { status: r.status, body: (await r.json()) as Record<string, never> };
};

const post = async (path: string, body: unknown) => {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, never> };
};

const CONTACT = { name: "林先生", phone: "13800138000" };

describe("GET /stores：按车型 + 城市/区找店", () => {
  it("按城市命中；返回的每家店都真的提供这款车", async () => {
    const r = await get("/stores?model=Model%20Y&city=深圳");
    assert.equal(r.status, 200);
    const stores = r.body.stores as unknown as Array<{ city: string; models: string[]; type: string }>;
    assert.ok(stores.length > 0);
    for (const s of stores) {
      assert.equal(s.city, "深圳");
      assert.ok(s.models.includes("Model Y"));
      assert.equal(s.type, "experience", "默认只返回体验店，服务中心不能混进试驾候选");
    }
  });

  it("**到区粒度**：南山只出南山那家", async () => {
    const r = await get("/stores?model=Model%20Y&city=深圳&district=南山");
    const stores = r.body.stores as unknown as Array<{ district: string }>;
    assert.equal(stores.length, 1);
    assert.equal(stores[0].district, "南山区");
  });

  /**
   * ⚠️ 这条原本锁的是「深圳盐田 → 零命中」。**M19-07 起那不再成立**——
   * 种子里没有的区会现合成一家（见本文件末尾那一组）。
   *
   * 零命中的语义本身没变，只是触发条件收窄到"地名根本不像地名"。
   * 改断言而不是删测试：`200 + 空数组`（而不是 404）这条形状仍然要守，
   * 上游靠它区分"没有店"与"接口坏了"。
   */
  it("**零命中是 200 + 空数组**——不是 404，上游靠这个区分「没有」和「坏了」", async () => {
    const r = await get("/stores?model=Model%20Y&city=的试驾");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.stores, []);
    assert.equal(r.body.matched as unknown as number, 0);
  });

  it("车型库里没有的车型 → 空数组，不是把所有店都返回", async () => {
    const r = await get("/stores?model=汉EV&city=深圳");
    assert.deepEqual(r.body.stores, []);
  });

  it("near 按距离升序，且带 distanceKm", async () => {
    // 取南山坐标：南山那家必须排第一。
    const r = await get("/stores?model=Model%20Y&city=深圳&near=22.5288,113.9442");
    const stores = r.body.stores as unknown as Array<{ district: string; distanceKm: number }>;
    assert.ok(stores.length >= 2);
    assert.equal(stores[0].district, "南山区");
    for (let i = 1; i < stores.length; i += 1) {
      assert.ok(stores[i].distanceKm >= stores[i - 1].distanceKm, "必须按距离升序");
    }
  });

  it("type=service 返回服务中心（M19-05 的维修预约要用）", async () => {
    const r = await get("/stores?model=Model%20Y&city=深圳&type=service");
    const stores = r.body.stores as unknown as Array<{ type: string }>;
    assert.ok(stores.length > 0);
    for (const s of stores) assert.equal(s.type, "service");
  });

  it("缺 model → 400，不给一个「所有店」的兜底", async () => {
    assert.equal((await get("/stores?city=深圳")).status, 400);
  });
});

describe("GET /stores/:id/slots：可预约时段", () => {
  it("**可复现**：两次调用逐字相同", async () => {
    const a = await get("/stores/sz-nanshan-exp/slots?model=Model%20Y");
    const b = await get("/stores/sz-nanshan-exp/slots?model=Model%20Y");
    assert.deepEqual(a.body.slots, b.body.slots);
    assert.ok((a.body.slots as unknown as unknown[]).length > 0);
  });

  it("**按日期滚动**：不同日期生成不同时段", () => {
    const d1 = generateSlots({ storeId: "sz-nanshan-exp", model: "Model Y", now: new Date("2026-08-13T00:00:00Z") });
    const d2 = generateSlots({ storeId: "sz-nanshan-exp", model: "Model Y", now: new Date("2026-09-13T00:00:00Z") });
    assert.notDeepEqual(
      d1.map((s) => s.slotId),
      d2.map((s) => s.slotId),
      "写死日期的话明天演示就全过期了",
    );
  });

  it("默认从**明天**起——今天当场约试驾会让人白跑一趟", () => {
    const now = new Date("2026-08-13T00:00:00Z");
    const slots = generateSlots({ storeId: "sz-nanshan-exp", model: "Model Y", now });
    assert.ok(slots.every((s) => s.startAt >= "2026-08-14"), slots[0]?.startAt);
  });

  it("店不存在 404", async () => {
    assert.equal((await get("/stores/nope/slots?model=Model%20Y")).status, 404);
  });

  it("这家店不提供这款车 → 空数组 **+ reason**（不是「没查到时段」）", async () => {
    // 上海闵行只有 Model Y。
    const r = await get("/stores/sh-minhang-exp/slots?model=Model%203");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.slots, []);
    assert.match(String(r.body.reason), /不提供/);
  });
});

describe("POST /bookings：编一个 slotId 就死在这里", () => {
  const anySlot = async () => {
    const r = await get("/stores/sz-nanshan-exp/slots?model=Model%20Y");
    return (r.body.slots as unknown as Array<{ slotId: string; remaining: number }>)[0];
  };

  it("**猜不出来**：门店和日期都对，但后缀是编的 → 404", async () => {
    // 这条是真跑出来的教训：起初 slotId 是「门店_日期_小时」拼的，
    // 模型不调 dealer_slots 也能猜中一个真实时段把单下了。后缀就是为此加的。
    const slot = await anySlot();
    const guessed = `${slot.slotId.replace(/_[a-z0-9]+$/, "")}_zzzzzz`;
    const r = await post("/bookings", { slotId: guessed, model: "Model Y", contact: CONTACT });
    assert.equal(r.status, 404);
    assert.equal(r.body.error as unknown as string, "slot_not_found");
  });

  it("没有后缀的老形态 id → 404（形状都不对）", async () => {
    const r = await post("/bookings", {
      slotId: "sz-nanshan-exp_2026-08-15_10",
      model: "Model Y",
      contact: CONTACT,
    });
    assert.equal(r.status, 404);
  });

  it("门店根本不存在的 slotId → 404", async () => {
    const r = await post("/bookings", { slotId: "fake-store_2026-08-15_10", model: "Model Y", contact: CONTACT });
    assert.equal(r.status, 404);
  });

  it("正常下单 → orderId，且留档只有**字段名**不含手机号", async () => {
    const slot = await anySlot();
    const r = await post("/bookings", { slotId: slot.slotId, model: "Model Y", contact: CONTACT });
    assert.equal(r.status, 200);
    assert.match(String(r.body.orderId), /^TD-\d{6}$/);
    assert.deepEqual(r.body.disclosed, ["称呼", "手机号"]);
    assert.equal(JSON.stringify(r.body).includes("13800138000"), false, "响应里不该回显完整手机号");
  });

  it("**同 idempotencyKey 重发不下两单**", async () => {
    const slot = await anySlot();
    const body = { slotId: slot.slotId, model: "Model Y", contact: CONTACT, idempotencyKey: "k1" };
    const a = await post("/bookings", body);
    const b = await post("/bookings", body);
    assert.equal(a.body.orderId, b.body.orderId);
    assert.equal(b.body.duplicate as unknown as boolean, true);
  });

  it("订满 → 409", async () => {
    const slot = await anySlot();
    for (let i = 0; i < slot.remaining; i += 1) {
      const r = await post("/bookings", { slotId: slot.slotId, model: "Model Y", contact: CONTACT, idempotencyKey: `k${i}` });
      assert.equal(r.status, 200);
    }
    const full = await post("/bookings", { slotId: slot.slotId, model: "Model Y", contact: CONTACT, idempotencyKey: "kx" });
    assert.equal(full.status, 409);
  });

  it("缺 contact → 400（门店打不通电话，用户以为约上了）", async () => {
    const slot = await anySlot();
    assert.equal((await post("/bookings", { slotId: slot.slotId, model: "Model Y" })).status, 400);
  });

  it("这家店不提供这款车 → 400，不能宽容地下单", async () => {
    const r = await get("/stores/sh-minhang-exp/slots?model=Model%20Y");
    const slot = (r.body.slots as unknown as Array<{ slotId: string }>)[0];
    const bad = await post("/bookings", { slotId: slot.slotId, model: "Model 3", contact: CONTACT });
    assert.equal(bad.status, 400);
  });
});

describe("GET /pricing：价格的唯一权威源", () => {
  it("**Model 3 后驱 = 235500**——与已经在用的那个数逐字一致", async () => {
    const r = await get("/pricing?model=Model%203&trim=后轮驱动版");
    assert.equal(r.status, 200);
    const trims = r.body.trims as unknown as Array<{ trim: string; priceCny: number }>;
    const rw = trims.find((t) => t.trim === "后轮驱动版");
    assert.equal(rw?.priceCny, 235_500, "对不上就是我们自己制造了两个真相");
  });

  it("**精确匹配优先**：后驱版不能连长续航后驱一起返回（真跑实测踩到）", async () => {
    const r = await get("/pricing?model=Model%203&trim=%E5%90%8E%E8%BD%AE%E9%A9%B1%E5%8A%A8%E7%89%88");
    const trims = r.body.trims as unknown as Array<{ trim: string; priceCny: number }>;
    assert.equal(trims.length, 1, `实际返回 ${trims.map((t) => t.trim).join("、")}`);
    assert.equal(trims[0].priceCny, 235_500, "取错一个就是两万四的差，而链路看起来完全正常");
  });

  it("半截词仍走模糊匹配", async () => {
    const r = await get("/pricing?model=Model%203&trim=%E9%95%BF%E7%BB%AD%E8%88%AA");
    const trims = r.body.trims as unknown as Array<{ trim: string }>;
    assert.ok(trims.length >= 2, "「长续航」应命中两个长续航配置");
  });

  it("Model Y 后驱 = 263500", async () => {
    const r = await get("/pricing?model=Model%20Y");
    const trims = r.body.trims as unknown as Array<{ trim: string; priceCny: number }>;
    assert.equal(trims.find((t) => t.trim === "后轮驱动版")?.priceCny, 263_500);
  });

  it("Cybertruck **没有人民币报价**——不换算汇率", async () => {
    const r = await get("/pricing?model=Cybertruck");
    const trims = r.body.trims as unknown as Array<{ priceCny?: number }>;
    assert.ok(trims.every((t) => t.priceCny === undefined), "换算汇率就是编数字");
  });

  it("车型不存在 404；配置不存在 404", async () => {
    assert.equal((await get("/pricing?model=汉EV")).status, 404);
    assert.equal((await get("/pricing?model=Model%203&trim=火箭版")).status, 404);
  });
});

describe("响应形态", () => {
  it("所有响应带 provenance=simulated——上游要能如实标注", async () => {
    const r = await get("/pricing?model=Model%203");
    assert.equal(r.body.provenance as unknown as string, "simulated");
  });

  it("未知路径回 **JSON** 404，不是 HTML（上游 JSON.parse 会炸在离现场很远的地方）", async () => {
    const r = await get("/nope");
    assert.equal(r.status, 404);
    assert.equal(r.body.error as unknown as string, "not_found");
  });

  it("/health 打出种子规模", async () => {
    const r = await get("/health");
    assert.ok((r.body.stores as unknown as number) >= 10);
    assert.ok((r.body.models as unknown as number) >= 3);
  });
});

/**
 * 任意城市 + 区（施工单 M19-07）。
 *
 * 种子只有四个城市十家店，而演示时车主会说任何一个地方。种子外一律零命中的话，
 * 助手只能一遍遍说"这个城市没有门店"——**看起来像功能坏了，其实是数据没铺开**。
 *
 * 这一组盯的是合成**不能变成编数据**：种子优先、确定性、id 自带来源、
 * 以及噪音进来时宁可零命中。
 */
describe("任意城市 + 区都能查到（M19-07）", () => {
  const storesOf = async (q: string) => {
    const r = await get(`/stores?model=Model%20Y&${q}`);
    return r.body.stores as unknown as Array<{ storeId: string; name: string; city: string; district: string }>;
  };

  it("种子外的城市 + 区也查得到", async () => {
    const s = await storesOf("city=北京&district=朝阳");
    assert.equal(s.length, 1);
    assert.equal(s[0].name, "北京朝阳体验店");
  });

  it("只给城市不给区也查得到", async () => {
    assert.equal((await storesOf("city=拉萨"))[0].name, "拉萨体验店");
  });

  it("**种子优先**——深圳南山仍是那家真种子店，不会多出一家合成的", async () => {
    const s = await storesOf("city=深圳&district=南山");
    assert.equal(s.length, 1);
    assert.equal(s[0].storeId, "sz-nanshan-exp");
  });

  it("种子城市里没有的区照样合成（深圳龙华）", async () => {
    const s = await storesOf("city=深圳&district=龙华");
    assert.equal(s[0].name, "深圳龙华体验店");
  });

  /**
   * 上游从原话里截地名，截歪了会传来「有没有」这种东西。合成是来者不拒的，
   * 放过去就是一家「深圳有没有体验店」——**比零命中难查得多**。
   */
  it("**区名不像地名 → 退回城市级的种子**，不合成", async () => {
    const s = await storesOf("city=深圳&district=有没有");
    assert.ok(s.length >= 2, "应当拿到深圳的真种子店");
    assert.ok(s.every((x) => !x.storeId.startsWith("gen-")), "不该出现合成店");
  });

  it("**城市名不像地名 → 零命中**，让上游回去问", async () => {
    assert.equal((await storesOf("city=的试驾")).length, 0);
  });

  it("**车型不认识不合成**——那等于替上游确认了一款不存在的车", async () => {
    const r = await get("/stores?model=Model%20Q&city=北京");
    assert.equal((r.body.stores as unknown as unknown[]).length, 0);
  });

  it("**同一个 (城市, 区) 永远同一个 storeId**——变了车主第二轮就查不到刚看过的店", async () => {
    const a = await storesOf("city=北京&district=朝阳");
    const b = await storesOf("city=北京&district=朝阳");
    assert.equal(a[0].storeId, b[0].storeId);
  });

  it("**合成店查得到时段、下得了单**（id 自带来源，不靠内存注册表）", async () => {
    const store = (await storesOf("city=成都&district=武侯区"))[0];
    const slotsRes = await get(`/stores/${encodeURIComponent(store.storeId)}/slots?model=Model%20Y`);
    assert.equal(slotsRes.status, 200);
    const slots = slotsRes.body.slots as unknown as Array<{ slotId: string }>;
    assert.ok(slots.length > 0, "合成店必须有时段，否则本单等于没做");

    const booked = await post("/bookings", {
      slotId: slots[0].slotId,
      model: "Model Y",
      contact: CONTACT,
    });
    assert.equal(booked.status, 200);
    assert.equal(booked.body.storeName as unknown as string, "成都武侯体验店");
  });

  it("**编一个合成 id 仍然被拒**——防编没有因为合成而松掉", async () => {
    const r = await post("/bookings", {
      slotId: "gen-deadbeef-exp_2026-08-15_10_zzzzzz",
      model: "Model Y",
      contact: CONTACT,
    });
    assert.equal(r.status, 404);
  });

  it("维修网点同样按区合成（appointment 那条线要用）", async () => {
    const r = await get("/stores?model=Model%20Y&city=北京&district=朝阳&type=service");
    const s = r.body.stores as unknown as Array<{ name: string; type: string }>;
    assert.equal(s[0].name, "北京朝阳服务中心");
    assert.equal(s[0].type, "service");
  });

  it("**合成地址如实写「模拟地址」**——编一个门牌号会让车主真的按它导航", async () => {
    const s = await storesOf("city=北京&district=朝阳");
    assert.match(s[0].storeId, /^gen-/);
    const addr = (s as unknown as Array<{ address: string }>)[0].address;
    assert.match(addr, /模拟地址/);
  });

  it("/health 声明这项能力——从一次 /stores 的结果上分辨不出来", async () => {
    const r = await get("/health");
    assert.equal(r.body.synthesizesAnyCity as unknown as boolean, true);
  });
});
