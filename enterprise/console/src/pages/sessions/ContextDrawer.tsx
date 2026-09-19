/**
 * 上下文抽屉（2026-09-15）：这一轮模型手上有什么。
 *
 * # 回答的问题
 *
 * 轨迹抽屉回答"哪一跳慢、谁答了什么"；这一个回答 ACR-036 之后才有的那个问题——
 * **这一轮开始时系统给模型装了什么事实**：车主的长期档案（Z1 锚定块的来源）、
 * 他手上正在办的事（`working_tasks`，跨会话共享）、本轮尾区的公共事实行，
 * 以及各 Agent 实际拿到的块。四段自上而下，前两段是"状态"，后两段是"注入"。
 *
 * # 与提示词的关系
 *
 * 各 Agent 拿到的块也在提示词原文里，但看提示词要提权 + 写审计（它含整段对话）。
 * 这里只有投影层截断过隐私的档案，与会话页的消息正文同一档，不设那道门。
 *
 * 形态与 `TraceDrawer` 相同（右侧抽屉、遮罩与 Esc 可关），一次只开一轮。
 */

import { useMemo } from "react";

import {
  contextOfTurn,
  factLabel,
  modeLabel,
  taskRows,
  userSectionRows,
  type ContextReplay,
  type ContextReplayState,
  type ContextTraceData,
  type SectionRow,
  type TaskRow,
} from "./context-view";
import { eventsOfTurn } from "./turns";

export function ContextDrawer({
  sessionId,
  turnId,
  turnIndex,
  replay,
  state,
  error,
  onClose,
}: {
  sessionId: string;
  turnId: string;
  turnIndex: number;
  replay: ContextReplay | null;
  state: ContextReplayState;
  error: string | null;
  onClose: () => void;
}): JSX.Element {
  const availability = useMemo(
    () => (replay ? contextOfTurn(eventsOfTurn(replay.timeline, turnId).events) : null),
    [replay, turnId],
  );

  let body: JSX.Element;
  if (state === "error") body = <p className="error">轨迹加载失败：{error}</p>;
  else if (state === "loading" || !replay || !availability) body = <p className="muted">载入上下文…</p>;
  else if (availability.kind === "none") {
    body = (
      <p className="muted">
        这一轮没有上下文记录：早于该埋点上线的轮次，或本会话事件太多、更早的轮次被截掉了。
        这<strong>不是装载失败</strong>——要看当时的注入结果，去轨迹抽屉提权看提示词原文。
      </p>
    );
  } else if (availability.kind === "off") {
    body = (
      <p className="muted">
        这一轮上下文装载层是<strong>关着的</strong>（`CARLIFE_CONTEXT_LAYER=off`）：没有装载、没有注入，
        模型只看到对话历史。
      </p>
    );
  } else if (availability.kind === "failed") {
    body = (
      <>
        <p className="error">这一轮上下文装载抛错，本轮走了老路径（模型没有拿到两级状态）。</p>
        <Overview data={availability.data} />
      </>
    );
  } else {
    body = <Loaded data={availability.data} sessionId={sessionId} />;
  }

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`第 ${turnIndex} 轮的上下文`}>
        <header className="drawer-head">
          <div>
            <strong>第 {turnIndex} 轮 · 上下文</strong>
            <div className="muted tiny mono">{turnId}</div>
          </div>
          <span className="spacer" />
          <button type="button" className="btn-link" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className="drawer-body cx">{body}</div>
      </aside>
    </>
  );
}

function Overview({ data }: { data: ContextTraceData }): JSX.Element {
  return (
    <dl className="cx-overview">
      <div>
        <dt>装载档位</dt>
        <dd>{modeLabel(data.mode)}</dd>
      </div>
      <div>
        <dt>装载耗时</dt>
        <dd>{data.loadMs !== undefined ? `${data.loadMs} ms` : "未记录"}</dd>
      </div>
      <div>
        <dt>线程</dt>
        <dd className="mono tiny">{data.threadId ?? "—"}</dd>
      </div>
      <div>
        <dt>用户</dt>
        <dd className="mono tiny">{data.userId ?? "匿名（没有用户键，不投影档案）"}</dd>
      </div>
    </dl>
  );
}

