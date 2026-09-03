/**
 * 大屏实时视图的状态归并 —— **纯函数，因为它踩过的坑都是逻辑坑，不是渲染坑**。
 *
 * # `unknown` 不是一个会话，是兜底桶
 *
 * 运行时的 `resolveTraceKey` 换算不到真会话时返回字面量 `unknown`：
 * ACP 冷启动（发生在任何一轮之外）、旁路垫场话的提示词（那条路上没有 threadId）
 * 都落在这里。它**不断有新事件**——实测一轮出行对话里，最近活动的会话在
 * `unknown` 与真实会话之间来回切了五次。
 *
 * 第一版按"最近有事件的那个会话"选要画的对象，于是每切一次，
 * 整张图（420px）就被卸载换成一行"最近的事件不属于任何轮次"，再切回来又挂上——
 * 页面上所有东西跟着上下跳。**这不是闪烁的观感问题，是那张图有一半时间不在。**
 *
 * 所以选择判据改成：**最近一条带 turnId 的事件属于谁**。
 * 会话外事件不丢，单独计数报出来（与会话详情页数 orphan 同一取向：
 * 不吭声的话读者会以为"就这些"）。
 */

export interface LiveTraceEvent {
  sessionId: string;
  turnId?: string;
  kind: string;
  at: number;
  data: Record<string, unknown>;
  redacted?: boolean;
}

/**
 * 每个会话留多少条。一轮实测 20~40 条，出行 fan-out 上百——
 * 300 够放下最近两三轮，再多就是在浏览器里养一份没人维护的轨迹副本，
 * **而真正的历史在回放页**。
 */
const PER_SESSION = 300;
/** 同时跟踪几个会话。超出按最近活动淘汰。 */
const MAX_SESSIONS = 8;

/** `resolveTraceKey` 换算不到真会话时的字面量。见模块注释。 */
export const ORPHAN_SESSION = "unknown";

export interface LiveSession {
  sessionId: string;
  events: LiveTraceEvent[];
  /** 最近一条**带 turnId** 的事件的到达时刻。选谁来画看的是它。 */
  lastTurnAt: number;
}

export interface LiveState {
  sessions: LiveSession[];
  /** 不属于任何轮次的事件条数（含 `unknown` 桶）。**不丢，要报出来。** */
  orphanCount: number;
  /** 出现过已脱敏内容——页面据此说明看到的不是原文。 */
  anyRedacted: boolean;
}

export const EMPTY: LiveState = { sessions: [], orphanCount: 0, anyRedacted: false };

/**
 * 并入一批事件。**成批而不是逐条**：事件是成串到达的
 * （一次 fan-out 几十条），逐条 setState 就是几十次重渲染。
 */
export function ingest(
  state: LiveState,
  batch: readonly LiveTraceEvent[],
  now: number,
): LiveState {
  if (batch.length === 0) return state;

  let orphanCount = state.orphanCount;
  let anyRedacted = state.anyRedacted;
  const byId = new Map(state.sessions.map((s) => [s.sessionId, s]));

  for (const e of batch) {
    if (e.redacted) anyRedacted = true;
    if (!e.turnId || e.sessionId === ORPHAN_SESSION) {
      orphanCount += 1;
      // 会话外事件到此为止：让它进 `sessions` 就等于让兜底桶去抢"最近活动"。
      continue;
    }
    const prev = byId.get(e.sessionId);
    byId.set(e.sessionId, {
      sessionId: e.sessionId,
      events: [...(prev?.events ?? []), e].slice(-PER_SESSION),
      lastTurnAt: now,
    });
  }

  const sessions = [...byId.values()]
    .sort((a, b) => b.lastTurnAt - a.lastTurnAt)
    .slice(0, MAX_SESSIONS);

  return { sessions, orphanCount, anyRedacted };
}

/**
 * 要画哪个会话：指定了就找它（找不到返回 undefined，**不悄悄退回最近活动**），
 * 没指定就是最近有轮次事件的那个。
 *
 * 单独抽出来是因为「选哪个会话」与「取它的哪一轮」是两件事：
 * 回放控制条要的是这个会话的**全部**轮次，不是最后一轮。
 */
export function sessionOf(state: LiveState, sessionId?: string): LiveSession | undefined {
  return sessionId ? state.sessions.find((x) => x.sessionId === sessionId) : state.sessions[0];
}

export interface LiveTurn {
  sessionId: string;
  turnId: string;
  events: LiveTraceEvent[];
  /** 最近一条事件到现在多久。判"是不是卡住了"用它。 */
  lastAt: number;
}

/**
 * 要画哪一轮：最近活动会话的**最后一轮**。
 *
 * 只取一轮而不是整个会话：把三轮铺在一张图上，第三轮的分支会和第一轮的
 * 混在一起亮着，读出来的是一条从没发生过的路径。
 *
 * `sessionId` 指定要画哪个会话（大屏锁定某个会话时用）；它不在跟踪列表里
 * 就返回 undefined——**不悄悄退回"最近活动"**，调用方要能分清
 * "锁定的会话没有实时事件"与"跟随模式没人说话"，两者的提示完全不同。
 */
export function pickTurn(state: LiveState, sessionId?: string): LiveTurn | undefined {
  const s = sessionOf(state, sessionId);
  if (!s || s.events.length === 0) return undefined;
  const turnId = s.events[s.events.length - 1].turnId;
  if (!turnId) return undefined;
  const events = s.events.filter((e) => e.turnId === turnId);
  return {
    sessionId: s.sessionId,
    turnId,
    events,
    lastAt: s.lastTurnAt,
  };
}

/** 会话列表行里与标题有关的那部分（`/console/replay/sessions` 的子集）。 */
export interface TitledSession {
  sessionId: string;
  title: string | null;
}

/**
 * 并入一批「会话 → 标题」。
 *
 * # 为什么大屏要自己攒一张标题表
 *
 * 实时轨迹总线只给 `sessionId`（轨迹表按 id 分组，它本来就不认识 `sessions` 那张表），
 * 而 topbar 要按 M28-01 的取向"有标题就把标题摆出来"。标题只能另取一次
 * （`/console/replay/sessions`），于是取回来的东西要在页面里留着——
 * 跟随模式下会话是会换的，换一次就重新请求一次太吵。
 *
 * # `null` 不覆盖已知标题
 *
 * 标题是首轮之后异步补写的：同一个会话在前一次请求里还没有标题，
 * 下一次才有。反过来"有了又变回 null"在业务上不发生，
 * 而**让 null 覆盖会把刚显示出来的标题又抹掉**，看起来像标题在闪。
 *
 * 返回值在无变化时是原对象——渲染层据此避免整张图跟着重画。
 */
export function mergeSessionTitles(
  prev: Readonly<Record<string, string>>,
  rows: readonly TitledSession[],
): Record<string, string> {
  let next: Record<string, string> | undefined;
  for (const r of rows) {
    if (!r.title) continue;
    if (prev[r.sessionId] === r.title) continue;
    next ??= { ...prev };
    next[r.sessionId] = r.title;
  }
  return next ?? prev;
}
