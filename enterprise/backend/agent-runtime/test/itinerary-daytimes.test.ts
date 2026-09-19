/**
 * M34-01：时段与住宿的语义校验。
 *
 * schema 只挡形状且只挡提交路径；这里守语义（同天单调、start<end）与
 * "非法整天丢弃、不修不猜"的纪律——半天可信半天不可信的时间轴比没有更糟。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { dayTimesValid, sanitizeLodging } from "../src/graph/subgraphs/itinerary";

test("全部合法：齐全、HH:MM、start<end、顺序不回退", () => {
  assert.equal(
    dayTimesValid([
      { estStart: "09:00", estEnd: "10:30" },
      { estStart: "10:50", estEnd: "12:20" },
      { estStart: "14:00", estEnd: "15:30" },
    ]),
    true,
  );
});

test("允许并列（同一时段两个点）与部分覆盖（有的点不带时段）", () => {
  assert.equal(
    dayTimesValid([
      { estStart: "09:00", estEnd: "10:30" },
      {},
      { estStart: "09:00", estEnd: "11:00" },
    ]),
    true,
  );
});

test("start >= end 非法", () => {
  assert.equal(dayTimesValid([{ estStart: "14:00", estEnd: "14:00" }]), false);
  assert.equal(dayTimesValid([{ estStart: "15:00", estEnd: "14:00" }]), false);
});

test("顺序回退非法——夜游排在上午正是要挡的形态", () => {
  assert.equal(
    dayTimesValid([
      { estStart: "19:00", estEnd: "20:30" },
      { estStart: "09:00", estEnd: "10:30" },
    ]),
    false,
  );
});

test("只给一半、形状不对（正文回落路径的脏值）非法", () => {
  assert.equal(dayTimesValid([{ estStart: "09:00" }]), false);
  assert.equal(dayTimesValid([{ estStart: "9am", estEnd: "11:00" }]), false);
  assert.equal(dayTimesValid([{ estStart: "25:00", estEnd: "26:00" }]), false);
});

test("全不带时段 = 合法（旧行程/模型没给，回退归 HUD）", () => {
  assert.equal(dayTimesValid([{}, {}]), true);
  assert.equal(dayTimesValid([]), true);
});

test("lodging 只认两个枚举；脏值丢弃、空 note 剥掉", () => {
  assert.deepEqual(sanitizeLodging({ strategy: "checkin-midday", note: "行李寄存前台" }), {
    strategy: "checkin-midday",
    note: "行李寄存前台",
  });
  assert.deepEqual(sanitizeLodging({ strategy: "checkin-evening", note: "  " }), {
    strategy: "checkin-evening",
  });
  assert.equal(sanitizeLodging({ strategy: "checkin-tonight" }), undefined);
  assert.equal(sanitizeLodging(undefined), undefined);
});

/*
 * 办入住的时段窗口（turn-ced08ea1 走查：「到如家商旅酒店的时间页没说」）。
 *
 * 纪律与景点时段同源但**丢的粒度不同**：那边整天一票制，这边只丢这一对——
 * 策略与行李处置那句话是独立可用的信息，不该被一个坏时段废掉。
 */
test("办入住窗口：合法就留，缺一半/形状不对/首尾倒置一律当没给", () => {
  assert.deepEqual(sanitizeLodging({ strategy: "checkin-midday", estStart: "12:00", estEnd: "12:40" }), {
    strategy: "checkin-midday",
    estStart: "12:00",
    estEnd: "12:40",
  });
  // 只给一头 = 没有窗口
  assert.deepEqual(sanitizeLodging({ strategy: "checkin-midday", estStart: "12:00" }), {
    strategy: "checkin-midday",
  });
  // 形状不对
  assert.deepEqual(sanitizeLodging({ strategy: "checkin-midday", estStart: "12点", estEnd: "12:40" }), {
    strategy: "checkin-midday",
  });
  // 首尾倒置 / 相等
  assert.deepEqual(sanitizeLodging({ strategy: "checkin-midday", estStart: "12:40", estEnd: "12:00" }), {
    strategy: "checkin-midday",
  });
  assert.deepEqual(sanitizeLodging({ strategy: "checkin-midday", estStart: "12:00", estEnd: "12:00" }), {
    strategy: "checkin-midday",
  });
});

test("**坏窗口不拖垮整个 lodging**——策略与行李那句话照旧留着", () => {
  assert.deepEqual(
    sanitizeLodging({ strategy: "checkin-midday", note: "行李放车上", estStart: "25:00", estEnd: "26:00" }),
    { strategy: "checkin-midday", note: "行李放车上" },
  );
});

test("办入住不能排到当天第一个景点之后——那种窗口是错的，落脚行会被画到景点后面", () => {
  assert.deepEqual(
    sanitizeLodging({ strategy: "checkin-midday", estStart: "12:00", estEnd: "12:40" }, "13:30"),
    { strategy: "checkin-midday", estStart: "12:00", estEnd: "12:40" },
  );
  // 结束晚于第一个景点的开始 → 丢窗口
  assert.deepEqual(sanitizeLodging({ strategy: "checkin-midday", estStart: "13:00", estEnd: "14:00" }, "13:30"), {
    strategy: "checkin-midday",
  });
  // 正好卡在第一个景点开始那一刻 = 合法（紧接着就走）
  assert.deepEqual(sanitizeLodging({ strategy: "checkin-midday", estStart: "13:00", estEnd: "13:30" }, "13:30"), {
    strategy: "checkin-midday",
    estStart: "13:00",
    estEnd: "13:30",
  });
  // 上界本身不可信（整天时段被判非法）时不参与判定
  assert.deepEqual(sanitizeLodging({ strategy: "checkin-midday", estStart: "13:00", estEnd: "14:00" }, "13点半"), {
    strategy: "checkin-midday",
    estStart: "13:00",
    estEnd: "14:00",
  });
});
