/**
 * 运行流 SSE（施工单 M85-03）。
 *
 * 这条流的价值全在"晚连上也看得见"和"结束了要说一声"两件事上，
 * 所以下面的断言都围着这两条转：第一帧必须是完整状态，终态必须有 `done`。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { loadLatestCodebook } from "../src/codebook/load";
import { createInternalApi } from "../src/internal-api";
import type { RunState } from "../src/internal-api/run-stream";

const book = loadLatestCodebook(join(new URL("..", import.meta.url).pathname.replace(/\/$/, ""), "codebooks"));

/**
 * 一次假运行：每被查一次就往前走一步。
 *
 * 用"查一次走一步"而不是定时器，是为了让断言不依赖真实时间——
 * 依赖时间的流测试在 CI 上是一台偶发红制造机。
 */
function scriptedRun(steps: RunState[]): { runState: (id: string) => Promise<RunState | null>; calls: () => number } {
  let i = 0;
  return {
    runState: async (id) => {
      if (id !== "run-1") return null;
      const st = steps[Math.min(i, steps.length - 1)];
      i += 1;
      return st;
    },
    calls: () => i,
  };
}

const STEPS: RunState[] = [
  { stage: "frame", notes: ["合同 c1，窗口 …"], pending: [] },
  { stage: "analyze", notes: ["合同 c1，窗口 …", "1482 轮 / 36 主题"], pending: [] },
  { stage: "synthesize", notes: ["合同 c1，窗口 …", "1482 轮 / 36 主题", "21 张洞察卡"], pending: [] },
  {
    stage: "gate",
    notes: ["合同 c1，窗口 …", "1482 轮 / 36 主题", "21 张洞察卡", "四道门：evidence 降级", "codebook 未锁"],
    pending: [{ kind: "codebook-lock" }],
  },
];

const script = scriptedRun(STEPS);

const api = createInternalApi({
  repo: {} as never,
  book,
  startedAt: Date.now(),
  queues: () => ({}),
  codebookLocked: () => false,
  runState: script.runState,
  runStreamPollMs: 5,
  runUsage: async () => ({ totalTokens: 12_345, models: ["deepseek-chat"] }),
});

let base = "";

before(async () => {
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

after(() => api.close());

interface Frame {
  event: string;
  [k: string]: unknown;
}

/** 读完整条流（它会自己结束）并按帧解析。 */
async function readStream(path: string): Promise<{ status: number; frames: Frame[]; contentType: string | null }> {
  const res = await fetch(`${base}${path}`, { headers: { accept: "text/event-stream" } });
  const contentType = res.headers.get("content-type");
  if (!res.ok) return { status: res.status, frames: [], contentType };
  const text = await res.text();
  const frames = text
    .split("\n\n")
    .map((f) => f.split("\n").find((l) => l.startsWith("data:")))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(5).trim()) as Frame);
  return { status: res.status, frames, contentType };
}

