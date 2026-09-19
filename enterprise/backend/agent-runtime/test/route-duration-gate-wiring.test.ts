/**
 * 段和核对这道闸**在真链路上是通的**，不是一道只在单测里成立的规则。
 *
 * 纯函数那一层由 `shared/tools/test/route-duration-ledger.test.ts` 钉死。这里钉的是它够不着的那截：
 * `map_route` 真的把实算时长记进了登记簿、`submit_drive_plan` 真的读得到、读到之后真的退回。
 * 这三段里任何一段没接上，外部表现都一样——**什么都不发生**，而那正是这类闸最容易失效的方式
 * （[[ledger-completion-criterion]]：单测全绿掩盖"根本没有数据源"）。
 *
 * 所以这组用例走**真工具**（`CARLIFE_TOOLS=mock` 的 map_route）、真登记簿、真提交工具，
 * 只把装配层那两行注入照抄过来；照抄的部分另有一条源码扫描用例守着，防止 `index.ts` 改了这里还绿。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  getTool,
  setBranchSubmissionSink,
  setRouteDurationLookup,
  setRouteDurationRecorder,
  ToolError,
  type ToolCallContext,
} from "@carlife/tools";

import { recordSubmission, sweepTurn } from "../src/branch-submissions";
import { peekRouteDurations, recordRouteDuration, resetRouteDurations } from "../src/route-durations";

/*
 * 两个 ctx 只差 `mode`，会话与轮次是同一个——这正是真链路的形态：
 * `map_route` 有 mock（不打高德），`submit_drive_plan` 没有 mock（它本来就只在本地跑）。
 */
const routeCtx: ToolCallContext = { sessionId: "s-gate", turnId: "t-gate", agent: "drive", mode: "mock" };
const ctx: ToolCallContext = { ...routeCtx, mode: "real" };

/** 与 `src/index.ts` 的装配逐字同形——差异由下面那条源码扫描用例守。 */
function wire(): void {
  setRouteDurationRecorder({ record: (c, route) => recordRouteDuration(c, route) });
  setRouteDurationLookup(({ sessionId, turnId }) => (turnId ? peekRouteDurations(sessionId, turnId) : undefined));
  // 提交暂存区：放行那几条要走到落槽才算真的通过，不能停在闸门上。
  setBranchSubmissionSink({ record: (c, tool, payload) => recordSubmission(c, tool, payload) });
}

const leg = (from: string, to: string, minutes: number, kind = "rest") => ({
  day: 1,
  direction: "outbound" as const,
  from,
  to: { kind, name: to },
  minutes,
});

beforeEach(() => {
  resetRouteDurations();
  wire();
});

afterEach(() => {
  setRouteDurationRecorder(undefined);
  setRouteDurationLookup(undefined);
  setBranchSubmissionSink(undefined);
  sweepTurn("s-gate", "t-gate");
  sweepTurn("s-gate", "t-gate-2");
  resetRouteDurations();
});

describe("段和核对这道闸在真链路上是通的", () => {
  it("map_route 跑一次，实算时长就进了登记簿——这一环断了下面两条会假绿", async () => {
    await getTool("map_route")!.tool.call({ origin: { name: "上海" }, destination: { name: "包河区" } }, routeCtx);
    assert.deepEqual(peekRouteDurations("s-gate", "t-gate"), [
      { from: "上海", to: "包河区", durationMin: 150 },
    ]);
  });

  it("**把路拆短了就退回**：提交工具读得到登记簿，且退回文案带着两个数", async () => {
    await getTool("map_route")!.tool.call({ origin: { name: "上海" }, destination: { name: "包河区" } }, routeCtx);
    await assert.rejects(
      () =>
        getTool("submit_drive_plan")!.tool.call(
          { origin: "上海", legs: [leg("上海", "阳澄湖服务区", 40), leg("阳澄湖服务区", "包河区", 38, "overnight")] },
          ctx,
        ),
      (e: unknown) =>
        e instanceof ToolError &&
        /78 分/.test(e.message) &&
        /150 分/.test(e.message) &&
        /少了 72 分/.test(e.message),
    );
  });

  it("按实算拆开就放行——闸不能把对的也拦住", async () => {
    await getTool("map_route")!.tool.call({ origin: { name: "上海" }, destination: { name: "包河区" } }, routeCtx);
    const r = await getTool("submit_drive_plan")!.tool.call(
      { origin: "上海", legs: [leg("上海", "阳澄湖服务区", 75), leg("阳澄湖服务区", "包河区", 75, "overnight")] },
      ctx,
    );
    assert.equal(r.data.accepted, 2);
  });

  it("没算过路就不核对（离线 / 单测档）——这一档是「不核对」，不是「全部放行」的许可", async () => {
    const r = await getTool("submit_drive_plan")!.tool.call(
      { origin: "上海", legs: [leg("上海", "包河区", 5, "overnight")] },
      ctx,
    );
    assert.equal(r.data.accepted, 1);
  });

  it("上一轮算的路不算数：登记簿按轮隔离，跨轮读不到", async () => {
    await getTool("map_route")!.tool.call({ origin: { name: "上海" }, destination: { name: "包河区" } }, routeCtx);
    const next: ToolCallContext = { ...ctx, turnId: "t-gate-2" };
    const r = await getTool("submit_drive_plan")!.tool.call(
      { origin: "上海", legs: [leg("上海", "包河区", 5, "overnight")] },
      next,
    );
    assert.equal(r.data.accepted, 1);
  });
});

describe("装配层确实接了这两根线", () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/index.ts"),
    "utf8",
  );

  it("`index.ts` 里 recorder 与 lookup 都注入了——上面那组照抄的注入不能替它作证", () => {
    assert.match(src, /setRouteDurationRecorder\(\{/);
    assert.match(src, /setRouteDurationLookup\(\(/);
  });

  it("轮结束要清登记簿，否则同一会话的下一轮会拿上一轮的时长去比", () => {
    const runner = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/turn-runner.ts"),
      "utf8",
    );
    assert.match(runner, /sweepRouteDurations\(input\.sessionId, input\.turnId\)/);
  });
});
