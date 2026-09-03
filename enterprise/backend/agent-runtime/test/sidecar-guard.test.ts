/**
 * 垫场话过输出管线与丢弃语义（施工单 M18-04，F-45-10）。
 *
 * 「不留痕」的另外三条（历史 / ①图状态 / 补发窗口）分别在
 * `sidecar.test.ts`（结构）与 `enterprise/backend/gateway/test/session-bus.test.ts`（窗口）里。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { emitFiller, type FillerOutputGuard } from "../src/sidecar/speak";
import {
  countFillerDrop,
  resetSidecarCounters,
  sidecarCounters,
} from "../src/sidecar/pair-session";
import type { FillerDraft } from "../src/sidecar/templates";

const DRAFT: FillerDraft = { text: "我在翻你这车的手册", phase: "retrieval" };

/** 等一轮微任务，让 fire-and-forget 的管线跑完。 */
const settle = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => resetSidecarCounters());

describe("过输出管线（F-45-10 / AC-45-9）", () => {
  it("整句送审，通过则用管线返回的文本下发", async () => {
    const seen: string[] = [];
    const pushed: string[] = [];
    const guard: FillerOutputGuard = {
      async checkOutput(text) {
        seen.push(text);
        return { allowed: true, text: `${text}（脱敏后）` };
      },
    };

    emitFiller({ guard, push: (t) => pushed.push(t), onDropped: countFillerDrop }, DRAFT);
    await settle();

    assert.deepEqual(seen, [DRAFT.text], "送审的是整句，不是切片");
    assert.deepEqual(pushed, ["我在翻你这车的手册（脱敏后）"], "下发的必须是管线返回的文本");
  });

  it("入口同步返回，不等管线", () => {
    let resolved = false;
    const guard: FillerOutputGuard = {
      checkOutput: () =>
        new Promise((r) => setTimeout(() => { resolved = true; r({ allowed: true, text: "x" }); }, 50)),
    };
    const started = Date.now();
    const ret = emitFiller({ guard, push: () => {} }, DRAFT);
    assert.equal(ret, undefined);
    assert.ok(Date.now() - started < 20, "扇出入口一旦 await，就从扇出变成了串联");
    assert.equal(resolved, false);
  });
});

describe("丢弃语义（M18-04 约束 3）", () => {
  it("审核不通过 ⇒ 零下发、计数 +1，且**不发 retract**", async () => {
    const pushed: string[] = [];
    const guard: FillerOutputGuard = {
      async checkOutput() {
        return { allowed: false, text: "", reason: "blocked" };
      },
    };
    emitFiller({ guard, push: (t) => pushed.push(t), onDropped: countFillerDrop }, DRAFT);
    await settle();

    assert.deepEqual(pushed, []);
    assert.equal(sidecarCounters().dropped.guard_denied, 1);
    // 语义断言：emitFiller 的出口只有 push（下发），没有任何撤回通道。
    // 垫场话还没发出去，发一句"这条我收回了"比不说更莫名其妙。
    assert.equal(
      /retract/i.test(emitFiller.toString()),
      false,
      "旁路不该有撤回路径——用户根本不知道有过这句话",
    );
  });

  it("管线未装配 ⇒ 丢弃（与主链路 output fail-closed 同向）", async () => {
    const pushed: string[] = [];
    emitFiller({ guard: undefined, push: (t) => pushed.push(t), onDropped: countFillerDrop }, DRAFT);
    await settle();
    assert.deepEqual(pushed, []);
    assert.equal(sidecarCounters().dropped.no_guard, 1);
  });

  it("管线抛错 ⇒ 丢弃且不外抛", async () => {
    const pushed: string[] = [];
    const guard: FillerOutputGuard = {
      async checkOutput() {
        throw new Error("阿里云超时");
      },
    };
    assert.doesNotThrow(() =>
      emitFiller({ guard, push: (t) => pushed.push(t), onDropped: countFillerDrop }, DRAFT),
    );
    await settle();
    assert.deepEqual(pushed, []);
    assert.equal(sidecarCounters().dropped.guard_error, 1);
  });

  it("三类丢弃分开计数——「没说」与「说了但没过」是两件事", async () => {
    const c = sidecarCounters();
    assert.deepEqual(Object.keys(c.dropped).sort(), ["guard_denied", "guard_error", "no_guard"]);
    assert.deepEqual(Object.keys(c.suppressed).sort(), ["closed", "gap", "muted", "silence"]);
  });
});

describe("能力边界的结构性保证（F-45-09 / AC-45-10）", () => {
  it("sidecar 目录不 import 任何业务能力包", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = new URL("../src/sidecar/", import.meta.url);
    const FORBIDDEN = /from\s+["'](@carlife\/(tools|rag|memory|db|guardrails)|\.\.\/(llm|graph))/;
    for (const f of readdirSync(dir)) {
      const src = readFileSync(new URL(f, dir), "utf8");
      assert.ok(!FORBIDDEN.test(src), `${f} 引了业务能力——L0 没有工具表，边界只能靠依赖守`);
    }
  });

  it("对外唯一的副作用导出是 emitFiller，其余是纯函数或计数读取", async () => {
    const speak = await import("../src/sidecar/speak");
    const templates = await import("../src/sidecar/templates");
    const silence = await import("../src/sidecar/silence");
    assert.deepEqual(Object.keys(speak).sort(), ["emitFiller"]);
    assert.deepEqual(Object.keys(templates).sort(), [
      "phaseOf",
      "progressBridge",
      "progressPrefix",
      "progressTables",
      "renderFiller",
      "templateTables",
    ]);
    assert.deepEqual(Object.keys(silence).sort(), ["shouldSpeak", "suppressReason"]);
  });
});
