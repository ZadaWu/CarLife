/**
 * [F-07-05][AC-7-3] 启动时那个会话怎么处置（施工单 M50-02，手机端）。
 *
 * 与车机同一条否定式判据：**无论输入是什么，结果里都不会出现"新建"**。
 * 手机端的复用规则比车机松一档（没有"太旧就不复用"）——那是刻意的，
 * 手机是个人设备，回源得到就接着用；车机是共用设备，上一段可能是别人的。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planBootstrap, type BootstrapPlan } from "../src/data/bootstrapSession";

describe("引导时的会话处置（手机端）", () => {
  it("存过且回源成功 → 接着用", () => {
    assert.deepEqual(planBootstrap({ stored: "sess-a", history: [] }), {
      kind: "resume",
      sessionId: "sess-a",
    });
  });

  it("**没存过 → 手上没有会话，不建**", () => {
    assert.deepEqual(planBootstrap({ stored: null, history: null }), {
      kind: "none",
      reason: "no-stored",
    });
  });

  it("**存了但回源失败 → 不建**", () => {
    assert.deepEqual(planBootstrap({ stored: "sess-a", history: null }), {
      kind: "none",
      reason: "unreachable",
    });
  });

  it("**穷举所有输入组合：没有一种会给出「新建」**", () => {
    const kinds = new Set<BootstrapPlan["kind"]>();
    for (const stored of [null, "sess-a"]) {
      for (const history of [null, [], [{ ts: 1 }]]) {
        kinds.add(planBootstrap({ stored, history }).kind);
      }
    }
    assert.deepEqual([...kinds].sort(), ["none", "resume"]);
  });
});
