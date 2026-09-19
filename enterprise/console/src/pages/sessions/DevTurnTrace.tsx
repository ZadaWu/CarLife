/**
 * 研发视图：单轮执行轨迹（施工单 TD-08）。
 *
 * 2026-09-15 从 `index.tsx` 原样搬出来——那个文件已过千行，且抽屉从此有两个视图
 * （研发 / 业务，见 `TraceDrawer.tsx`）。**内容一字未动**：分跳耗时、编排图位置、
 * 执行流程、时间轴、提示词、逐条事件，与轨迹回放页共用同一批纯函数与组件。
 * 提示词提权从这里抽成了 `usePromptReveal`，两个视图共用同一道门。
 */

import { HopTable } from "../trace/HopTable";
import { TurnFlowChart } from "../trace/TurnFlow";
import { buildFlow, hopBreakdown, layout, type TraceEvent } from "../trace/timeline";
import { RunFlow } from "../workflow/RunFlow";
import { projectRun } from "../workflow/projection";
import { FillerNote, fillersOfTurn } from "./FillerNote";
import { eventsOfTurn } from "./turns";
import { usePromptReveal, type PromptRow } from "./usePromptReveal";

/** 会话轨迹（`/console/replay/:id` 的返回，本页只用得到 timeline 与两个标记）。 */
export interface ReplayPayload {
  timeline: TraceEvent[];
  hasMore: boolean;
  redacted: boolean;
}

export type ReplayState = "idle" | "loading" | "error";

/**
 * 单轮执行轨迹的内容（施工单 TD-08，F-44-04）。
 * 呈现容器是 `TraceDrawer`，本组件只管内容。
 *
 * # 为什么放在会话详情页而不是只在回放页
 *
 * 排障的入口是**一条具体的对话**："这句为什么等了这么久"。
 * 回放页按会话看整条时间轴，回答不了"是哪一轮"——而一个会话十几轮时，
 * 把整条轴摊开反而更难定位。这里按轮切开，问题和证据挨在一起。
 *
 * # 耗时表与回放页共用同一个组件与同一个纯函数
 *
 * `HopTable` + `hopBreakdown` 两处复用。各写一份的话两边口径迟早分叉，
 * 而"同一轮在两个页面上耗时不一样"是那种没人会怀疑是 bug、只会怀疑数据的错。
 *
 * # 轮次外的事件必须说出来，不能静默丢掉
 *
 * `acp.connect`（连接建立在任何一轮之外）与轮次关闭后才落的裁决
 * （确认超时那一类）都没有 `turnId`。按轮过滤时它们全都不在——
 * 不吭声的话，读者会以为"这一轮就是这些"，而恰恰是那些漏掉的最慢。
 */
