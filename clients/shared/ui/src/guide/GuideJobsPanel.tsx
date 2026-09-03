/**
 * 导览采集进度面板（施工单 M40-01；数据面 ACR-008）。
 *
 * 纯展示组件：吃 `GuideJobsStatus`，渲染进度头（x/N 就绪）+ 逐景点状态行 +
 * 「获取导览」按钮。**不做任何 fetch/轮询/计时**——数据源、节流、乐观置 pending
 * 全归两端接线（M40-02/03）；组件只负责"此刻这份状态怎么给人看"。
 *
 * 按钮语义（总览决策 3）：只有 `unprocessed`/`failed` 有「获取导览」——
 * 在途的按了也只是撞后端 singletonKey 去重，按钮出现就该有意义；
 * `ready` 行整行可点（onOpen 开导览页），面板是导览页的索引，不是第二个导览页。
 */

import type { GuideJobSpot, GuideJobState, GuideJobsStatus } from "@carlife/shared";

export interface GuideJobsPanelProps {
  jobs: GuideJobsStatus;
  /** 「获取导览」：unprocessed/failed 行的补采触发。 */
  onFetch: (spotName: string) => void;
  /** 点 ready 行打开导览页；不传则 ready 行不渲染成可点。 */
  onOpen?: (spotName: string) => void;
  /** 面板标题，缺省「景点导览」。 */
  title?: string;
}

/** 五态的人话与徽标 class。文案定死在这里，两端不各写一份（工单约束）。 */
const STATE_LABEL: Record<GuideJobState, string> = {
  unprocessed: "未采集",
  pending: "排队中",
  processing: "采集中",
  ready: "已就绪",
  failed: "未成功",
};

const FETCHABLE: ReadonlySet<GuideJobState> = new Set(["unprocessed", "failed"]);

function Row({ spot, onFetch, onOpen }: { spot: GuideJobSpot; onFetch: GuideJobsPanelProps["onFetch"]; onOpen?: GuideJobsPanelProps["onOpen"] }) {
  const openable = spot.state === "ready" && onOpen;
  const name = openable ? (
    <button
      type="button"
      className="guide-jobs__name guide-jobs__name--open"
      onClick={() => onOpen!(spot.spotName)}
    >
      {spot.spotName}
    </button>
  ) : (
    <span className="guide-jobs__name">{spot.spotName}</span>
  );
  return (
    <li className={`guide-jobs__row is-${spot.state}`}>
      <span className={`guide-jobs__state is-${spot.state}`}>{STATE_LABEL[spot.state]}</span>
      {name}
      {FETCHABLE.has(spot.state) && (
        <button type="button" className="guide-jobs__fetch" onClick={() => onFetch(spot.spotName)}>
          获取导览
        </button>
      )}
      {spot.state === "failed" && spot.note && <span className="guide-jobs__note">{spot.note}</span>}
    </li>
  );
}

export function GuideJobsPanel({ jobs, onFetch, onOpen, title = "景点导览" }: GuideJobsPanelProps) {
  if (jobs.spots.length === 0) return null;
  const { summary } = jobs;
  const active = summary.pending + summary.processing > 0;
  return (
    <section className="guide-jobs" aria-label={`${title}采集进度`}>
      <header className="guide-jobs__head">
        {/* 有在途任务时的活动小点：复用采集中动效，一眼看出"后台在干活" */}
        {active && <span className="guide-screen__pending-dot guide-jobs__dot" aria-hidden="true" />}
        <span className="guide-jobs__title">{title}</span>
        <span className="guide-jobs__progress">
          {/* 数字来自 summary（服务端账本），不自己数行——两处账对不上时要暴露而不是掩盖 */}
          {summary.ready}/{summary.total} 就绪
        </span>
      </header>
      <ul className="guide-jobs__list">
        {jobs.spots.map((s) => (
          <Row key={s.spotName} spot={s} onFetch={onFetch} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}
