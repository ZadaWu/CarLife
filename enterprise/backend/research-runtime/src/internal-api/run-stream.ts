/**
 * 运行流 `GET /internal/research/runs/:id/stream`（施工单 M85-03）。
 *
 * # 进度文案不是新写的，是图本来就在产的那句话
 *
 * 研究图每个节点都往 `notes[]` 里推一句人话（`1482 轮 / 36 主题`、`21 张洞察卡`）。
 * 再写一套"第 3 步，共 6 步"的进度文案，就会出现两份对同一次运行的描述，
 * 而它们分叉时不报错。所以这条流只做一件事：把 `notes[]` 新增的那几条发出去。
 *
 * # 为什么是轮询而不是订阅
 *
 * 图的状态活在 PG 的检查点表里，LangGraph 没有给"状态变了叫我一声"的钩子。
 * 起一个进程内的事件总线也不行——`GET runs/:id` 已经是从检查点读的，
 * 两个信息源迟早对不上（重启之后总线是空的，而检查点还在）。
 * 所以这里按同一个 `runState` 轮询，**一个信息源**。
 *
 * # 连上就先补一次当前状态
 *
 * 晚连上的客户端不该看到一片空白。第一帧是完整状态，之后才是增量。
 */

import type { ServerResponse } from "node:http";

/** 与 `trace-stream.ts`、端上下行同一个值。三处不同的话最短的那个说了算，而那不明显。 */
const HEARTBEAT_MS = 15_000;

/** 轮询间隔。图的一个节点动辄几十秒，1 秒够细了；再密只是空转查库。 */
export const POLL_MS = 1_000;

export interface RunState {
  stage: string;
  notes: string[];
  pending: unknown[];
  /**
   * 这次运行**自己报的**失败（施工单 M85-06）。
   *
   * 在它之前，这条流只有两种失败途径：查状态抛错、状态整个没了。
   * 图的一次运行确实只有这两种——节点抛错时整张图抛，`getState` 跟着抛。
   * 但能力运行是本进程里跑的一段异步，它失败时状态**还在**，
   * 只是里面记着一句原因。没有这个字段的话，那种失败会一路走到
   * `stage === "done"` 发出一帧 `done`——**一次失败的运行在界面上显示成成功**。
   */
  error?: string;
  /** 终态产出。`done` 帧原样带出去，界面拿它渲染结果。 */
  result?: unknown;
}

/** 一次运行烧了多少 token。取不到就是 `null`——**不写 0**，那会被读成"没花钱"。 */
export interface RunUsage {
  totalTokens: number;
  models: string[];
}

export interface RunStreamDeps {
  runState(runId: string): Promise<RunState | null>;
  /**
   * 这次运行的用量（G7：界面要看得见花了多少）。
   *
   * ⚠️ 口径有个已知的窟窿写在这里而不是藏着：`llm_usage` 没有 run 这一列，
   * 只能按"这次运行开始之后、`sessionId = research` 的那些行"求和。
   * 同一时刻并发两次 run 的话，两条流会各自报出两次运行的合计。
   * POC 下一次只跑一个窗（`thread_id` 由合同 + 窗口定），所以先这么记；
   * 真要分得开，得给 `llm_usage` 加一列，而那是另一张单的事。
   */
  runUsage?(runId: string): Promise<RunUsage | null>;
  /** 轮询间隔。只有测试会传——生产用 `POLL_MS`，不给它开配置项。 */
  pollMs?: number;
}

/** 走到这几档就没有下一步了：流该关，不该继续轮询。 */
const isTerminalStage = (stage: string): boolean => stage === "done";

/** 这一帧是不是终态：跑完了 / 停在人工确认上 / 自己报了失败，三者都该收摊。 */
const isSettled = (st: RunState): boolean =>
  isTerminalStage(st.stage) || st.pending.length > 0 || st.error !== undefined;

type EventName = "state" | "progress" | "stage" | "done" | "failed";

interface Frame {
  event: EventName;
  data: Record<string, unknown>;
}

