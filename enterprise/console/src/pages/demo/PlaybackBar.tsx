/**
 * 回放控制条。
 *
 * # 它得先说清"现在放的是不是实时的"
 *
 * 一张停着的图和"系统很闲"在观众眼里没有区别（这是 LiveFlow 反复在处理的同一件事）。
 * 控制条一旦引入"暂停"，就多了一种新的停——**用户自己按停的**。
 * 所以最左边永远是状态标签：跟随实时 / 回放中 / 已暂停 / 固定在某一轮，
 * 而不是只有一个 ▶︎ 图标让人自己猜。
 *
 * # 轮次条是"可以点的进度"，不是列表
 *
 * 每一轮一个小格，放到哪一格就亮哪一格：既是进度，也是选择器。
 * 单独做一个下拉列表的话，演示时要点两下才能跳到"刚才那一轮"，
 * 而现场最常见的操作就是这一下。
 */

import type { Playback, PlaybackTurn } from "./playback";

export function PlaybackBar({
  turns,
  pb,
  live,
  onPlayPause,
  onStep,
  onReplay,
  onLoop,
  onPickTurn,
  onBackToLive,
}: {
  turns: PlaybackTurn[];
  pb: Playback;
  /** 这个会话此刻还在实时跟踪里——决定要不要给"回到跟随实时"。 */
  live: boolean;
  onPlayPause: () => void;
  onStep: (delta: number) => void;
  onReplay: () => void;
  onLoop: () => void;
  onPickTurn: (turnId: string) => void;
  onBackToLive: () => void;
}): JSX.Element {
  const i = pb.mode === "live" ? turns.length - 1 : turns.findIndex((t) => t.turnId === pb.turnId);
  const turn = i >= 0 ? turns[i] : undefined;
  const total = turn?.events.length ?? 0;
  const shown = pb.mode === "live" ? total : Math.min(pb.cursor, total);

  return (
    <div className="demo-playback">
      <span className={pb.mode === "live" ? "demo-pb-state demo-pb-state--live" : "demo-pb-state"}>
        {pb.mode === "live"
          ? "● 跟随最新轮次"
          : !pb.playing
            ? "⏸ 已暂停"
            : pb.pinned
              ? "◉ 固定回放这一轮"
              : "▶ 逐轮回放中"}
      </span>

      <div className="demo-pb-btns">
        <button type="button" title="上一轮" onClick={() => onStep(-1)} disabled={turns.length === 0}>
          ⏮
        </button>
        <button
          type="button"
          title={pb.mode === "live" ? "暂停（停在当前这一轮）" : pb.playing ? "暂停" : "继续"}
          onClick={onPlayPause}
          disabled={turns.length === 0}
        >
          {pb.mode !== "live" && !pb.playing ? "▶" : "⏸"}
        </button>
        <button type="button" title="下一轮" onClick={() => onStep(1)} disabled={turns.length === 0}>
          ⏭
        </button>
        <button type="button" title="重播这一轮" onClick={onReplay} disabled={!turn}>
          ↻ 重播
        </button>
        <button
          type="button"
          className={pb.loop ? "demo-pb-on" : undefined}
          title={pb.pinned ? "循环这一轮" : "放完从第一轮再来"}
          onClick={onLoop}
          disabled={turns.length === 0}
        >
          🔁 循环{pb.loop ? "：开" : "：关"}
        </button>
        {live && pb.mode !== "live" ? (
          <button type="button" onClick={onBackToLive} title="放弃回放，回到最新轮次">
            ⏵ 跟随实时
          </button>
        ) : null}
      </div>

      <span className="muted tiny demo-pb-progress">
        {turns.length === 0 ? (
          "这个会话还没有可回放的轮次"
        ) : (
          <>
            第 {i + 1}/{turns.length} 轮 · <code>{turn?.turnId}</code> · 事件 {shown}/{total}
          </>
        )}
      </span>

      {/* 轮次条：既是进度也是选择器。轮次多时横向滚动，不换行——版面高度留给图。 */}
      <div className="demo-pb-turns">
        {turns.map((t, k) => (
          <button
            key={t.turnId}
            type="button"
            className={k === i ? "demo-pb-turn demo-pb-turn--on" : "demo-pb-turn"}
            title={`第 ${k + 1} 轮 · ${t.turnId} · ${new Date(t.startedAt).toLocaleTimeString()} · ${t.events.length} 条事件`}
            onClick={() => onPickTurn(t.turnId)}
          >
            {k + 1}
          </button>
        ))}
      </div>
    </div>
  );
}
