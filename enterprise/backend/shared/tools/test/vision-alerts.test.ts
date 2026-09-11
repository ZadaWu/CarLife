/**
 * [F-20-03][AC-20-1] 读车机警报列表（施工单 M80-10）。
 *
 * 重点是**代码的形态卡死**：`VCFRONT_a004` 抄成 `Dl_a223`、`DI a223` 都要被拒收——
 * 代码是检索那一条官方解释的唯一钥匙，抄错一个字符比没抄到更糟（下游会以为查过了）。
 * 2026-09-10 真实照片上确实发生过：屏幕上是 `DL_a166`，模型读成 `DI_a166`。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ALERT_CODE_RE, AlertEntrySchema, AlertReadingSchema, EMPTY_ALERT_READING, composeVisionProvider, createDeepSeekVisionProvider, createYoloDetectProvider } from "../src/vision/index";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

describe("[F-20-03][AC-20-1] 警报代码的形态", () => {
  it("官方形态放行：前缀大写 + 下划线 + a/w + 数字", () => {
    for (const c of ["APP_w009", "VCFRONT_a004", "DI_a223", "UI_a114", "VCSEC_a260", "ESP_a039", "DL_a166"]) {
      assert.match(c, ALERT_CODE_RE, c);
    }
  });

  it("**抄错一个字符就拒收**——它是检索那条官方解释的唯一钥匙", () => {
    for (const c of ["DI a223", "di_a223", "DI_A223", "DI_223", "DI_a", "_a223", "DI-a223", "DI_a223x"]) {
      assert.doesNotMatch(c, ALERT_CODE_RE, c);
    }
  });

  it("坏代码让整条被拒，schema 不放行", () => {
    assert.throws(() => AlertEntrySchema.parse({ code: "DI a223", title: "牵引力控制已停用" }));
    const ok = AlertEntrySchema.parse({ code: "DI_a223", title: "牵引力控制已停用" });
    assert.equal(ok.subtitle, "");
    assert.equal(ok.active, true, "缺省算活动警报");
    assert.equal(ok.iconColor, "unknown");
  });
});

describe("[F-20-03][AC-20-1] AlertReading", () => {
  it("不是警报页 → entries 为空即可；「无活动警报」与「没读到」是两件事", () => {
    const notAlert = AlertReadingSchema.parse({ isAlertScreen: false });
    assert.deepEqual(notAlert.entries, []);
    assert.equal(notAlert.noActiveAlerts, false);
    const none = AlertReadingSchema.parse({ isAlertScreen: true, noActiveAlerts: true });
    assert.equal(none.noActiveAlerts, true, "屏幕上写着「无活动警报」——下游能说「当前没有活动警报」");
    assert.deepEqual(EMPTY_ALERT_READING.entries, []);
  });

  it("多一个键就拒收——与观察层同一条纪律，模型想越界没地方写", () => {
    assert.throws(() => AlertReadingSchema.parse({ isAlertScreen: true, severity: "high" }));
    assert.throws(() => AlertEntrySchema.parse({ code: "DI_a223", meaning: "牵引力控制坏了" }));
  });

  it("活动 / 历史分组分得开，时间戳原样留着", () => {
    const r = AlertReadingSchema.parse({
      isAlertScreen: true,
      entries: [
        { code: "DI_a223", title: "牵引力控制已停用", subtitle: "小心驾驶", iconColor: "red" },
        { code: "APP_w009", title: "自动紧急制动不可用", active: false, at: "10:21" },
      ],
    });
    assert.equal(r.entries.filter((e) => e.active).length, 1);
    assert.equal(r.entries[1].at, "10:21");
  });
});

describe("[F-20-03][AC-20-1] readAlerts 是可选能力", () => {
  it("端侧检测器没有它；组合体跟着描述那一家走", () => {
    const yolo = createYoloDetectProvider({ baseURL: "http://t", model: "m" });
    assert.equal(yolo.readAlerts, undefined, "yolo 只会框位置，读不了小字");
    const ds = createDeepSeekVisionProvider({ apiKey: "k" });
    assert.equal(typeof ds.readAlerts, "function");
    assert.equal(typeof composeVisionProvider(yolo, ds).readAlerts, "function", "yolo+deepseek 要能读警报页");
    assert.equal(composeVisionProvider(yolo, yolo as never).readAlerts, undefined, "两边都没有就整个不给，上游跳过这一遍");
  });

  it("请求打的是描述档，且带上系统提示词", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetchStub = (async (_u: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ isAlertScreen: true, entries: [{ code: "DI_a223", title: "牵引力控制已停用" }] }) } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const p = createDeepSeekVisionProvider({ apiKey: "k", fetch: fetchStub, describeModel: "deepseek-flash" });
    const r = await p.readAlerts!(PNG);
    assert.equal(r.entries[0].code, "DI_a223");
    assert.equal(calls[0].model, "deepseek-flash");
    const msgs = calls[0].messages as Array<{ role: string; content: unknown }>;
    assert.match(String(msgs[0].content), /文字抄写员/);
    assert.match(String(msgs[0].content), /整条不要/, "「看不清就整条不要」必须在提示词里");
  });
});
