/**
 * [F-01-10][AC-01-1] [F-01-10][AC-01-6] [F-01-04][AC-01-5] 主页 · 功能入口页（施工单 M103-01）。
 *
 * 读源码不渲染（本包没有 jsdom）+ 纯函数断言。守的是 2026-09-17 定下的三条：
 *  - 主页没有行程内容、没有麦克风、没有「长按说话」、没有输入框；
 *  - 两张入口卡等大等重，谁都不是实心橙；
 *  - 读不到写「读不到」、没有写「暂无 / 还没有」，不用 0 顶替。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import {
  consultStatus,
  energyValue,
  greetingFor,
  odometerValue,
  serviceValue,
  tripsStatus,
  vehicleLine,
  consultLevelOf,
  toHomeVehicle,
} from "../src/features/home/model";

/** 注释不算：文件头写着"没有「长按说话」"，守的是界面文字与部件，不是注释的措辞（与 login-theme-tokens 同一条教训）。 */
const SRC = readFileSync(new URL("../src/features/home/index.tsx", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const CSS = readFileSync(new URL("../src/features/home/home.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const count = (src: string, needle: string) => src.split(needle).length - 1;

describe("[F-01-10][AC-01-1] 入口页：没有行程、没有语音、没有输入框", () => {
  it("源码里不出现行程地图与语音的任何部件", () => {
    for (const forbidden of ["<input", "MicIndicator", "长按说话", "AmapTripLayer", "PortraitTimeline", "EnergyCapsule", "HudStage", "AmapBackdrop"]) {
      assert.equal(SRC.includes(forbidden), false, `入口页不该出现 ${forbidden}`);
    }
  });

  it("暖暖恰好一处，且两行提示语都传空串（dock 自带的卡由 CSS 收掉）", () => {
    assert.equal(count(SRC, "<AssistantDock"), 1);
    assert.match(SRC, /primaryLabel=""/);
    assert.match(SRC, /secondaryLabel=""/);
    assert.match(CSS, /\.mh-hero \.hud-assistant__card\s*\{\s*display:\s*none;?\s*\}/, "dock 的卡（音波 + 提示语）必须整个收掉");
  });

  it("主页暖暖只挂 tap，不挂长按 PTT（2026-09-18：手机端不走语音那条链）", () => {
    const APP = readFileSync(new URL("../src/app/index.tsx", import.meta.url), "utf8");
    // 主页传的是只有 onClick 的那份，不是 useAssistantInteraction 的全套手势（后者含长按起录音）。
    assert.match(APP, /const homeAssistantGesture = useMemo\(\(\) => \(\{ onClick: \(\) => setNav\("dialog"\) \}\), \[\]\)/);
    assert.match(APP, /<MobileHome[\s\S]{0,400}assistantGestureProps=\{homeAssistantGesture\}/);
  });

  it("组件不 invoke、不 fetch：数据全部由 props 进", () => {
    assert.equal(SRC.includes("invoke("), false);
    assert.equal(SRC.includes("fetch("), false);
  });
});

describe("[F-01-10][AC-01-6] 两张等大的入口卡", () => {
  it("恰好两枚 .mh-entry，data-entry 分别是 diagnosis / trips", () => {
    assert.equal(count(SRC, 'className="mh-entry"'), 2);
    assert.match(SRC, /data-entry="diagnosis"/);
    assert.match(SRC, /data-entry="trips"/);
  });

  it("grid 两等分；两卡共用同一个类，没有第二个视觉重量", () => {
    // `minmax(0, 1fr)` 而不是裸 `1fr`：卡里有 nowrap 的说明行，裸 1fr 按 min-content 撑开会让整行溢出视口。
    assert.match(CSS, /\.mh-entries\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/);
    assert.equal(CSS.includes(".mh-entry--primary"), false);
    assert.equal(CSS.includes("--hud-amber-cta"), false, "入口页没有实心橙主行动（底导那枚是导航态，不算）");
  });
});

describe("[F-01-04][AC-01-5] 车况条与状态行：缺失写字，不用 0 顶替", () => {
  it("能量：缺席与 unavailable 都是「读不到」；电 / 油各画各的", () => {
    assert.equal(energyValue(undefined).value, "读不到");
    assert.equal(energyValue({ kind: "unavailable", reason: "no signal" }).value, "读不到");
    assert.equal(energyValue(undefined).muted, true);
    const bat = energyValue({ kind: "battery", percent: 67.6, rangeKm: 300, charging: false });
    assert.deepEqual([bat.caption, bat.value, bat.unit], ["剩余电量", "68", "%"]);
    assert.equal(energyValue({ kind: "battery", percent: 40, rangeKm: 100, charging: true }).caption, "剩余电量 · 充电中");
    assert.equal(energyValue({ kind: "fuel", percent: 55, rangeKm: 400 }).caption, "剩余油量");
  });

  it("表显里程：只有 ready 才有数，其余「暂无」", () => {
    assert.deepEqual(odometerValue("offline", null), { value: "暂无", muted: true });
    assert.deepEqual(odometerValue("empty", undefined), { value: "暂无", muted: true });
    const v = odometerValue("ready", { model: "x", modelYear: 2024, odometerKm: 23480 });
    assert.deepEqual([v.value, v.unit, v.muted], ["23,480", "km", false]);
  });

  it("距下次保养：负数换 caption 说已超期；缺席「暂无」", () => {
    assert.equal(serviceValue(undefined).value, "暂无");
    const over = serviceValue({ remainingKm: -120 });
    assert.deepEqual([over.caption, over.value, over.unit], ["保养已超期", "约 120", "km"]);
    const ok = serviceValue({ remainingKm: 1380.4 });
    assert.deepEqual([ok.caption, ok.value], ["距下次保养", "约 1,380"]);
  });

  it("问诊状态行只写日期，没有等级；没有记录就说没有", () => {
    assert.equal(consultStatus(undefined), "还没有问诊记录");
    const now = Date.parse("2026-09-18T10:00:00+08:00");
    assert.equal(consultStatus(Date.parse("2026-09-17T14:41:00+08:00"), undefined, now), "上次问诊 · 9/17");
    assert.equal(consultStatus(Date.parse("2025-12-01T10:00:00+08:00"), undefined, now), "上次问诊 · 2025/12/1");
    assert.equal(/风险/.test(consultStatus(Date.now())), false, "没有等级就不写等级");
    // 等级来自留档 resolution 的固定前缀（M104-04）——我们自己写的字面，不是模型输出。
    assert.equal(consultStatus(Date.parse("2026-09-17T14:41:00+08:00"), "medium", now), "上次 · 中风险 · 9/17");
  });

  it("留档等级只认三个固定前缀；最近一条问诊记录进主页卡", () => {
    assert.equal(consultLevelOf("【中风险】建议尽快检查"), "medium");
    assert.equal(consultLevelOf("中风险 建议…"), undefined);
    assert.equal(consultLevelOf(undefined), undefined);
    const v = toHomeVehicle({
      vin: "x", model: "m", modelYear: 2024, purchasedAt: 0, odometerKm: 1, maintenance: [],
      repairs: [
        { at: 10, odometerKm: 1, symptom: "a", source: "问诊", resolution: "【低风险】…" },
        { at: 20, odometerKm: 1, symptom: "b", source: "问诊", resolution: "【高风险】…" },
        { at: 30, odometerKm: 1, symptom: "c", source: "门店" },
      ],
    });
    assert.equal(v.lastConsultAt, 20);
    assert.equal(v.lastConsultLevel, "high");
  });

  it("行程状态行：0 程不写数字", () => {
    assert.deepEqual(tripsStatus(0), { label: "还没有行程" });
    assert.deepEqual(tripsStatus(8), { label: "我的行程", count: 8 });
  });

  it("车辆行三态各说各的", () => {
    assert.equal(vehicleLine("offline", null), "暂时读不到车辆档案");
    assert.equal(vehicleLine("empty", null), "还没有车辆档案");
    assert.equal(vehicleLine("ready", { model: "特斯拉 Model Y", modelYear: 2024, odometerKm: 23480 }), "特斯拉 Model Y · 表显 23,480 km");
  });

  it("问候四档", () => {
    assert.deepEqual([6, 11, 14, 20].map(greetingFor), ["早上好", "上午好", "下午好", "晚上好"]);
  });
});

describe("设计系统守卫：页壳、字号、颜色", () => {
  it("页壳让顶部安全区与底导；不出现红；字号只从 --m-font-* 取", () => {
    assert.match(CSS, /env\(safe-area-inset-top\)/);
    assert.match(CSS, /var\(--hud-bottom-nav-clear\)/);
    assert.equal(/#c0392b|--hud-danger/i.test(CSS), false, "入口页没有红——红只给「拥堵」与「读不到」的判定");
    assert.equal(/font-size:\s*\d/.test(CSS), false, "字号不许写死 px");
  });
});
