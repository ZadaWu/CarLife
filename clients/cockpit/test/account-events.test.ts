/**
 * 账号级事件通道在车机端的接线（ACR-032）。
 *
 * 本包没有 jsdom，组件渲染不了，所以这份测试**不测"收到事件后界面怎么变"**，
 * 而是钉住那几处只要一漂移、现象就完全是静默的地方：
 *
 *  1. **事件名两侧必须一字不差。** Rust 侧 `emit` 的字面量与 `BRIDGE_EVENTS` 里那个
 *     是两份独立的字符串。改一处漏一处的后果是：Rust 照发、前端照听，谁都不报错，
 *     只是永远对不上——而现象与"服务端没推"一模一样。
 *  2. **前端必须引用常量而不是自己写字面量。** 写死一个字符串在当时是对的，
 *     下一次改名字时它就成了第二份真相。
 *  3. **换人之后要重起这条流。** 它订阅的键是人，而车机正是那个会换人的端。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { ACCOUNT_EVENTS } from "@carlife/shared";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(resolve(here, "..", p), "utf8");

describe("[ACR-032] 车机端接入账号级事件通道", () => {
  it("Rust emit 的事件名与 BRIDGE_EVENTS 一字不差——对不上时两侧都不报错，只是永远收不到", () => {
    const rust = read("src-tauri/src/events.rs");
    const m = rust.match(/pub const EVENT_SESSIONS_CHANGED: &str = "([^"]+)";/);
    assert.ok(m, "events.rs 里找不到 EVENT_SESSIONS_CHANGED");
    assert.equal(
      m[1],
      ACCOUNT_EVENTS.sessionsChanged,
      `Rust 发的是 ${m[1]}，前端听的是 ${ACCOUNT_EVENTS.sessionsChanged}`,
    );
  });

  it("前端订阅走 ACCOUNT_EVENTS 常量，不写字面量——写死的那个在下次改名时就是第二份真相", () => {
    const app = read("src/App.tsx");
    assert.ok(
      app.includes("ACCOUNT_EVENTS.sessionsChanged"),
      "App.tsx 没有用 ACCOUNT_EVENTS.sessionsChanged 订阅",
    );
    assert.ok(
      !app.includes(`"${ACCOUNT_EVENTS.sessionsChanged}"`),
      "App.tsx 里出现了事件名的字面量，应当只用常量",
    );
  });

  it("收到事件就整拉列表，而不是把那一条插进去——增量合并会把乱序引回来", () => {
    const app = read("src/App.tsx");
    const i = app.indexOf("ACCOUNT_EVENTS.sessionsChanged");
    assert.ok(i > 0);
    // 订阅回调紧随其后，取一小段看它调的是整拉（reset = true）。
    const near = app.slice(i, i + 400);
    assert.ok(
      /loadSessionsRef\.current\?\.\(true\)/.test(near),
      `订阅回调里没有整拉会话列表：${near.slice(0, 200)}`,
    );
  });

  it("换人（上车声明）之后要重起这条流——它订阅的键是人，而车机正是会换人的那个端", () => {
    const app = read("src/App.tsx");
    const starts = app.match(/invoke\("start_user_events_stream"\)/g) ?? [];
    assert.ok(
      starts.length >= 2,
      `只在 ${starts.length} 处起了账号事件流：引导一次、上车声明落地后一次，缺一不可`,
    );
  });

  it("账号流有自己的停止位，不跟会话流共用——共用的话每次新建会话都会顺手把它掐掉", () => {
    const events = read("src-tauri/src/events.rs");
    assert.ok(events.includes("user_stop"), "StreamState 没有独立的 user_stop");
    assert.ok(
      events.includes("pub fn replace_user_stream"),
      "没有 replace_user_stream——换人时旧流不会被置停",
    );
  });
});
