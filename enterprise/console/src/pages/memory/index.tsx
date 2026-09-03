/**
 * 记忆浏览（施工单 M3-05）。
 *
 * 页面的核心不是"展示记忆"，而是**让哪一类还没有数据成为明示事实**：
 * 六类分区都在，只有 ①Working 有内容，其余五类挂着"未接入"和清单编号。
 * 这样运营不会把架构现状当成 bug 反复上报，将来接 Mem0 也不用重做页面。
 */

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { api, ApiError } from "../../api";
import { Hint } from "../../components/Hint";
import { EnvCacheBrowser } from "./env-cache";

interface MemoryCategory {
  id: number;
  key: string;
  name: string;
  storage: string;
  decay: string;
  owner: string;
  note: string;
}

interface WorkingState {
  sessionId: string;
  status: "active" | "expired" | "empty" | "unavailable";
  threadId: string | null;
  lastActiveMs: number | null;
  turnCount: number;
  messages: Array<{ role: string; content: string; redacted?: boolean }>;
  storage: string;
}

const STATUS_TEXT: Record<WorkingState["status"], string> = {
  active: "活跃",
  expired: "已过期（超 24h 未活动，§7① 硬过期）",
  empty: "空（该会话还没有轮次）",
  unavailable: "不可用：进程重启导致内存检查点丢失（§13-3）——权威对话历史不受影响",
};

/** 会话选择器的条目（来自 `/console/sessions`，与「会话与对话」页同一个接口）。 */
interface SessionBrief {
  sessionId: string;
  title: string | null;
  turnCount: number;
  updatedAt: string;
}

/** 某一类记忆的一条具体内容（来自 `/console/memory/items/:userId`）。 */
interface MemoryItem {
  id: string;
  text: string;
  meta?: string;
  at?: string;
}

/**
 * 类别编号 → 明细接口的 key。
 *
 * ①走 `working/:sessionId`（按会话查）、⑤走 `memory/cache`（按地点存、要分页与
 * 命名空间筛选，见 `env-cache.tsx`）——两者都不在这张表里，各有各的接口。
 * 表里返回 null 只表示"不走 items 那条通用接口"，**不表示这一类看不了**。
 */
const ITEM_KEY: Record<number, string | null> = {
  1: null,
  2: "episodic",
  3: "preference",
  4: "vehicle",
  5: null,
  6: "usage",
};

/** 六类接线状态与真实计数（M11-05，来自 `/console/memory/overview`）。 */
interface MemoryOverview {
  userId: string;
  runtimeReachable: boolean;
  wiring: Array<{ id: number; key: string; store: string; write: boolean; read: boolean }>;
  counts: Record<string, number> | null;
  /** ⑤环境缓存的运行数据（运行时自报；缺省即运行时不可达或版本较旧）。 */
  cache?: {
    hits: number;
    misses: number;
    degraded: number;
    writtenThisProcess: number;
    /** Redis 里现存多少条；数不到就没有这个字段（**不会是 0**）。 */
    keysInStore?: number;
  };
}

/**
 * 类别编号 → 计数字段。
 *
 * ⑤在 Redis，网关这一侧数不到——返回 `null` 而不是 0。
 * **0 与"数不到"必须分开**：前者是这个用户没有，后者是我们看不见，
 * 而这一页存在的全部意义就是别再把这两件事说成一样。
 */
function countFor(counts: Record<string, number> | null, id: number): number | null {
  if (!counts) return null;
  const map: Record<number, string | null> = {
    1: "working",
    2: "episodic",
    3: "preference",
    4: "vehicle",
    5: null,
    6: "usage",
  };
  const key = map[id];
  return key ? (counts[key] ?? 0) : null;
}

/**
 * `**x**` → `<strong>`。
 *
 * taxonomy 的 note 是给人读的中文，加粗标的是"这句里最容易搞错的地方"。
 * 直接塞进 `<p>` 会把星号原样印出来，糊在中文里比不加粗更难读——
 * 而这一页存在的意义就是把话说清楚。
 *
 * 只认这一种语法、只认成对出现，输入是我们自己的常量而非用户数据。
 */
function emphasize(text: string): Array<string | JSX.Element> {
  return text.split(/\*\*(.+?)\*\*/g).map((seg, i) => (i % 2 ? <strong key={i}>{seg}</strong> : seg));
}

