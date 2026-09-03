/**
 * 大屏的"现在流到哪了"（实时 + 可锁定到历史会话）。
 *
 * # 为什么不是把 10 秒轮询的聚合再刷快一点
 *
 * 大屏其余部分读的是轨迹**仓储**，而仓储是缓冲 + 定时批量写的
 * （在写入路径上 await 落库会把数据库延迟加到每一次 token 之间）。
 * 所以读库最快也要等一个刷盘周期。这条走的是运行时的实时总线，
 * 与落库并列扇出，谁也不挡谁。
 *
 * # 三种"没东西看"必须分得开
 *
 * 演示现场最怕的是一屏安静，而安静有三种完全不同的成因：
 *
 *   · 没连上（网关或运行时不在）——**要红**；
 *   · 连着但这一阵没人说话——正常，说"等着呢"；
 *   · 连着、有会话、但这一轮跑了很久还没动静——**这才是值得盯的**。
 *
 * 合成一句"暂无数据"正好在故障时说了句最像正常的话。
 *
 * # 锁定会话：实时的归实时总线，历史的归回放接口
 *
 * 锁定的会话若仍在实时跟踪列表里，走原来的实时路径（还能看它继续动）；
 * 不在（历史会话）就取回放接口的轨迹，**逐轮回放**，并明说这是回放不是实时
 * ——不标注的话，一张停着的图和"系统很闲"在观众眼里没有区别。
 * 两条路画的是同一张图、同一个 `projectRun`，不为回放另做一套投影。
 *
 * # 谁在推进那张图：两个来源，一个模式开关
 *
 *   · 实时主体 + `live` 模式 —— 图由**新事件**推进（最新一轮，来了就画）；
 *   · 其余一切 —— 图由**回放引擎**推进（`playback.ts` 按 cursor 逐条放）。
 *
 * 历史会话默认就在回放里（"回放每个 turn"）；实时会话默认跟随，
 * 控制条上的重播 / 暂停 / 点某一轮会把它临时切进回放，放完再回到跟随。
 * 判据全在 `playback.ts` 那个纯函数里，这里只负责挂表与接线。
 *
 * # 图一旦画出来就不再卸载
 *
 * 实时事件里混着会话外事件（`unknown` 兜底桶），一轮里能把"最近活动的会话"
 * 抢走五次——图被反复卸载再挂回来，整页跟着上下跳。选谁来画的判据修在
 * `live-model.ts`；这里再加一道：**画过一次之后就保留最后一帧**。
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { api, ApiError } from "../../api";
import { openEventStream, type StreamState } from "../../api/stream";
import { RunFlow } from "../workflow/RunFlow";
import { projectRun, type TraceLike } from "../workflow/projection";
import {
  EMPTY,
  ingest,
  mergeSessionTitles,
  sessionOf,
  type LiveState,
  type LiveTraceEvent,
} from "./live-model";
// 筛选参数与「会话与对话」页共用同一份（含日期 → 时间点那一步）：
// 两处各写一份的话，"选了 8-31 却看不到 8-31" 这种错只会在其中一处被修掉。
import { hasFilters, sessionQuery } from "../sessions/filters";
import { PlaybackBar } from "./PlaybackBar";
import {
  advance,
  backToLive,
  currentTurn,
  livePlayback,
  playTurn,
  replayCurrent,
  replayPlayback,
  stepTurn,
  togglePlay,
  turnsOf,
  type Playback,
  type PlaybackTurn,
} from "./playback";

/** 超过这么久没有新事件，就不再说"正在跑"。 */
const IDLE_MS = 90_000;
/**
 * 会话标题表的复取间隔。
 *
 * 标题是首轮之后异步补写的，所以"刚开始的那个会话此刻还没有标题"是常态——
 * 只在挂载时取一次的话，演示全程它就一直只有一串 id。20 秒一次：
 * 一个 groupBy + 一个 in 查询，比 KPI 的 10 秒轮询还轻。
 */
const TITLE_MS = 20_000;
/**
 * 显示中的会话还没有标题时的补取节奏，以及最多补几次。
 *
 * 新会话的标题是**首轮结束之后**才补写的，而大屏正好在这一段时间里盯着它——
 * 只按 20 秒的常规节奏走，演示前半程 topbar 上就只有一串 id。
 * 但**不能无限快取**：`guide-*`、`__selfcheck__` 这类会话永远不会有标题，
 * 它们一被显示就会一直落在这个分支里。
 */
