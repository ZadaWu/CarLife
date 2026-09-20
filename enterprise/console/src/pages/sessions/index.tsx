/**
 * 会话与对话浏览（施工单 M3-04）—— ops 与 admin 均可。
 *
 * 默认脱敏是"默认"不是"可选"：首屏一律脱敏，看原文是一个显式动作，
 * 且**每次提权都被审计**。页面上会一直挂着"原文模式"的状态条，
 * 让人知道自己正在看什么。
 *
 * 列表的可点区域是**整行**，不是行尾那个小链接——第一版把"查看"做成了
 * 暗色文字链，看上去像禁用状态，实际使用中没人点得到（已修）。
 */

import { useCallback, useContext, useEffect, useState } from "react";

/** 每页条数。50 是一屏扫得完、又不至于翻太多次的折中。 */
const PAGE_SIZE = 20;
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { api, ApiError } from "../../api";
import { IdentityContext } from "../../app/identity";
import { AudioButton } from "./AudioButton";
import { RouteCompare } from "./RouteCompare";
// 轨迹抽屉（研发 / 业务两个视图）在 ./TraceDrawer；本文件只负责会话列表与对话流。
import { TraceDrawer } from "./TraceDrawer";
// 上下文抽屉（两级状态与各 Agent 实际拿到的块）在 ./ContextDrawer，与轨迹抽屉共用同一份 replay。
import { ContextDrawer } from "./ContextDrawer";
import type { ReplayPayload, ReplayState } from "./DevTurnTrace";
// 轮次切分/排序是纯逻辑，放在 ./turns 而不是本文件——本文件 import 了 css，
// node:test 加载不了，留在这里等于那部分逻辑永远测不到。
import { turnsNewestFirst, type ConsoleMessage } from "./turns";
// 筛选参数的拼装（含日期 → 时间点那一步）是纯逻辑，放 ./filters 才测得到；
// 演示大屏的会话选择器 import 的是同一份，两处的筛选语义不会各自漂移。
import { hasFilters, sessionQuery } from "./filters";
import { tripChipText, type SessionTrip } from "./trip-chip";
import "./sessions.css";

interface SessionRow {
  sessionId: string;
  /** 旁路生成的会话标题（M28-01）；`null` = 还没起出来。 */
  title: string | null;
  userId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  turnCount: number;
  firstMessageAt: number | null;
  lastMessageAt: number | null;
  /** 清理时刻（M108，软删除）；`null` / 缺席 = 没被清理过。 */
  deletedAt?: string | null;
  /** 这条会话最新的行程摘要（网关按会话前缀带上）；缺省 = 这条对话没落成行程。 */
  trip?: SessionTrip;
}

const REDACT_LABEL: Record<string, string> = {
  phone_cn: "手机号",
  id_card_18: "身份证",
  id_card_15: "身份证(15位)",
  bank_card: "银行卡",
  email: "邮箱",
};

export function SessionsPage(): JSX.Element {
  const { sessionId } = useParams();
  if (sessionId) return <SessionDetail sessionId={sessionId} />;
  return <SessionList />;
}

