/**
 * [F-01-08][AC-01-3] 两端桥接适配器逐字相同（施工单 M65-02 任务 2）。
 *
 * 两份 `bridge/index.ts` 文件头都承诺"与对方逐字相同"，而 M65 走查发现手机端少了
 * permission / title / branch 三条订阅——承诺没有守卫就只是一句话。本文件把它变成机器判据：
 * 去掉文件头注释块之后，两份必须相等；并且订阅集合 = `BRIDGE_EVENTS` 里除 filler 之外的全部键
 * （filler 是等待期垫场话，只在车机 Rust 侧播、不进 WebView，两端一致地不订）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { BRIDGE_EVENTS } from "@carlife/shared";

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");
const stripHeader = (t: string): string => t.replace(/^\/\*\*[\s\S]*?\*\/\n/, "");

const MOBILE = read("../src/bridge/index.ts");
const COCKPIT = read("../../cockpit/src/bridge/index.ts");

describe("[F-01-08] bridge/index.ts 两端逐字相同", () => {
  it("去掉文件头注释后两份文本相等", () => {
    assert.equal(stripHeader(MOBILE), stripHeader(COCKPIT));
  });

  it("订阅集合覆盖 BRIDGE_EVENTS 全部键（filler 除外）", () => {
    const subscribed = [...MOBILE.matchAll(/BRIDGE_EVENTS\.(\w+)/g)].map((m) => m[1]).sort();
    const expected = Object.keys(BRIDGE_EVENTS).filter((k) => k !== "dialogFiller").sort();
    assert.deepEqual(subscribed, expected);
  });
});