const TITLE_PENDING_MS = 5_000;
const TITLE_PENDING_TRIES = 3;
/**
 * 事件成批刷进状态的间隔。
 *
 * 一次 fan-out 几十条事件在几百毫秒内到齐，逐条 setState 就是几十次重渲染，
 * 每次都要重建整张图的节点与边。250ms 一批，人眼看不出延迟，重渲染少一个量级。
 */
const FLUSH_MS = 250;
/**
 * 回放推进的心跳。
 *
 * 比 `MIN_GAP` 密一档就够：真正的节奏由 `gapBefore` 定，这里只是"来问一下该不该放下一条"。
 * 与事件刷新（250ms）分开是因为两者的快慢理由不同——那条是为了少重渲染，
 * 这条是为了让回放看起来是连续的。
 */
const TICK_MS = 60;
/**
 * 历史会话一次取多少条事件。
 *
 * 500 条约等于最近十几轮——大屏回放讲的是"这个会话怎么走过来的"，
 * 不是把整段历史都放一遍；真要逐条看全的在回放页。
 */
const REPLAY_LIMIT = 500;
/** 空轮次列表的常量：每次渲染新建一个 `[]` 会让下游的 memo 全部失效。 */
const EMPTY_TURNS: PlaybackTurn[] = [];
/** 会话列表一次取多少条（弹窗与标题表共用）。与"会话与对话"页的每页条数一致。 */
const SESSION_PAGE = 20;

/**
 * 会话选择弹窗的一行。
 *
 * **来源是 `/console/sessions`（与"会话与对话"页同一个接口）而不是轨迹表**：
 * 轨迹表按 `sessionId` 分组，里面混着 `unknown` 兜底桶、`system:worker`、
 * `guide-*` 导览任务、`__selfcheck__` 自检——它们都不是"会话"。
 * 大屏的选择器摆出这些东西，演示时点进去只会得到一张画不出路径的图。
 */
interface SessionRow {
  sessionId: string;
  /** 会话标题（M28-01）；`null` = 还没起出来。 */
  title: string | null;
  /** `null` = 访客会话（车机上车声明选了访客模式）。**不要渲染成空字符串。** */
  userId: string | null;
  turnCount: number;
  messageCount: number;
  updatedAt: string;
  lastMessageAt: number | null;
  /**
   * 轨迹事件条数（`withTraceCounts=1` 才有）。
   *
   * 与"轮次"是两回事：轮次是"说了几个来回"，事件是"跑起来落了多少步"
   * （意图、路由、分支、工具调用、span…）——**它决定这条点进去有没有东西可放**。
   *
   * ⚠️ 它是**整条会话**的总数，而回放控制条上"事件 8/13"的分母是**当前这一轮**的。
   * 单轮会话两者相同（实测 `sess-c27851e5-95c`：列表 13、控制条 8/13），
   * 多轮会话则是"这一轮的 ≤ 列表里的"（`sess-42c12c19-1f2` 7 轮共 267 条）。
   * 别把这两个数当同一个来对。
   *
   * `0` 与缺席不是一回事：`0` 表示查了、真没有（轨迹按天清理过），
   * 缺席表示这次没查。所以下面渲染时判的是 `=== undefined`，不是 `|| 0`。
   */
  traceEvents?: number;
}

/** 历史会话的全部轮次（来自回放接口，非实时）。 */
interface ReplayTurns {
  sessionId: string;
  turns: PlaybackTurn[];
  redacted: boolean;
}

