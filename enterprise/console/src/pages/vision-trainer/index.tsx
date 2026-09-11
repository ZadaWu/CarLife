/**
 * 「模型训练」页 `/vision-trainer`（施工单 M76-03，ACR-026）。
 *
 * 四块竖排：模型（列表 + 展开曲线 / 逐类指标 / 验证 / 导出 / 删除）→ 任务（进度 + 取消，running 的开 SSE）
 * → 发起训练（admin）→ 试推理（上传或选评测集照片，预测框与真值框叠画）。
 *
 * # 图片都要带 token 取
 *
 * `<img src>` 带不了 Authorization，曲线图、标注图、评测集照片全部先 `api.blob()` 再 `createObjectURL`，
 * 卸载时 revoke（会话试听的先例）。
 *
 * # 两个 503 要分开说
 *
 * `vision_trainer_not_configured` 是配置（部署没启用这项功能），`vision_trainer_unreachable` 是运维（该起没起）。
 * 两句都写成能复制的命令。
 *
 * # 页面不算指标
 *
 * mAP、轮数、耗时全是服务算好的；这里只显示。叠框的坐标换算（真值 0–1000 归一化 → 像素 → 画布）在 `model.ts`，有单测。
 */

import { Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { api, ApiError } from "../../api";
import { openEventStream, type StreamState } from "../../api/stream";
import { IdentityContext } from "../../app/identity";
import { Hint } from "../../components/Hint";
import {
  applyProgress,
  detectionBoxes,
  errorMessage,
  fitBoxes,
  fmtBytes,
  fmtMetric,
  fmtTime,
  isActive,
  kindLabel,
  percentOf,
  statusLabel,
  truthBoxes,
  type DatasetView,
  type JobView,
  type ModelView,
  type PhotoView,
  type PredictResult,
  type ProgressState,
} from "./model";

const BASE = "/console/vision-trainer";

function codeOf(e: unknown): string {
  if (e instanceof ApiError) return e.isForbidden ? "forbidden" : e.code;
  return String(e);
}

/** 带 token 取图 → objectURL，卸载 / 换图时 revoke。 */
function useObjectUrl(path: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) {
      setUrl(null);
      return;
    }
    let alive = true;
    let current: string | null = null;
    api
      .blob(path)
      .then(({ blob }) => {
        if (!alive) return;
        current = URL.createObjectURL(blob);
        setUrl(current);
      })
      .catch(() => alive && setUrl(null));
    return () => {
      alive = false;
      if (current) URL.revokeObjectURL(current);
    };
  }, [path]);
  return url;
}

function Unavailable({ code }: { code: string }): JSX.Element {
  return (
    <section className="page">
      <h1>模型训练</h1>
      <p className="error">{errorMessage(code)}</p>
      <p className="muted">服务是 enterprise/backend/vision-trainer（Python，宿主机跑，要 MPS）；起来后刷新本页。</p>
    </section>
  );
}

