/**
 * [F-11-03][AC-11-2] 锚定块必须确定性渲染（M84-03，ACR-036 §4.9）。
 *
 * 这一条没有别的验法：锚定块进的是直连的 `system` 与 pi 会话的第一条 prompt——**前缀**。
 * 前缀变一个字，这个线程此前累积的缓存全部作废，而那不报错、不失败、测试全绿，
 * 只表现为账单变贵与首字变慢。所以"两次渲染逐字相同"必须是一条断言。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { UserContext } from "@carlife/shared";

import { fingerprintContext } from "../src/context/anchor";
import { renderAnchor } from "../src/context/render";

const FULL: UserContext = {
  userId: "u-1",
  identity: { userId: "u-1", displayName: "老王", role: "owner" },
  vehicle: {
    vin: "LSJA0000000000001",
    model: "Model Y",
    modelYear: 2023,
    energyType: "bev",
    odometerKm: 32_140.6,
    odometerAsOf: 1_755_000_000_000,
    odometerSource: "telemetry",
    maintenanceIntervalKm: 10_000,
  },
  home: { city: "浙江杭州", lat: 30.28, lon: 120.16 },
  companions: [
    { label: "妈", relation: "母亲", ageBand: "senior", needs: ["frequent-rest"] },
    { label: "囡囡", relation: "女儿", ageBand: "child", needs: ["child-seat"] },
  ],
  trips: [
    { ref: "plan-ab12cd34", destination: "青岛", days: 3, startDate: "2026-09-20" },
    { ref: "plan-ef56gh78", destination: "南通", days: 2 },
  ],
  reminders: [{ kind: "maintenance", dueAt: 1_760_000_000_000, remainingKm: 820, degraded: false }],
  preferences: ["住市区不住郊区", "晚上充电"],
  usage: { summary: "近 30 天日均 42 km，常在夜里充电", usable: true },
};

const ALL = [
  "identity",
  "vehicle",
  "home",
  "companions",
  "trips",
  "reminders",
  "preferences",
  "usage",
] as const;

describe("[F-11-03][AC-11-2] 锚定块：两次渲染逐字相同", () => {
  it("同一份上下文渲染两次，字符串严格相等", () => {
    assert.strictEqual(renderAnchor(FULL, ALL), renderAnchor(FULL, ALL));
  });

  it("对象键的插入顺序不影响输出——哪几段读到了会变，输出不该跟着变", () => {
    // 反序构造同一份内容：JSON.stringify 的结果不同，渲染必须相同。
    const reversed: UserContext = {
      usage: FULL.usage,
      preferences: FULL.preferences,
      reminders: FULL.reminders,
      trips: FULL.trips,
      companions: FULL.companions,
      home: FULL.home,
      vehicle: FULL.vehicle,
      identity: FULL.identity,
      userId: FULL.userId,
    };
    assert.notStrictEqual(JSON.stringify(reversed), JSON.stringify(FULL), "前提：两者的 JSON 确实不同");
    assert.strictEqual(renderAnchor(reversed, ALL), renderAnchor(FULL, ALL));
  });

  it("指纹也不看键序：同内容不同键序的两份指纹相同", () => {
    const reversed: UserContext = { userId: FULL.userId, vehicle: FULL.vehicle, identity: FULL.identity };
    const forward: UserContext = { identity: FULL.identity, vehicle: FULL.vehicle, userId: FULL.userId };
    assert.strictEqual(fingerprintContext(reversed), fingerprintContext(forward));
  });

  it("内容真变了，指纹就变——否则 delta 永远不会触发", () => {
    const changed: UserContext = { ...FULL, preferences: ["住市区不住郊区"] };
    assert.notStrictEqual(fingerprintContext(changed), fingerprintContext(FULL));
  });
});

describe("[F-11-03][AC-11-2] 锚定块：不含任何随时间变的东西", () => {
  const text = renderAnchor(FULL, ALL);

  it("不含相对时间词（那些属于本轮尾区）", () => {
    for (const word of ["天前", "刚刚", "今天", "昨天", "小时前", "分钟前"]) {
      assert.ok(!text.includes(word), `锚定块里不该出现「${word}」：它每天都会变，进前缀就等于每天换一次缓存\n实际：\n${text}`);
    }
  });

  it("不含检索分数与当前年份的时间戳", () => {
    assert.ok(!/score/i.test(text), "Mem0 的检索分数每次都可能不同，不能进前缀");
    assert.ok(!text.includes(String(Date.now()).slice(0, 8)), "不能把当前时刻写进去");
  });

  it("里程写绝对值、不写「多久没更新」——后者是本轮尾区的活", () => {
    assert.ok(text.includes("32141 km"), `实际：\n${text}`);
    assert.ok(!text.includes("没更新"));
  });

  it("固定头部在最前面，且只出现一次", () => {
    assert.ok(text.startsWith("【当前状态"), `实际开头：${text.slice(0, 40)}`);
    assert.equal(text.split("【当前状态").length - 1, 1);
  });
});

describe("[F-11-03][AC-11-2] 锚定块：段的输出顺序与丢弃顺序解耦", () => {
  it("给的段少了，留下来的那几段顺序不变（换位置 = 换前缀）", () => {
    const full = renderAnchor(FULL, ALL);
    const some = renderAnchor(FULL, ["identity", "vehicle", "trips"]);
    const lines = some.split("\n").filter((l) => l.startsWith("车主：") || l.startsWith("车辆：") || l.startsWith("已确认的行程"));
    const order = lines.map((l) => l.slice(0, 3));
    assert.deepStrictEqual(order, ["车主：", "车辆：", "已确认"], `实际：\n${some}`);
    assert.ok(full.indexOf("车主：") < full.indexOf("车辆："));
  });
});