export function MemoryPage(): JSX.Element {
  const { sessionId: routeSession } = useParams();
  const navigate = useNavigate();

  const [categories, setCategories] = useState<MemoryCategory[] | null>(null);
  /**
   * 六类的接线状态与真实计数（M11-05）。
   *
   * **不用 taxonomy 里的 `connected`**：那是写死在代码里的常量，
   * 会随实现演进变成谎话——这一页此前就写着"②③未接入：Mem0 尚未部署"，
   * 而 Mem0 早已部署。状态一律来自运行时自报 + 库里数出来的计数。
   */
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [sessionId, setSessionId] = useState(routeSession ?? "");
  const [sessions, setSessions] = useState<SessionBrief[] | null>(null);
  const [working, setWorking] = useState<WorkingState | null>(null);
  /**
   * 展开哪几类的明细，以及各自取回的内容。
   *
   * **按需取而不是随页面一起拉**：六类一起拉会在打开页面时打六次库，
   * 而多数时候用户只想看其中一类。展开过的留在手里，收起再展开不重复请求。
   */
  const [openIds, setOpenIds] = useState<Set<number>>(new Set());
  const [items, setItems] = useState<Record<number, MemoryItem[] | "loading" | "error">>({});
  const [error, setError] = useState<string | null>(null);
  /**
   * ⑤展开明细时刚扫出来的库存总数。
   *
   * 有它就用它——健康视图那份是 60 秒刷新一次的，两个数字并排出现在同一张卡上时
   * 差异读起来就是个 bug（实测展开后"71 条在库"配着"共 75 条"）。
   */
  const [cacheTotal, setCacheTotal] = useState<number | null>(null);

  useEffect(() => {
    api
      .get<{ categories: MemoryCategory[] }>("/console/memory/taxonomy")
      .then((r) => setCategories(r.categories))
      .catch((e: unknown) => setError(e instanceof ApiError ? e.code : String(e)));
  }, []);

  useEffect(() => {
    api
      .get<MemoryOverview>("/console/memory/overview?userId=demo-user")
      .then(setOverview)
      .catch(() => setOverview(null));
  }, []);

  /*
   * 会话清单：供下拉按**标题或 id** 检索。
   *
   * 默认落到最近一个**有轮次**的会话，而不是最近一个会话——
   * 建了没说话的空会话会排在最前（端上一进对话页就建一个），
   * 默认落在它上面时 ①Working 显示"空"，页面看起来像坏了。
   * 路由里已经带了会话时不动它：那是用户从别处点进来的，比默认值优先。
   */
  useEffect(() => {
    api
      .get<{ sessions: SessionBrief[] }>("/console/sessions?limit=50")
      .then((r) => {
        setSessions(r.sessions);
        if (routeSession) return;
        const firstUsed = r.sessions.find((x) => x.turnCount > 0);
        if (firstUsed) navigate(`/memory/${firstUsed.sessionId}`, { replace: true });
      })
      .catch(() => setSessions([]));
    // 只在首次挂载时定默认值——把 routeSession 放进依赖会让用户手动切换后又被拽回默认。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!routeSession) return;
    setSessionId(routeSession);
    api
      .get<WorkingState>(`/console/memory/working/${routeSession}`)
      .then(setWorking)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.code : String(e)));
  }, [routeSession]);

  const toggleItems = (id: number) => {
    setOpenIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) {
        next.delete(id);
        return next;
      }
      next.add(id);
      const key = ITEM_KEY[id];
      // 已经取过就不再取：这一页的数据不是实时的，来回展开重复打库没有意义。
      if (key && items[id] === undefined) {
        setItems((m) => ({ ...m, [id]: "loading" }));
        api
          .get<{ items: MemoryItem[] }>(`/console/memory/items/demo-user?key=${key}&limit=20`)
          .then((r) => setItems((m) => ({ ...m, [id]: r.items })))
          .catch(() => setItems((m) => ({ ...m, [id]: "error" })));
      }
      return next;
    });
  };

  return (
    <div className="page">
      <h1>记忆浏览</h1>
      <div className="banner">
        {overview === null ? (
          <>接线状态<b>读不到</b>（运行时未启动或不可达）—— 这与"未接入"不是一回事，下面的标注仅供参考。</>
        ) : !overview.runtimeReachable ? (
          <>运行时不可达，<b>接线状态未知</b>。计数仍来自数据库，是真实的。</>
        ) : (
          <>各分区的接线状态由<b>运行时自报</b>、条数由<b>库里数出来</b> —— 都不是写死的。
            「未接线」= 我们没做；「0 条」= 这个用户还没有。<b>两者不是一回事。</b></>
        )}
      </div>

      {/*
        会话选择：**可输入的下拉**（input + datalist），不是纯 select。
        两个理由：① 打标题或 id 的任意片段都能筛（浏览器对 value 与 label 都匹配）；
        ② 仍然接受手敲/粘贴任意 id——排障时那个 id 往往来自工单或日志，
        不在最近 50 条里，纯 select 会把这条路堵死。
      */}
      <div className="filters">
        <label className="field mem-session-field">
          <span>
            会话
            <Hint label="会话选择说明">
              <p>
                下拉列最近 50 个会话，<strong>打标题或 id 的片段都能筛</strong>。
                默认落在最近一个<strong>有轮次</strong>的会话上——
                端上一进对话页就建一个空会话，默认落在它上面时
                ①Working 会显示"空"，看起来像页面坏了。
              </p>
              <p>不在列表里的 id 可以直接粘贴进来，照样查得到。</p>
            </Hint>
          </span>
          <input
            list="mem-session-list"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            placeholder="按标题或 id 检索…"
          />
          <datalist id="mem-session-list">
            {(sessions ?? []).map((x) => (
              <option
                key={x.sessionId}
                value={x.sessionId}
                label={`${x.title ?? "未命名会话"} · ${x.turnCount} 轮 · ${new Date(x.updatedAt).toLocaleString()}`}
              />
            ))}
          </datalist>
        </label>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => navigate(`/memory/${sessionId.trim()}`)}
          disabled={sessionId.trim() === ""}
        >
          查询
        </button>
        {/* 当前看的是谁：id 是一串乱码，光看它认不出是哪次对话 */}
        {routeSession && (
          <span className="mem-current muted">
            正在看：
            <b>{sessions?.find((x) => x.sessionId === routeSession)?.title ?? "未命名会话"}</b>
            <span className="mono tiny">（{routeSession}）</span>
          </span>
        )}
      </div>

      {error ? <p className="error">{error}</p> : null}

      {!categories ? (
        <p className="muted">载入中…</p>
      ) : (
        <div className="mem-grid">
          {categories.map((c) => {
            const w = overview?.wiring.find((x) => x.id === c.id);
            const n = overview ? countFor(overview.counts, c.id) : null;
            return (
            <section key={c.id} className={`mem-card ${w && (w.read || w.write) ? "" : "is-pending"}`}>
              <div className="mem-head">
                <span className="mem-id">{"①②③④⑤⑥"[c.id - 1]}</span>
                <h2>
                  {c.name}
                  <Hint label={`${c.name}说明`}>
                    <p>{emphasize(c.note)}</p>
                  </Hint>
                </h2>
                {/*
                  三态而不是两态：读写都通 / 只通一端 / 都没通。
                  「只通一端」是常态而不是异常——③曾经长期只能读不能写，
                  而两态显示会把它标成"已接入"，那正是这一页此前误导人的方式。
                */}
                {!w ? (
                  <span className="pending-tag">状态未知</span>
                ) : w.read && w.write ? (
                  <span className="result-badge result-ok">读写已接线</span>
                ) : w.read || w.write ? (
                  <span className="pending-tag">仅{w.read ? "读" : "写"}已接线</span>
                ) : (
                  <span className="pending-tag">未接线 · {c.owner}</span>
                )}
              </div>
              {/* 条数是这张卡的主角：接线状态回答"做没做"，条数回答"有没有数据" */}
              <div className="mem-count">
                  {n === null ? (
                    /*
                     * ⑤在 Redis，网关这一侧数不到条数。**不写 0**——
                     * 那会被读成"缓存里什么都没有"，而真相是我们没数
                     * （实测那会儿 Redis 里有 75 条，卡上却像个空壳）。
                     *
                     * 改为报**命中率**：它才是"缓存有没有在起作用"的答案，
                     * 而且不受进程重启影响。
                     */
                    c.id === 5 && overview?.cache ? (
                      <>
                        {/*
                          主数是**库里现存条数**，不是命中率：用户问的是"里面有没有东西"。
                          命中率放次要位——它是"缓存有没有起作用"，另一个问题。
                          数不到时显示"数不到"而不是 0（0 会被读成"缓存是空的"）。
                        */}
                        {(cacheTotal ?? overview.cache.keysInStore) === undefined ? (
                          <span className="mem-count-na">数不到（Redis 未接或扫描失败）</span>
                        ) : (
                          <>
                            <span className="mem-count-num">{cacheTotal ?? overview.cache.keysInStore}</span>
                            <span className="mem-count-unit">条在库</span>
                          </>
                        )}
                        <div className="tiny muted">
                          本进程 {overview.cache.hits} 命中 / {overview.cache.misses} 未命中
                          {overview.cache.hits + overview.cache.misses > 0
                            ? `（命中率 ${Math.round((overview.cache.hits * 100) / (overview.cache.hits + overview.cache.misses))}%）`
                            : "——计数随进程重启归零，不代表缓存空了"}
                          {overview.cache.degraded > 0 ? ` · ⚠️ ${overview.cache.degraded} 次降级直连` : ""}
                        </div>
                      </>
                    ) : (
                      <span className="mem-count-na">不在此处统计（见「存放」）</span>
                    )
                  ) : (
                    <>
                      <span className={n === 0 ? "mem-count-num is-zero" : "mem-count-num"}>{n}</span>
                      <span className="mem-count-unit">
                        条{n === 0 ? "　—— 这个用户还没有，不是没做" : ""}
                      </span>
                    </>
                  )}
                  {/*
                    ⑥是**两段式**：流水入 PG，聚合成画像才进 Mem0。
                    只报流水数会让"第二段一份产物都没跑出来"完全看不见——
                    而缺了画像，§6 的双路检索就塌成 RAG 一路，对谁都给通用答案。
                    实测就出过这个：139 条流水在库里，`usage_pattern` 是 0。
                  */}
                  {c.id === 6 && overview?.counts ? (
                    <div className="tiny">
                      其中聚合画像{" "}
                      {overview.counts.usagePattern ? (
                        <b>{overview.counts.usagePattern} 份</b>
                      ) : (
                        <span className="muted">
                          0 份 —— 流水进来了但没聚合过，双路检索会塌成通用答案
                        </span>
                      )}
                    </div>
                  ) : null}
              </div>
              <dl className="mem-meta">
                <dt>存放</dt>
                <dd>{w?.store ?? c.storage}</dd>
                <dt>衰减</dt>
                <dd>{c.decay}</dd>
              </dl>

              {/*
                具体内容。**只在这一类真的能列时才给按钮**——
                ①按会话查（下面那块）、⑤走上面那块自己的分页浏览，
                给它们一个点开永远是空的按钮，等于告诉用户"里面没东西"。
              */}
              {/*
                ⑤的明细：走自己的接口、自己的分页。**按钮无条件给**——
                这一类的"没有条目"是正常状态（带 TTL，过一会儿本来就空），
                而把按钮藏起来等于告诉用户"这里点不开"，那正是它此前被当成
                空壳的原因。
              */}
              {c.id === 5 && (
                <div className="mem-items">
                  <button type="button" className="mem-items-toggle" onClick={() => toggleItems(5)}>
                    {openIds.has(5) ? "▾ 收起缓存条目" : "▸ 看缓存条目"}
                  </button>
                  {openIds.has(5) && <EnvCacheBrowser onTotal={setCacheTotal} />}
                </div>
              )}

              {ITEM_KEY[c.id] && n !== 0 && (
                <div className="mem-items">
                  <button type="button" className="mem-items-toggle" onClick={() => toggleItems(c.id)}>
                    {openIds.has(c.id) ? "▾ 收起具体内容" : "▸ 看具体内容"}
                  </button>
                  {openIds.has(c.id) && (
                    items[c.id] === "loading" ? (
                      <p className="muted tiny">正在读取…</p>
                    ) : items[c.id] === "error" ? (
                      <p className="error tiny">读不到明细（记忆库不可达）。上面的条数仍是真的。</p>
                    ) : (
                      <ul className="mem-item-list">
                        {(items[c.id] as MemoryItem[]).map((it) => (
                          <li key={it.id}>
                            <span className="mem-item-text">{it.text}</span>
                            <span className="mem-item-meta">
                              {it.at ? new Date(it.at).toLocaleDateString() : null}
                              {/*
                                来源标记必须显示：`simulated` 是演示种子数据。
                                与真实记忆混在一起看，就会拿假数据当证据。
                              */}
                              {it.meta ? ` · ${it.meta}` : null}
                            </span>
                          </li>
                        ))}
                        {(items[c.id] as MemoryItem[]).length === 0 && (
                          <li className="muted tiny">这一类当前没有可列的内容。</li>
                        )}
                        {n !== null && n > 20 && (
                          <li className="muted tiny">只列了最近 20 条（共 {n} 条）。</li>
                        )}
                      </ul>
                    )
                  )}
                </div>
              )}

              {c.id === 1 ? (
                working ? (
                  <div className="working">
                    <div className="working-status">
                      状态：<b>{STATUS_TEXT[working.status]}</b>
                      {working.status === "active" ? `　轮数：${working.turnCount}` : null}
                    </div>
                    {working.threadId ? (
                      <div className="muted tiny mono">thread: {working.threadId}</div>
                    ) : null}
                    {working.messages.length > 0 ? (
                      <ol className="working-msgs">
                        {working.messages.map((m, i) => (
                          <li key={i}>
                            <span className="muted tiny">{m.role}</span> {m.content}
                          </li>
                        ))}
                      </ol>
                    ) : null}
                    <div className="muted tiny">默认脱敏，与会话页同一套规则</div>
                  </div>
                ) : (
                  <p className="muted tiny">上面选一个会话，这里显示它的 ①Working 上下文。</p>
                )
              ) : null}
            </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