export function VisionTrainerPage(): JSX.Element {
  const identity = useContext(IdentityContext);
  const isAdmin = identity?.role === "admin";

  const [models, setModels] = useState<ModelView[] | null>(null);
  const [datasets, setDatasets] = useState<DatasetView[] | null>(null);
  const [photos, setPhotos] = useState<PhotoView[] | null>(null);
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    return Promise.all([api.get<ModelView[]>(`${BASE}/models`), api.get<DatasetView[]>(`${BASE}/datasets`), api.get<PhotoView[]>(`${BASE}/photos`), api.get<JobView[]>(`${BASE}/jobs`)])
      .then(([m, d, p, j]) => {
        setModels(m);
        setDatasets(d);
        setPhotos(p);
        setJobs(j);
        setUnavailable(null);
        setError(null);
      })
      .catch((e: unknown) => {
        const code = codeOf(e);
        if (code === "vision_trainer_not_configured" || code === "vision_trainer_unreachable") setUnavailable(code);
        else setError(errorMessage(code));
      });
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // ── 任务进度（一次只有一个在跑）
  const running = useMemo(() => (jobs ?? []).find((j) => isActive(j.status)) ?? null, [jobs]);
  const [progress, setProgress] = useState<ProgressState>({ job: null, finished: false });
  const [streamState, setStreamState] = useState<StreamState | null>(null);
  useEffect(() => {
    if (!running) {
      setStreamState(null);
      return;
    }
    setProgress({ job: running, finished: false });
    const handle = openEventStream<JobView | { status: string; error?: string }>(`${BASE}/jobs/${encodeURIComponent(running.id)}/stream`, {
      onEvent: (ev) => {
        if ("kind" in ev) setProgress((s) => applyProgress(s, { type: "progress", job: ev }));
        else {
          setProgress((s) => applyProgress(s, { type: "done", status: ev.status, error: ev.error }));
          handle.close();
          void reload();
        }
      },
      onState: (s) => setStreamState(s),
    });
    return () => handle.close();
  }, [running, reload]);

  // ── 发起训练
  const [form, setForm] = useState({ dataset: "", base: "yolo11n.pt", epochs: 30, patience: 10, imgsz: 640, batch: 16, name: "" });
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (datasets && datasets.length > 0 && !form.dataset) setForm((f) => ({ ...f, dataset: datasets[0].name }));
  }, [datasets, form.dataset]);

  const createJob = async (kind: "train" | "val" | "export", params: Record<string, unknown>): Promise<void> => {
    setSubmitting(true);
    setFormError(null);
    try {
      await api.post(`${BASE}/jobs`, { kind, params });
      await reload();
    } catch (e: unknown) {
      setFormError(errorMessage(codeOf(e)));
    } finally {
      setSubmitting(false);
    }
  };
  const deleteJob = async (id: string): Promise<void> => {
    try {
      await api.del(`${BASE}/jobs/${encodeURIComponent(id)}`);
      await reload();
    } catch (e: unknown) {
      setFormError(errorMessage(codeOf(e)));
    }
  };

  // ── 模型展开
  const [openModel, setOpenModel] = useState<string | null>(null);
  const curveUrl = useObjectUrl(openModel ? `${BASE}/jobs/${encodeURIComponent(openModel)}/files/results.png` : null);
  const cmUrl = useObjectUrl(openModel ? `${BASE}/jobs/${encodeURIComponent(openModel)}/files/confusion_matrix.png` : null);

  // ── 试推理
  const [predModel, setPredModel] = useState("");
  const [conf, setConf] = useState(0.25);
  const [source, setSource] = useState<{ kind: "upload"; file: File } | { kind: "photo"; id: string } | null>(null);
  const [predicting, setPredicting] = useState(false);
  const [predError, setPredError] = useState<string | null>(null);
  const [result, setResult] = useState<PredictResult | null>(null);
  const [showTruth, setShowTruth] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (models && models.length > 0 && !predModel) setPredModel(models[0].id);
  }, [models, predModel]);
  const photoUrl = useObjectUrl(source?.kind === "photo" ? `${BASE}/photos/${encodeURIComponent(source.id)}/image` : null);
  const uploadUrl = useMemo(() => (source?.kind === "upload" ? URL.createObjectURL(source.file) : null), [source]);
  useEffect(() => () => void (uploadUrl && URL.revokeObjectURL(uploadUrl)), [uploadUrl]);
  const imageUrl = source?.kind === "upload" ? uploadUrl : photoUrl;
  const selectedPhoto = source?.kind === "photo" ? (photos ?? []).find((p) => p.id === source.id) ?? null : null;

  const predict = async (): Promise<void> => {
    if (!source || !predModel) return;
    setPredicting(true);
    setPredError(null);
    setResult(null);
    try {
      const q = `?model=${encodeURIComponent(predModel)}&conf=${conf}`;
      const r =
        source.kind === "upload"
          ? await api.postBinary<PredictResult>(`${BASE}/predict${q}`, await source.file.arrayBuffer(), source.file.type || "image/png")
          : await api.post<PredictResult>(`${BASE}/predict${q}&photo=${encodeURIComponent(source.id)}`);
      setResult(r);
    } catch (e: unknown) {
      setPredError(errorMessage(codeOf(e)));
    } finally {
      setPredicting(false);
    }
  };

  // 叠框：原图画到画布（宽 720），预测框实线、真值框虚线
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageUrl) return;
    const img = new Image();
    img.onload = () => {
      const canvasW = 720;
      const fit = fitBoxes([], img.naturalWidth, img.naturalHeight, canvasW);
      canvas.width = canvasW;
      canvas.height = fit.canvasH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, canvasW, fit.canvasH);
      ctx.lineWidth = 2;
      ctx.font = "12px ui-monospace, monospace";
      if (showTruth) {
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = "#e8a33d";
        ctx.fillStyle = "#e8a33d";
        for (const b of fitBoxes(truthBoxes(selectedPhoto, img.naturalWidth, img.naturalHeight), img.naturalWidth, img.naturalHeight, canvasW).boxes) {
          ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
          ctx.fillText(b.label, b.x1, b.y2 + 12);
        }
      }
      if (result) {
        ctx.setLineDash([]);
        ctx.strokeStyle = "#3aa76d";
        ctx.fillStyle = "#3aa76d";
        for (const b of fitBoxes(detectionBoxes(result.detections), result.imageW, result.imageH, canvasW).boxes) {
          ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
          ctx.fillText(b.label, b.x1, b.y1 - 3);
        }
      }
    };
    img.src = imageUrl;
  }, [imageUrl, result, selectedPhoto, showTruth]);

  if (unavailable) return <Unavailable code={unavailable} />;
  if (error) return <p className="error">加载失败：{error}</p>;

  const live = progress.job && running && progress.job.id === running.id ? progress.job : null;

  return (
    <section className="page">
      <header className="page-head">
        <h1>
          模型训练
          <Hint label="本页说明">
            <p>警示灯小检测器的工作台：训练、验证、导出、拿一张照片试。训练在本机 MPS 上跑，一次一个，其余排队。</p>
            <p>
              <strong>指标只在真实数据集上有意义</strong>——合成集（synth-tesla01）的图标与底图同源于一张照片，mAP 只证明流程没断。
            </p>
            <p>轮数是上限，不是必须跑满的数：验证集 mAP 连续 patience 轮不涨就早停。</p>
          </Hint>
        </h1>
        <p className="muted">检测器不在问诊链路里；它进链路前要过 ACR。这里是给数据到位后比较各版模型用的。</p>
      </header>

      <h2 className="evals-h2">模型</h2>
      {models && models.length === 0 && <p className="muted">还没有模型——下面发起一次训练，训完的任务目录里有 weights/best.pt 就会出现在这里。</p>}
      {models && models.length > 0 && (
        <table className="table table-clickable">
          <thead>
            <tr>
              {/*
                每列一个问号：这张表里除了「名称」和「创建」，其余每一栏都是术语，
                而读它的人是运营不是炼丹的。解释写在离数字最近的地方，不写在页面顶部——
                顶部那段说明谁都不会为了看懂一列数字滚回去读。
              */}
              <th>
                名称
                <Hint label="名称怎么来的" align="left">
                  <p>发起训练时填的「名字」，没填就用任务号顶上。</p>
                  <p>
                    下面那行灰字<strong>始终</strong>是任务号（<code>train-日期-时分秒-随机</code>），产物目录、权重文件都在
                    <code>evals/runs/vision-trainer/&lt;任务号&gt;/</code> 下，名字只是给人看的。
                  </p>
                </Hint>
              </th>
              <th>
                数据集
                <Hint label="数据集是什么">
                  <p>这一版模型是拿哪一批标注好的图训出来的。</p>
                  <p>
                    <strong>只有同一个数据集训出来的模型才好横着比</strong>——换了数据集，下面几栏的分数就不是一个尺子量的了。
                  </p>
                </Hint>
              </th>
              <th>
                基座
                <Hint label="基座是什么">
                  <p>从哪一份现成的权重开始训，<strong>不是从零开始</strong>。</p>
                  <p>
                    <code>yolo11n</code> 是在 COCO（80 类日常物体）上预训练好的最小号模型：它已经会「什么是一个物体、边缘长什么样」，
                    我们只是再教它认警示灯，所以几十轮就够，不用几千轮。
                  </p>
                  <p>也可以挑一个已有的模型当基座接着训——数据集扩充后想在旧模型上继续，就选它。</p>
                </Hint>
              </th>
              <th>
                轮数
                <Hint label="轮数是什么">
                  <p>
                    <strong>实际跑完</strong>的轮数，不是发起时填的那个上限——验证集分数连续若干轮不涨就提前停了。
                  </p>
                  <p>
                    一轮 = 把训练集的图全部看一遍。每轮看到的都是随机裁剪、变亮变暗、翻转过的版本，所以不是同一批图简单重复。
                  </p>
                </Hint>
              </th>
              <th>
                mAP50
                <Hint label="mAP50 是什么">
                  <p>
                    <strong>0 到 1，越大越好</strong>。宽松口径的准确度：模型画的框和标注框重叠过半（IoU ≥ 0.5）就算「找对了」，再对所有类别取平均。
                  </p>
                  <p>它回答的是「该找的有没有找到、有没有乱框」，不管框贴得准不准。</p>
                </Hint>
              </th>
              <th>
                mAP50-95
                <Hint label="mAP50-95 是什么" align="right">
                  <p>严格口径：把「算重叠」的门槛从 0.5 一路提到 0.95，十档各算一次再平均。考的是<strong>框贴不贴</strong>。</p>
                  <p>
                    它<strong>永远低于 mAP50</strong>。两者差得多，说明模型找得到东西但框歪；差得少，说明框也画得准。
                  </p>
                </Hint>
              </th>
              <th>
                权重
                <Hint label="权重是什么" align="right">
                  <p>训练产物 <code>best.pt</code> 的文件大小——模型本体就是这个文件。</p>
                  <p>
                    存的是<strong>验证集上表现最好的那一轮</strong>，不是最后一轮：训练后期分数可能回落，留最后一轮反而更差。
                  </p>
                </Hint>
              </th>
              <th>
                ONNX
                <Hint label="ONNX 是什么" align="right">
                  <p>有没有额外导出成 ONNX 这种跨框架格式。这一栏是「—」就是还没导，点开这一行有「导出 ONNX」。</p>
                  <p>
                    导出后<strong>不装 PyTorch 也能推理</strong>，是把模型放到车机端或别的语言里跑的前提；训练与试推理本身用不到它。
                  </p>
                </Hint>
              </th>
              <th>创建</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <Fragment key={m.id}>
                <tr onClick={() => setOpenModel(openModel === m.id ? null : m.id)} tabIndex={0}>
                  <td>
                    <strong>{m.name}</strong>
                    <br />
                    <code className="muted">{m.id}</code>
                  </td>
                  <td>{m.dataset ?? "—"}</td>
                  <td>{m.base ?? "—"}</td>
                  <td>{m.epochsRun ?? "—"}</td>
                  <td className="vt-num">{fmtMetric(m.mAP50)}</td>
                  <td className="vt-num">{fmtMetric(m.mAP50_95)}</td>
                  <td>{fmtBytes(m.weightsBytes)}</td>
                  <td>{m.onnx ? fmtBytes(m.onnxBytes) : "—"}</td>
                  <td className="muted">{fmtTime(m.createdAt)}</td>
                </tr>
                {openModel === m.id && (
                  <tr className="vt-detail">
                    <td colSpan={9}>
                      <div className="vt-detail-grid">
                        <div>
                          <h3>训练曲线</h3>
                          {curveUrl ? <img src={curveUrl} alt="results.png" className="vt-img" /> : <p className="muted">没有 results.png（不是训练任务，或还没训完）</p>}
                        </div>
                        <div>
                          <h3>混淆矩阵</h3>
                          {cmUrl ? <img src={cmUrl} alt="confusion_matrix.png" className="vt-img" /> : <p className="muted">没有混淆矩阵图</p>}
                        </div>
                        <div>
                          <h3>逐类 mAP50</h3>
                          {m.perClass ? (
                            <ul className="vt-list">
                              {Object.entries(m.perClass).map(([k, v]) => (
                                <li key={k}>
                                  <code>{k}</code> <span className="vt-num">{fmtMetric(v)}</span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="muted">—</p>
                          )}
                          {isAdmin && (
                            <div className="evals-actions">
                              <button className="btn btn-sm" disabled={submitting} onClick={() => void createJob("val", { model: m.id })}>
                                验证
                              </button>
                              <button className="btn btn-sm btn-secondary" disabled={submitting || m.onnx} onClick={() => void createJob("export", { model: m.id, format: "onnx" })}>
                                {m.onnx ? "已导出 ONNX" : "导出 ONNX"}
                              </button>
                              <button className="btn btn-sm btn-secondary" disabled={submitting} onClick={() => void deleteJob(m.id)}>
                                删除
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="evals-h2">任务</h2>
      <table className="table">
        <thead>
          <tr>
            <th>任务</th>
            <th>动作</th>
            <th>进度</th>
            <th>状态</th>
            <th>创建</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(jobs ?? []).map((j) => {
            const v = live && live.id === j.id ? live : j;
            const pct = percentOf(v);
            return (
              <tr key={j.id}>
                <td>
                  <code>{j.id}</code>
                  {typeof j.params.name === "string" && j.params.name && <span className="muted"> · {j.params.name}</span>}
                </td>
                <td>
                  {kindLabel(j.kind)}
                  {j.kind === "train" && <span className="muted"> · {String(j.params.dataset)} · {String(j.params.epochs)} 轮</span>}
                  {j.kind !== "train" && <span className="muted"> · {String(j.params.model)}</span>}
                </td>
                <td>
                  {v.kind === "train" && v.progress ? (
                    <span className="vt-progress">
                      <span className="evals-bar" aria-hidden>
                        <span className="evals-bar-fill" style={{ width: `${pct ?? 0}%` }} />
                      </span>
                      <span className="evals-count">
                        {v.progress.epoch}/{v.progress.epochs} 轮 · mAP50 {fmtMetric(v.progress.mAP50)}
                      </span>
                    </span>
                  ) : (
                    <span className="muted">{v.status === "done" ? "完成" : v.status === "running" ? "运行中…" : "—"}</span>
                  )}
                </td>
                <td>
                  <span className={`evals-status evals-status--${v.status}`}>{statusLabel(v.status)}</span>
                  {v.error && <span className="evals-warn"> {v.error}</span>}
                  {v.id === running?.id && streamState && <span className={`evals-dot evals-dot--${streamState}`} title={streamState === "open" ? "进度连接正常" : streamState === "connecting" ? "连接中" : "连接断开"} />}
                </td>
                <td className="muted">{fmtTime(j.createdAt)}</td>
                <td className="row-cta">
                  {isAdmin && (
                    <button className="btn btn-secondary btn-sm" onClick={() => void deleteJob(j.id)}>
                      {isActive(v.status) ? "取消" : "删除"}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {jobs && jobs.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                还没有任务
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2 className="evals-h2">发起训练</h2>
      {!isAdmin && <p className="muted">发起、取消与删除是管理员动作；运营角色只能查看。</p>}
      <div className="evals-new vt-form">
        <div className="vt-form-row">
          <label className="field">
            <span>数据集</span>
            <select value={form.dataset} disabled={!isAdmin} onChange={(e) => setForm({ ...form, dataset: e.target.value })}>
              {(datasets ?? []).map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name} · {d.classes.length} 类 · {d.train}/{d.val}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>基座</span>
            <select value={form.base} disabled={!isAdmin} onChange={(e) => setForm({ ...form, base: e.target.value })}>
              <option value="yolo11n.pt">yolo11n（最小，2.6M 参数）</option>
              <option value="yolo11s.pt">yolo11s</option>
              {(models ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  继续训：{m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>轮数上限（早停 patience 轮不涨就停）</span>
            <input type="number" min={1} max={300} value={form.epochs} disabled={!isAdmin} onChange={(e) => setForm({ ...form, epochs: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>patience</span>
            <input type="number" min={1} max={100} value={form.patience} disabled={!isAdmin} onChange={(e) => setForm({ ...form, patience: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>图片尺寸</span>
            <select value={form.imgsz} disabled={!isAdmin} onChange={(e) => setForm({ ...form, imgsz: Number(e.target.value) })}>
              {[320, 480, 640, 960].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>批大小</span>
            <input type="number" min={1} max={64} value={form.batch} disabled={!isAdmin} onChange={(e) => setForm({ ...form, batch: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>名字（可选）</span>
            <input value={form.name} disabled={!isAdmin} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如 synth-30ep" />
          </label>
        </div>
        {formError && <p className="error">{formError}</p>}
        <div className="evals-actions">
          <button
            className="btn"
            disabled={!isAdmin || submitting || !form.dataset}
            onClick={() => void createJob("train", { dataset: form.dataset, base: form.base, epochs: form.epochs, patience: form.patience, imgsz: form.imgsz, batch: form.batch, ...(form.name ? { name: form.name } : {}) })}
          >
            {running ? "排队训练" : "开始训练"}
          </button>
        </div>
      </div>

      <h2 className="evals-h2">试推理</h2>
      <div className="evals-new vt-form">
        <div className="vt-form-row">
          <label className="field">
            <span>模型</span>
            <select value={predModel} onChange={(e) => setPredModel(e.target.value)}>
              {(models ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>置信度阈值 {conf.toFixed(2)}</span>
            <input type="range" min={0.05} max={0.95} step={0.05} value={conf} onChange={(e) => setConf(Number(e.target.value))} />
          </label>
          <label className="field">
            <span>上传照片</span>
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => e.target.files?.[0] && (setSource({ kind: "upload", file: e.target.files[0] }), setResult(null))} />
          </label>
          <label className="field">
            <span>或选评测集照片（带真值框）</span>
            <select value={source?.kind === "photo" ? source.id : ""} onChange={(e) => e.target.value && (setSource({ kind: "photo", id: e.target.value }), setResult(null))}>
              <option value="">—</option>
              {(photos ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} · {p.vehicle ?? ""} · {p.items.filter((i) => i.category === "warning_light").length} 灯
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="evals-actions">
          <button className="btn" disabled={!source || !predModel || predicting} onClick={() => void predict()}>
            {predicting ? "推理中…" : "推理"}
          </button>
          {selectedPhoto && (
            <label className="vt-inline">
              <input type="checkbox" checked={showTruth} onChange={(e) => setShowTruth(e.target.checked)} /> 叠画真值框（虚线）
            </label>
          )}
        </div>
        {predError && <p className="error">{predError}</p>}
        {imageUrl && (
          <div className="vt-canvas-wrap">
            <canvas ref={canvasRef} className="vt-canvas" />
            <p className="muted vt-legend">
              <span className="vt-legend-pred">━</span> 预测框（类别 置信度） <span className="vt-legend-truth">╌</span> 真值框（symbol_id）
            </p>
          </div>
        )}
        {result && (
          <div>
            <p className="muted">
              {result.detections.length} 个检出 · {result.ms.toFixed(0)} ms · 原图 {result.imageW}×{result.imageH}
              {result.detections.length === 0 && " · 没有高于阈值的框：把阈值拉低，或者这个模型训得还不够"}
            </p>
            {result.detections.length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th>类别</th>
                    <th>置信度</th>
                    <th>框（x1, y1, x2, y2）</th>
                  </tr>
                </thead>
                <tbody>
                  {result.detections.map((d, i) => (
                    <tr key={i}>
                      <td>
                        <code>{d.name}</code>
                      </td>
                      <td className="vt-num">{d.conf.toFixed(3)}</td>
                      <td className="vt-num">{d.xyxy.map((v) => Math.round(v)).join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
