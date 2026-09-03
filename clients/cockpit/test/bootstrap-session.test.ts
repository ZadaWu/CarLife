/**
 * [F-07-05][AC-7-3] 启动时那个会话怎么处置（施工单 M50-02）。
 *
 * 这里最重要的一条断言是**否定式**的：无论输入是什么，结果里都不会出现"新建"。
 * 开机即建正是 M50-01 之外剩下那 18 个空会话的成因——启动后没说话、
 * 或者又重启一次，那个会话就永远零消息地挂在库里（服务端是懒关闭，
 * 没人再访问它就永远不落 `closed_at`）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planBootstrap, type BootstrapPlan } from "../src/data/bootstrapSession";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

describe("引导时的会话处置", () => {
  it("上次会话还新鲜 → 接着用", () => {
    const plan = planBootstrap({
      stored: "sess-a",
      history: [{ ts: NOW - MIN }],
      now: NOW,
    });
    assert.deepEqual(plan, { kind: "resume", sessionId: "sess-a" });
  });

  it("**没存过 → 手上没有会话，不建**", () => {
    const plan = planBootstrap({ stored: null, history: null, now: NOW });
    assert.deepEqual(plan, { kind: "none", reason: "no-stored" });
  });

  it("**存了但回源失败（会话不存在 / 网关不在）→ 不建**", () => {
    const plan = planBootstrap({ stored: "sess-a", history: null, now: NOW });
    assert.deepEqual(plan, { kind: "none", reason: "unreachable" });
  });

  it("**存了但太旧 → 不建**（复用判定仍是 M22-03 那一条）", () => {
    const plan = planBootstrap({
      stored: "sess-a",
      history: [{ ts: NOW - 31 * MIN }],
      now: NOW,
    });
    assert.deepEqual(plan, { kind: "none", reason: "stale" });
  });

  it("空历史但刚建出来 → 接着用（同一次启动里的边界）", () => {
    const plan = planBootstrap({
      stored: "sess-a",
      history: [],
      createdAt: NOW - MIN,
      now: NOW,
    });
    assert.equal(plan.kind, "resume");
  });

  it("空历史且创建太久 → 不建", () => {
    const plan = planBootstrap({
      stored: "sess-a",
      history: [],
      createdAt: NOW - 31 * MIN,
      now: NOW,
    });
    assert.deepEqual(plan, { kind: "none", reason: "stale" });
  });

  it("**穷举所有输入组合：没有一种会给出「新建」**——这条是本单的判据本身", () => {
    const kinds = new Set<BootstrapPlan["kind"]>();
    for (const stored of [null, "sess-a"]) {
      for (const history of [null, [], [{ ts: NOW - MIN }], [{ ts: NOW - 99 * MIN }]]) {
        for (const createdAt of [undefined, NOW - MIN, NOW - 99 * MIN]) {
          kinds.add(planBootstrap({ stored, history, createdAt, now: NOW }).kind);
        }
      }
    }
    assert.deepEqual([...kinds].sort(), ["none", "resume"]);
  });
});
