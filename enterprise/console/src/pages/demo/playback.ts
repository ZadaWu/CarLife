/**
 * 大屏的轮次回放引擎 —— **纯函数，因为回放会错的地方全在时序上**。
 *
 * # 回放的是"这一轮怎么一步步走完的"，不是一张终局图
 *
 * 直接把一轮的全部事件投影上去，得到的是终局：所有走过的节点一次性亮起。
 * 那张图回答不了演示现场最常被问的那句"它到底先干了什么、再干了什么"。
 * 所以回放按事件逐条放出去，图跟着一步步亮——`projectRun` 已经能吃"截到一半"
 * 的事件序列（它本来就是给实时流用的），这里只负责决定**放到第几条**。
 *
 * # 事件间隔按真实时间压缩，不用固定节拍
 *
 * 固定节拍（每 300ms 一条）会把"哪一步慢"这个信息抹掉，而那正是大屏要讲的事：
 * 一次 LLM 等了 8 秒、一次工具 200ms 就回来了，观众应该看得出快慢差别。
 * 所以间隔取真实间隔压缩 `SPEED` 倍，再夹进 [`MIN_GAP`, `MAX_GAP`]：
 *
 *   · 下限保证一串同毫秒到达的事件不是"啪"地一起亮（那等于没回放）；
 *   · **上限是硬要求**——真实里等 30 秒的那一步，回放时不能让大屏黑着脸停 30 秒，
 *     现场没人等得了，而停住的画面与"系统挂了"在观众眼里没有区别。
 *
 * # 状态机只有两个模式，其余都是它俩的参数
 *
 *   · `live`   —— 跟最新一轮，新事件到了就画（实时会话的默认）。这是唯一"不由本模块推进"的模式。
 *   · `replay` —— 按 `turnId` + `cursor` 逐条放。历史会话默认就在这个模式里。
 *
 * `pinned` 是"用户点了某一轮"：放完不往下一轮走（"固定展示"）。
 * `loop` 是"放完再来"：pinned 时循环这一轮，否则循环整个会话。
 */

import type { TraceLike } from "../workflow/projection";

/** 真实间隔的压缩倍率。6 倍：一轮 30 秒的对话回放约 5 秒，一口气讲得完。 */
const SPEED = 6;
/** 事件之间至少停这么久，否则同毫秒到达的一批会一起亮。 */
export const MIN_GAP = 120;
/** 最多停这么久。见模块注释：上限是硬要求。 */
export const MAX_GAP = 900;
/** 一轮放完后停留多久再走下一轮——直接跳走的话，最后一步没人看得清。 */
export const HOLD_MS = 1_800;

export interface PlaybackTurn {
  turnId: string;
  /** 时间升序。 */
  events: TraceLike[];
  startedAt: number;
  endedAt: number;
}

/**
 * 把一段轨迹切成轮次。
 *
 * **按 turnId 归组而不是按相邻切段**：并行 fan-out 时同一轮的事件本来就交错，
 * 而两轮之间也可能因为落库批次而首尾相接。归组后按首事件时间排序，
 * 顺序就是这些轮次真实发生的顺序。
 *
 * 没有 `turnId` 的事件（ACP 冷启动、旁路垫场）**整条丢掉**：
 * 它们不属于任何一轮，混进来只会让图上亮起一条这一轮没走过的路径。
 */
export function turnsOf(events: readonly TraceLike[]): PlaybackTurn[] {
  const byTurn = new Map<string, TraceLike[]>();
  for (const e of events) {
    if (!e.turnId) continue;
    const list = byTurn.get(e.turnId);
    if (list) list.push(e);
    else byTurn.set(e.turnId, [e]);
  }
  return [...byTurn.entries()]
    .map(([turnId, list]) => {
      const sorted = [...list].sort((a, b) => a.at - b.at);
      return {
        turnId,
        events: sorted,
        startedAt: sorted[0]?.at ?? 0,
        endedAt: sorted[sorted.length - 1]?.at ?? 0,
      };
    })
    .sort((a, b) => a.startedAt - b.startedAt);
}

export type PlaybackMode = "live" | "replay";

export interface Playback {
  mode: PlaybackMode;
  /** `replay` 正在放的那一轮。`live` 时为 null（画的永远是最新那一轮）。 */
  turnId: string | null;
  /** 已放出的事件条数。 */
  cursor: number;
  playing: boolean;
  loop: boolean;
  /** 用户点了某一轮：放完停在这一轮，不往下走。 */
  pinned: boolean;
  /**
   * 放完之后回到 `live`。
   *
   * 只有"从实时会话点了重播"才为真：重播一遍是插播，插播完该回到实时——
   * 否则大屏就停在一张旧图上，而它看起来和"系统很闲"一模一样。
   */
  returnToLive: boolean;
  /** 上一次推进的时刻（wall clock）。 */
  lastAt: number;
}

/** 实时会话的默认：跟最新一轮。 */
export function livePlayback(now: number, loop = false): Playback {
  return {
    mode: "live",
    turnId: null,
    cursor: 0,
    playing: true,
    loop,
    pinned: false,
    returnToLive: false,
    lastAt: now,
  };
}

/** 历史会话的默认：从第一轮开始逐轮放。 */
export function replayPlayback(turns: readonly PlaybackTurn[], now: number, loop = false): Playback {
  return {
    mode: "replay",
    turnId: turns[0]?.turnId ?? null,
    cursor: 0,
    playing: true,
    loop,
    pinned: false,
    returnToLive: false,
    lastAt: now,
  };
}

