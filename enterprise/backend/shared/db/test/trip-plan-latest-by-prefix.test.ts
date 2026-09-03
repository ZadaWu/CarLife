/**
 * `latestBySessionPrefixes` 的归位规则（后台会话列表带行程摘要用）。
 *
 * 行程行的 session_id 带 `#turn` 后缀，列表上的会话 id 不带——所以是前缀匹配；
 * 而前缀匹配有一个坑：`sess-1` 与 `sess-12` 同页时，后者的行程会同时匹配两个前缀。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assignLatestByPrefix } from "../src/repositories/trip-plan";

const row = (id: string, sessionId: string) => ({ id, sessionId });

describe("assignLatestByPrefix", () => {
  it("每个前缀只留最新一份（输入已按 committedAt 降序）", () => {
    const out = assignLatestByPrefix(
      [row("new", "sess-a#2"), row("old", "sess-a#1"), row("b", "sess-b#9")],
      ["sess-a", "sess-b"],
    );
    assert.equal(out.get("sess-a")?.id, "new");
    assert.equal(out.get("sess-b")?.id, "b");
  });

  it("按最长匹配前缀归位：`sess-12` 的行程不算给 `sess-1`", () => {
    const out = assignLatestByPrefix([row("x", "sess-12#1")], ["sess-1", "sess-12"]);
    assert.equal(out.get("sess-12")?.id, "x");
    assert.equal(out.get("sess-1"), undefined);
  });

  it("没有行程的会话不在 Map 里——调用方按「没有」处理，不是空对象", () => {
    const out = assignLatestByPrefix([], ["sess-z"]);
    assert.equal(out.size, 0);
  });
});
