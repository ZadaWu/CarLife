/**
 * 轨迹回放（施工单 M9-01，FL-29 F-29-02~09）。
 *
 * # 罗启明的四个问题，答案不在代码里，在这个页面上
 *
 * 真的是多 Agent 吗 / 并行是真的吗 / 中断恢复是真的吗 / 数据是真的吗。
 * 四问放在页面最上方，**每一条都指向下面时间轴上可以亲眼看到的东西**——
 * 不是一句结论，而是"你自己看这两条是不是横着叠在一起"。
 *
 * # 回放不是重跑
 *
 * 页面只读 `/console/replay/*`，那两个接口在服务端拿不到 streamer 与工具注册表
 * （见 `gateway/src/console/replay.ts`）。所以"不会触发任何真实调用"是结构性的，
 * 不是靠这里克制。
 *
 * # 呈现层不做任何过滤（F-29-08）
 *
 * 失败必须可见。这里没有"只看错误"或"隐藏成功"的开关——
 * 一旦引入过滤，就无法证明"没被隐藏"。异常状态靠**颜色**突出，不靠筛掉别的。
 */

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { api, ApiError } from "../../api";
import { Hint } from "../../components/Hint";
import { HopTable } from "./HopTable";
import { hasOverlap, hopBreakdown, layout, type TraceEvent } from "./timeline";

interface ReplaySession {
  sessionId: string;
  events: number;
  lastAt: number;
}

interface ReplayResponse {
  sessionId: string;
  answers: {
    agentCount: number;
    hasParallelOverlap: boolean;
    longestInterruptMs: number | null;
    toolCalls: { total: number; real: number; mock: number };
  };
  hasMore: boolean;
  redacted: boolean;
  timeline: TraceEvent[];
}

/**
 * 不是一次对话的会话键。
 *
 * `__selfcheck__` 是分层自检写的，`unknown` 是运行时换算不到真会话时的兜底桶
 * （ACP 冷启动、旁路垫场都落在这里）。它们**照常可选**——出问题时正要看它们——
 * 但**不该作为默认落点**：四问在它们上面全是"没有"，时间轴横跨好几天，
 * 页面打开就是一屏"什么都没发生"，而那正是用户说"不知道要看什么"的那一屏。
 */
function isSystemBucket(sessionId: string): boolean {
  return sessionId === "unknown" || sessionId === "unknown-session" || /^(__|selfcheck-)/.test(sessionId);
}

/**
 * 逐条事件的载荷：先给人话，原文一键可见。
 *
 * 原来直接 `JSON.stringify` 再 CSS 截断，一屏几百行全是
 * `{"name":"acp.session_new","agent":"supervisor","status":"o…`——
 * 每一行看起来都一样，等于没有信息。
 *
 * **这不是过滤**（F-29-08 禁止的是"某些事件看不到"）：所有事件都在、一条不少，
 * 只是换个写法；原始 JSON 由页面顶部的开关一键切回，两种写法覆盖的是同一批行。
 */
function readablePayload(kind: string, data: Record<string, unknown>): string {
  const g = (k: string): string | undefined => {
    const v = data[k];
    if (v === undefined || v === null || v === "") return undefined;
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  };
  const join = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(" · ");

  switch (kind) {
    case "span":
      return join(g("name"), g("durationMs") && `${g("durationMs")}ms`, g("status"), g("agent"), g("detail"));
    case "prompt":
      return join(g("agent"), g("chars") && `${g("chars")} 字`, g("truncated") && "已截断");
    case "tool_call":
      return join(g("name"), g("provider"), (data.source as { kind?: string })?.kind, g("status"));
    case "guard":
      return join(g("tool"), g("decision"), g("durationMs") && `${g("durationMs")}ms`, g("reason"));
    case "route":
      return join(g("target"), g("reason"));
    case "risk":
      return join(g("category"), g("decision"), g("note"));
    case "branch":
      return join(g("agent"), g("startedAt") && g("endedAt") && `${Number(data.endedAt) - Number(data.startedAt)}ms`);
    case "agent_session":
      return join(g("agent"), g("sessionId"));
    case "interrupt":
    case "resume":
      return join(g("tool"), g("interruptId"));
    case "turn_end":
      return join(g("outcome"), g("answerChars") && `${g("answerChars")} 字`, g("ttsRequests") && `${g("ttsRequests")} 次合成`);
    default: {
      // 不认识的 kind **不藏**：把前几个字段按 `k=v` 摊平，总比一串 JSON 好读。
      const pairs = Object.entries(data)
        .slice(0, 4)
        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
      return pairs.join(" · ");
    }
  }
}