describe("[M85-03] 运行流", () => {
  it("不存在的 run 回 404 JSON，而不是开一条永远安静的流", async () => {
    const { status, frames, contentType } = await readStream("/internal/research/runs/nope/stream");
    assert.equal(status, 404);
    assert.equal(frames.length, 0);
    assert.match(String(contentType), /application\/json/);
  });

  it("连上立刻收到一次完整状态，之后按 notes 增量推进，终态发 done", async () => {
    const { status, contentType, frames } = await readStream("/internal/research/runs/run-1/stream");
    assert.equal(status, 200);
    assert.match(String(contentType), /text\/event-stream/);

    // 第一帧是完整状态——晚连上的客户端从这里就能把面板画全。
    assert.equal(frames[0].event, "state");
    assert.deepEqual(frames[0].notes, STEPS[0].notes);
    assert.equal(frames[0].stage, "frame");

    // 增量：每条新 note 一条 progress，顺序与 notes 一致，且不重发第一条。
    const progress = frames.filter((f) => f.event === "progress").map((f) => f.note);
    assert.deepEqual(progress, [
      "1482 轮 / 36 主题",
      "21 张洞察卡",
      "四道门：evidence 降级",
      "codebook 未锁",
    ]);

    // 阶段变一次发一条 stage。
    assert.deepEqual(
      frames.filter((f) => f.event === "stage").map((f) => f.stage),
      ["analyze", "synthesize", "gate"],
    );

    // 有挂起项就是终点：图停在 review 等人，流该收了。
    const done = frames.at(-1)!;
    assert.equal(done.event, "done");
    assert.equal(done.stage, "gate");
    assert.deepEqual(done.pending, [{ kind: "codebook-lock" }]);
  });

  it("载荷自己带 event 字段——共用的 openEventStream 只看 data: 那一行", async () => {
    const { frames } = await readStream("/internal/research/runs/run-1/stream");
    for (const f of frames) assert.ok(typeof f.event === "string" && f.event.length > 0);
  });

  it("用量跟着状态帧一起出（G7）", async () => {
    const { frames } = await readStream("/internal/research/runs/run-1/stream");
    const usage = frames[0].usage as { totalTokens: number; models: string[] };
    assert.equal(usage.totalTokens, 12_345);
    assert.deepEqual(usage.models, ["deepseek-chat"]);
  });

  it("已经跑完的 run 连上就一帧状态一帧 done，不空等", async () => {
    const finished = createInternalApi({
      repo: {} as never,
      book,
      startedAt: Date.now(),
      queues: () => ({}),
      codebookLocked: () => false,
      runState: async () => ({ stage: "done", notes: ["走完"], pending: [] }),
    });
    await new Promise<void>((r) => finished.listen(0, "127.0.0.1", r));
    const port = (finished.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/internal/research/runs/x/stream`);
    const text = await res.text();
    finished.close();
    assert.match(text, /event: state/);
    assert.match(text, /event: done/);
    assert.ok(!text.includes("event: progress"));
  });

  it("没有图（缺 DATABASE_URL）时回 503，不是 404", async () => {
    const bare = createInternalApi({
      repo: {} as never,
      book,
      startedAt: Date.now(),
      queues: () => ({}),
      codebookLocked: () => false,
    });
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
    const port = (bare.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/internal/research/runs/x/stream`);
    const body = (await res.json()) as { error: string };
    bare.close();
    assert.equal(res.status, 503);
    assert.equal(body.error, "runs_not_available");
  });

  it("跑着跑着状态没了 → failed，不是 done", async () => {
    let n = 0;
    const vanishing = createInternalApi({
      repo: {} as never,
      book,
      startedAt: Date.now(),
      queues: () => ({}),
      codebookLocked: () => false,
      runStreamPollMs: 5,
      runState: async () => (n++ === 0 ? { stage: "analyze", notes: [], pending: [] } : null),
    });
    await new Promise<void>((r) => vanishing.listen(0, "127.0.0.1", r));
    const port = (vanishing.address() as AddressInfo).port;
    const text = await (await fetch(`http://127.0.0.1:${port}/internal/research/runs/x/stream`)).text();
    vanishing.close();
    assert.match(text, /event: failed/);
    assert.match(text, /run_state_vanished/);
    assert.ok(!text.includes("event: done"));
  });
});

/*
 * 能力运行（M85-06）与图的运行不一样：它失败时**状态还在**，只是里面记着一句原因。
 * 图那边只有两种失败途径（查状态抛错、状态整个没了），所以这条分支在 M85-03 时
 * 还不存在——没有它的话，一次失败的运行会一路走到 `stage === "done"` 发出一帧 `done`，
 * 界面上显示成一次成功。
 */
describe("[M85-06] 运行自己报的失败", () => {
  const serveState = async (st: RunState): Promise<string> => {
    const api2 = createInternalApi({
      repo: {} as never,
      book,
      startedAt: Date.now(),
      queues: () => ({}),
      codebookLocked: () => false,
      runStreamPollMs: 5,
      runState: async () => st,
    });
    await new Promise<void>((r) => api2.listen(0, "127.0.0.1", r));
    const port = (api2.address() as AddressInfo).port;
    const text = await (await fetch(`http://127.0.0.1:${port}/internal/research/runs/x/stream`)).text();
    api2.close();
    return text;
  };

  it("**带 error 的终态发 failed，不发 done**", async () => {
    const text = await serveState({
      stage: "done",
      notes: ["装配：查需求码下的主题"],
      pending: [],
      error: "4 个主题一张卡都没出成：冬天续航掉多少、天冷停一夜掉电",
    });
    assert.match(text, /event: failed/);
    assert.ok(!text.includes("event: done"), "一次失败的运行被发成了 done——界面上看不出出了什么事");
  });

  it("失败原因原样带出去，不换成一句通用文案", async () => {
    const text = await serveState({ stage: "done", notes: [], pending: [], error: "boundary 里没写「已授权车主」" });
    assert.match(text, /已授权车主/);
  });

  it("没有 error 的终态照旧发 done，并带上 result", async () => {
    const text = await serveState({ stage: "done", notes: [], pending: [], result: { insightIds: ["i-1"] } });
    assert.match(text, /event: done/);
    assert.match(text, /i-1/);
  });
});