/** 放第 `cursor` 条之前要等多久。见模块注释的压缩规则。 */
export function gapBefore(turn: PlaybackTurn, cursor: number): number {
  if (cursor <= 0) return 0;
  const prev = turn.events[cursor - 1];
  const cur = turn.events[cursor];
  if (!prev || !cur) return MIN_GAP;
  return Math.min(Math.max((cur.at - prev.at) / SPEED, MIN_GAP), MAX_GAP);
}

/** 当前正在放（或跟随）的那一轮。取不到返回 undefined——**不退回第一轮**。 */
export function currentTurn(
  pb: Playback,
  turns: readonly PlaybackTurn[],
): PlaybackTurn | undefined {
  if (pb.mode === "live") return turns[turns.length - 1];
  return turns.find((t) => t.turnId === pb.turnId);
}

/**
 * 推进一格。**每次至多放一条**：一次补齐"落下的那几条"会让积压的事件
 * 一瞬间全亮（切回标签页时最明显），那正好把回放本身取消掉了。
 *
 * 状态不该变时返回**原对象**，调用方 `setState` 因此直接 bail out，不重渲染。
 */
export function advance(pb: Playback, turns: readonly PlaybackTurn[], now: number): Playback {
  if (pb.mode === "live" || !pb.playing || turns.length === 0) return pb;

  const i = turns.findIndex((t) => t.turnId === pb.turnId);
  // 正在放的那一轮不见了（实时缓冲淘汰了它 / 刚切完会话还没对上号）：
  // 从第一轮重开，**不静默停住**——停住的画面与"系统很闲"分不开。
  if (i < 0) return { ...pb, turnId: turns[0].turnId, cursor: 0, lastAt: now };

  const turn = turns[i];
  if (pb.cursor < turn.events.length) {
    if (now - pb.lastAt < gapBefore(turn, pb.cursor)) return pb;
    return { ...pb, cursor: pb.cursor + 1, lastAt: now };
  }

  // ── 这一轮放完了：停留一下再决定去哪
  if (now - pb.lastAt < HOLD_MS) return pb;
  if (pb.pinned) return pb.loop ? { ...pb, cursor: 0, lastAt: now } : { ...pb, playing: false };
  if (i + 1 < turns.length) return { ...pb, turnId: turns[i + 1].turnId, cursor: 0, lastAt: now };
  if (pb.loop) return { ...pb, turnId: turns[0].turnId, cursor: 0, lastAt: now };
  if (pb.returnToLive) return livePlayback(now, pb.loop);
  return { ...pb, playing: false };
}

/** 点某一轮：固定放它（"选择某个 turn 就固定展示"）。 */
export function playTurn(
  pb: Playback,
  turnId: string,
  now: number,
  opts: { returnToLive?: boolean } = {},
): Playback {
  return {
    ...pb,
    mode: "replay",
    turnId,
    cursor: 0,
    playing: true,
    pinned: true,
    returnToLive: opts.returnToLive ?? false,
    lastAt: now,
  };
}

/** 重播当前这一轮。实时会话点它是"插播"：放完自动回到跟随。 */
export function replayCurrent(pb: Playback, turns: readonly PlaybackTurn[], now: number): Playback {
  const turn = currentTurn(pb, turns);
  if (!turn) return pb;
  return {
    ...pb,
    mode: "replay",
    turnId: turn.turnId,
    cursor: 0,
    playing: true,
    // 从实时插播的重播保持"不固定"，放完回实时；已经在回放里的重播保持原状。
    pinned: pb.mode === "live" ? false : pb.pinned,
    returnToLive: pb.mode === "live" ? true : pb.returnToLive,
    lastAt: now,
  };
}

/**
 * 上一轮 / 下一轮。
 *
 * 手动翻轮**一律固定住**：翻过去又被自动播走，等于这个按钮没有用。
 */
export function stepTurn(
  pb: Playback,
  turns: readonly PlaybackTurn[],
  delta: number,
  now: number,
): Playback {
  if (turns.length === 0) return pb;
  const cur = currentTurn(pb, turns);
  const i = cur ? turns.findIndex((t) => t.turnId === cur.turnId) : -1;
  const next = Math.min(Math.max((i < 0 ? 0 : i) + delta, 0), turns.length - 1);
  if (i === next && pb.mode === "replay") return pb;
  return playTurn(pb, turns[next].turnId, now, { returnToLive: false });
}

/** 播放 / 暂停。在 `live` 模式按下等于"停在此刻这一轮"，再按继续跟随。 */
export function togglePlay(pb: Playback, turns: readonly PlaybackTurn[], now: number): Playback {
  if (pb.mode === "live") {
    const turn = currentTurn(pb, turns);
    if (!turn) return pb;
    // 暂停实时 = 冻结在当前这一轮的完整画面（cursor 已到末尾），而不是从头放。
    return {
      ...pb,
      mode: "replay",
      turnId: turn.turnId,
      cursor: turn.events.length,
      playing: false,
      pinned: true,
      returnToLive: true,
      lastAt: now,
    };
  }
  if (!pb.playing && pb.returnToLive && pb.pinned) {
    // 从"暂停的实时"恢复：回到跟随，而不是接着放这一轮的余下部分。
    return livePlayback(now, pb.loop);
  }
  return { ...pb, playing: !pb.playing, lastAt: now };
}

/** 回到跟随实时。 */
export function backToLive(pb: Playback, now: number): Playback {
  return livePlayback(now, pb.loop);
}