const TONE_CLASS: Record<string, string> = {
  normal: "trace-bar",
  warn: "trace-bar trace-bar--warn",
  danger: "trace-bar trace-bar--danger",
};

export function TracePage(): JSX.Element {
  const [sessions, setSessions] = useState<ReplaySession[] | null>(null);
  /*
   * `?session=` 直达（M67-04）：评测逐题页据此跳过来。有参数时跳过"挑第一条"，
   * 且不依赖会话列表——评测会话可能不在列表的最近 N 条里，详情接口本来就不看列表。
   */
  const [searchParams] = useSearchParams();
  const sessionParam = searchParams.get("session");
  const [selected, setSelected] = useState<string | null>(sessionParam);
  const [replay, setReplay] = useState<ReplayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 逐条事件是看人话还是看原始 JSON。默认人话——原文一键即得，不是藏起来。 */
  const [rawPayload, setRawPayload] = useState(false);

  useEffect(() => {
    api
      .get<{ sessions: ReplaySession[] }>("/console/replay/sessions")
      .then((r) => {
        setSessions(r.sessions);
        /*
         * **任意真实会话都可回放**（AC-29-10）：默认选最近一次，
         * 而不是预置一条 Demo 数据——现场出的题也要能放。
         *
         * 但"最近一次"要跳过自检与兜底桶（见 `isSystemBucket`）：
         * 它们常常正好是最新的，于是页面一打开四问全空、时间轴横跨两天半。
         * 都是系统桶时才退回第一条——**不给空页面**。
         */
        if (sessionParam) return; // 直达时不覆盖
        const firstReal = r.sessions.find((x) => !isSystemBucket(x.sessionId));
        const pick = firstReal ?? r.sessions[0];
        if (pick) setSelected(pick.sessionId);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.code : String(e)));
  }, [sessionParam]);

  // 参数变化（从逐题页连点两题）要跟着换会话
  useEffect(() => {
    if (sessionParam) setSelected(sessionParam);
  }, [sessionParam]);

  const load = useCallback(() => {
    if (!selected) return;
    setReplay(null);
    api
      .get<ReplayResponse>(`/console/replay/${encodeURIComponent(selected)}`)
      .then(setReplay)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.code : String(e)));
  }, [selected]);

  useEffect(load, [load]);

  if (error) return <p className="error">加载失败：{error}</p>;

  const view = replay ? layout(replay.timeline) : null;
  const hops = replay ? hopBreakdown(replay.timeline) : null;

  return (
    <section className="page">
      <header className="page-head">
        <h1>
          轨迹回放
          <Hint label="本页说明">
            <p>
              只读已留存的轨迹，<strong>不触发任何真实 LLM 或外部调用</strong>——
              回放接口在服务端就拿不到执行句柄，这是结构性的，不靠页面克制。
            </p>
            <p>
              呈现层<strong>不做任何过滤</strong>：没有"只看错误"的开关。
              一旦引入过滤，就无法证明"没被隐藏"。异常靠颜色突出，不靠筛掉别的。
            </p>
          </Hint>
        </h1>
        <p className="muted">
          挑一次对话，看它在服务端<strong>实际</strong>走了哪些步、各花了多久。
          下面四张卡是要回答的四个问题，每张都指向时间轴上能亲眼看到的东西。
        </p>
      </header>

      <label className="field">
        <span>会话</span>
        <select
          value={selected ?? ""}
          onChange={(e) => setSelected(e.target.value)}
          disabled={!sessions || sessions.length === 0}
        >
          {/*
            分两组而不是过滤掉系统桶：排障时正要看它们（ACP 冷启动落在 unknown）。
            分组只是别让它们混在真实会话里被误选。
          */}
          <optgroup label="真实会话">
            {(sessions ?? [])
              .filter((s) => !isSystemBucket(s.sessionId))
              .map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {s.sessionId}（{s.events} 条事件 · {new Date(s.lastAt).toLocaleString()}）
                </option>
              ))}
          </optgroup>
          <optgroup label="自检与系统桶（不是对话）">
            {(sessions ?? [])
              .filter((s) => isSystemBucket(s.sessionId))
              .map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {s.sessionId}（{s.events} 条事件 · {new Date(s.lastAt).toLocaleString()}）
                </option>
              ))}
          </optgroup>
        </select>
        <button type="button" onClick={load} disabled={!selected}>
          重新加载
        </button>
      </label>

      {sessions && sessions.length === 0 && (
        <p className="muted">
          还没有任何轨迹。跑一次对话后回到这里——轨迹是落库的，进程重启也不会丢。
        </p>
      )}

      {/* 选了系统桶：先说清"四问会全空不是坏了"，否则那一屏看起来就像页面故障 */}
      {selected && isSystemBucket(selected) && (
        <p className="banner banner-warn">
          <b>{selected}</b> 不是一次对话——它是{selected === "unknown" ? "运行时换算不到真会话时的兜底桶（ACP 冷启动、旁路垫场）" : "分层自检写的记录"}。
          下面四问会全是"没有"，那是<b>正常的</b>，不是页面坏了。要看链路请在上面选一个「真实会话」。
        </p>
      )}

      {replay && view && (
        <>
          <FourQuestions
            answers={replay.answers}
            overlapVisible={hasOverlap(view)}
            branchSpanMs={maxBranchSpan(view)}
          />

          {replay.redacted && (
            <p className="muted">
              时间轴中含已脱敏内容（手机号/身份证/银行卡/邮箱）。看原文需单独提权并留审计。
            </p>
          )}
          {replay.hasMore && (
            <p className="muted">事件较多，当前只加载了前一段。四问的统计基于已加载部分。</p>
          )}

          {/*
            阅读顺序（2026-08-28 走查后重排）：
              四问（结论）→ 时间轴（证据）→ 折叠区（要深挖时才展开）。
            原来是四问 → 分跳耗时三卡 + 两张表 → 时间轴 → 逐条事件，
            七块内容一屏铺开、每块还带两三行说明，用户的原话是"不知道怎么看"。
            **一样都没删**——只是把"排障时才需要"的挪进折叠。
          */}
          <h2 className="trace-h2">
            这一轮的时间轴
            <Hint label="时间轴怎么看">
              <p>
                每条泳道一个参与者，横条是它占用的真实时间区间。
                <strong>两条横条在水平方向叠在一起 = 它们真的在并行</strong>，
                这就是上面第二问的证据本身。
              </p>
              <p>黄条 = 模拟数据，红条 = 失败。异常靠颜色突出，不靠筛掉别的。</p>
            </Hint>
          </h2>
          <div className="trace-timeline">
            <div className="trace-axis">
              <span>0ms</span>
              <span>{view.durationMs}ms</span>
            </div>
            {view.lanes.map((lane) => (
              <div className="trace-lane" key={lane.label}>
                <div className="trace-lane-label">{lane.label}</div>
                <div className="trace-lane-track">
                  {lane.bars.map((bar, i) => (
                    <div
                      key={`${bar.label}-${bar.startedAt}-${i}`}
                      className={TONE_CLASS[bar.tone]}
                      style={{ left: `${bar.leftPct}%`, width: `${bar.widthPct}%` }}
                      title={`${bar.label}${bar.detail ? ` — ${bar.detail}` : ""}\n+${bar.startedAt - view.startedAt}ms`}
                    >
                      <span className="trace-bar-text">{bar.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {hops && (
            <details className="trace-fold">
              <summary>
                分跳耗时（哪一跳慢、该优化谁）
                {hops.firstTokenMs !== null && (
                  <span className="trace-fold-peek">首字 {hops.firstTokenMs}ms · 全程 {hops.totalMs}ms</span>
                )}
              </summary>
              <HopTable hops={hops} />
            </details>
          )}

          <details className="trace-fold">
            <summary>
              逐条事件
              <span className="trace-fold-peek">{replay.timeline.length} 条</span>
            </summary>
          <div className="trace-events-head">
            <h2>
              逐条事件（{replay.timeline.length} 条）
              <Hint label="逐条事件说明">
                <p>
                  <strong>不做任何过滤</strong>：失败、降级、mock 数据都在这里，只是标了颜色。
                  过滤一旦存在，就无法证明"没被隐藏"。
                </p>
                <p>
                  「原始载荷」开关切的是<strong>同一批行的两种写法</strong>，不是两批行——
                  人话版把关键字段挑出来，原文一键即得。
                </p>
              </Hint>
            </h2>
            <span className="spacer" />
            <label className="trace-raw-toggle">
              <input
                type="checkbox"
                checked={rawPayload}
                onChange={(e) => setRawPayload(e.target.checked)}
              />
              原始载荷（JSON）
            </label>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>+ms</th>
                <th>事件</th>
                <th>轮次</th>
                <th>载荷</th>
              </tr>
            </thead>
            <tbody>
              {replay.timeline.map((e, i) => (
                <tr key={`${e.kind}-${e.at}-${i}`}>
                  <td>{e.at - view.startedAt}</td>
                  <td>{e.kind}</td>
                  <td className="muted">{e.turnId ?? "—"}</td>
                  <td>
                    {/* 原文始终留在 title 里：即使在人话模式下，鼠标一停也能看到完整 JSON */}
                    <code className="trace-payload" title={JSON.stringify(e.data)}>
                      {rawPayload ? JSON.stringify(e.data) : readablePayload(e.kind, e.data) || "—"}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </details>
        </>
      )}
    </section>
  );
}

/**
 * 四问。每条都写成"证据在哪"而不是"结论是什么"——
 * 演示时被追问，手指头能直接点到时间轴上对应的东西。
 */
/**
 * 分支里最长的那段耗时。用来区分"确实没并行"与"太快了测不出来"。
 *
 * 离线/fake 路径下分支往往 0~1ms 就结束，区间交集判据必然判不出重叠——
 * 但那不等于没有并行，只是时间分辨率不够。
 * **把这两种情况显示成同一句话，等于在演示时说了一句不实的话。**
 */
function maxBranchSpan(view: ReturnType<typeof layout>): number {
  const bars = view.lanes.flatMap((l) => l.bars).filter((b) => b.kind === "branch");
  return bars.reduce((m, b) => Math.max(m, b.endedAt - b.startedAt), 0);
}

/** 低于这个耗时，时间戳的毫秒分辨率不足以判定重叠。 */
const OVERLAP_RESOLUTION_MS = 2;

function FourQuestions({
  answers,
  overlapVisible,
  branchSpanMs,
}: {
  answers: ReplayResponse["answers"];
  overlapVisible: boolean;
  branchSpanMs: number;
}): JSX.Element {
  // 有多个 Agent、但分支快到测不出重叠——如实说"测不出"，不说"没有"。
  const tooFastToTell =
    !answers.hasParallelOverlap && answers.agentCount > 1 && branchSpanMs < OVERLAP_RESOLUTION_MS;
  const items = [
    {
      q: "① 真的是多 Agent 吗",
      a: `${answers.agentCount} 个 Agent 各有独立会话`,
      ok: answers.agentCount > 1,
      why: "下面每个 Agent 一条泳道，会话是分开的。",
    },
    {
      q: "② 并行是真的吗",
      a: answers.hasParallelOverlap
        ? "分支时间区间有交集"
        : tooFastToTell
          ? `分支耗时不足 ${OVERLAP_RESOLUTION_MS}ms，时间分辨率不足以判定`
          : "本次没有并行分支",
      ok: answers.hasParallelOverlap,
      // 页面自己也算一遍并行，与服务端判据相同。两边不一致说明有一侧错了，
      // 这比"看起来都对"有用得多。
      why:
        overlapVisible !== answers.hasParallelOverlap
          ? "⚠️ 页面与服务端判定不一致，其中一侧有问题。"
          : tooFastToTell
            ? `${answers.agentCount} 个分支都在 1ms 内跑完（离线/fake 路径的常态）——这不等于没有并行，是测不出来。真实模型下分支耗时以秒计，重叠会明显可见。`
            : answers.hasParallelOverlap
              ? "时间轴上两条分支横向叠在一起，肉眼可验。"
              : "本次只走了单分支，时间轴上也只有一条。",
    },
    {
      q: "③ 中断恢复是真的吗",
      a: answers.longestInterruptMs === null
        ? "本次没有人工确认"
        : `最长挂起 ${answers.longestInterruptMs}ms`,
      ok: answers.longestInterruptMs !== null,
      why: "「人工确认」泳道上的横条就是挂起区间，两端是 interrupt 与 resume 的真实时刻。",
    },
    {
      q: "④ 数据是真的吗",
      a: `工具调用 ${answers.toolCalls.total} 次：真实 ${answers.toolCalls.real} / 模拟 ${answers.toolCalls.mock}`,
      // **mock 不算真实**。合起来算就答不了这个问题了。
      ok: answers.toolCalls.real > 0 && answers.toolCalls.mock === 0,
      why: "模拟调用在时间轴上标黄，不与真实调用混在一起计数。",
    },
  ];

  /*
   * `why`（证据在哪）收进问号，卡面只留结论。
   *
   * 四张卡各带一段两三行的说明时，这一屏是四段文字而不是四个答案——
   * 而"并行是真的吗"的答案就三个字。想追问的人点问号，
   * 演示时手指头照样点得到时间轴上对应的东西（那才是证据本身）。
   */
  return (
    <div className="trace-answers">
      {items.map((it) => (
        <div className={`trace-answer${it.ok ? "" : " trace-answer--weak"}`} key={it.q}>
          <h3>
            {it.q}
            <Hint label={`${it.q}的依据`}>
              <p>{it.why}</p>
            </Hint>
          </h3>
          <strong>{it.a}</strong>
        </div>
      ))}
    </div>
  );
}