/**
 * 事件类型**同时写在 `event:` 行和载荷里**，这不是冗余。
 *
 * 控制台共用的 `openEventStream`（`console/src/api/stream.ts`）只挑 `data:` 那一行，
 * `event:` 行它看都不看。要让前端分得出 `progress` 与 `done`，只有两条路：
 * 改那一层的解析（所有页面都受影响），或者让载荷自己带。选后者。
 * `event:` 行仍然写，因为 curl 与浏览器 DevTools 都按它显示。
 */
const writeFrame = (res: ServerResponse, f: Frame): void => {
  res.write(`event: ${f.event}\ndata: ${JSON.stringify({ event: f.event, ...f.data })}\n\n`);
};

/**
 * 开一条运行流。返回一个 promise，连接关闭时 resolve。
 *
 * 运行不存在时**不开流**，回 404 JSON——与 `GET runs/:id` 的 `run_not_found` 同一个码。
 * 开一条永远安静的流会让"这个 run 不存在"和"这个 run 还没动静"长得一模一样。
 */
export async function handleRunStream(
  res: ServerResponse,
  runId: string,
  deps: RunStreamDeps,
  onClose: (fn: () => void) => void,
): Promise<void> {
  const first = await deps.runState(runId);
  if (!first) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "run_not_found" }));
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");

  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
  };
  onClose(close);

  const pollMs = deps.pollMs ?? POLL_MS;
  const usageOf = async (): Promise<RunUsage | null> => (deps.runUsage ? deps.runUsage(runId).catch(() => null) : null);

  // 第一帧：完整状态。晚连上的客户端从这里就能把面板画全。
  writeFrame(res, { event: "state", data: { runId, ...first, usage: await usageOf() } });
  let sentNotes = first.notes.length;
  let stage = first.stage;

  /**
   * 收尾：**先看有没有 `error`，再看阶段**。
   *
   * 反过来的话，一次失败的运行（它同样走到终态阶段）会发出一帧 `done`——
   * 界面上是一次成功的运行，而失败原因就躺在同一个对象里没人读。
   */
  const settle = async (st: RunState): Promise<void> => {
    if (st.error !== undefined) {
      writeFrame(res, { event: "failed", data: { runId, stage: st.stage, error: st.error, usage: await usageOf() } });
    } else {
      writeFrame(res, {
        event: "done",
        data: { runId, stage: st.stage, pending: st.pending, result: st.result, usage: await usageOf() },
      });
    }
    close();
    res.end();
  };

  if (isSettled(first)) {
    await settle(first);
    return;
  }

  heartbeat = setInterval(() => res.write(": hb\n\n"), HEARTBEAT_MS);

  await new Promise<void>((resolve) => {
    const tick = async (): Promise<void> => {
      if (closed) {
        resolve();
        return;
      }
      let st: RunState | null;
      try {
        st = await deps.runState(runId);
      } catch (err) {
        // 查库失败就如实说一句再收摊——安静地断掉会被读成"跑完了"。
        writeFrame(res, { event: "failed", data: { runId, error: err instanceof Error ? err.message : String(err) } });
        close();
        res.end();
        resolve();
        return;
      }
      if (!st) {
        // 跑着跑着状态没了（检查点被清）：这是失败，不是完成。
        writeFrame(res, { event: "failed", data: { runId, error: "run_state_vanished" } });
        close();
        res.end();
        resolve();
        return;
      }

      for (const note of st.notes.slice(sentNotes)) {
        writeFrame(res, { event: "progress", data: { runId, stage: st.stage, note } });
      }
      sentNotes = st.notes.length;
      if (st.stage !== stage) {
        stage = st.stage;
        writeFrame(res, { event: "stage", data: { runId, stage, usage: await usageOf() } });
      }

      if (isSettled(st)) {
        await settle(st);
        resolve();
        return;
      }
      setTimeout(() => void tick(), pollMs);
    };
    setTimeout(() => void tick(), pollMs);
  });
}
