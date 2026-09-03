/**
 * charging / car_catalog / appointment 三个工具（施工单 A2）。
 *
 * 三条最要紧的性质各自有测：
 *  · charging  —— 排队信息恒为不可知，**类型里就没有空闲桩数**；插点是算术不是判断；
 *  · appointment —— 外发信息是白名单，且能被完整列出（F-26-09）；重复提交不下两单；
 *  · car_catalog —— 零命中的车型要显式说出来，不能悄悄只返回一边。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createChargingTool,
  planChargeStops,
  parsePowerKw,
  haversineKm,
  SAFETY_SOC,
  QUEUE_NOTICE,
  type ChargingBackend,
} from "../src/charging";
import {
  createAppointmentTool,
  createMockAppointmentBackend,
  describeDisclosure,
  maskPhone,
  type AppointmentArgs,
} from "../src/appointment";
import { createCarCatalogTool, type CatalogBackend } from "../src/car-catalog";
import { TOOL_REGISTRY, listForAgent, listExposableForMcp } from "../src/registry";

const ctx = { sessionId: "s-1" };

describe("charging：插点是算术，排队是未知", () => {
  it("一口气能到就不插点", () => {
    // 400km 续航、90% 电、开 200km：可用 (0.9-0.15)*400 = 300km > 200
    assert.deepEqual(planChargeStops(200, 400, 0.9), []);
  });

  it("按安全余量插点，且补到 TARGET_SOC 后继续算", () => {
    const stops = planChargeStops(700, 400, 0.9);
    // 第一段可用 (0.9-0.15)*400 = 300km
    assert.equal(stops[0].atKm, 300);
    assert.equal(stops[0].arriveSoc, SAFETY_SOC);
    // 之后每段 (0.8-0.15)*400 = 260km
    assert.equal(stops[1].atKm, 560);
    assert.equal(stops.length, 2, "700km 只需两次补能");
  });

  it("出发电量低于安全余量直接报错，不硬凑一个方案", () => {
    assert.throws(() => planChargeStops(500, 400, 0.1), /低于安全余量/);
  });

  it("功率解析不出来就是 undefined——**不猜**", () => {
    assert.equal(parsePowerKw("国网快充站 120kW"), 120);
    assert.equal(parsePowerKw("某某充电站"), undefined);
    assert.equal(parsePowerKw("充电站 9999kW"), undefined, "越界值不采信");
  });

  it("结果恒带排队不可知说明，且结构里没有空闲桩数字段", async () => {
    const backend: ChargingBackend = {
      around: async () => [
        { id: "p1", name: "A站 120kW", type: "", typecode: "011100", address: "x", cityName: "深圳", lat: 22.5, lon: 114, distanceM: 500 },
      ],
    };
    const tool = createChargingTool(backend);
    const { data } = await tool.call(
      { route: [{ lat: 22.5, lon: 114 }, { lat: 25.0, lon: 114 }], rangeKm: 200, startSoc: 0.9 },
      ctx,
    );
    assert.equal(data.queueUnknown, true);
    assert.equal(data.queueNotice, QUEUE_NOTICE);
    const station = data.stops[0].candidates[0] as Record<string, unknown>;
    for (const forbidden of ["available", "freeCount", "idle", "queue", "waiting"]) {
      assert.equal(forbidden in station, false, `候选站不该有 ${forbidden} 字段`);
    }
  });

  it("被质量门槛筛掉的站点要留下理由", async () => {
    const backend: ChargingBackend = {
      around: async () => [
        { id: "p1", name: "慢充站 30kW", type: "", typecode: "011100", address: "x", cityName: "深圳", lat: 22.5, lon: 114, distanceM: 100 },
        { id: "p2", name: "快充站 120kW", type: "", typecode: "011100", address: "y", cityName: "深圳", lat: 22.6, lon: 114, distanceM: 900 },
      ],
    };
    const { data } = await createChargingTool(backend).call(
      { route: [{ lat: 22.5, lon: 114 }, { lat: 25.0, lon: 114 }], rangeKm: 200, startSoc: 0.9, minPowerKw: 60 },
      ctx,
    );
    assert.equal(data.stops[0].candidates.length, 1);
    assert.equal(data.rejected.length, 1);
    assert.match(data.rejected[0].reason, /30kW 低于要求的 60kW/);
  });

  it("距离已知的排前面，未知的不假装很近", async () => {
    const backend: ChargingBackend = {
      around: async () => [
        { id: "far", name: "远", type: "", typecode: "011100", address: "", cityName: "", lat: 0, lon: 0, distanceM: null },
        { id: "near", name: "近", type: "", typecode: "011100", address: "", cityName: "", lat: 0, lon: 0, distanceM: 200 },
      ],
    };
    const { data } = await createChargingTool(backend).call(
      { route: [{ lat: 22.5, lon: 114 }, { lat: 25.0, lon: 114 }], rangeKm: 200, startSoc: 0.9 },
      ctx,
    );
    assert.deepEqual(data.stops[0].candidates.map((c) => c.id), ["near", "far"]);
  });

  it("haversine 与已知距离量级一致（深圳→广州约 100km）", () => {
    const d = haversineKm({ lat: 22.54, lon: 114.06 }, { lat: 23.13, lon: 113.26 });
    assert.ok(d > 90 && d < 115, `实际 ${d.toFixed(1)}km`);
  });
});

describe("appointment：外发信息是白名单且可被完整列出（F-26-09）", () => {
  const base: AppointmentArgs = {
    kind: "test_drive",
    storeId: "S1",
    storeName: "某某门店",
    at: "2026-09-01T10:00:00+08:00",
    contact: { name: "林先生", phone: "13800138000" },
    subject: "某车型",
  };

  it("披露清单逐项可渲染，手机号掩码", () => {
    const items = describeDisclosure(base.contact);
    assert.deepEqual(items.map((i) => i.field), ["称呼", "手机号"]);
    assert.equal(items[1].value, "138****8000", "弹窗可能在车机大屏上，不重复展示完整号码");
  });

  it("有备注时才出现第三项——不凭空造字段", () => {
    assert.equal(describeDisclosure({ ...base.contact, note: "  " }).length, 2);
    assert.equal(describeDisclosure({ ...base.contact, note: "想试麋鹿测试" }).length, 3);
  });

  it("maskPhone 对非 11 位也不泄露中段", () => {
    assert.equal(maskPhone("021-1234"), "0*****4");
    assert.equal(maskPhone("1"), "*");
  });

  it("手机号格式不对**硬失败**，不尽力提交", async () => {
    const tool = createAppointmentTool(createMockAppointmentBackend());
    await assert.rejects(
      () => tool.call({ ...base, contact: { name: "林先生", phone: "1380013" } }, ctx),
      /手机号格式不正确/,
    );
  });

  it("重复提交同一幂等键不下两单", async () => {
    const tool = createAppointmentTool(createMockAppointmentBackend());
    const args = { ...base, idempotencyKey: "k-1" };
    const a = await tool.call(args, ctx);
    const b = await tool.call(args, ctx);
    assert.equal(a.data.orderId, b.data.orderId, "重复提交必须返回同一单号");
  });

  it("留档的是字段名不是值——审计表里不该再存一份手机号", async () => {
    const { data } = await createAppointmentTool(createMockAppointmentBackend()).call(base, ctx);
    assert.deepEqual(data.disclosed, ["称呼", "手机号"]);
    assert.equal(JSON.stringify(data).includes("13800138000"), false);
  });

  it("试驾当场确认、维修待门店回执——语义不统一成 confirmed", async () => {
    const tool = createAppointmentTool(createMockAppointmentBackend());
    const td = await tool.call({ ...base, idempotencyKey: "a" }, ctx);
    const sv = await tool.call({ ...base, kind: "service", idempotencyKey: "b" }, ctx);
    assert.equal(td.data.status, "confirmed");
    assert.equal(sv.data.status, "pending_store");
  });

  it("标记为 sensitive，且不重试（重试一次就是下两单）", () => {
    const tool = createAppointmentTool(createMockAppointmentBackend());
    assert.equal(tool.sensitive, true);
  });
});

describe("car_catalog：零命中要说出来", () => {
  it("比较两款车时其中一款零命中，必须显式列出", async () => {
    const backend: CatalogBackend = {
      retrieve: async () => [
        { text: "A 车续航 605km", document: "A车型手册.pdf", score: 0.9, model: "A车" },
      ],
    };
    const { data } = await createCarCatalogTool(backend).call(
      { query: "续航", models: ["A车", "B车"] },
      ctx,
    );
    assert.deepEqual(data.missingModels, ["B车"], "只返回 A 车会让对比看起来完整实则单边");
  });

  it("每个片段都带出处", async () => {
    const backend: CatalogBackend = {
      retrieve: async () => [{ text: "x", document: "手册.pdf", score: 0.8 }],
    };
    const { data } = await createCarCatalogTool(backend).call({ query: "配置" }, ctx);
    assert.equal(data.chunks[0].document, "手册.pdf");
  });

  it("空检索词直接报错", async () => {
    const backend: CatalogBackend = { retrieve: async () => [] };
    await assert.rejects(() => createCarCatalogTool(backend).call({ query: "  " }, ctx), /不能为空/);
  });
});

describe("registry：三个工具已注册且权限/暴露面正确", () => {
  const byName = (n: string) => TOOL_REGISTRY.find((t) => t.name === n);

  it("三个工具都在注册表里——**这是「存在」与「能被调用」的分界**", () => {
    for (const n of ["charging", "car_catalog", "appointment"]) {
      assert.ok(byName(n), `${n} 未注册，Agent 拿不到它`);
    }
  });

  it("appointment 是敏感工具，charging/car_catalog 不是", () => {
    assert.equal(byName("appointment")!.sensitive, true, "有副作用必须过权限门");
    assert.equal(byName("charging")!.sensitive, false);
    assert.equal(byName("car_catalog")!.sensitive, false);
  });

  it("appointment 不对外经 MCP 暴露（有副作用 + 外发个人信息）", () => {
    assert.equal(listExposableForMcp().some((t) => t.name === "appointment"), false);
  });

  it("按 §4.3 挂到正确的 Agent 上", () => {
    // drive 是 M12 补上的：多天行程的自驾分支要按能源类型排沿途补能，
    // 它的 prompt 点名了 `charging`（与 `refuel` 成对）。
    assert.deepEqual([...byName("charging")!.agents].sort(), ["drive", "supervisor", "trip"]);
    assert.deepEqual([...byName("car_catalog")!.agents], ["buying"]);
    assert.deepEqual([...byName("appointment")!.agents].sort(), ["buying", "service"]);
    // car_catalog 是购车专属：用车助手拿不到它
    assert.equal(listForAgent("ownership").some((t) => t.name === "car_catalog"), false);
  });
});
