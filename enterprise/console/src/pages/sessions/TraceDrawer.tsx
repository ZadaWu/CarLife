/**
 * 轨迹抽屉（施工单 TD-08 追加；2026-09-15 起有研发 / 业务两个视图）。
 *
 * # 为什么是抽屉而不是就地展开
 *
 * 第一版做的是在轮次上方就地插入。问题是它**把对话列表撑开了**——
 * 轨迹面板比一轮对话高得多，展开后上下两轮被推得老远，
 * "这句话对应这段耗时"这个视觉关联反而断了。
 *
 * 抽屉从右侧拉出，对话列表原地不动：**左边是问题（哪句话），右边是证据（哪一跳慢）**，
 * 两者同屏。代价是一次只能看一轮（见 `drawerTurn` 的说明）。
 *
 * # 遮罩点击与 Esc 都要能关
 *
 * 遮罩挡住了正文，只留右上角一个叉的话，鼠标党每次都要瞄准那 20 像素。
 *
 * # 两个视图，同一批事件
 *
 * 研发视图（`DevTurnTrace`）回答"哪一跳慢、并行真不真、数据真不真"；
 * 业务视图（`BusinessTrace`）回答"系统听懂了什么、每一步查了什么答了什么、最后答了什么"。
 * 两者读的是**同一份 `replay.timeline` 切到本轮**的事件，没有第二份数据、没有过滤——
 * 业务视图只是换了组织方式。切换记在 localStorage；缺省按角色：ops 先看业务视图，admin 先看研发视图。
 */

import { useState, type ReactNode } from "react";

import { useIdentity } from "../../app/identity";
import { BusinessTrace } from "./BusinessTrace";
import { TurnTrace, type ReplayPayload, type ReplayState } from "./DevTurnTrace";
import type { ConsoleMessage } from "./turns";

export type TraceView = "business" | "dev";

const VIEW_KEY = "carlife.console.traceView";

function readStoredView(): TraceView | null {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "business" || v === "dev" ? v : null;
  } catch {
    return null;
  }
}

export function TraceDrawer({
  sessionId,
  turnId,
  turnIndex,
  messages,
  replay,
  state,
  error,
  onClose,
}: {
  sessionId: string;
  turnId: string;
  turnIndex: number;
  messages: ConsoleMessage[];
  replay: ReplayPayload | null;
  state: ReplayState;
  error: string | null;
  onClose: () => void;
}): JSX.Element {
  const identity = useIdentity();
  const [view, setViewState] = useState<TraceView>(
    () => readStoredView() ?? (identity.role === "admin" ? "dev" : "business"),
  );
  const setView = (v: TraceView): void => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // 存不进去就只影响下次的缺省，不影响这次
    }
  };

  const body: ReactNode =
    view === "business" ? (
      <BusinessTrace sessionId={sessionId} turnId={turnId} messages={messages} replay={replay} state={state} error={error} />
    ) : (
      <TurnTrace sessionId={sessionId} turnId={turnId} replay={replay} state={state} error={error} />
    );

  return (
    <>
      {/* 遮罩本身可点关闭；它不是按钮语义，所以 Esc 那条在会话页单独挂着 */}
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`第 ${turnIndex} 轮的执行轨迹`}
      >
        <header className="drawer-head">
          <div>
            <strong>第 {turnIndex} 轮 · 执行轨迹</strong>
            <div className="muted tiny mono">{turnId}</div>
          </div>
          <span className="spacer" />
          <div className="bz-view-switch" role="tablist" aria-label="视图">
            <button
              type="button"
              role="tab"
              aria-selected={view === "business"}
              className={view === "business" ? "is-on" : ""}
              onClick={() => setView("business")}
              title="业务视图：系统听懂了什么、每一步查了什么答了什么、最后答了什么"
            >
              业务视图
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "dev"}
              className={view === "dev" ? "is-on" : ""}
              onClick={() => setView("dev")}
              title="研发视图：分跳耗时、编排图位置、时间轴、逐条事件"
            >
              研发视图
            </button>
          </div>
          <button type="button" className="btn-link" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className="drawer-body">{body}</div>
      </aside>
    </>
  );
}
