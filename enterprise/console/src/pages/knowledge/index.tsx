/**
 * 知识库管理（施工单 M8-01 后台部分，FL-24）。
 *
 * # 这一页的存在理由是"看得见切分"
 *
 * §6 把解析与切分交给了 RAGFlow，我们保留的是可见性而非控制权。
 * 说明书里最有价值的内容（保养周期表、故障码表、操作步骤表）恰恰最容易被切坏，
 * 而切坏之后检索**仍然会返回结果**——只是那些结果没用。
 * 没有这一页，"知识库有没有问题"就只能等到用户问出一个答不上来的问题才知道。
 *
 * # 三处刻意的措辞
 *
 * 1. 状态一律说到**解析**层面，不说"上传成功"。
 * 2. 零命中标成"信息"不是"错误"——它说明这个问题当前答不了，正是要先知道的事。
 * 3. `repair-kb` 始终标注"模拟数据"，不冒充真实厂商资料（F-24-11）。
 */

import { useCallback, useEffect, useState } from "react";

import { api, ApiError } from "../../api";
import { Hint } from "../../components/Hint";
import "./knowledge.css";

type ParseStatus = "queued" | "parsing" | "succeeded" | "failed";

interface DatasetInfo {
  key: string;
  name: string;
  consumers: string[];
  provenance: "public" | "simulated";
  configured: boolean;
}

interface DocumentStatus {
  documentId: string;
  name: string;
  status: ParseStatus;
  error?: string;
  chunkCount?: number;
}

interface ChunkPreview {
  index: number;
  content: string;
  looksTabular: boolean;
}

interface ChunksResponse {
  chunks: ChunkPreview[];
  suspicious: Array<{ index: number; why: string }>;
}

interface RetrievalTest {
  query: string;
  empty: boolean;
  hits: Array<{ document: string; location?: string; score: number; excerpt: string }>;
}

const STATUS_TEXT: Record<ParseStatus, string> = {
  queued: "排队中",
  parsing: "解析中",
  succeeded: "解析完成",
  failed: "解析失败",
};

/** 触发过双路的一轮（清单项）。 */
interface DualTurnRow {
  sessionId: string;
  turnId: string;
  at: number;
  question: string | null;
  personalized: boolean;
  ragChunks: number;
  usageUsable: boolean;
}

/** 一轮双路的完整明细。`detail` 就是轨迹里那条 merge 事件的载荷。 */
interface DualTurnDetail {
  sessionId: string;
  turnId: string;
  at: number;
  question: string | null;
  answer: string | null;
  detail: {
    personalized?: boolean;
    caveats?: string[];
    ragChunks?: number;
    vehicleModel?: string | null;
    ragTop?: Array<{ text: string; document: string; location: string | null }>;
    usageSummary?: {
      avgDailyKm: number;
      lowTempRangeKm?: number;
      mildTempRangeKm?: number;
      sampleSize: number;
    } | null;
    usageUnusableReason?: string | null;
    context?: string;
  };
}

