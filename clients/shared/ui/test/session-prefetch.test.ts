/**
 * [F-03-03] 会话历史的「没占满就再要一页」不能在列表未布局时触发。
 *
 * 手机上这一栏是收起的抽屉，列表 clientHeight/scrollHeight 都是 0，
 * `0 <= 0` 于是被判成"没占满"→ 请求下一页 → sessions 一变 effect 重跑 → 再请求，
 * 一路翻到没有更多为止。2026-09-02 在 iPhone 13 上实测：每次进对话页都把
 * **3901 条会话全量拉下来**（40 个来回），界面上只有一行「会话历史 · 3901」，
 * 看不出发生过任何事——既费流量，又让那个数字变得毫无意义。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shouldPrefetchMore } from "../src/dialog/SessionList";

const box = (clientHeight: number, scrollHeight: number) => ({ clientHeight, scrollHeight });

describe("[F-03-03] 会话历史的预取判据", () => {
  it("列表没被布局时一律不预取（手机上抽屉收起就是这个状态）", () => {
    assert.equal(shouldPrefetchMore(box(0, 0), false, true), false);
  });

  it("车机的常驻左栏没被填满时照旧预取", () => {
    // 高 800 的栏里只有 300 的内容 → 永远滚不动，触底事件不会来
    assert.equal(shouldPrefetchMore(box(800, 300), false, true), true);
  });

  it("已经填满就不预取，交给触底", () => {
    assert.equal(shouldPrefetchMore(box(800, 2400), false, true), false);
  });

  it("正在加载 / 没有更多时都不预取", () => {
    assert.equal(shouldPrefetchMore(box(800, 300), true, true), false);
    assert.equal(shouldPrefetchMore(box(800, 300), false, false), false);
  });
});
