/**
 * 业务视图的「在编排图上的位置」：六个站点的路径条（模型见 `business-path.ts`）。
 *
 * 亮灭来自 `projectRun` 的投影，不是这里重新解读轨迹。"专家处理"一站下面把本轮
 * 上场的 Agent 排成一排——并行的几条腿并排放，业务人员看到的就是"几位专家同时在做"。
 */

import type { StationRun } from "./business-path";
import { formatDuration, type AgentStep } from "./business-view";

const STATE_TEXT: Record<StationRun["state"], string> = {
  done: "走完",
  failed: "在这里出事",
  active: "停在这里",
  skipped: "没走到",
};

/**
 * 同一位专家在一轮里可能上场好几次（行程规划：骨架后每条腿再跑一次、酒店按片区追查一次），
 * 站点上一位专家只画**一枚**芯片，`×N` 是次数；状态取最差的那一次。每次的细节在下面执行流程里逐次列出。
 */
function groupByAgent(agents: AgentStep[]): Array<{ agent: string; label: string; times: number; status: AgentStep["status"]; totalMs: number; parallelWith: string[] }> {
  const order: Array<AgentStep["status"]> = ["failed", "cancelled", "warn", "ok", "skipped"];
  const map = new Map<string, { agent: string; label: string; times: number; status: AgentStep["status"]; totalMs: number; parallelWith: string[] }>();
  for (const a of agents) {
    const g = map.get(a.agent) ?? { agent: a.agent, label: a.label, times: 0, status: a.status, totalMs: 0, parallelWith: [] };
    g.times += 1;
    g.totalMs += a.durationMs;
    if (order.indexOf(a.status) < order.indexOf(g.status)) g.status = a.status;
    for (const p of a.parallelWith) if (!g.parallelWith.includes(p) && p !== a.label) g.parallelWith.push(p);
    map.set(a.agent, g);
  }
  return [...map.values()];
}

export function BusinessPath({ stations, agents }: { stations: StationRun[]; agents: AgentStep[] }): JSX.Element {
  // 专家处理站下挂的 Agent：排掉理解与表述那两步（它们各归自己的站）。
  const experts = groupByAgent(
    agents.filter((a) => !a.agent.endsWith("-intent") && !a.agent.endsWith("-voice") && a.agent !== "direct"),
  );
  return (
    <div className="bz-path">
      <ol className="bz-stations">
        {stations.map((s, i) => (
          <li
            key={s.id}
            className={`bz-station bz-station--${s.state}`}
            title={`${s.hint}${s.nodes.length ? `\n图上节点：${s.nodes.join("、")}` : ""}`}
          >
            <span className="bz-station-dot" aria-hidden="true">{i + 1}</span>
            <span className="bz-station-label">{s.label}</span>
            <span className="bz-station-meta">
              {STATE_TEXT[s.state]}
              {s.durationMs !== undefined && s.state !== "skipped" ? ` · ${formatDuration(s.durationMs)}` : ""}
            </span>
            {s.id === "experts" && experts.length > 0 ? (
              <span className="bz-station-agents">
                {experts.map((a) => (
                  <span
                    key={a.agent}
                    className={`bz-agent-chip bz-agent-chip--${a.status}`}
                    title={`${a.agent}${a.times > 1 ? ` · 本轮上场 ${a.times} 次，共 ${formatDuration(a.totalMs)}` : ` · ${formatDuration(a.totalMs)}`}${a.parallelWith.length ? `\n与 ${a.parallelWith.join("、")} 同时进行` : ""}`}
                  >
                    {a.label}
                    {a.times > 1 ? ` ×${a.times}` : ""}
                  </span>
                ))}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      <p className="muted tiny">
        六个站点是主链路图折叠后的样子，亮灭与研发视图那张图同源。
        专家名后的 <b>×N</b> 表示这位专家本轮上场了 N 次（行程规划里骨架定下后每条腿会再跑一次、酒店按片区还会补查），每次的细节在下面「执行流程」里逐次列出。
        <span className="bz-legend bz-legend--done">● 走完</span>
        <span className="bz-legend bz-legend--active">● 停在这里</span>
        <span className="bz-legend bz-legend--failed">● 在这里出事</span>
        <span className="bz-legend bz-legend--skipped">● 没走到</span>
      </p>
    </div>
  );
}
