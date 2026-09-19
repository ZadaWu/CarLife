/**
 * 业务视图的「执行流程」：阶段 → 其中的 Agent → 它调的工具，三层可展开。
 *
 * # 每一层都能看到输入与输出
 *
 * 业务人员查"酒店为什么排得不合理"，要顺着看三样：这位专家收到什么任务（提示词，
 * 提权后可见）、拿什么条件查了什么（工具入参 / 出参）、交回了什么（结论）。
 * 三样都折在各自的 `<details>` 里——展开的是"我要看的那一步"，其余保持一行。
 *
 * # JSON 一律画成表
 *
 * 入参 / 出参 / 结论都经 `JsonTable`：数组 → 列表、对象 → 键值表，表头「中文(英文)」。
 * 原始 JSON 折叠在每张表下面，研发对账不用切视图。
 *
 * # 不做过滤
 *
 * 失败、降级、模拟数据都在，只是标了颜色与文字。与研发视图和回放页同一纪律。
 */

import { formatDuration, type AgentStep, type PhaseStep, type ToolUse } from "./business-view";
import { JsonTable } from "./JsonTable";
import type { PromptReveal } from "./usePromptReveal";

const STATUS_TEXT: Record<PhaseStep["status"], string> = {
  ok: "完成",
  failed: "失败",
  cancelled: "取消",
  warn: "有降级",
  skipped: "跳过",
};

function ToolRow({ t }: { t: ToolUse }): JSX.Element {
  return (
    <li className={`bz-tool bz-tool--${t.status}`}>
      <details>
        <summary>
          <span className="bz-tool-name">
            {t.submit ? "📤 " : "🔎 "}
            {t.label}
          </span>
          <code className="bz-tool-raw">{t.name}</code>
          {t.mock ? <span className="bz-tag bz-tag--mock">模拟数据</span> : null}
          {t.status === "failed" ? <span className="bz-tag bz-tag--bad">失败</span> : null}
          {t.summary ? <span className="bz-tool-summary">{t.summary}</span> : null}
          <span className="spacer" />
          <span className="bz-ms">{formatDuration(t.durationMs)}</span>
        </summary>
        <div className="bz-io">
          <div>
            <div className="bz-io-head">拿什么条件去查（入参）{t.inputTruncated ? " · 已截断" : ""}</div>
            {t.input ? <JsonTable text={t.input} /> : <p className="muted tiny">（这一轮跑在埋点之前，没有记入参）</p>}
          </div>
          <div>
            <div className="bz-io-head">查回来什么（出参）{t.outputTruncated ? " · 已截断" : ""}</div>
            {t.output ? (
              <JsonTable text={t.output} />
            ) : (
              <p className="muted tiny">{t.status === "failed" ? "（调用失败，没有返回值）" : "（这一轮跑在埋点之前，没有记返回值）"}</p>
            )}
          </div>
        </div>
      </details>
    </li>
  );
}

function AgentCard({ a, reveal }: { a: AgentStep; reveal: PromptReveal }): JSX.Element {
  const promptText = a.prompt ? reveal.textOf(a.agent, a.prompt.at) : undefined;
  const queries = a.tools.filter((t) => !t.submit);
  const submits = a.tools.filter((t) => t.submit);
  return (
    <li className={`bz-agent bz-agent--${a.status}`}>
      <details>
        <summary>
          <span className="bz-agent-name">
            {a.label}
            {a.seq > 1 ? <span className="bz-seq">第 {a.seq} 次</span> : null}
          </span>
          <code className="bz-tool-raw">{a.agent}</code>
          <span className={`bz-tag bz-tag--${a.status}`}>{a.statusText}</span>
          {a.parallelWith.length > 0 ? <span className="bz-tag">与 {a.parallelWith.join("、")} 同时进行</span> : null}
          <span className="bz-agent-brief">
            {queries.length > 0 ? `查了 ${queries.length} 次` : "没有查资料"}
            {submits.length > 0 ? ` · 交回 ${submits.length} 份结论` : ""}
          </span>
          <span className="spacer" />
          <span className="bz-ms">{formatDuration(a.durationMs)}</span>
        </summary>
        <div className="bz-agent-body">
          {a.roleNote ? <p className="muted tiny">{a.roleNote}</p> : null}

          <div className="bz-io-head">收到的任务（发给模型的提示词）</div>
          {!a.prompt ? (
            <p className="muted tiny">（这一轮跑在埋点之前，没有记提示词）</p>
          ) : promptText ? (
            <pre className="bz-pre">{promptText}</pre>
          ) : (
            <p className="muted tiny">
              {a.prompt.chars} 字符{a.prompt.truncated ? "（入库时已截断）" : ""}。
              提示词≈整段对话原文，看原文要提权且记审计：
              <button type="button" className="btn-link" disabled={reveal.busy} onClick={() => void reveal.reveal()}>
                {reveal.busy ? "提权中…" : "查看原文"}
              </button>
            </p>
          )}

          <div className="bz-io-head">做了什么（按时间）</div>
          {a.tools.length === 0 ? (
            <p className="muted tiny">没有调用任何工具——结论全靠模型自己的知识。</p>
          ) : (
            <ul className="bz-tools">
              {a.tools.map((t, i) => (
                <ToolRow key={`${t.name}-${t.at}-${i}`} t={t} />
              ))}
            </ul>
          )}

          <div className="bz-io-head">
            交回的结论{a.output?.source === "submission" ? "（结构化，走提交通道）" : ""}
            {a.output?.truncated ? " · 已截断" : ""}
          </div>
          {a.output ? (
            <JsonTable text={a.output.text} />
          ) : (
            <p className="muted tiny">
              {a.status === "failed" ? "（失败，没有结论）" : a.status === "cancelled" ? "（被取消，没有结论）" : "（这一轮跑在埋点之前，没有记产出）"}
            </p>
          )}
        </div>
      </details>
    </li>
  );
}

export function BusinessSteps({ phases, reveal }: { phases: PhaseStep[]; reveal: PromptReveal }): JSX.Element {
  return (
    <ol className="bz-phases">
      {phases.map((p, i) => (
        <li key={`${p.id}-${p.startedAt}`} className={`bz-phase bz-phase--${p.status}`}>
          <div className="bz-phase-head">
            <span className="bz-phase-no">{i + 1}</span>
            <span className="bz-phase-label">{p.label}</span>
            <span className={`bz-tag bz-tag--${p.status}`}>{p.statusText ?? STATUS_TEXT[p.status]}</span>
            <span className="spacer" />
            <span className="bz-ms">{formatDuration(p.durationMs)}</span>
          </div>
          {p.summary ? <p className="bz-phase-summary">{p.summary}</p> : null}
          {p.notes.length > 0 ? (
            <ul className="bz-notes">
              {p.notes.map((n, j) => (
                <li key={j}>{n}</li>
              ))}
            </ul>
          ) : null}
          {p.agents.length > 0 ? (
            <ul className="bz-agents">
              {p.agents.map((a) => (
                <AgentCard key={`${a.agent}-${a.seq}`} a={a} reveal={reveal} />
              ))}
            </ul>
          ) : null}
          {p.tools.length > 0 ? (
            <>
              <div className="bz-io-head">这一步直接查的资料</div>
              <ul className="bz-tools">
                {p.tools.map((t, j) => (
                  <ToolRow key={`${t.name}-${t.at}-${j}`} t={t} />
                ))}
              </ul>
            </>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
