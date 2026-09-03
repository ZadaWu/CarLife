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