export function TurnTrace({
  sessionId,
  turnId,
  replay,
  state,
  error,
}: {
  sessionId: string;
  turnId: string;
  replay: ReplayPayload | null;
  state: ReplayState;
  error: string | null;
}): JSX.Element {
  if (state === "loading") return <p className="muted">载入轨迹…</p>;
  if (state === "error") return <p className="error">轨迹加载失败：{error}</p>;
  if (!replay) return <p className="muted">载入轨迹…</p>;

  const { events, orphan } = eventsOfTurn(replay.timeline, turnId);

  if (events.length === 0) {
    return (
      <div className="turn-trace">
        <p className="muted">
          这一轮没有留下轨迹。轨迹是从 M9-01 起才落库、分跳耗时是从 TD-08 起才采集的，
          更早的轮次查不到；
          {/*
           * 文案在 M18-07 改过：原来只说"更早的轮次查不到"，而当时 `bySession`
           * 取的是**最旧**的 limit 条——真正查不到的恰恰是最近的几轮，
           * 因果被说反了。取数方向已改成取最近，这里把截断的可能性一并说清楚。
           */}
          若本会话事件很多，超出取数上限的<strong>更早轮次</strong>也会是空的。
          两种情况都<strong>不是采集失败</strong>。
          {replay.hasMore ? "（本会话已超出取数上限，见页面顶部提示。）" : ""}
          {orphan > 0 ? `（另有 ${orphan} 条不属于任何轮次的事件，见轨迹回放页。）` : ""}
        </p>
      </div>
    );
  }

  const hops = hopBreakdown(events);
  const view = layout(events);
  const flow = buildFlow(events);
  const fillers = fillersOfTurn(events);
  const run = projectRun(events);

  return (
    <div className="turn-trace">
      {fillers.length > 0 ? <FillerNote fillers={fillers} /> : null}

      {/*
        编排图上的位置放在最前，执行流程紧随其后。**两者回答的不是同一个问题**：
        这张回答"走了哪条路、哪条没走"（它把没走的也画出来），
        下面那张回答"这条路上的时间花在哪"。
        先有位置再看数字——否则一串 `node.ownershipDual 4200ms` 只是个名字。
      */}
      <h3>在编排图上的位置</h3>
      <RunFlow run={run} />

      <h3>执行流程</h3>
      <TurnFlowChart flow={flow} />

      <HopTable hops={hops} scope="turn" />

      <h3>本轮时间轴</h3>
      <div className="trace-timeline">
        <div className="trace-axis">
          <span>0ms</span>
          <span>{view.durationMs}ms</span>
        </div>
        {view.lanes.map((lane) => (
          <div className="trace-lane" key={lane.label}>
            <div className="trace-lane-label">{lane.label}</div>
            <div className="trace-lane-track">
              {lane.bars.map((bar, i) => (
                <div
                  key={`${bar.label}-${bar.startedAt}-${i}`}
                  className={
                    bar.tone === "danger"
                      ? "trace-bar trace-bar--danger"
                      : bar.tone === "warn"
                        ? "trace-bar trace-bar--warn"
                        : "trace-bar"
                  }
                  style={{ left: `${bar.leftPct}%`, width: `${bar.widthPct}%` }}
                  title={`${bar.label}${bar.detail ? ` — ${bar.detail}` : ""}\n+${bar.startedAt - view.startedAt}ms`}
                >
                  <span className="trace-bar-text">{bar.label}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <TurnPrompts sessionId={sessionId} events={events} />

      <h3>本轮逐条事件</h3>
      {/* 与回放页同一取向：**不做任何过滤**（F-29-08）。失败必须可见，靠颜色不靠筛掉别的。 */}
      <table className="table">
        <thead>
          <tr>
            <th>+ms</th>
            <th>事件</th>
            <th>载荷</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e, i) => (
            <tr key={`${e.kind}-${e.at}-${i}`}>
              <td>{e.at - view.startedAt}</td>
              <td>{e.kind}</td>
              <td>
                {/*
                  **缩进 + 换行展示，不挤成一行**。单行 JSON 在这一列里要么被截断、
                  要么撑出横向滚动条，而载荷正是排障时最需要逐字看的东西
                  （`caveats` 为什么降级、`decision` 是哪一档、失败归到了哪一类）。
                */}
                <pre className="trace-payload trace-payload--wrap">
                  {JSON.stringify(e.data, null, 2)}
                </pre>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="muted tiny">
        {replay.redacted ? "轨迹含已脱敏内容（手机号/身份证/银行卡/邮箱）。" : ""}
        {replay.hasMore ? "事件较多，接口只返回了前一段，本轮可能不完整。" : ""}
        {orphan > 0
          ? `本会话另有 ${orphan} 条不属于任何轮次的事件（ACP 冷启动、以及轮次关闭后才落的裁决），它们不在上表里——去轨迹回放页看整条会话。`
          : ""}
      </p>
    </div>
  );
}

/**
 * 本轮每次 LLM 调用**实际发出去**的提示词（TD-08）。
 *
 * # 默认只给长度，看原文要提权
 *
 * 提示词 ≈ 整段对话原文（ACP 新会话要回灌全部历史）。而会话浏览页看原文
 * 是要提权 + 写审计的——轨迹页要是把它直接摊开，就成了绕过那道门的后门。
 * 所以 `/console/replay/:id` 默认把 `text` 整段挖掉，只留 `chars`；
 * 要看走 `/console/replay/:id/reveal`，**每次都写审计，审计写不进去就拒绝放行**。
 *
 * # 为什么值得看
 *
 * 实测那次"助手对着燃油车谈续航"，原因不在模型也不在车辆档案，
 * 而是编排层经 `describeMerged` 把「续航余量」注入到了最后一条用户消息里。
 * 那件事**只有看实际发出的提示词才能确认**——图状态里看不出来。
 */
function TurnPrompts({
  sessionId,
  events,
}: {
  sessionId: string;
  events: TraceEvent[];
}): JSX.Element | null {
  const { revealed, busy, error: err, reveal, textOf } = usePromptReveal(sessionId);

  // 展开在前、`at`/`turnId` 在后：轨迹事件的时间戳是外层那个，
  // data 里没有 at，但类型上有——不这么写会被 data 的 undefined 盖掉。
  const rows: PromptRow[] = events
    .filter((e) => e.kind === "prompt")
    .map((e) => ({
      ...(e.data as unknown as Omit<PromptRow, "at" | "turnId">),
      at: e.at,
      turnId: e.turnId,
    }));
  if (rows.length === 0) return null;

  return (
    <>
      <h3>发给模型的提示词</h3>
      <div className="detail-actions">
        {revealed ? (
          <span className="banner banner-warn inline">原文模式：本次查看已记入审计</span>
        ) : (
          <>
            <span className="muted tiny">
              默认只显示长度。提示词≈整段对话原文，看原文与会话页同一道门：提权且被审计。
            </span>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void reveal()}>
              {busy ? "提权中…" : "查看原文"}
            </button>
          </>
        )}
      </div>
      {err ? <p className="error">{err}</p> : null}
      {rows.map((r, i) => {
        const text = textOf(r.agent, r.at);
        return (
          <div className="prompt-block" key={`${r.agent}-${r.at}-${i}`}>
            <div className="flow-child-head">
              <span className="mono">{r.agent}</span>
              {r.truncated ? <span className="flow-tag">已截断</span> : null}
              <span className="spacer" />
              <span className="flow-ms">{r.chars} 字符</span>
            </div>
            {text ? (
              <pre className="trace-payload trace-payload--wrap">{text}</pre>
            ) : (
              <p className="muted tiny">（原文未展示）</p>
            )}
          </div>
        );
      })}
    </>
  );
}
