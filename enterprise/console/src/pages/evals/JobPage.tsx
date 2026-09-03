/**
 * 任务详情 `/evals/:jobId/:tier`（施工单 M67-04；2026-09-03 按「任务 → 测评 → 报告 / 逐题」重排）：
 * 一个任务跑了几个测评，页面就是这几个测评的选择器——选中哪个，下面就是**它的**总分、报告与逐题，
 * 路径里带着测评名，可以直接分享「某次任务的某个测评」。报告是 runner 渲染好的 markdown（页面只显示不重算）；
 * 逐题表列每题的原话、期望、实际、失败原因、回答原文、时延，点「看轨迹」直达回放页那条会话。
 *
 * 报告数字**只有一个出处**（runner），逐题表只做列表计数并标明"与报告同源"。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";

import { api, ApiError } from "../../api";
import { expectLines, failureKind } from "./expect-text";
import { renderMarkdown } from "./markdown";
import { errorMessage, scoreCards, scoreText, statusLabel, type JobView } from "./model";

interface CaseRow {
  id: string;
  input: string;
  expect: Record<string, unknown>;
  tags: string[];
  notes?: string;
  status: string;
  failures: string[];
  reasons?: string[];
  reply?: string;
  sessionId?: string;
  latencyMs?: number;
  trials?: Array<{ status: string; reply?: string; sessionId?: string; judgedBy?: string; judgeRationale?: string; reasons?: string[] }>;
  judgedBy?: string;
  judgeRationale?: string;
  passHatK?: number;
  extra: Record<string, unknown>;
}

interface CasesResponse {
  id: string;
  tier: string;
  at?: string;
  metricsVersion?: string;
  selected?: number;
  total?: number;
  cases: CaseRow[];
}

const REPORT_ORDER = ["summary", "scenario-fake", "scenario-real", "risk-local", "risk-full", "memory-decay"] as const;
const REPORT_LABEL: Record<string, string> = {
  summary: "汇总",
  "scenario-fake": "场景 fake",
  "scenario-real": "场景 real",
  "risk-local": "风险本地层",
  "risk-full": "风险全护栏",
  "memory-decay": "记忆衰减",
};

const okStatus = (s: string): boolean => s === "pass" || s === "intercepted";
const badStatus = (s: string): boolean => s === "fail" || s === "leaked";

export function EvalJobPage(): JSX.Element {
  const { jobId = "baseline", tier } = useParams();
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<{ tab: string; md: string | null; missing: boolean } | null>(null);
  const [cases, setCases] = useState<{ tab: string; data: CasesResponse | null; missing: boolean } | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [onlyFailed, setOnlyFailed] = useState(false);

  useEffect(() => {
    api
      .get<JobView>(`/console/evals/jobs/${encodeURIComponent(jobId)}`)
      .then(setJob)
      .catch((e: unknown) => setError(e instanceof ApiError ? errorMessage(e.code) : String(e)));
  }, [jobId]);

  const loadReport = useCallback(
    (tab: string) => {
      setReport({ tab, md: null, missing: false });
      fetch(`/console/evals/jobs/${encodeURIComponent(jobId)}/tiers/${encodeURIComponent(tab)}/report`, {
        headers: { authorization: `Bearer ${localStorage.getItem("carlife.console.token") ?? ""}` },
      })
        .then(async (r) => {
          if (r.status === 404) return setReport({ tab, md: null, missing: true });
          if (!r.ok) throw new ApiError(r.status, `http_${r.status}`);
          setReport({ tab, md: await r.text(), missing: false });
        })
        .catch((e: unknown) => setError(e instanceof ApiError ? errorMessage(e.code) : String(e)));
    },
    [jobId],
  );

  // 选中的测评：路径里没带就落到默认（有汇总看汇总，否则第一档）——用 Navigate 补进路径，让地址栏始终可分享
  // 本任务有哪些测评：tiers 里的，加上旧任务 / 基线经 summary 字段带出来的汇总与记忆衰减
  const evalTabs = job
    ? REPORT_ORDER.filter((t) => job.tiers.includes(t) || (t === "summary" && job.summary?.hasSummary) || (t === "memory-decay" && job.summary?.hasMemoryDecay))
    : [];
  const defaultTab = job ? (evalTabs.includes("summary") ? "summary" : (evalTabs[0] ?? "summary")) : null;
  const selected = tier && evalTabs.includes(tier as (typeof REPORT_ORDER)[number]) ? tier : null;
  const hasCases = Boolean(job && selected && job.tiers.includes(selected) && selected !== "summary" && selected !== "memory-decay");

  useEffect(() => {
    if (job && selected) loadReport(selected);
  }, [job, selected, loadReport]);

  useEffect(() => {
    if (!job || !selected || !hasCases) return;
    setCases({ tab: selected, data: null, missing: false });
    api
      .get<CasesResponse>(`/console/evals/jobs/${encodeURIComponent(jobId)}/tiers/${encodeURIComponent(selected)}/cases`)
      .then((d) => setCases({ tab: selected, data: d, missing: false }))
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) setCases({ tab: selected, data: null, missing: true });
        else setError(e instanceof ApiError ? errorMessage(e.code) : String(e));
      });
  }, [job, selected, hasCases, jobId]);

  const rows = useMemo(() => {
    const list = cases?.data?.cases ?? [];
    return onlyFailed ? list.filter((c) => badStatus(c.status)) : list;
  }, [cases, onlyFailed]);

  if (error) return <p className="error">加载失败：{error}</p>;
  if (!job) return <p className="muted">载入中…</p>;
  if (!selected) return <Navigate to={`/evals/${encodeURIComponent(jobId)}/${defaultTab ?? "summary"}`} replace />;

  const cards = scoreCards(job, REPORT_LABEL);
  const selectedCard = cards.find((c) => c.key === selected);
  const total = cases?.data?.cases.length ?? 0;
  const okCount = (cases?.data?.cases ?? []).filter((c) => okStatus(c.status)).length;

  return (
    <section className="page">
      <header className="page-head">
        <h1>
          <Link to="/evals" className="muted">
            评测
          </Link>{" "}
          /{" "}
          <Link to={`/evals/${encodeURIComponent(jobId)}`} className="muted">
            {job.readonly ? "基线" : job.id}
          </Link>{" "}
          / {REPORT_LABEL[selected] ?? selected}
        </h1>
        <p className="muted">
          状态 {statusLabel(job.status)} · 档位 {job.tiers.join("、")}
          {job.ids.length > 0 && ` · 只跑 ${job.ids.length} 题`}
        </p>
      </header>

      <h2 className="evals-h2">这次任务跑了哪些测评</h2>
      <p className="muted evals-score-rule">
        点一张卡进入那个测评的报告与逐题。分数每题 1 分：通过 / 拦住计 1，失败 / 漏拦计 0；满分 = 本轮有判定的题数，未判定的题不进满分。
      </p>
      <ul className="evals-scores" aria-label="测评">
        {evalTabs.includes("summary") && (
          <li className={`evals-score-card${selected === "summary" ? " evals-score-card--active" : ""}`}>
            <Link to={`/evals/${encodeURIComponent(jobId)}/summary`} className="evals-score-link">
              <span className="evals-score-label">汇总</span>
              <span className="evals-score-value">跨测评</span>
              <span className="evals-score-note">五个测评的合计与 §14 指标表</span>
            </Link>
          </li>
        )}
        {cards.map((c) => {
          const linkable = c.key !== "total";
          const inner = (
            <>
              <span className="evals-score-label">{c.label}</span>
              <span className="evals-score-value">{scoreText(c.score)}</span>
              {c.note && <span className="evals-score-note">{c.note}</span>}
              {!c.score && <span className="evals-score-note">{job.tierRuns[c.key]?.status === "running" ? "跑着，分数随进度更新" : c.key === "total" ? "" : "无分数（产物未落或旧代产物）"}</span>}
            </>
          );
          const cls = ["evals-score-card", c.key === "total" ? "evals-score-card--total" : "", c.key === selected ? "evals-score-card--active" : ""].join(" ");
          return (
            <li key={c.key} className={cls} title={c.note ?? ""}>
              {linkable ? <Link to={`/evals/${encodeURIComponent(jobId)}/${c.key}`} className="evals-score-link">{inner}</Link> : inner}
            </li>
          );
        })}
      </ul>

      <h2 className="evals-h2">
        {REPORT_LABEL[selected] ?? selected} · 报告
        {selectedCard?.score && <span className="muted evals-h2-score"> {scoreText(selectedCard.score)}</span>}
      </h2>
      <div className="evals-report">
        {!report || report.tab !== selected ? (
          <p className="muted">载入中…</p>
        ) : report.missing ? (
          <p className="muted">该档未跑或未出报告。</p>
        ) : report.md === null ? (
          <p className="muted">载入中…</p>
        ) : (
          renderMarkdown(report.md)
        )}
      </div>

      {hasCases && (
        <>
          <h2 className="evals-h2">{REPORT_LABEL[selected] ?? selected} · 逐题</h2>
          <div className="evals-tabs">
            <label className="evals-only-failed">
              <input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} /> 只看未通过
            </label>
          </div>
        </>
      )}
      {!hasCases && <p className="muted">{selected === "summary" ? "汇总没有逐题——逐题在各个测评自己的页里。" : "记忆衰减是断言式评测，没有逐题，判定明细在上面的报告里。"}</p>}
      {hasCases && cases?.data && (
        <p className="muted">
          列表计数 {okCount}/{total} 通过（与报告同源，报告里的比率才是口径）· 产物代次 {cases.data.metricsVersion ?? "（无）"} · {cases.data.at ?? ""}
        </p>
      )}
      {hasCases && cases?.missing && <p className="muted">该档未跑或产物尚未落盘。</p>}
      {hasCases && cases?.data && (
        <table className="table evals-cases">
          <thead>
            <tr>
              <th>题</th>
              <th>原话</th>
              <th>期望</th>
              <th>实际</th>
              <th>时延</th>
              <th>轨迹</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const expanded = open.has(c.id);
              const kinds = c.failures.map(failureKind);
              const reasons = c.reasons ?? [];
              const sub = c.tags.find((t) => t.startsWith("sub:") || t.startsWith("hb:")) ?? String(c.extra.category ?? c.extra.scene ?? "");
              return (
                <tr key={c.id} className={badStatus(c.status) ? "evals-row--bad" : okStatus(c.status) ? "evals-row--ok" : ""}>
                  <td>
                    <code>{c.id}</code>
                    <br />
                    <span className="muted">{sub}</span>
                  </td>
                  <td className="evals-input">{c.input || <span className="muted">（题库里没有这个 id）</span>}</td>
                  <td className="evals-expect">
                    <ul>
                      {expectLines(c.expect).map((l) => (
                        <li key={l.label}>
                          <span className="muted">{l.label}：</span>
                          {l.value}
                        </li>
                      ))}
                    </ul>
                    {c.notes && expanded && <p className="muted evals-notes">{c.notes}</p>}
                  </td>
                  <td className="evals-actual">
                    <span className={`evals-status evals-status--${c.status}`}>{c.status}</span>
                    {typeof c.passHatK === "number" && <span className="muted"> · pass^k {c.passHatK}</span>}
                    {c.judgedBy && <span className="muted"> · {c.judgedBy === "judge" ? "裁判" : "正则"}</span>}
                    {[...c.failures, ...reasons].length > 0 && (
                      <ul className="evals-failures">
                        {c.failures.map((f, i) => (
                          <li key={`f${i}`} className={`evals-fail evals-fail--${kinds[i]}`}>
                            {f}
                          </li>
                        ))}
                        {reasons.map((r, i) => (
                          <li key={`r${i}`} className="evals-fail evals-fail--other">
                            {r}
                          </li>
                        ))}
                      </ul>
                    )}
                    {c.reply !== undefined && (
                      <div className="evals-reply">
                        <span className="muted">回答：</span>
                        {expanded ? c.reply : `${c.reply.slice(0, 120)}${c.reply.length > 120 ? "…" : ""}`}
                      </div>
                    )}
                    {c.judgeRationale && expanded && (
                      <div className="evals-reply">
                        <span className="muted">裁判理由：</span>
                        {c.judgeRationale}
                      </div>
                    )}
                    {c.trials && expanded && (
                      <ol className="evals-trials">
                        {c.trials.map((t, i) => (
                          <li key={i}>
                            <span className={`evals-status evals-status--${t.status}`}>{t.status}</span>
                            {t.judgedBy && <span className="muted"> · {t.judgedBy}</span>}
                            {t.reply && <div className="evals-reply">{t.reply}</div>}
                            {t.judgeRationale && <div className="muted">裁判：{t.judgeRationale}</div>}
                            {t.sessionId && (
                              <Link to={`/trace?session=${encodeURIComponent(t.sessionId)}`} className="btn btn-link">
                                看第 {i + 1} 轮轨迹
                              </Link>
                            )}
                          </li>
                        ))}
                      </ol>
                    )}
                    <button
                      className="btn btn-link"
                      onClick={() =>
                        setOpen((s) => {
                          const n = new Set(s);
                          if (n.has(c.id)) n.delete(c.id);
                          else n.add(c.id);
                          return n;
                        })
                      }
                    >
                      {expanded ? "收起" : "展开"}
                    </button>
                  </td>
                  <td className="muted">{typeof c.latencyMs === "number" ? `${c.latencyMs} ms` : "—"}</td>
                  <td>
                    {c.sessionId ? (
                      <Link to={`/trace?session=${encodeURIComponent(c.sessionId)}`} className="btn btn-secondary btn-sm">
                        看轨迹
                      </Link>
                    ) : (
                      <span className="muted" title="该产物早于 M67，没有会话号">
                        无会话号
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