function SessionList(): JSX.Element {
  const navigate = useNavigate();
  /*
   * `?userId=` 只做**初值**（M68-03）：账号详情的「看他的全部会话」从这里进来。
   * 之后改筛选不回写 URL——回写会让浏览器历史里塞满筛选态（M67 回放页的 `?session=` 同一条）。
   */
  const [searchParams] = useSearchParams();
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [userId, setUserId] = useState(searchParams.get("userId") ?? "");
  const [keyword, setKeyword] = useState("");
  /** 标题模糊搜。**没起名的会话搜不到**——标题是首轮之后旁路生成的（M28-01）。 */
  const [title, setTitle] = useState("");
  /** 日期范围按**创建时间**筛（接口口径），本地时区整天，见 ./filters。 */
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  /**
   * 「只看说过话的」。**缺省关**——空白对话（建了没说话）在运营这里是要看的现象，
   * 只有车主端把它们藏起来（见 `userSessionPage` 的注释）。
   */
  const [nonEmpty, setNonEmpty] = useState(false);
  /** 清理状态筛选（M108）：`""` 未清理（缺省）/ `include` 含已清理 / `only` 只看已清理。 */
  const [deleted, setDeleted] = useState<"" | "include" | "only">("");
  const [error, setError] = useState<string | null>(null);
  /**
   * 分页游标栈。
   *
   * **存"每一页的起点"而不是页码**：接口是游标式的（`nextCursor` 指向下一页的
   * 第一条），没有 offset 也就没有"第 3 页"这个东西。存一摞起点才能往回翻——
   * 只记当前游标的话，上一页要从头重新翻一遍。
   * 栈长度 = 当前是第几页，正好也是页码显示的来源。
   */
  const [stack, setStack] = useState<Array<string | undefined>>([undefined]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const cursor = stack[stack.length - 1];

  const filters = { userId, sessionId: keyword, title, since, until, nonEmpty, deleted: deleted || undefined };
  const load = useCallback(() => {
    const q = sessionQuery(
      { userId, sessionId: keyword, title, since, until, nonEmpty, deleted: deleted || undefined },
      { limit: String(PAGE_SIZE) },
    );
    if (cursor) q.set("cursor", cursor);
    setRows(null);
    setLoading(true);
    api
      .get<{ sessions: SessionRow[]; hasMore: boolean; nextCursor: string | null }>(
        `/console/sessions?${q}`,
      )
      .then((r) => {
        setRows(r.sessions);
        setNext(r.hasMore ? r.nextCursor : null);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.code : String(e)))
      .finally(() => setLoading(false));
  }, [userId, keyword, title, since, until, nonEmpty, deleted, cursor]);

  useEffect(() => {
    load();
  }, [load]);

  /*
   * 改筛选条件就回到第一页。
   *
   * 不回的话，上一次翻到第 4 页的游标会被带到新的结果集上——那个 id 在新集合里
   * 多半不存在，翻出来的是一页空的，而用户以为"这个筛选没有结果"。
   */
  const resetPaging = () => {
    setStack([undefined]);
    setNext(null);
  };

  /*
   * ── 清理与恢复（M108-04）。**软删除**：只是让会话从列表里退场，任何东西都没删，
   * 所以界面一律说「清理 / 恢复」，不说「删除」——叫删除会让人以为找不回来。
   * 只有 admin 看得到这三个入口；接口那一侧也只认 admin（ops 会拿到 403）。
   */
  const identity = useContext(IdentityContext);
  const isAdmin = identity?.role === "admin";
  /** 正在处理的那一行（按钮禁用）；`"*"` = 正在清理全部。 */
  const [busy, setBusy] = useState<string | null>(null);
  /** 「清理全部」的确认框：`total` 来自服务端的 dryRun，不是这一页的条数。 */
  const [confirmAll, setConfirmAll] = useState<{ total: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const act = (key: string, run: () => Promise<string | null>): void => {
    setBusy(key);
    setError(null);
    setNotice(null);
    run()
      .then((msg) => {
        if (msg) setNotice(msg);
        // 成功后重新拉当前页，不在本地拼列表——这一页少了一条之后该补谁进来，只有服务端知道。
        load();
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.code : String(e)))
      .finally(() => setBusy(null));
  };
  const cleanOne = (id: string): void =>
    act(id, async () => {
      await api.post(`/console/sessions/${encodeURIComponent(id)}/clean`);
      return null;
    });
  const restoreOne = (id: string): void =>
    act(id, async () => {
      await api.post(`/console/sessions/${encodeURIComponent(id)}/restore`);
      return null;
    });
  // 只问个数、不动任何东西——所以不走 `act`（那条成功后会重拉列表，这里没有东西变）。
  const askCleanAll = (): void => {
    setError(null);
    setNotice(null);
    api
      .post<{ total: number }>("/console/sessions/clean-all", { dryRun: true })
      .then((r) => setConfirmAll({ total: r.total }))
      .catch((e: unknown) => setError(e instanceof ApiError ? e.code : String(e)));
  };
  const cleanAll = (): void => {
    setConfirmAll(null);
    act("*", async () => {
      const r = await api.post<{ cleaned: number; remaining: number }>(
        "/console/sessions/clean-all",
        { confirm: "all" },
      );
      resetPaging();
      return r.remaining > 0
        ? `已清理 ${r.cleaned} 条，还剩 ${r.remaining} 条——一次最多清 1 万条，再点一次「清理全部」。`
        : `已清理 ${r.cleaned} 条。需要找回时选「只看已清理」再点恢复。`;
    });
  };

  return (
    <div className="ss-page">
      <h1>会话与对话</h1>
      <p className="ss-desc">
        数据源与端上权威历史同一张表（不做副本）。内容默认脱敏，查看原文需提权且被审计。
        点击任意一行查看该会话的完整对话。
      </p>

      <div className="ss-filters">
        <label className="ss-field">
          <span>用户</span>
          <input
            value={userId}
            onChange={(e) => {
              setUserId(e.target.value);
              resetPaging();
            }}
            placeholder="userId"
          />
        </label>
        <label className="ss-field">
          <span>会话 ID（精确定位）</span>
          <input
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value);
              resetPaging();
            }}
            placeholder="sess-…"
          />
        </label>
        {/*
          标题模糊搜。与上面那个 id 精确定位是两件事：手上有 id 用那个，
          只记得"聊的是保养那段"用这个。**没起名的会话搜不到**（标题是首轮之后
          才生成的），所以标签里点明"模糊"，空结果时下面还会再说一遍。
        */}
        <label className="ss-field">
          <span>标题（模糊）</span>
          <input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              resetPaging();
            }}
            placeholder="保养、行程…"
          />
        </label>
        {/* 日期范围按**创建时间**筛（与接口口径一致：排序用活跃时间，筛用创建时间）。 */}
        <label className="ss-field ss-field--day">
          <span>建于（起）</span>
          <input
            type="date"
            value={since}
            max={until || undefined}
            onChange={(e) => {
              setSince(e.target.value);
              resetPaging();
            }}
          />
        </label>
        <label className="ss-field ss-field--day">
          <span>建于（止）</span>
          <input
            type="date"
            value={until}
            min={since || undefined}
            onChange={(e) => {
              setUntil(e.target.value);
              resetPaging();
            }}
          />
        </label>
        {/*
          空白对话（建了但一句没说）的开关。**过滤在服务端**（`nonEmpty=1` → SQL 的 EXISTS），
          不是把这一页筛一遍：应用层筛的话"每页 20 条"会变成"这一页只剩 6 条"，
          页码与翻页跟着不准。
        */}
        <label className="ss-field ss-field--check">
          <input
            type="checkbox"
            checked={nonEmpty}
            onChange={(e) => {
              setNonEmpty(e.target.checked);
              resetPaging();
            }}
          />
          <span>只看说过话的（隐藏空白对话）</span>
        </label>
        {/*
          被清理的会话（M108，软删除）缺省不在列表里。三态而不是一个勾：
          「连它们一起看」与「只看它们」是两个用途——前者是核对，后者是找回清错的那条。
        */}
        <label className="ss-field">
          <span>清理状态</span>
          <select
            value={deleted}
            onChange={(e) => {
              setDeleted(e.target.value as "" | "include" | "only");
              resetPaging();
            }}
          >
            <option value="">未清理</option>
            <option value="include">含已清理</option>
            <option value="only">只看已清理</option>
          </select>
        </label>
        <button type="button" className="ss-btn" onClick={load}>
          查询
        </button>
        {hasFilters(filters) ? (
          <button
            type="button"
            className="ss-btn ss-btn--ghost"
            onClick={() => {
              setUserId("");
              setKeyword("");
              setTitle("");
              setSince("");
              setUntil("");
              setNonEmpty(false);
              setDeleted("");
              resetPaging();
            }}
          >
            清空
          </button>
        ) : null}
        {isAdmin ? (
          <button
            type="button"
            className="ss-btn ss-btn--danger"
            disabled={busy !== null}
            onClick={askCleanAll}
            title="把全部会话从列表里清理掉（软删除，可恢复）"
          >
            清理全部…
          </button>
        ) : null}
      </div>

      {confirmAll ? (
        <div className="ss-confirm" role="alertdialog" aria-label="确认清理全部会话">
          <p>
            将清理<b> {confirmAll.total} </b>条会话（全部未清理的，不受上面筛选条件影响）。
            <br />
            这是软删除：会话、消息、轨迹一条都不会删，只是不再出现在车主端与这里的列表里；
            清理的同时会话会被关闭，不能再接着说。之后可在「只看已清理」里逐条恢复。
          </p>
          <div className="ss-confirm-actions">
            <button type="button" className="ss-btn ss-btn--danger" onClick={cleanAll}>
              确认清理 {confirmAll.total} 条
            </button>
            <button type="button" className="ss-btn ss-btn--ghost" onClick={() => setConfirmAll(null)}>
              取消
            </button>
          </div>
        </div>
      ) : null}
      {notice ? <p className="ss-note">{notice}</p> : null}

      {error ? <p className="ss-error">{error}</p> : null}
      {!rows ? (
        <p className="ss-note">载入中…</p>
      ) : rows.length === 0 ? (
        <p className="ss-empty">
          没有匹配的会话。
          {title.trim() ? "（标题是首轮之后才生成的，还没起名的会话搜不到。）" : ""}
          {/* 空结果时说清是哪条筛掉的——否则"这个用户一条会话都没有"与"他的会话都是空白的"长得一模一样。 */}
          {nonEmpty ? "（已隐藏空白对话：建了但一句没说的那些。）" : ""}
          {deleted === "" ? "（被清理的会话缺省不显示，可在「清理状态」里选含已清理。）" : ""}
        </p>
      ) : (
        <div className="ss-list">
          {/*
            标题当主行（M28-01）：翻会话时先认的是"这段在聊什么"，
            id 是接下来排障要复制的东西（mono 副行）。两者都在——**标题不替代 id**，
            它会重名，而排障要的是能唯一定位的那个。
          */}
          {rows.map((s) => {
            const open = (): void => {
              void navigate(`/sessions/${s.sessionId}`);
            };
            return (
              <div
                key={s.sessionId}
                className={`ss-row${s.deletedAt ? " is-deleted" : ""}`}
                onClick={open}
                tabIndex={0}
                role="link"
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    open();
                  }
                }}
              >
                <div className="ss-row-main">
                  {s.title ? (
                    <span className="ss-row-title">{s.title}</span>
                  ) : (
                    <span className="ss-row-title ss-row-title--none">（还没起名）</span>
                  )}
                  <span className="ss-row-id">{s.sessionId}</span>
                  {s.deletedAt ? (
                    <span className="ss-deleted-chip" title="软删除：会话与消息都还在，可恢复">
                      已清理 · {new Date(s.deletedAt).toLocaleString()}
                    </span>
                  ) : null}
                  {/* 定了行程的对话在列表上就能认出来，不用逐条点进去 */}
                  {s.trip && (
                    <span
                      className={`ss-trip-chip${s.trip.status === "cancelled" ? " is-cancelled" : ""}`}
                      title={s.trip.themes.join("；") || undefined}
                    >
                      {s.trip.status === "cancelled" ? "行程已取消" : "已定行程"} · {tripChipText(s.trip)}
                    </span>
                  )}
                </div>
                <span className="ss-row-user" title={s.userId}>{s.userId}</span>
                <span className="ss-row-stats">
                  <span className="ss-stat">
                    <b>{s.turnCount}</b>
                    <span>轮</span>
                  </span>
                  <span className="ss-stat">
                    <b>{s.messageCount}</b>
                    <span>消息</span>
                  </span>
                </span>
                <span className="ss-row-time">
                  {s.lastMessageAt ? new Date(s.lastMessageAt).toLocaleString() : "—"}
                </span>
                {isAdmin ? (
                  <button
                    type="button"
                    className="ss-btn ss-btn--ghost ss-row-act"
                    disabled={busy !== null}
                    onClick={(e) => {
                      // 行本身是个链接；不拦的话点「清理」会同时跳进详情页。
                      e.stopPropagation();
                      if (s.deletedAt) restoreOne(s.sessionId);
                      else cleanOne(s.sessionId);
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    {busy === s.sessionId ? "处理中…" : s.deletedAt ? "恢复" : "清理"}
                  </button>
                ) : null}
                <span className="ss-row-cta">查看详情 →</span>
              </div>
            );
          })}
        </div>
      )}

      {/*
        翻页条。**列表非空才显示**——空结果下摆一排翻页按钮，
        看起来像"还有别的页没翻到"，而其实是这个筛选没有结果。
      */}
      {rows && rows.length > 0 && (stack.length > 1 || next) && (
        <div className="ss-pager">
          <button
            type="button"
            className="ss-btn ss-btn--ghost"
            disabled={stack.length === 1 || loading}
            onClick={() => setStack((st) => st.slice(0, -1))}
          >
            ← 上一页
          </button>
          {/*
            只说"第 N 页"，**不说"共 M 页"**：游标式接口拿不到总数，
            编一个总页数出来就是假的。同理不做页码跳转——那需要 offset。
          */}
          <span className="ss-pager-at">第 {stack.length} 页 · 每页 {PAGE_SIZE} 条</span>
          <button
            type="button"
            className="ss-btn ss-btn--ghost"
            disabled={!next || loading}
            onClick={() => setStack((st) => [...st, next ?? undefined])}
          >
            下一页 →
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 引擎档位的人话（M60-01）。两个 `mock` 是**不同的服务**，各自说清楚：
 * ASR 的 mock 是 local-asr 容器（真模型跑本机），TTS 的 mock 是 mock-tts 的
 * say 包装。同名不同物，按值取标签会撞车，所以这里按实际语境分开写死。
 */
/** 轮次头上两个入口对应的抽屉：上下文（模型手上有什么）/ 轨迹（它拿这些做了什么）。 */
type DrawerPanel = "context" | "trace";

const ENGINE_LABEL: Record<string, string> = {
  ark: "火山方舟豆包",
  doubao: "豆包 seed-tts",
  aliyun: "阿里云百炼",
  mock: "本机（不计费）",
  fake: "Fake（测试）",
  local: "本机（旧档名）",
};

function SessionDetail({ sessionId }: { sessionId: string }): JSX.Element {
  const navigate = useNavigate();
  const [meta, setMeta] = useState<SessionRow | null>(null);
  const [messages, setMessages] = useState<ConsoleMessage[] | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 会话轨迹**整份取一次**，按 `turnId` 在前端切到各轮（TD-08）。
   *
   * 不给每轮各发一次请求：一个会话十几轮就是十几次往返，而轨迹接口
   * 每次都要先 `flush()` 落库缓冲。取一次切开用，展开第二轮时零延迟。
   */
  const [replay, setReplay] = useState<ReplayPayload | null>(null);
  const [replayState, setReplayState] = useState<ReplayState>("idle");
  const [replayError, setReplayError] = useState<string | null>(null);
  /**
   * 抽屉里正在看的那一轮；null 即关闭。
   *
   * **抽屉一次只能开一轮**——这是抽屉这种形态自带的取舍：换来的是对话列表
   * 不被撑开、上下文（哪句话）始终留在左边可见，代价是没法把两轮并排对比。
   * 要对比就去回放页看整条会话的时间轴。
   */
  const [drawerTurn, setDrawerTurn] = useState<{ turnId: string; index: number; panel: DrawerPanel } | null>(null);

  /** 懒加载：没人点"查看轨迹 / 查看上下文"就不去取，会话列表页不该为此变慢。 */
  const loadReplay = useCallback(async (): Promise<void> => {
    if (replay || replayState === "loading") return;
    setReplayState("loading");
    setReplayError(null);
    try {
      setReplay(await api.get<ReplayPayload>(`/console/replay/${encodeURIComponent(sessionId)}`));
      setReplayState("idle");
    } catch (e) {
      setReplayState("error");
      setReplayError(e instanceof ApiError ? e.code : String(e));
    }
  }, [sessionId, replay, replayState]);

  const openDrawer = useCallback(
    (turnId: string, index: number, panel: DrawerPanel): void => {
      setDrawerTurn({ turnId, index, panel });
      void loadReplay();
    },
    [loadReplay],
  );

  // Esc 关抽屉。**遮罩挡住了正文**，没有键盘出口的话只能去够右上角那个叉。
  useEffect(() => {
    if (!drawerTurn) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setDrawerTurn(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerTurn]);

  useEffect(() => {
    setRevealed(false);
    setMessages(null);
    setError(null);
    setReplay(null);
    setReplayState("idle");
    setDrawerTurn(null);

    // 会话概况：直接按 sessionId 查列表接口，保证 URL 直达时也有元信息
    api
      .get<{ sessions: SessionRow[] }>(
        `/console/sessions?limit=1&sessionId=${encodeURIComponent(sessionId)}`,
      )
      .then((r) => setMeta(r.sessions[0] ?? null))
      .catch(() => setMeta(null));

    api
      .get<{ messages: ConsoleMessage[] }>(`/console/sessions/${sessionId}/messages`)
      .then((r) => setMessages(r.messages))
      .catch((e: unknown) =>
        setError(
          e instanceof ApiError && e.code === "session_not_found"
            ? "该会话不存在（可能已被清理，或 ID 输入有误）"
            : e instanceof ApiError
              ? e.code
              : String(e),
        ),
      );
  }, [sessionId]);

  async function reveal(): Promise<void> {
    if (!window.confirm("查看原文将被记入审计（谁、何时、看了哪个会话）。继续？")) return;
    try {
      const r = await api.post<{ messages: ConsoleMessage[] }>(
        `/console/sessions/${sessionId}/reveal`,
        {},
      );
      setMessages(r.messages);
      setRevealed(true);
    } catch (e) {
      // 审计不可用时提权被拒——这是设计（保护用户隐私），不是故障
      setError(
        e instanceof ApiError && e.code === "audit_unavailable"
          ? "审计不可用，已拒绝提权：没有留痕的查看不被允许。"
          : String(e),
      );
    }
  }

  const turns = turnsNewestFirst(messages ?? []);
  const redactedCount = (messages ?? []).filter((m) => m.redacted).length;

  return (
    <div className="ss-page">
      <button type="button" className="ss-back" onClick={() => navigate("/sessions")}>
        ← 返回列表
      </button>

      <div className="ss-hero">
        {/*
          标题当主标题、id 降为副行（M28-01）。没有标题时**仍以 id 当主标题**，
          不要垫一个"未命名会话"——那是一句凭空多出来的话，而"这段还没起名字"
          本身就是个有意义的事实。
        */}
        {meta?.title ? (
          <>
            <h1>{meta.title}</h1>
            <p className="ss-hero-id">{sessionId}</p>
          </>
        ) : (
          <h1 className="mono">{sessionId}</h1>
        )}

        {meta ? (
          <dl className="ss-meta">
            <div>
              <dt>用户</dt>
              <dd>{meta.userId}</dd>
            </div>
            <div>
              <dt>会话创建</dt>
              <dd>{new Date(meta.createdAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>轮数</dt>
              <dd>{meta.turnCount}</dd>
            </div>
            <div>
              <dt>消息数</dt>
              <dd>{meta.messageCount}</dd>
            </div>
            {meta.trip && (
              <div>
                <dt>行程</dt>
                <dd>
                  <span className={`ss-trip-chip${meta.trip.status === "cancelled" ? " is-cancelled" : ""}`}>
                    {meta.trip.status === "cancelled" ? "已取消" : "已确定"} · {tripChipText(meta.trip)}
                  </span>
                </dd>
              </div>
            )}
            <div>
              <dt>首条 / 末条</dt>
              <dd>
                {meta.firstMessageAt ? new Date(meta.firstMessageAt).toLocaleString() : "—"}
                {" / "}
                {meta.lastMessageAt ? new Date(meta.lastMessageAt).toLocaleString() : "—"}
              </dd>
            </div>
          </dl>
        ) : null}
      </div>

      <div className="ss-actions">
        {revealed ? (
          <span className="ss-revealed">原文模式：本次查看已记入审计</span>
        ) : (
          <>
            <span className="ss-note">
              默认脱敏（手机号 / 身份证 / 银行卡 / 邮箱）
              {redactedCount > 0 ? ` · 本会话 ${redactedCount} 条命中` : " · 本会话无命中"}
            </span>
            <button type="button" className="ss-btn ss-btn--ghost" onClick={() => void reveal()}>
              查看原文
            </button>
          </>
        )}
        <button
          type="button"
          className="ss-btn ss-btn--ghost"
          onClick={() => navigate(`/memory/${sessionId}`)}
        >
          该会话的记忆
        </button>
        {/*
          整条会话的时间轴在回放页；**逐轮**的执行轨迹在下面每轮标题右侧就地展开（TD-08）。
          这个按钮此前是 `disabled title="待 FL-29 落地"` 的占位——FL-29 已落地，接上。
        */}
        <button type="button" className="ss-btn ss-btn--ghost" onClick={() => navigate("/trace")}>
          整条会话的轨迹 →
        </button>
      </div>

      {/*
        已确定的行程 + 路径优化前后对比（route_audit）——非行程会话接口回空数组，这里就不渲染。
        `refreshKey`：会话元信息刷新（末条时间变了）就让它重取——行程是在对话里被确认的，
        页面开着的时候用户说一句"就这么定了"，这块不该还停在确认之前的样子。
      */}
      <RouteCompare sessionId={sessionId} refreshKey={meta?.lastMessageAt ?? 0} />

      {error ? <p className="ss-error">{error}</p> : null}
      {/*
        取数上限提示（M18-07）。

        此前**没有任何提示**：轨迹取到上限就静默截断，而页面按最近轮次倒序排，
        用户点最上面几轮全是空的——这正是"轨迹消失了"这句话的来源。
        取数方向已改成取最近，但上限仍在，所以撞到时必须说出来。
      */}
      {replay?.hasMore ? (
        <p className="muted tiny">
          ⚠️ 本会话事件较多，轨迹只取了<strong>最近 {replay.timeline.length} 条</strong>
          ——更早轮次的执行轨迹在这里会是空的，去「整条会话的轨迹」页分段查看。
        </p>
      ) : null}
      {!messages ? (
        error ? null : <p className="ss-note">载入中…</p>
      ) : messages.length === 0 ? (
        <p className="ss-empty">该会话还没有消息（建会话后没有发过内容）。</p>
      ) : (
        <div className="ss-turns">
          {/*
            **时间逆序**：最近一轮排最上面。排障与运营查看时想看的几乎总是"刚才那次"，
            正序要一路滚到底。序号仍是**真实的时间顺序**（第 1 轮是最早那轮），
            不随显示顺序倒过来——否则同一轮在这里叫"第 1 轮"、在轨迹里是最后一条，
            对不上就没法交流。
          */}
          {turns.map(({ turnId, messages: list, index: chronoIndex }) => {
            const active = drawerTurn?.turnId === turnId;
            return (
            <div className={`ss-turn${active ? " ss-turn--active" : ""}`} key={turnId}>
              <div className="ss-turn-head">
                <span className="ss-turn-no">第 {chronoIndex} 轮</span>
                <span className="ss-turn-id">{turnId}</span>
                <hr />
                {/*
                  两个抽屉、两个入口，并排放在轮次头上：**上下文在左、轨迹在右**——
                  先看"模型手上有什么"，再看"它拿这些做了什么"，与阅读一轮的顺序一致。
                */}
                <button
                  type="button"
                  className="ss-trace-btn"
                  onClick={() => openDrawer(turnId, chronoIndex, "context")}
                  aria-haspopup="dialog"
                  aria-expanded={active && drawerTurn?.panel === "context"}
                  title="这一轮开始时系统给模型装了什么：车主长期档案、进行中的任务、各 Agent 实际拿到的块"
                >
                  查看上下文
                </button>
                <button
                  type="button"
                  className="ss-trace-btn"
                  onClick={() => openDrawer(turnId, chronoIndex, "trace")}
                  aria-haspopup="dialog"
                  aria-expanded={active && drawerTurn?.panel === "trace"}
                >
                  查看轨迹 →
                </button>
              </div>
              {list.map((m) => (
                <div key={m.messageId} className={`ss-bubble ss-bubble--${m.role}`}>
                  <div className="ss-bubble-meta">
                    <span className="ss-role">{m.role === "user" ? "车主" : "助手"}</span>
                    <span>{m.source === "voice" ? "🎙 语音" : "⌨ 文字"}</span>
                    <span>{new Date(m.ts).toLocaleString()}</span>
                    {m.redacted ? (
                      <span className="redact-mark">
                        已脱敏
                        {m.redactedKinds?.length
                          ? `：${[...new Set(m.redactedKinds)]
                              .map((k) => REDACT_LABEL[k] ?? k)
                              .join("、")}`
                          : ""}
                      </span>
                    ) : null}
                    <span className="ss-spacer" />
                    <span className="ss-msg-id">{m.messageId}</span>
                  </div>
                  <div className="ss-bubble-body">{m.content}</div>
                  {m.source === "voice" && m.role === "user" ? (
                    <div className="ss-asr-note">
                      内容为 ASR 识别原文
                      {m.asrEngine ? ` · ${ENGINE_LABEL[m.asrEngine] ?? m.asrEngine}` : ""}
                      {/*
                        录音只在**存过**的时候给播放键：早于 M60-02 的会话没有留存，
                        给一个必然 404 的按钮比没有按钮更难解释。
                        `storedAudio === undefined` 是"这套功能没接"，同样不给。
                      */}
                      {m.storedAudio?.includes("asr") ? (
                        <>
                          {" · "}
                          <AudioButton messageId={m.messageId} kind="asr" stored />
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  {/*
                    TTS 标签只在助手消息上出现，且措辞是"下发档位"不是"已播放"——
                    合成在端上发生，服务端不知道那一句最终有没有出声（用户可能
                    关了播报开关、也可能合成失败降级 say）。写成"使用了 X 合成"
                    是把一个不知道的事说成知道。
                  */}
                  {m.role === "assistant" && (m.ttsEngine || m.storedAudio) ? (
                    <div className="ss-asr-note">
                      {m.ttsEngine ? `播报下发档位：${ENGINE_LABEL[m.ttsEngine] ?? m.ttsEngine}` : "播报档位未记录（早于 M60-01）"}
                      {/*
                        助手这一侧的音频服务端手里没有（合成在端上），所以播放键
                        对**每条有文本的助手消息**都给——第一次点是按当时下发的
                        档位补合成一次并存下来，之后取存下来的那份。
                        措辞见 AudioButton：不能说成"当时播的那段"。
                      */}
                      {m.storedAudio && m.content.trim() ? (
                        <>
                          {" · "}
                          <AudioButton
                            messageId={m.messageId}
                            kind="tts"
                            stored={m.storedAudio.includes("tts")}
                          />
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            );
          })}
        </div>
      )}

      {drawerTurn?.panel === "context" ? (
        <ContextDrawer
          sessionId={sessionId}
          turnId={drawerTurn.turnId}
          turnIndex={drawerTurn.index}
          replay={replay}
          state={replayState}
          error={replayError}
          onClose={() => setDrawerTurn(null)}
        />
      ) : null}
      {drawerTurn?.panel === "trace" ? (
        <TraceDrawer
          sessionId={sessionId}
          turnId={drawerTurn.turnId}
          turnIndex={drawerTurn.index}
          // 这一轮的对话（车主问 / 助手答）：业务视图的"最终回答"只在消息表里，轨迹只有长度。
          messages={turns.find((t) => t.turnId === drawerTurn.turnId)?.messages ?? []}
          replay={replay}
          state={replayState}
          error={replayError}
          onClose={() => setDrawerTurn(null)}
        />
      ) : null}
    </div>
  );
}
