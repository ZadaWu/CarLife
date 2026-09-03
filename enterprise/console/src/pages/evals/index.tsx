/**
 * 评测任务页 `/evals`（施工单 M67-03）。
 *
 * 上面是任务列表（含「基线」——仓库提交的产物），下面是新建区：勾几档、看清楚哪几档计费、点起跑；
 * 正在跑的任务自动开一条 SSE 看进度，随时能取消。
 *
 * # 角色在服务端
 *
 * 页面按 `identity.role` 隐藏起跑 / 取消按钮只是体验；直接敲接口一样被 403 挡住，
 * 那时用 `ApiError.isForbidden` 明确说"不是没登录，是没权限"。
 *
 * # 计费是两步
 *
 * 勾了计费档，起跑按钮变成「确认计费并起跑」并展开一块确认区，列出各档题数与轮次
 * （数据来自 `/console/evals/tiers`，页面不估金额——估一个数比不估更糟）；确认后请求体才带 `confirmCost: true`。
 *
 * # 进度的真相是文件
 *
 * SSE 断了要显示"连接断开"，不能停在旧数字（`openEventStream` 的 `onState`）；任务结束后关流不再重连。
 */

import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { api, ApiError } from "../../api";
import { openEventStream, type StreamState } from "../../api/stream";
import { IdentityContext } from "../../app/identity";
import { Hint } from "../../components/Hint";
import {
  applyProgressEvent,
  errorMessage,
  needsCostConfirm,
  groupByEval,
  parseIds,
  scoreText,
  statusLabel,
  tierPercent,
  tierSummary,
  type JobView,
  type ProgressEvent,
  type ProgressState,
  type TierInfo,
} from "./model";

function fmtTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function EvalsPage(): JSX.Element {
  const identity = useContext(IdentityContext);
  const isAdmin = identity?.role === "admin";
  const [tiers, setTiers] = useState<TierInfo[] | null>(null);
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const [picked, setPicked] = useState<string[]>(["scenario-fake"]);
  const [idsRaw, setIdsRaw] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [progress, setProgress] = useState<ProgressState>({ job: null, finished: false });
  const [streamState, setStreamState] = useState<StreamState | null>(null);

  const reload = useCallback(() => {
    return Promise.all([api.get<{ tiers: TierInfo[] }>("/console/evals/tiers"), api.get<{ jobs: JobView[] }>("/console/evals/jobs")])
      .then(([t, j]) => {
        setTiers(t.tiers);
        setJobs(j.jobs);
        setError(null);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.code === "evals_unavailable") setUnavailable(true);
        else setError(e instanceof ApiError ? errorMessage(e.code) : String(e));
      });
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 正在跑的那个任务（一次只会有一个）——列表里 running 的第一条
  const running = useMemo(() => (jobs ?? []).find((j) => !j.readonly && (j.status === "running" || j.status === "queued")) ?? null, [jobs]);

  useEffect(() => {
    if (!running) {
      setStreamState(null);
      return;
    }
    setProgress({ job: running, finished: false });
    const handle = openEventStream<JobView | { status: string }>(`/console/evals/jobs/${encodeURIComponent(running.id)}/stream`, {
      onEvent: (ev) => {
        // 网关用 event: progress / event: done 两种帧；openEventStream 只给 data——按形状分辨
        const e: ProgressEvent = "tierRuns" in (ev as JobView) ? { type: "progress", job: ev as JobView } : { type: "done", status: (ev as { status: string }).status };
        setProgress((s) => applyProgressEvent(s, e));
        if (e.type === "done") {
          handle.close();
          void reload();
        }
      },
      onState: (s) => setStreamState(s),
    });
    return () => handle.close();
  }, [running, reload]);

  const costConfirm = tiers ? needsCostConfirm(picked, tiers) : false;
  const ids = parseIds(idsRaw);

  const submit = async (): Promise<void> => {
    if (!tiers) return;
    if (costConfirm && !confirming) {
      setConfirming(true);
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await api.post("/console/evals/jobs", { tiers: picked, ids, ...(costConfirm ? { confirmCost: true } : {}) });
      setConfirming(false);
      await reload();
    } catch (e: unknown) {
      setFormError(e instanceof ApiError ? errorMessage(e.isForbidden ? "forbidden" : e.code) : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async (id: string): Promise<void> => {
    try {
      await api.post(`/console/evals/jobs/${encodeURIComponent(id)}/cancel`);
      await reload();
    } catch (e: unknown) {
      setFormError(e instanceof ApiError ? errorMessage(e.isForbidden ? "forbidden" : e.code) : String(e));
    }
  };

  if (unavailable) {
    return (
      <section className="page">
        <h1>评测</h1>
        <p className="error">{errorMessage("evals_unavailable")}</p>
      </section>
    );
  }
  if (error) return <p className="error">加载失败：{error}</p>;

  const live = progress.job && running && progress.job.id === running.id ? progress.job : running;

  return (
    <section className="page">
      <header className="page-head">
        <h1>
          评测
          <Hint label="本页说明">
            <p>四档评测就是四个 runner 档位：场景 fake / real，风险本地 / 全护栏。任务是一个编排进程，产物是一个目录，网关只读它。</p>
            <p>
              <strong>计费档要确认，同时只跑一个</strong>——隔离栈端口只有一套；不排队，排队会让人忘了自己起过什么。
            </p>
            <p>「基线」是仓库提交的那四份产物与六份报告，不起任务也能看。</p>
          </Hint>
        </h1>
        <p className="muted">起一个任务、看它一题一题往前走、点进去读报告和逐题细节。</p>
      </header>

      <h2 className="evals-h2">任务</h2>
      <table className="table evals-jobs">
        <thead>
          <tr>
            <th>任务</th>
            <th>创建</th>
            <th>档位与进度</th>
            <th>状态</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(jobs ?? []).map((j) => {
            const v = live && live.id === j.id ? live : j;
            return (
              <tr key={j.id}>
                <td>
                  <Link to={`/evals/${encodeURIComponent(j.id)}`}>{j.readonly ? "基线（仓库提交的产物）" : j.id}</Link>
                  {j.ids.length > 0 && <span className="muted"> · 只跑 {j.ids.length} 题</span>}
                </td>
                <td className="muted">{fmtTime(j.createdAt)}</td>
                <td>
                  <ul className="evals-tiers">
                    {v.tiers.map((t) => {
                      const run = v.tierRuns[t];
                      const pct = tierPercent(run);
                      const def = tiers?.find((x) => x.id === t);
                      return (
                        <li key={t} className={`evals-tier evals-tier--${run?.status ?? "queued"}`}>
                          <span className="evals-tier-name">
                            <Link to={`/evals/${encodeURIComponent(j.id)}/${t}`} title="打开这个测评的报告与逐题">{t}</Link>
                            {def?.billable && <span className="evals-bill" title="真实 LLM，计费">¥</span>}
                          </span>
                          <span className="evals-bar" aria-hidden>
                            <span className="evals-bar-fill" style={{ width: `${pct ?? 0}%` }} />
                          </span>
                          <span className="evals-count">
                            {run ? (run.selected === null ? (run.status === "running" ? "起栈中…" : statusLabel(run.status)) : `${run.done}/${run.selected}`) : "—"}
                          </span>
                          <span className="evals-score" title={run?.score?.note ?? "总分 / 满分 · 得分率"}>
                            {scoreText(run?.score)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </td>
                <td>
                  <span className={`evals-status evals-status--${v.status}`}>{statusLabel(v.status)}</span>
                  {v.id === running?.id && streamState && (
                    <span className={`evals-dot evals-dot--${streamState}`} title={streamState === "open" ? "进度连接正常" : streamState === "connecting" ? "连接中" : "连接断开"} />
                  )}
                </td>
                <td className="row-cta">
                  {isAdmin && !j.readonly && (v.status === "running" || v.status === "queued") && (
                    <button className="btn btn-secondary btn-sm" onClick={() => void cancel(j.id)}>
                      取消
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2 className="evals-h2">新建任务</h2>
      {!isAdmin && <p className="muted">起跑与取消是管理员动作；运营角色只能查看。</p>}
      {tiers && (
        <div className="evals-new">
          <p className="muted">四个测评各一组，勾一个测评里的一档或几档；汇总读的是本任务其它档的产物，单勾它只会得到一份全是「未跑」的报告。</p>
          <div className="evals-evals">
            {groupByEval(tiers).map((g) => (
              <fieldset key={g.eval.key} className="evals-eval">
                <legend>
                  <strong>{g.eval.title}</strong>
                  {g.eval.dir && <code className="muted"> {g.eval.dir}</code>}
                </legend>
                {g.eval.note && <p className="muted evals-eval-note">{g.eval.note}</p>}
                <div className="evals-picks">
                  {g.tiers.map((t) => (
                    <label key={t.id} className={`evals-pick${picked.includes(t.id) ? " evals-pick--on" : ""}`}>
                      <input
                        type="checkbox"
                        checked={picked.includes(t.id)}
                        disabled={!isAdmin}
                        onChange={(e) => {
                          setConfirming(false);
                          setPicked((p) => (e.target.checked ? [...p, t.id] : p.filter((x) => x !== t.id)));
                        }}
                      />
                      <span>
                        <strong>{t.id}</strong>
                        {t.billable && <span className="evals-bill">¥ 计费</span>}
                        {t.needsAliyun && !t.aliyunKeyPresent && <span className="evals-warn">缺阿里云密钥</span>}
                        <br />
                        <span className="muted">
                          {t.label}
                          {t.hasCases !== false && ` · ${t.cases} 题`}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
          <label className="field">
            <span>只跑这些题 id（可选，逗号分隔；给调试与 e2e 用）</span>
            <input value={idsRaw} disabled={!isAdmin} onChange={(e) => setIdsRaw(e.target.value)} placeholder="o-01, s-41, r-33" />
          </label>
          {confirming && (
            <div className="evals-confirm">
              <strong>确认计费</strong>
              <ul>
                {tierSummary(picked, tiers, ids).map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              <p className="muted">页面不估金额——没有可靠的单价来源。真实档按次调用 DeepSeek；全护栏另有阿里云审核与 LLM 裁判。</p>
            </div>
          )}
          {formError && <p className="error">{formError}</p>}
          <div className="evals-actions">
            <button className="btn" disabled={!isAdmin || submitting || picked.length === 0 || Boolean(running)} onClick={() => void submit()}>
              {running ? "有任务在跑" : costConfirm ? (confirming ? "确认计费并起跑" : "起跑（含计费档）") : "起跑"}
            </button>
            {confirming && (
              <button className="btn btn-secondary" onClick={() => setConfirming(false)}>
                取消
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