export function LiveFlow({
  title,
  pinned,
  onPinChange,
  onAutoSession,
}: {
  /** 页面标题。与连接状态、会话信息合并成同一行（2026-08-26 压缩版面）。 */
  title: string;
  /** 锁定到的会话；null = 跟随实时最近活动。 */
  pinned: string | null;
  onPinChange: (sessionId: string | null) => void;
  /** 跟随模式下当前画的是哪个会话——父层拿它去圈 KPI。 */
  onAutoSession: (sessionId: string | undefined) => void;
}): JSX.Element {
  const [state, apply] = useReducer(
    (prev: LiveState, batch: readonly LiveTraceEvent[]) => ingest(prev, batch, Date.now()),
    EMPTY,
  );
  const [stream, setStream] = useState<{ s: StreamState; detail?: string }>({ s: "connecting" });
  const [now, setNow] = useState(() => Date.now());
  const [picker, setPicker] = useState(false);
  const [replay, setReplay] = useState<
    { kind: "idle" } | { kind: "loading" } | { kind: "empty" } | { kind: "error"; detail: string } | { kind: "ok"; data: ReplayTurns }
  >({ kind: "idle" });
  const pending = useRef<LiveTraceEvent[]>([]);
  // 会话 → 标题。实时总线只给 id，标题另取（见 mergeSessionTitles 的说明）。
  const [titles, setTitles] = useState<Record<string, string>>({});

  useEffect(() => {
    const flush = setInterval(() => {
      if (pending.current.length === 0) return;
      const batch = pending.current;
      pending.current = [];
      apply(batch);
    }, FLUSH_MS);

    const handle = openEventStream<LiveTraceEvent>("/console/trace/stream", {
      onEvent: (e) => pending.current.push(e),
      onState: (s, detail) => setStream({ s, detail }),
    });
    return () => {
      clearInterval(flush);
      handle.close();
    };
  }, []);

  // "多久没动静了"要自己走时钟：光靠事件驱动的话，**没有事件时它永远不刷新**，
  // 而"很久没有事件"恰恰是这里最该说出来的那件事。
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 2_000);
    return () => clearInterval(t);
  }, []);

  /** 并入一批行的标题（弹窗与定时复取共用同一条路）。 */
  const mergeTitles = useCallback((rows: SessionRow[]) => {
    setTitles((prev) => mergeSessionTitles(prev, rows));
  }, []);
  /**
   * 取一次会话标题表。
   *
   * **取不到不报错、不占版面**：标题是锦上添花，而这块地方是留给"实时通道断了"
   * 那条红线的——多一条"标题取不到"的告警只会稀释它。
   */
  const pullTitles = useCallback(() => {
    api
      .get<{ sessions: SessionRow[] }>(`/console/sessions?limit=${SESSION_PAGE}`)
      .then((r) => mergeTitles(r.sessions))
      .catch(() => undefined);
  }, [mergeTitles]);

  // 锁定时优先在实时列表里找它；找不到才算历史会话。
  const liveSession = useMemo(() => sessionOf(state, pinned ?? undefined), [state, pinned]);
  const liveTurns = useMemo(() => turnsOf(liveSession?.events ?? []), [liveSession]);
  const autoSid = useMemo(() => sessionOf(state)?.sessionId, [state]);

  // 跟随模式画的是谁，如实报给父层（KPI 圈定跟着它走）。
  useEffect(() => {
    onAutoSession(autoSid);
  }, [autoSid, onAutoSession]);

  // 锁定的会话不在实时列表里 → 拉回放。锁定变化就重拉；回到跟随就清掉。
  const needReplay = pinned !== null && liveTurns.length === 0;
  useEffect(() => {
    if (!needReplay || pinned === null) {
      setReplay({ kind: "idle" });
      return;
    }
    let dead = false;
    setReplay({ kind: "loading" });
    api
      .get<{ timeline: Array<TraceLike>; redacted: boolean; hasMore: boolean }>(
        `/console/replay/${encodeURIComponent(pinned)}?limit=${REPLAY_LIMIT}`,
      )
      .then((r) => {
        if (dead) return;
        const all = turnsOf(r.timeline);
        if (all.length === 0) {
          setReplay({ kind: "empty" });
          return;
        }
        /*
         * 取的是**最近** REPLAY_LIMIT 条事件（仓储按时间倒序取再反转）。
         * 还有更多时，最老的那一轮多半只剩后半截——把半截当一轮放出去，
         * 图上就是一条从没发生过的路径（起点不亮、中间凭空开始）。只剩一轮时不丢，
         * 那时"半截"总比"什么都没有"强，且 topbar 会说明它被截过。
         */
        const truncated = r.hasMore && all.length > 1;
        setReplay({
          kind: "ok",
          data: {
            sessionId: pinned,
            turns: truncated ? all.slice(1) : all,
            redacted: r.redacted,
          },
        });
      })
      .catch((e: unknown) => {
        if (!dead) setReplay({ kind: "error", detail: e instanceof ApiError ? e.code : String(e) });
      });
    return () => {
      dead = true;
    };
  }, [needReplay, pinned]);

  // ── 当前主体：放谁的哪些轮次。历史会话走回放接口，其余都走实时缓冲。
  const historical = needReplay;
  const turns = historical
    ? replay.kind === "ok" && replay.data.sessionId === pinned
      ? replay.data.turns
      : EMPTY_TURNS
    : liveTurns;
  const turnsRef = useRef<PlaybackTurn[]>(turns);
  turnsRef.current = turns;

  /**
   * 回放状态。**换主体就整个重置**：历史会话从第一轮开始逐轮放，
   * 实时会话回到跟随最新——把上一个会话的 cursor 带过来，画面会停在一个
   * 与新会话毫无关系的位置上。
   *
   * 跟随模式下"最近活动的会话"变了也算换主体：正在插播的重播会被打断，
   * 回到跟随新会话。这是故意的——大屏在跟随模式下的承诺就是"给你看最新的那段"，
   * 而状态标签会立刻翻回"跟随最新轮次"，比默默把回放接到另一个会话的轮次上诚实。
   */
  const [pb, setPb] = useState<Playback>(() => livePlayback(Date.now()));
  const subject = `${historical ? "replay" : "live"}:${pinned ?? autoSid ?? ""}`;
  const lastSubject = useRef(subject);
  useEffect(() => {
    if (lastSubject.current === subject) return;
    lastSubject.current = subject;
    setPb(
      historical
        ? replayPlayback(turnsRef.current, Date.now())
        : livePlayback(Date.now()),
    );
  }, [subject, historical]);

  // 心跳：只在真的要推进时挂表（live 模式与暂停时不挂）。
  useEffect(() => {
    if (pb.mode === "live" || !pb.playing) return;
    const t = setInterval(() => setPb((p) => advance(p, turnsRef.current, Date.now())), TICK_MS);
    return () => clearInterval(t);
  }, [pb.mode, pb.playing]);

  const turn = currentTurn(pb, turns);
  const shownEvents = useMemo(() => {
    if (!turn) return [];
    return pb.mode === "live" ? turn.events : turn.events.slice(0, pb.cursor);
  }, [turn, pb.mode, pb.cursor]);
  // "多久没动静了"只对实时主体有意义——历史会话本来就不会再动。
  const idleMs = !historical && liveSession ? now - liveSession.lastTurnAt : 0;
  const idle = !historical && (!turn || idleMs > IDLE_MS);
  const run = useMemo(
    () =>
      projectRun(shownEvents, {
        // 回放途中让当前节点保持呼吸；放完（或实时里很久没动静）就停下来。
        live: pb.mode === "live" ? !idle : pb.cursor < (turn?.events.length ?? 0),
      }),
    [shownEvents, idle, pb.mode, pb.cursor, turn],
  );

  const connected = stream.s === "open";
  // topbar 上正在报的是哪个会话：跟随时是图上那个，锁定时就是锁定的那个。
  const shownSid = pinned ?? liveSession?.sessionId;
  const shownTitle = shownSid ? titles[shownSid] : undefined;

  /**
   * 标题表：挂载即取、定时复取，**换了会话再补取一次**。
   *
   * 最后这一下是为了跟随模式：会话是随时会换的，而新会话的标题多半
   * 落在下一个 20 秒里——不补这一次，观众会看着 topbar 上的一串 id 干等。
   */
  useEffect(() => {
    pullTitles();
  }, [pullTitles, shownSid]);
  useEffect(() => {
    const t = setInterval(pullTitles, TITLE_MS);
    return () => clearInterval(t);
  }, [pullTitles]);

  // 还没有标题的那几次补取（见 TITLE_PENDING_MS）。换会话就重新计次。
  const [pendingTries, setPendingTries] = useState(0);
  useEffect(() => setPendingTries(0), [shownSid]);
  useEffect(() => {
    if (!shownSid || shownTitle || pendingTries >= TITLE_PENDING_TRIES) return;
    const t = setTimeout(() => {
      pullTitles();
      setPendingTries((n) => n + 1);
    }, TITLE_PENDING_MS);
    return () => clearTimeout(t);
  }, [shownSid, shownTitle, pendingTries, pullTitles]);

  return (
    <>
      {/* 标题、连接状态、切换入口、跟踪计数、会话信息合成一行：大屏的每一像素高度都是图的 */}
      <div className="demo-topbar">
        <h1>{title}</h1>
        <span className={connected ? "banner inline" : "banner banner-warn inline"}>
          {connected
            ? "实时轨迹：已连接"
            : stream.s === "connecting"
              ? "实时轨迹：连接中…"
              : `实时轨迹：已断开${stream.detail ? `（${stream.detail}）` : ""}——正在退避重连`}
        </span>
        <button type="button" className="demo-pick-btn" onClick={() => setPicker(true)}>
          {/* 按钮上有标题就报标题（与弹窗、下面那行同一取向）；完整 id 在下面那行。 */}
          ⇄ {pinned ? `已锁定 ${short(shownTitle ?? pinned)}` : "跟随实时 · 切换会话"}
        </button>
        {connected ? (
          <span className="muted tiny" title="会话外事件：ACP 冷启动、旁路垫场等不属于任何一轮的事件">
            跟踪 {state.sessions.length} 个会话
            {state.orphanCount > 0 ? ` · ${state.orphanCount} 条会话外事件` : ""}
          </span>
        ) : null}
        {!historical ? (
          // ── 实时主体（跟随 / 锁定到一个还在动的会话）：原有的三种安静各说各的
          !turn ? (
            <span className="muted tiny">
              {pinned === null ? "跟随实时" : "已锁定"} ·
              连着，还没有任何轮次开始。跑一次对话即可看到它在图上流动。
            </span>
          ) : (
            /*
             * "现在跟的是谁"必须写在 topbar 上（M9-07 走查）：
             * 观众在图上看到的是节点与边，没有任何地方能读出会话与轮次的 id，
             * 而讲解的下一步往往就是拿这两个 id 去回放页 / 日志里查。
             */
            <span className="muted tiny">
              <strong>{pinned === null ? "跟随实时" : "已锁定"}</strong> · 会话{" "}
              <SessionTag id={shownSid ?? ""} title={shownTitle} />
              {" "}· {pb.mode === "live" ? "最新一轮" : "回放"} <code>{turn.turnId}</code>
              {pb.mode !== "live"
                ? ""
                : run.finished
                  ? " · 本轮已收口"
                  : idle
                    ? " · 已很久没有新事件"
                    : " · 进行中"}
              {state.anyRedacted ? " · 含已脱敏内容" : ""}
            </span>
          )
        ) : replay.kind === "loading" ? (
          <span className="muted tiny">
            正在取会话 <SessionTag id={pinned ?? ""} title={shownTitle} /> 的轨迹…
          </span>
        ) : replay.kind === "error" ? (
          <span className="error tiny">
            取不到会话 <SessionTag id={pinned ?? ""} title={shownTitle} /> 的轨迹：{replay.detail}
          </span>
        ) : replay.kind === "empty" ? (
          <span className="muted tiny">
            会话 <SessionTag id={pinned ?? ""} title={shownTitle} /> 没有任何完整轮次，图上没有可画的路径。
          </span>
        ) : (
          <span className="muted tiny">
            <strong>历史会话回放（非实时）</strong> · 会话{" "}
            <SessionTag id={pinned ?? ""} title={shownTitle} />
            {turn ? (
              <>
                {" "}· 正在放 <code>{turn.turnId}</code>
              </>
            ) : null}
            {replay.kind === "ok" && replay.data.redacted ? " · 含已脱敏内容" : ""}
          </span>
        )}
      </div>

      {!connected ? (
        <p className="error">
          实时通道没连上——<strong>下面这张图不代表"系统很闲"，它只是停在最后一帧</strong>。
          先确认网关与 agent-runtime 都在（<code>dev:status</code>）。
        </p>
      ) : null}

      {/* 这条只在**真的跟着实时**时才有意义：回放里的"没有新事件"是回放放完了，不是卡住。 */}
      {idle && pb.mode === "live" && pinned === null && turn && !run.finished ? (
        <p className="error">
          这一轮已经 {Math.round(idleMs / 1000)} 秒没有新事件，也没有收口——
          停在上面亮着的最后一步。这是值得盯的那种安静。
        </p>
      ) : null}

      {/*
        回放控制条**一直挂着**（哪怕零轮次时是一排禁用按钮）：
        它同时承担"现在放的是不是实时"这句话，而那句话在没有轮次时最需要说。
      */}
      <PlaybackBar
        turns={turns}
        pb={pb}
        live={!historical}
        onPlayPause={() => setPb((p) => togglePlay(p, turnsRef.current, Date.now()))}
        onStep={(d) => setPb((p) => stepTurn(p, turnsRef.current, d, Date.now()))}
        onReplay={() => setPb((p) => replayCurrent(p, turnsRef.current, Date.now()))}
        onLoop={() => setPb((p) => ({ ...p, loop: !p.loop }))}
        onPickTurn={(id) =>
          setPb((p) => playTurn(p, id, Date.now(), { returnToLive: !historical }))
        }
        onBackToLive={() => setPb((p) => backToLive(p, Date.now()))}
      />

      {/*
        **无条件挂着**。没有可画的轮次时它就是一张全暗的空图——
        版面高度不变，比"一行说明与 420px 的图来回替换"好得多。
      */}
      {/* 投屏态由外层 flex 把剩余视口高度交给流程图，避免固定高度把 KPI 推到下一页。 */}
      <RunFlow run={run} fit className="demo-run-flow" />

      {picker ? (
        <SessionPicker
          liveIds={state.sessions.map((s) => s.sessionId)}
          pinned={pinned}
          // 弹窗取到的行顺手并进标题表：选完就关，topbar 不必再等下一次复取。
          onRows={mergeTitles}
          onClose={() => setPicker(false)}
          onPick={(sid) => {
            onPinChange(sid);
            setPicker(false);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * 会话选择弹窗。
 *
 * # 只摆"会话"，与"会话与对话"页同一个概念
 *
 * 列表来自 `/console/sessions`——那一页摆的是什么，这里就摆什么（同一张 `sessions` 表、
 * 同样按最后活跃排序、同样的标题与轮次口径）。此前用的是轨迹表的 `groupBy sessionId`，
 * 于是 `unknown` 兜底桶、`system:worker`、`guide-*` 导览任务、`__selfcheck__` 自检
 * 全都摆进了这个"会话列表"——**它们不是会话**，演示时点进去只会得到一张画不出路径的图。
 *
 * 代价是列表里可能出现"还没有任何轨迹"的会话（建了但没说过话）。这比反过来好：
 * 选中后 topbar 会明说"没有可回放的轮次"，而摆一个 `unknown` 出来没人知道那是什么。
 *
 * 正在被实时跟踪的标出来——选它等于"锁定后还能看它继续动"。
 */
function SessionPicker({
  liveIds,
  pinned,
  onRows,
  onClose,
  onPick,
}: {
  liveIds: string[];
  pinned: string | null;
  /** 取到的行报给父层（它据此在 topbar 上显示标题）。 */
  onRows: (rows: SessionRow[]) => void;
  onClose: () => void;
  onPick: (sessionId: string | null) => void;
}): JSX.Element {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** 筛选条件：与「会话与对话」页同一组（用户 / 会话 id / 标题 / 建于起止）。 */
  const [userId, setUserId] = useState("");
  const [keyword, setKeyword] = useState("");
  const [title, setTitle] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const filters = { userId, sessionId: keyword, title, since, until };
  /**
   * 分页游标栈。**存"每一页的起点"而不是页码**——接口是游标式的
   * （`nextCursor` 指向下一页的第一条），没有 offset 也就没有"第 3 页"这个东西。
   * 存一摞起点才翻得回去；栈长度正好就是当前第几页。与「会话与对话」页同一形态。
   */
  const [stack, setStack] = useState<Array<string | undefined>>([undefined]);
  const [next, setNext] = useState<string | null>(null);
  const cursor = stack[stack.length - 1];

  const report = useRef(onRows);
  report.current = onRows;

  const load = useCallback(() => {
    /*
     * `nonEmpty=1`：**只列说过话的会话**。
     *
     * 这个弹窗是用来挑"放哪一段"的，而零消息的会话点进去只有一张空图。
     * 过滤放在**服务端**：在前端筛会把"每页 20 条"变成"这一页只剩 6 条"，
     * 翻页也跟着不准。「会话与对话」页不带这个参数——运营视角要看得见
     * "建了但没说话"的会话（上车声明、举证脚本、发失败的那一次都会留下一条）。
     */
    const q = sessionQuery(
      { userId, sessionId: keyword, title, since, until },
      { limit: String(SESSION_PAGE), nonEmpty: "1", withTraceCounts: "1" },
    );
    if (cursor) q.set("cursor", cursor);
    setLoading(true);
    setError(null);
    api
      .get<{ sessions: SessionRow[]; hasMore: boolean; nextCursor: string | null }>(
        `/console/sessions?${q}`,
      )
      .then((r) => {
        setRows(r.sessions);
        setNext(r.hasMore ? r.nextCursor : null);
        report.current(r.sessions);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.code : String(e)))
      .finally(() => setLoading(false));
  }, [userId, keyword, title, since, until, cursor]);

  /*
   * 边打字边查，但**隔 300ms 才发**。
   *
   * 「会话与对话」页是每敲一个键就发一次；那一页是运营自己在用，无所谓。
   * 这个弹窗开在**投屏的大屏上**，而这里最常做的操作正是粘一串 `sess-` 开头的 id——
   * 不去抖的话一次粘贴之后是十几个请求排队回来，最后一个才是对的。
   * 翻页（cursor 变）也走这条，多等 300ms 看不出来。
   */
  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  /**
   * 改筛选条件就回到第一页。
   *
   * 不回的话，上一次翻到第 3 页的游标会被带到新的结果集上——那个 id 在新集合里
   * 多半不存在，翻出来是一页空的，而看的人以为"这个筛选没有结果"。
   */
  const resetPaging = (): void => {
    setStack([undefined]);
    setNext(null);
  };

  return (
    <div className="demo-modal-overlay" onClick={onClose}>
      <div className="demo-modal" role="dialog" aria-label="选择会话" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>选择会话</h3>
          <button type="button" className="demo-pick-btn" onClick={onClose}>关闭</button>
        </header>

        {/*
          **过滤是开着的，就要写在脸上**：只列说过话的会话。
          悄悄滤掉的后果是"我明明建过那个会话"变成一场没有线索的排查。
        */}
        <p className="muted tiny demo-modal-note">
          只列说过话的会话；建了但一句没说的去「会话与对话」页看。
        </p>

        {/* 筛选：与「会话与对话」页同一组条件、同一套语义（会话 id 是精确定位，不是模糊搜） */}
        <div className="demo-filters">
          <label className="demo-field">
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
          <label className="demo-field">
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
            标题模糊搜：与上面那个 id 精确定位是两件事——手上有 id 用那个，
            只记得"聊的是保养那段"用这个。**没起名的会话搜不到**（标题是首轮之后
            才生成的），空结果时下面会说明。
          */}
          <label className="demo-field">
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
          {/* 日期范围按**创建时间**筛（与接口口径一致），本地时区整天，见 ../sessions/filters。 */}
          <label className="demo-field demo-field--day">
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
          <label className="demo-field demo-field--day">
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
          {hasFilters(filters) && (
            <button
              type="button"
              className="demo-pick-btn"
              onClick={() => {
                setUserId("");
                setKeyword("");
                setTitle("");
                setSince("");
                setUntil("");
                resetPaging();
              }}
            >
              清空
            </button>
          )}
        </div>

        {/*
          「跟随实时」不是一条会话，所以它**不进列表、不受筛选与翻页影响**，
          固定钉在这里。把它混进分页结果里，翻到第 2 页就找不着回实时的路了。
        */}
        <button
          type="button"
          className={pinned === null ? "demo-session-row demo-session-row--current" : "demo-session-row"}
          onClick={() => onPick(null)}
        >
          <span>跟随实时</span>
          <span className="muted tiny">自动画最近活动的会话（默认）</span>
        </button>

        <div className="demo-modal-list">
          {error ? (
            <p className="error">取不到会话列表：{error}</p>
          ) : rows === null ? (
            <p className="muted">加载中…</p>
          ) : rows.length === 0 ? (
            /*
             * **把"过滤是开着的"说出来**。不说的话，按 id 精确定位一条
             * 还没说过话的会话会得到"没有匹配"——而那条会话明明存在，
             * 看的人会以为自己记错了 id。
             */
            <p className="muted">
              {hasFilters(filters) ? "没有匹配的会话" : "还没有任何会话"}
              ——注意这里<b>只列说过话的</b>，建了但一句没说的不在这里，去「会话与对话」页看。
              {title.trim() ? "标题是首轮之后才生成的，还没起名的会话也搜不到。" : ""}
            </p>
          ) : (
            rows.map((r) => (
              <button
                key={r.sessionId}
                type="button"
                className={
                  pinned === r.sessionId
                    ? "demo-session-row demo-session-row--current"
                    : "demo-session-row"
                }
                onClick={() => onPick(r.sessionId)}
              >
                {/*
                  有标题就把标题当主行、id 降到副行（M28-01）。
                  此前这里只有一列随机串，演示时找"刚才那段"全靠时间戳比对。
                  **id 不撤**：标题会重名，而这一步之后往往就要拿 id 去查轨迹。
                */}
                <span className={r.title ? "" : "mono"}>{r.title ?? r.sessionId}</span>
                <span className="muted tiny">
                  {r.title ? <code className="mono">{r.sessionId}</code> : null}
                  {r.title ? " · " : ""}
                  {/* 列表已由服务端滤掉零消息的会话（`nonEmpty=1`），这里的轮次恒 > 0。 */}
                  {r.turnCount} 轮 ·{" "}
                  {/*
                    轨迹事件条数：这条点进去能放多少步。
                    **`0` 要说成"无轨迹"而不是"0 条事件"**——轨迹是按天清理的
                    （`TraceRepository.prune`），老会话"有 12 轮、0 条事件"是常态，
                    而那句话真正的意思是"这条没得放"，不是"这条很短"。
                  */}
                  {r.traceEvents === undefined
                    ? null
                    : r.traceEvents > 0
                      ? `${r.traceEvents} 条事件 · `
                      : "无轨迹 · "}
                  {new Date(r.lastMessageAt ?? r.updatedAt).toLocaleTimeString()}
                  {/* 访客会话要明说，不能渲染成空（与会话与对话页同一口径）。 */}
                  {r.userId ? "" : " · 访客"}
                  {liveIds.includes(r.sessionId) ? " · ● 实时跟踪中" : ""}
                </span>
              </button>
            ))
          )}
        </div>

        {/*
          翻页条。**列表非空才显示**——空结果下摆一排翻页按钮，
          看起来像"还有别的页没翻到"，而其实是这个筛选没有结果（与会话与对话页同一取向）。
        */}
        {rows && rows.length > 0 && (stack.length > 1 || next) ? (
          <div className="demo-pager">
            <button
              type="button"
              className="demo-pick-btn"
              disabled={stack.length === 1 || loading}
              onClick={() => setStack((st) => st.slice(0, -1))}
            >
              ← 上一页
            </button>
            {/*
              只说"第 N 页"，**不说"共 M 页"**：游标式接口拿不到总数，
              编一个总页数出来就是假的。同理不做页码跳转——那需要 offset。
            */}
            <span className="muted tiny">
              第 {stack.length} 页 · 每页 {SESSION_PAGE} 条{loading ? " · 取数中…" : ""}
            </span>
            <button
              type="button"
              className="demo-pick-btn"
              disabled={!next || loading}
              onClick={() => setStack((st) => [...st, next ?? undefined])}
            >
              下一页 →
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 会话在 topbar 上的一处呈现：**有标题就把标题摆出来，id 一直都在**。
 *
 * 与选择弹窗同一取向（M28-01）：标题会重名，而看完这一行往往就要拿 id
 * 去回放页查——所以标题不是替换 id，是排在它前面。
 */
function SessionTag({ id, title }: { id: string; title?: string }): JSX.Element {
  return (
    <>
      {title ? <b className="demo-session-title">{title}</b> : null}
      {title ? " " : null}
      <code>{id}</code>
    </>
  );
}

/** 按钮上放不下整串，截断只用在按钮上——完整值永远在它下面那行。 */
function short(text: string): string {
  return text.length > 14 ? `${text.slice(0, 12)}…` : text;
}
