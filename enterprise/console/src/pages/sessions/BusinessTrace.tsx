/**
 * 业务视图（2026-09-15）：单轮执行轨迹，按业务人员的问题组织。
 *
 * 四段，自上而下是阅读顺序：
 *   1. 概览——车主问了什么、系统听懂了什么、交给谁、结果如何；
 *   2. 在编排图上的位置——六个站点的路径条（`BusinessPath`）；
 *   3. 执行流程——阶段 → Agent → 工具，每层可展开看输入输出（`BusinessSteps`）；
 *   4. 最终回答——助手那条消息的全文。
 *
 * 数据与研发视图完全同源：`replay.timeline` 切到本轮，经 `buildBusinessTurn` 重组；
 * 路径条的亮灭经 `projectRun` 投影（与研发视图那张图同一份）。
 */

import { useMemo } from "react";

import { projectRun } from "../workflow/projection";
import { BusinessPath } from "./BusinessPath";
import { BusinessSteps } from "./BusinessSteps";
import { projectStations } from "./business-path";
import { buildBusinessTurn, formatDuration } from "./business-view";
import type { ReplayPayload, ReplayState } from "./DevTurnTrace";
import { eventsOfTurn, type ConsoleMessage } from "./turns";
import { usePromptReveal } from "./usePromptReveal";
import "./business-trace.css";

export function BusinessTrace({
  sessionId,
  turnId,
  messages,
  replay,
  state,
  error,
}: {
  sessionId: string;
  turnId: string;
  messages: ConsoleMessage[];
  replay: ReplayPayload | null;
  state: ReplayState;
  error: string | null;
}): JSX.Element {
  const reveal = usePromptReveal(sessionId);
  const events = useMemo(() => (replay ? eventsOfTurn(replay.timeline, turnId) : null), [replay, turnId]);
  const view = useMemo(() => (events ? buildBusinessTurn(events.events, messages) : null), [events, messages]);
  const stations = useMemo(() => (events ? projectStations(projectRun(events.events)) : null), [events]);

  if (state === "loading" || !replay) {
    return <p className="muted">{state === "error" ? `轨迹加载失败：${error}` : "载入轨迹…"}</p>;
  }
  if (state === "error") return <p className="error">轨迹加载失败：{error}</p>;
  if (!events || !view || !stations) return <p className="muted">载入轨迹…</p>;

  const ask = messages.find((m) => m.role === "user")?.content;
  const answer = messages.filter((m) => m.role === "assistant").map((m) => m.content).join("\n\n");

  if (events.events.length === 0) {
    return (
      <div className="bz">
        <Overview ask={ask} />
        <p className="muted">
          这一轮没有留下执行轨迹（早于埋点的轮次，或本会话事件太多、更早轮次被截掉了）。
          这<strong>不是执行失败</strong>——回答本身在下面。
        </p>
        {answer ? <AnswerBlock text={answer} /> : null}
      </div>
    );
  }

  return (
    <div className="bz">
      <Overview
        ask={ask}
        goal={view.goal}
        constraints={view.constraints}
        route={view.route}
        sideTasks={view.sideTasks}
        risk={view.risk}
        outcome={view.outcome}
        outcomeText={view.outcomeText}
        totalMs={view.totalMs}
        agentCount={view.agents.filter((a) => !a.agent.endsWith("-intent") && !a.agent.endsWith("-voice")).length}
      />

      <h3>在编排图上的位置</h3>
      <BusinessPath stations={stations} agents={view.agents} />

      <h3>执行流程</h3>
      {reveal.revealed ? <p className="banner banner-warn inline">原文模式：提示词原文已展示，本次查看已记入审计</p> : null}
      {reveal.error ? <p className="error">{reveal.error}</p> : null}
      <BusinessSteps phases={view.phases} reveal={reveal} />

      <h3>最终回答</h3>
      {answer ? <AnswerBlock text={answer} /> : <p className="muted tiny">这一轮没有助手消息（被拒、被打断，或还没回完）。</p>}

      <p className="muted tiny">
        {replay.redacted ? "内容含已脱敏字段（手机号 / 身份证 / 银行卡 / 邮箱）。" : ""}
        {replay.hasMore ? "本会话事件较多，接口只返回了最近一段，本轮可能不完整。" : ""}
        {events.orphan > 0 ? `另有 ${events.orphan} 条不属于任何轮次的事件（连接建立、轮次关闭后才落的裁决），研发视图与回放页可见。` : ""}
        想看分跳耗时、时间轴与逐条事件，切到「研发视图」。
      </p>
    </div>
  );
}

function AnswerBlock({ text }: { text: string }): JSX.Element {
  return <div className="bz-answer">{text}</div>;
}

function Overview(p: {
  ask?: string;
  goal?: string;
  constraints?: string[];
  route?: { label: string; reason?: string };
  sideTasks?: Array<{ label: string; goal: string }>;
  risk?: { label: string; decision: string };
  outcome?: string;
  outcomeText?: string;
  totalMs?: number;
  agentCount?: number;
}): JSX.Element {
  return (
    <dl className="bz-overview">
      <div>
        <dt>车主问</dt>
        <dd className="bz-ask">{p.ask ?? "（没有用户消息）"}</dd>
      </div>
      <div>
        <dt>系统听懂的目标</dt>
        <dd>
          {p.goal ?? "—"}
          {p.constraints && p.constraints.length > 0 ? (
            <span className="bz-constraints">约束：{p.constraints.join("；")}</span>
          ) : null}
        </dd>
      </div>
      <div>
        <dt>交给谁</dt>
        <dd>
          {p.route ? p.route.label : "—"}
          {p.route?.reason ? <span className="muted tiny">（{p.route.reason}）</span> : null}
          {p.sideTasks && p.sideTasks.length > 0 ? (
            <span className="bz-constraints">顺带：{p.sideTasks.map((t) => `${t.label}——${t.goal}`).join("；")}</span>
          ) : null}
        </dd>
      </div>
      <div>
        <dt>安全检查</dt>
        <dd>{p.risk ? `${p.risk.label} → ${p.risk.decision === "deny" ? "拒绝" : p.risk.decision === "note" ? "放行并附提醒" : "放行"}` : "—"}</dd>
      </div>
      <div>
        <dt>结果</dt>
        <dd className={`bz-outcome bz-outcome--${p.outcome ?? "unknown"}`}>
          {p.outcomeText ?? "—"}
          {p.totalMs !== undefined ? ` · 全程 ${formatDuration(p.totalMs)}` : ""}
          {p.agentCount !== undefined && p.agentCount > 0 ? ` · ${p.agentCount} 位专家参与` : ""}
        </dd>
      </div>
    </dl>
  );
}