function Loaded({ data, sessionId }: { data: ContextTraceData; sessionId: string }): JSX.Element {
  const sections = userSectionRows(data.user);
  const tasks = taskRows(data, sessionId);
  const facts = data.facts ?? [];
  const served = data.served ?? [];
  return (
    <>
      <Overview data={data} />

      <h3>用户长期状态（锚定块 Z1 的来源，一个线程内钉死）</h3>
      <table className="table cx-sections">
        <tbody>
          {sections.map((r) => (
            <SectionLine key={r.section} row={r} />
          ))}
        </tbody>
      </table>

      <h3>任务工作状态（`working_tasks`，按用户 × 种类，跨会话共享）</h3>
      {tasks.length === 0 ? (
        <p className="muted tiny">这一轮开始时他手上没有进行中的事，轮末也没有开新的。</p>
      ) : (
        tasks.map((t) => <TaskCard key={t.kind} row={t} />)
      )}

      <h3>本轮尾区的公共事实行（Z3，只在最后一条 user 消息里）</h3>
      {facts.length === 0 ? (
        <p className="muted tiny">没有记录。</p>
      ) : (
        <ul className="cx-facts">
          {facts.map((f, i) => (
            <li key={`${f.item}-${i}`}>
              <span className="flow-tag">{factLabel(f.item)}</span>
              <pre className="trace-payload trace-payload--wrap">{f.text}</pre>
            </li>
          ))}
        </ul>
      )}

      <h3>各 Agent 实际拿到的块</h3>
      {served.length === 0 ? (
        <p className="muted tiny">这一轮没有 Agent 取过上下文块（被输入管线拦下、或走的分支不读它）。</p>
      ) : (
        served.map((s) => (
          <div className="prompt-block" key={s.agent}>
            <div className="flow-child-head">
              <span className="mono">{s.agent}</span>
              <span className="spacer" />
              <span className="muted tiny">
                {[s.anchor ? "锚定块" : null, s.turn ? "本轮尾区" : null].filter(Boolean).join(" + ")}
              </span>
            </div>
            {s.anchor ? <pre className="trace-payload trace-payload--wrap">{s.anchor}</pre> : null}
            {s.turn ? <pre className="trace-payload trace-payload--wrap">{s.turn}</pre> : null}
          </div>
        ))
      )}
    </>
  );
}

function SectionLine({ row }: { row: SectionRow }): JSX.Element {
  return (
    <tr className={`cx-section cx-section--${row.state}`}>
      <th scope="row">{row.label}</th>
      <td>
        <span className="cx-state">
          {row.state === "present" ? "有" : row.state === "unavailable" ? "读不到" : "没有"}
        </span>
      </td>
      <td className="cx-section-text">{row.text}</td>
    </tr>
  );
}

const CHANGE_LABEL: Record<TaskRow["change"], string> = {
  unchanged: "本轮未变",
  updated: "本轮有写入",
  opened: "本轮新开",
  closed: "本轮关闭",
};

function TaskCard({ row }: { row: TaskRow }): JSX.Element {
  const s = row.after ?? row.state;
  return (
    <div className={`cx-task cx-task--${row.change}`}>
      <div className="flow-child-head">
        <strong>{row.kindLabel}</strong>
        <span className="flow-tag">{row.statusLabel}</span>
        {row.afterStatusLabel ? <span className="flow-tag">→ {row.afterStatusLabel}</span> : null}
        <span className="spacer" />
        <span className="muted tiny">{CHANGE_LABEL[row.change]}</span>
      </div>
      <dl className="cx-task-meta">
        <div>
          <dt>版本</dt>
          <dd>
            v{row.state.version}
            {row.after && row.after.version !== row.state.version ? ` → v${row.after.version}` : ""}
          </dd>
        </div>
        <div>
          <dt>落库引用</dt>
          <dd className="mono tiny">{s.base ? `${s.base.ref}（第 ${s.base.version} 次）` : "还没落过库"}</dd>
        </div>
        <div>
          <dt>时间</dt>
          <dd className="tiny">
            开 {fmt(s.openedAt)} · 触 {fmt(s.touchedAt)} · 到期 {fmt(s.expiresAt)}
          </dd>
        </div>
        <div>
          <dt>硬约束</dt>
          <dd className="tiny">{s.constraints?.length ? s.constraints.join("；") : "无"}</dd>
        </div>
        {s.pending ? (
          <div>
            <dt>挂着的问题</dt>
            <dd className="tiny">
              {s.pending.kind}，已 {s.pending.unansweredTurns} 轮未答
              {s.pending.candidates?.length ? `：${s.pending.candidates.map((c) => c.label).join(" / ")}` : ""}
            </dd>
          </div>
        ) : null}
        {s.lastAction ? (
          <div>
            <dt>上次动作</dt>
            <dd className="tiny">
              {s.lastAction.op}（{s.lastAction.outcome}）· {fmt(s.lastAction.at)}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>跨会话</dt>
          <dd className="tiny">
            {row.sharedFrom.length === 0
              ? "只在本会话里改过"
              : `还被 ${row.sharedFrom.length} 段其它对话改过：${row.sharedFrom.join("、")}`}
          </dd>
        </div>
        {row.events.length > 0 ? (
          <div>
            <dt>本轮事件</dt>
            <dd className="tiny">{row.events.join(" → ")}</dd>
          </div>
        ) : null}
      </dl>
      {s.draftText ? (
        <details className="cx-draft">
          <summary>
            草案正文{s.draftTruncated ? "（已截断）" : ""}
            {row.after && row.after.draftText !== row.state.draftText ? " · 轮末那份" : ""}
          </summary>
          <pre className="trace-payload trace-payload--wrap">{s.draftText}</pre>
        </details>
      ) : null}
    </div>
  );
}

function fmt(ms: number): string {
  return new Date(ms).toLocaleString();
}
