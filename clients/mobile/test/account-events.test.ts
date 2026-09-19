/**
 * 账号级事件通道在手机端的接线（ACR-033）。
 *
 * 与车机端那份同形（`clients/cockpit/test/account-events.test.ts`），盯的是同一类
 * 只要一漂移、现象就完全静默的地方：
 *
 *  1. **事件名三处必须一字不差**：手机 Rust、车机 Rust、`ACCOUNT_EVENTS`。
 *     对不上的时候 Rust 照发、前端照听，谁都不报错，只是永远收不到。
 *  2. **前端订阅走常量**，不写字面量。
 *  3. **收到就整拉**，不做增量合并。
 *
 * 手机端**没有**车机那条"换人要重起流"的断言：手机是个人设备，token 自带身份，
 * 不存在换人。多断言一条会把两端的差别写成"手机漏了"。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { ACCOUNT_EVENTS } from "@carlife/shared";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(resolve(here, "..", p), "utf8");
const nameIn = (src: string): string | undefined =>
  src.match(/pub const EVENT_SESSIONS_CHANGED: &str = "([^"]+)";/)?.[1];

describe("[ACR-033] 手机端接入账号级事件通道", () => {
  it("事件名三处一致：手机 Rust、车机 Rust、ACCOUNT_EVENTS", () => {
    const mine = nameIn(read("src-tauri/src/events.rs"));
    const cockpit = nameIn(read("../cockpit/src-tauri/src/events.rs"));
    assert.equal(mine, ACCOUNT_EVENTS.sessionsChanged, "手机 Rust 与契约对不上");
    assert.equal(cockpit, ACCOUNT_EVENTS.sessionsChanged, "车机 Rust 与契约对不上");
  });

  it("前端订阅走 ACCOUNT_EVENTS 常量，不写字面量", () => {
    const app = read("src/app/index.tsx");
    assert.ok(
      app.includes("ACCOUNT_EVENTS.sessionsChanged"),
      "index.tsx 没有用 ACCOUNT_EVENTS.sessionsChanged 订阅",
    );
    assert.ok(
      !app.includes(`"${ACCOUNT_EVENTS.sessionsChanged}"`),
      "index.tsx 里出现了事件名的字面量，应当只用常量",
    );
  });

  it("收到事件就整拉列表，而不是把那一条插进去", () => {
    const app = read("src/app/index.tsx");
    const i = app.indexOf("ACCOUNT_EVENTS.sessionsChanged");
    assert.ok(i > 0);
    const near = app.slice(i, i + 400);
    assert.ok(
      /loadSessionsRef\.current\?\.\(true\)/.test(near),
      `订阅回调里没有整拉会话列表：${near.slice(0, 200)}`,
    );
  });

  it("引导时起了这条流——不起的话订阅永远等不到事件", () => {
    const app = read("src/app/index.tsx");
    assert.ok(
      app.includes('invoke("start_user_events_stream")'),
      "index.tsx 没有起 start_user_events_stream",
    );
  });

  it("账号流有自己的停止位，不跟会话流共用", () => {
    const events = read("src-tauri/src/events.rs");
    assert.ok(events.includes("user_stop"), "StreamState 没有独立的 user_stop");
    assert.ok(events.includes("pub fn replace_user_stream"), "没有 replace_user_stream");
  });
});
