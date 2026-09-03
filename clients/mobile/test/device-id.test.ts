/**
 * [F-56-03][AC-56-2] 车机 deviceId 的正常化与校验（施工单 M51-01）。
 *
 * 这一层是「车机终端」那一屏里唯一好测的部分，也恰好是最会出错的部分：
 * 车主对着另一块屏抄 32 位十六进制。所以每条 reason 都要被钉住——
 * 一句"格式不对"让人只能整串重抄一遍，而那正是这一屏想省掉的事。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEVICE_ID_LENGTH,
  formatDeviceId,
  normalizeDeviceId,
  validateDeviceId,
} from "../src/features/ownership/device-id";

const GOOD = "9f2c4a7b1d8e0356af41b90c7d2e5681";
const SELF = "0011223344556677889900aabbccddee";

describe("[F-56-03][AC-56-2] deviceId 正常化", () => {
  it("正常的 32 位 hex 原样通过", () => {
    const r = validateDeviceId(GOOD);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.id, GOOD);
  });

  it("粘贴带来的空格 / 换行 / 连字符都清掉", () => {
    const messy = "9f2c 4a7b\n1d8e-0356\taf41 b90c 7d2e 5681";
    assert.equal(normalizeDeviceId(messy), GOOD);
    const r = validateDeviceId(messy);
    assert.equal(r.ok, true, "从二维码工具或聊天记录里粘过来的必然带这些");
  });

  it("大写 hex 转小写——服务端存的是小写", () => {
    const r = validateDeviceId(GOOD.toUpperCase());
    assert.equal(r.ok && r.id, GOOD);
  });

  it("4 位一组显示，且不改变内容", () => {
    const shown = formatDeviceId(GOOD);
    assert.equal(shown, "9f2c 4a7b 1d8e 0356 af41 b90c 7d2e 5681");
    assert.equal(normalizeDeviceId(shown), GOOD, "分组只是显示，不许动内容");
  });
});

describe("[F-56-03][AC-56-2] deviceId 校验的每一条都要能指导修正", () => {
  it("空 → 指回车机屏", () => {
    const r = validateDeviceId("   ");
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.reason, /车机屏/);
  });

  it("含非 hex 字符 → 点名是哪个字符", () => {
    const r = validateDeviceId("9f2c4a7b1d8e0356af41b90c7d2e56g1");
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.reason, /0-9 与 a-f/);
    assert.match(r.ok ? "" : r.reason, /「g」/, "不说是哪个字符，等于让人整串重抄");
  });

  it("中文混进来也算非 hex", () => {
    const r = validateDeviceId("9f2c4a7b1d8e0356af41b90c7d2e56：1");
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.reason, /0-9 与 a-f/);
  });

  it("少一位 / 多一位 → reason 里带上实际位数", () => {
    const short = validateDeviceId(GOOD.slice(0, 31));
    assert.equal(short.ok, false);
    assert.match(short.ok ? "" : short.reason, /31 位/);

    const long = validateDeviceId(GOOD + "a");
    assert.equal(long.ok, false);
    assert.match(long.ok ? "" : long.reason, /33 位/);
  });

  it("**填了本机自己的编号 → 拦下**", () => {
    const r = validateDeviceId(SELF, SELF);
    assert.equal(r.ok, false, "这是最危险的一种错：服务端会成功地把手机注册成车机");
    assert.match(r.ok ? "" : r.reason, /这台手机自己/);
  });

  it("本机编号带格式差异也认得出来（大小写 / 空格）", () => {
    const r = validateDeviceId(formatDeviceId(SELF).toUpperCase(), SELF);
    assert.equal(r.ok, false, "正常化要发生在比对之前，否则这条拦不住");
  });

  it("没传本机 id 时不拦——拿不到就不该误伤", () => {
    assert.equal(validateDeviceId(SELF).ok, true);
  });

  it("长度常量与实现一致", () => {
    assert.equal(DEVICE_ID_LENGTH, 32);
    assert.equal(GOOD.length, DEVICE_ID_LENGTH);
  });
});