export function KnowledgePage(): JSX.Element {
  /** 双路对照的状态。与上面的单路检索测试各管各的——它们回答的是不同问题。 */
  const [turns, setTurns] = useState<DualTurnRow[] | null>(null);
  const [pickedTurn, setPickedTurn] = useState<string>("");
  const [dual, setDual] = useState<DualTurnDetail | null>(null);
  const [dualState, setDualState] = useState<"idle" | "loading" | "error">("idle");
  const [dualError, setDualError] = useState<string | null>(null);
  /**
   * 对照：同一段上下文去掉用车数据后再答一次。
   * **按需生成**——一次 LLM 调用十几秒且花钱，不该在打开页面时就跑。
   */
  const [contrast, setContrast] = useState<{ contrastContext: string; answer: string } | null>(null);
  const [contrastState, setContrastState] = useState<"idle" | "running" | "error">("idle");
  const [contrastError, setContrastError] = useState<string | null>(null);

  const [datasets, setDatasets] = useState<DatasetInfo[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [docs, setDocs] = useState<DocumentStatus[] | null>(null);
  const [notConfigured, setNotConfigured] = useState<string | null>(null);
  const [openDoc, setOpenDoc] = useState<string | null>(null);
  const [chunks, setChunks] = useState<ChunksResponse | null>(null);
  const [query, setQuery] = useState("");
  const [test, setTest] = useState<RetrievalTest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ datasets: DatasetInfo[] }>("/console/knowledge/datasets")
      .then((r) => {
        setDatasets(r.datasets);
        if (r.datasets.length > 0) setActive(r.datasets[0].key);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.code : String(e)));
  }, []);

  const loadDocs = useCallback(() => {
    if (!active) return;
    setDocs(null);
    setNotConfigured(null);
    setOpenDoc(null);
    setChunks(null);
    api
      .get<{ documents: DocumentStatus[] }>(`/console/knowledge/${active}/documents`)
      .then((r) => setDocs(r.documents))
      .catch((e: unknown) => {
        // 未接入不是错误，是一个要如实说出来的状态。
        if (e instanceof ApiError && e.code === "not_configured") {
          setNotConfigured("RAGFlow 未接入：在系统配置里填 RAGFLOW_BASE_URL / API_KEY / 三个数据集 id。");
          return;
        }
        setError(e instanceof ApiError ? e.code : String(e));
      });
  }, [active]);

  useEffect(loadDocs, [loadDocs]);

  function openChunks(documentId: string): void {
    setOpenDoc(documentId);
    setChunks(null);
    api
      .get<ChunksResponse>(`/console/knowledge/${active}/documents/${documentId}/chunks`)
      .then(setChunks)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.code : String(e)));
  }

  function upload(file: File): void {
    setError(null);
    fetch(`/console/knowledge/${active}/documents`, {
      method: "POST",
      headers: {
        "content-type": file.type || "application/octet-stream",
        // 中文文件名必须 percent-encode——HTTP 头是 ByteString。
        "x-filename": encodeURIComponent(file.name),
        authorization: `Bearer ${localStorage.getItem("carlife.console.token") ?? ""}`,
      },
      body: file,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(((await r.json()) as { reason?: string }).reason ?? `HTTP ${r.status}`);
        // 上传只是开始。**解析没跑完之前检索什么都查不到**，
        // 所以这里刷新列表让用户看到"解析中"，而不是弹一句"上传成功"就完事。
        loadDocs();
      })
      .catch((e: unknown) => setError(String(e)));
  }

  function runTest(): void {
    if (!active || !query.trim()) return;
    setTest(null);
    api
      .get<RetrievalTest>(`/console/knowledge/${active}/retrieval-test?q=${encodeURIComponent(query)}`)
      .then(setTest)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.code : String(e)));
  }

  /*
   * 清单：只列**真的跑完双路**的轮次。判据是轨迹里那条带 personalized 的
   * merge 事件——路由到用车/售后不等于跑了双路（问诊留档那一支直接返回、不查库）。
   */
  useEffect(() => {
    api
      .get<{ turns: DualTurnRow[] }>("/console/knowledge/dual-turns?limit=30")
      .then((r) => {
        setTurns(r.turns);
        // 默认落到最近一轮：这一页打开就该有东西看，而不是先让人挑。
        if (r.turns[0]) setPickedTurn(r.turns[0].turnId);
      })
      .catch(() => setTurns([]));
  }, []);

  useEffect(() => {
    if (!pickedTurn) return;
    setDual(null);
    setDualError(null);
    setDualState("loading");
    // 换了一轮就把上一轮的对照清掉：留着会让人以为这是当前这轮的对照。
    setContrast(null);
    setContrastState("idle");
    setContrastError(null);
    api
      .get<DualTurnDetail>(`/console/knowledge/dual-turns/${encodeURIComponent(pickedTurn)}`)
      .then((r) => {
        setDual(r);
        setDualState("idle");
      })
      .catch((e: unknown) => {
        setDualError(e instanceof ApiError ? e.code : String(e));
        setDualState("error");
      });
  }, [pickedTurn]);

  function runContrast(): void {
    if (!pickedTurn) return;
    setContrastError(null);
    setContrastState("running");
    api
      .post<{ contrastContext: string; answer: string }>(
        `/console/knowledge/dual-turns/${encodeURIComponent(pickedTurn)}/contrast`,
      )
      .then((r) => {
        setContrast(r);
        setContrastState("idle");
      })
      .catch((e: unknown) => {
        setContrastError(e instanceof ApiError ? e.code : String(e));
        setContrastState("error");
      });
  }

  if (error) return <p className="kb-banner kb-banner--err">加载失败：{error}</p>;

  const current = datasets?.find((d) => d.key === active);

  return (
    <section className="kb-page">
      <h1>知识库管理</h1>
      <p className="kb-desc">
        解析与切分由 RAGFlow 承担，本页保留的是可见性——最有价值的表格内容也最容易被切坏，
        而切坏之后检索仍然会返回结果。
      </p>

      {/* ── 数据集卡片：消费方与数据来源一眼可见 ── */}
      <div className="kb-datasets">
        {(datasets ?? []).map((d) => (
          <button type="button" key={d.key} className={`kb-ds${d.key === active ? " kb-ds--active" : ""}`} onClick={() => setActive(d.key)}>
            <span className="kb-ds-head">
              <b>{d.name}</b>
              <span className="kb-ds-key">{d.key}</span>
            </span>
            <span className="kb-ds-consumers">
              {d.consumers.map((c) => (
                <span key={c} className="kb-chip">{c}</span>
              ))}
              {d.provenance === "simulated" && <span className="kb-chip kb-chip--warn">模拟数据</span>}
              {!d.configured && <span className="kb-chip kb-chip--unset">未配置</span>}
            </span>
          </button>
        ))}
      </div>

      <div className="kb-toolbar">
        <label className="kb-upload">
          上传文档
          <input
            type="file"
            accept=".pdf,.md,.txt,.docx,.html"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
              e.target.value = "";
            }}
          />
        </label>
        <button type="button" className="kb-ghost" onClick={loadDocs}>
          刷新
        </button>
      </div>
      <p className="kb-note">
        上传后会自动触发解析。<strong>解析完成前检索不到任何内容</strong>——所以下面看的是解析状态，不是“上传成功”。
      </p>

      {current?.provenance === "simulated" && (
        <p className="kb-banner kb-banner--warn">
          本数据集是<strong>模拟数据</strong>，不是真实厂商资料。引用它的回答必须带此标注。
        </p>
      )}

      {notConfigured && <p className="kb-banner">{notConfigured}</p>}

      {docs && (
        <section className="kb-card">
          <h2>文档与解析状态</h2>
          <p className="kb-card-sub">
            状态说到解析层面，不说“上传成功”——文件传上去了但解析失败，检索时什么都查不到。
          </p>
          {docs.length === 0 ? (
            <p className="kb-empty">这个数据集里还没有文档。</p>
          ) : (
            <table className="kb-table">
              <thead>
                <tr>
                  <th>文档</th>
                  <th>状态</th>
                  <th>切片数</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.documentId}>
                    <td className="kb-doc-name">{d.name}</td>
                    <td>
                      <span className={`kb-status kb-status--${d.status}`}>
                        <i />
                        {STATUS_TEXT[d.status]}
                      </span>
                      {d.error && <div className="kb-doc-error">{d.error}</div>}
                    </td>
                    <td className="kb-num">{d.chunkCount ?? "—"}</td>
                    <td>
                      <button type="button" className="kb-ghost" onClick={() => openChunks(d.documentId)}>
                        看切分
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {openDoc && (
        <section className="kb-card">
          <h2>切分预览</h2>
          {chunks === null ? (
            <p className="kb-note">加载中…</p>
          ) : (
            <>
              {chunks.suspicious.length > 0 ? (
                <div className="kb-suspicious">
                  <strong>这些切片值得先看一眼：</strong>
                  <ul>
                    {chunks.suspicious.map((s, i) => (
                      <li key={`${s.index}-${i}`}>
                        #{s.index}：{s.why}
                      </li>
                    ))}
                  </ul>
                  <p className="kb-note">这是提示不是判定——它只把最可能出问题的地方挑出来，切得好不好最终要人看。</p>
                </div>
              ) : (
                <p className="kb-card-sub">启发式检查没发现明显问题。这不等于切得好，只等于没触发已知的坏模式。</p>
              )}
              <ol className="kb-chunks">
                {chunks.chunks.map((c) => (
                  <li key={c.index} className={c.looksTabular ? "kb-chunk kb-chunk--tabular" : "kb-chunk"}>
                    <span className="kb-chunk-head">
                      #{c.index}
                      {c.looksTabular && <span className="kb-chip kb-chip--warn">疑似表格</span>}
                    </span>
                    <pre>{c.content}</pre>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      )}

      {/*
        双路检索：**看真实发生过的那一轮**，不是现场重跑一个问题。
        重跑的检索结果未必与当时相同（知识库与用车数据都在变），
        演示时被追问"这是刚查的还是当时就这样"，重跑答不上来。
        放在单路检索测试之前：那条是知识库运维，这条是产品主张。
      */}
      <section className="kb-card kb-dual">
        <h2>
          双路检索：通用手册 × 这辆车
          <Hint label="双路检索说明">
            <p>
              用车助手与售后的检索是<strong>两路并发</strong>：一路 RAGFlow（通用原理，带出处），
              一路 ⑥用车数据（这辆车的真实使用情况）。
            </p>
            <p>
              只查前者会得到<strong>任何人问都一样</strong>的通用答案。
              个性化不是靠提示词说"请个性化"，是靠后者那几个数字真的进了上下文。
            </p>
            <p>
              下面这些是<strong>真实跑过的轮次</strong>，不是现场重跑——
              判据是轨迹里那条带 personalized 的 merge 事件：路由到用车/售后不等于跑了双路
              （问诊留档那一支直接返回、不查知识库）。
            </p>
          </Hint>
        </h2>
        <p className="kb-card-sub">挑一轮真实对话，看它当时用了什么、怎么答的。</p>

        <div className="kb-turnpick">
          <label>
            <span>轮次</span>
            <select value={pickedTurn} onChange={(e) => setPickedTurn(e.target.value)}>
              {(turns ?? []).map((t) => (
                <option key={t.turnId} value={t.turnId}>
                  {t.question ? t.question.slice(0, 40) : `（无问题文本）${t.turnId}`}
                  {" · "}
                  {t.personalized ? "个性化" : "通用"}
                  {" · "}
                  {new Date(t.at).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          {turns && turns.length === 0 && (
            <span className="kb-note">还没有跑过双路的轮次。在车机上问一句"我这车续航掉得正常吗"。</span>
          )}
        </div>

        {dualState === "loading" && <p className="kb-note">读取这一轮的轨迹…</p>}
        {dualState === "error" && <p className="kb-banner kb-banner--err">读取失败：{dualError}</p>}

        {dual && (
          <>
            <div className={dual.detail.personalized ? "kb-verdict kb-verdict--on" : "kb-verdict"}>
              <b>{dual.detail.personalized ? "✓ 这一轮给出了个性化回答" : "✗ 这一轮只能给通用回答"}</b>
              <span className="kb-verdict-why">
                {dual.detail.personalized
                  ? "两路都拿到了实质内容——通用原理有出处，这辆车的数据也在。"
                  : "少了一路。提示词里会明确要求模型不要暗示这是针对这辆车的结论。"}
                {dual.detail.vehicleModel ? ` · 检索限定车型：${dual.detail.vehicleModel}` : " · 未限定车型"}
              </span>
              {(dual.detail.caveats?.length ?? 0) > 0 && (
                <ul className="kb-caveats">
                  {dual.detail.caveats!.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              )}
            </div>

            {/* ① 两路的输入 */}
            <div className="kb-dual-grid">
              <div className="kb-lane">
                <div className="kb-lane-head">
                  <span className="kb-lane-tag">路 1</span>
                  <b>通用手册（RAGFlow）</b>
                  <span className="spacer" />
                  <span className="kb-lane-count">命中 {dual.detail.ragChunks ?? 0} 段</span>
                </div>
                {(dual.detail.ragTop?.length ?? 0) === 0 ? (
                  <p className="kb-note">
                    这一轮没有留下段落明细（明细自 2026-08-28 起才落轨迹，更早的轮次只有计数）。
                  </p>
                ) : (
                  <ul className="kb-chunks">
                    {dual.detail.ragTop!.map((c, i) => (
                      <li key={i}>
                        <p>{c.text}…</p>
                        <span className="kb-src">
                          {c.document}
                          {c.location ? ` · ${c.location}` : ""}
                        </span>
                      </li>
                    ))}
                    {(dual.detail.ragChunks ?? 0) > dual.detail.ragTop!.length && (
                      <li className="kb-note">
                        另有 {dual.detail.ragChunks! - dual.detail.ragTop!.length} 段未留档（只存前 4 段）。
                      </li>
                    )}
                  </ul>
                )}
                <p className="kb-lane-foot">
                  这一路<b>与"谁在问"无关</b>——同一个问题，所有用户拿到的是同一批内容。
                </p>
              </div>

              <div className="kb-lane kb-lane--mine">
                <div className="kb-lane-head">
                  <span className="kb-lane-tag kb-lane-tag--mine">路 2</span>
                  <b>这辆车的真实数据（⑥用车）</b>
                  <span className="spacer" />
                  <span className="kb-lane-count">
                    {dual.detail.usageSummary ? `${dual.detail.usageSummary.sampleSize} 条行程` : "不可用"}
                  </span>
                </div>
                {dual.detail.usageSummary ? (
                  <dl className="kb-facts">
                    <div>
                      <dt>近期日均里程</dt>
                      <dd>{dual.detail.usageSummary.avgDailyKm.toFixed(1)} km</dd>
                    </div>
                    {dual.detail.usageSummary.mildTempRangeKm !== undefined && (
                      <div>
                        <dt>常温实测续航</dt>
                        <dd>{dual.detail.usageSummary.mildTempRangeKm.toFixed(0)} km</dd>
                      </div>
                    )}
                    {dual.detail.usageSummary.lowTempRangeKm !== undefined && (
                      <div>
                        <dt>低温实测续航</dt>
                        <dd>{dual.detail.usageSummary.lowTempRangeKm.toFixed(0)} km</dd>
                      </div>
                    )}
                  </dl>
                ) : (
                  <p className="kb-note kb-note--err">
                    {dual.detail.usageUnusableReason ?? "这一路当时没有可用数据"}
                  </p>
                )}
                <p className="kb-lane-foot">
                  这一路<b>只属于这辆车</b>——它把"续航掉得正常吗"从常识题变成了判断题。
                </p>
              </div>
            </div>

            {/* ② 合成的提示词 → ③ 模型答的 */}
            <div className="kb-flow">
              <div className="kb-flow-step">
                <div className="kb-step-head">
                  <span className="kb-step-no">合成</span>
                  <b>两路合起来喂给模型的上下文</b>
                  <span className="spacer" />
                  <span className="kb-lane-count">{dual.detail.context?.length ?? 0} 字</span>
                </div>
                {dual.detail.context ? (
                  <pre className="kb-context">{dual.detail.context}</pre>
                ) : (
                  <p className="kb-note">这一轮没有留下上下文原文（明细自 2026-08-28 起才落轨迹）。</p>
                )}
                <p className="kb-lane-foot">
                  末尾那句指令<b>随判定改变</b>——不具备个性化依据时它明写
                  "不要暗示这是针对这辆车的结论"。诚实是结构性的，不靠模型自觉。
                </p>
              </div>

              <div className="kb-flow-step kb-flow-step--answer">
                <div className="kb-step-head">
                  <span className="kb-step-no kb-step-no--answer">回答</span>
                  <b>模型当时真实答给车主的话</b>
                  <span className="spacer" />
                  <span className="kb-lane-count">{new Date(dual.at).toLocaleString()}</span>
                </div>
                {dual.answer ? (
                  <p className="kb-answer-text">{dual.answer}</p>
                ) : (
                  <p className="kb-note">这一轮没有留下助手回复（可能被撤回或当时失败）。</p>
                )}
                <p className="kb-lane-foot">
                  取自对话历史，<b>不是这里重新生成的</b>——这一页展示发生过的事，不是演示能力。
                </p>

                {/*
                  对照入口挂在真实答案下方，而不是与它并排：并排会读成"两个平等的候选"，
                  而左边那个才是真的发过给车主的。对照是**为了衬托它**才存在的。
                */}
                <div className="kb-contrast">
                  <div className="kb-contrast-head">
                    <b>如果当时没有用车数据呢？</b>
                    <span className="spacer" />
                    <button
                      type="button"
                      className="kb-answer-btn"
                      disabled={contrastState === "running" || !dual.detail.context}
                      onClick={runContrast}
                    >
                      {contrastState === "running"
                        ? "生成中…（约 10~20 秒）"
                        : contrast
                          ? "重新对比"
                          : "生成对比"}
                    </button>
                  </div>

                  {!dual.detail.context ? (
                    <p className="kb-note">
                      这一轮没有留下上下文原文，生不出对照（明细自 2026-08-28 起才落轨迹）。
                    </p>
                  ) : contrastState === "error" ? (
                    <p className="kb-banner kb-banner--err">生成失败：{contrastError}</p>
                  ) : contrast ? (
                    <>
                      <p className="kb-contrast-answer">{contrast.answer}</p>
                      <p className="kb-lane-foot">
                        <b>同一段上下文、同一个模型、同一份人设</b>，只去掉了「这辆车的真实数据」那一节
                        （末尾指令随之变成"不要暗示这是针对这辆车的结论"）。
                        <b>没有重跑检索</b>——重跑会引入第二个变量，那样差别里就混进了"检索结果不同"。
                      </p>
                    </>
                  ) : (
                    <p className="kb-note">
                      点上面的按钮，把同一段上下文去掉用车数据那一节再答一次——
                      两段话的差别就是那几个数字带来的全部价值。
                    </p>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </section>

      <section className="kb-card">
        <h2>检索测试</h2>
        <p className="kb-card-sub">判定“传成功了”的真正标准：拿一个真实问题去检索，看得到什么。</p>
        <div className="kb-search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runTest()}
            placeholder="例如：低温下续航为什么会下降"
          />
          <button type="button" onClick={runTest} disabled={!query.trim()}>
            检索
          </button>
        </div>

        {test &&
          (test.empty ? (
            <p className="kb-banner kb-banner--info">
              零命中。<strong>这不是错误，是信息</strong>——说明这个问题当前知识库答不了，需要补文档或换切分方式。
            </p>
          ) : (
            <div className="kb-hits">
              {test.hits.map((h, i) => (
                <div className="kb-hit" key={`${h.document}-${i}`}>
                  <div className="kb-hit-head">
                    <span className="kb-hit-doc">{h.document}</span>
                    {h.location && <span className="kb-hit-loc">{h.location}</span>}
                    <span className="kb-score">
                      <span className="kb-score-track">
                        <span className="kb-score-bar" style={{ width: `${Math.max(2, Math.min(1, h.score) * 100)}%`, display: "block" }} />
                      </span>
                      <span className="kb-score-num">{h.score.toFixed(3)}</span>
                    </span>
                  </div>
                  <p className="kb-hit-excerpt">{h.excerpt}</p>
                </div>
              ))}
            </div>
          ))}
      </section>
    </section>
  );
}
