/**
 * 景点导览信息页（施工单 M36-03，todo 1.b「单页信息页：左时间轴右小地图」）。
 *
 * 数据是 M36-02 的 `GuideBrief`；时间轴**不在这里拼**——`guideBriefToTimeline`
 * 是 shared 的确定性投影，本组件只渲染（求解与表述分开的界面版）。
 *
 * 三态由调用方给：collecting（后台三分支在采集，骨架占位）/ ready / failed
 * （"本次未查到"明说，不出空壳假内容——总览决策 8）。缺席的栏目整栏不渲染，
 * 缺口由 `caveats` 原样上屏。
 */

import type { ReactNode } from "react";

import type { GuideBrief, GuideComfortItem, GuideTimelineKind } from "@carlife/shared";
import { guideBriefToTimeline } from "@carlife/shared";

import { GuideMiniMap } from "./GuideMiniMap";

export type GuideScreenState =
  | { status: "collecting" }
  | { status: "failed" }
  | { status: "ready"; brief: GuideBrief; cached?: boolean };

export interface GuideScreenProps {
  spotName: string;
  state: GuideScreenState;
  onBack: () => void;
  /** failed 时的"再试一次"；不给就只有返回。 */
  onRetry?: () => void;
  /**
   * ready 时的「重新采集」（2026-08-29：简报持久化后只采一次，刷新只走这里）。
   * 不给就不渲染按钮——与 onRetry 同一条规矩：不出点了没反应的钮。
   */
  onRegenerate?: () => void;
  /**
   * 布局：wide=车机横向两栏（默认）；portrait=手机竖屏单列（M36-04）——
   * 上小地图下时间轴、休憩栏目紧随其后（下车逛景区的高频问题）、
   * 自驾到达段折叠不占首屏。默认值不变，车机端一行不用改。
   */
  layout?: "wide" | "portrait";
  /** 底图主题（小地图真实底图形态用）；缺省 light。 */
  theme?: "light" | "dark";
}

const KIND_LABEL: Record<GuideTimelineKind, string> = {
  parking: "停车场",
  spot: "游玩点",
  photo: "打卡点",
  food: "餐饮",
  rest: "休息",
  toilet: "厕所",
  charging: "充电",
  refuel: "加油",
};

const COMFORT_LABEL: Record<GuideComfortItem["kind"], string> = {
  rest: "休息",
  food: "吃饭",
  toilet: "厕所",
  pitfall: "避雷",
};

function Header({
  spotName,
  onBack,
  sub,
  action,
}: {
  spotName: string;
  onBack: () => void;
  sub?: string;
  action?: ReactNode;
}) {
  return (
    <header className="guide-screen__header">
      <button type="button" className="guide-screen__back" onClick={onBack} aria-label="返回主页">
        ‹ 返回
      </button>
      <div className="guide-screen__title-wrap">
        <h1 className="guide-screen__title">{spotName} · 景区导览</h1>
        {sub && <p className="guide-screen__arrival">{sub}</p>}
      </div>
      {action}
    </header>
  );
}

export function GuideScreen({
  spotName,
  state,
  onBack,
  onRetry,
  onRegenerate,
  layout = "wide",
  theme,
}: GuideScreenProps) {
  const portrait = layout === "portrait";
  const rootClass = `guide-screen${portrait ? " guide-screen--portrait" : ""}`;
  if (state.status === "collecting") {
    return (
      <section className={rootClass} aria-label={`${spotName} 导览（采集中）`}>
        <Header spotName={spotName} onBack={onBack} />
        <div className="guide-screen__pending" role="status">
          <span className="guide-screen__pending-dot" aria-hidden="true" />
          <p>三位向导正在为你采集{spotName}的游玩路线、停车与休憩信息……</p>
          <p className="guide-screen__pending-sub">首次查询约需一分钟，之后会记住结果</p>
        </div>
        {/* 骨架占位：两栏形状先立起来，数据到了原地填充，页面不跳版 */}
        <div className={`guide-screen__body is-skeleton${portrait ? " is-portrait" : ""}`} aria-hidden="true">
          <div className="guide-screen__timeline-col">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="guide-screen__skeleton-row" />
            ))}
          </div>
          <div className="guide-screen__map-col">
            <div className="guide-screen__skeleton-map" />
          </div>
        </div>
      </section>
    );
  }

  if (state.status === "failed") {
    return (
      <section className={rootClass} aria-label={`${spotName} 导览（未查到）`}>
        <Header spotName={spotName} onBack={onBack} />
        <div className="guide-screen__failed" role="alert">
          <p>这次没有查到{spotName}的导览资料。</p>
          <p className="guide-screen__failed-sub">可能是网络不稳或景区太冷门——不给凭空编的攻略。</p>
          {onRetry && (
            <button type="button" className="guide-screen__retry" onClick={onRetry}>
              再试一次
            </button>
          )}
        </div>
      </section>
    );
  }

  const { brief } = state;
  const timeline = guideBriefToTimeline(brief);
  const firstParking = brief.access?.parking[0];
  const pitfalls = brief.comfort.filter((c) => c.kind === "pitfall");
  // 时间轴只收带名字的休憩条目（shared 的规则）；这里补齐全量休憩面与泛提示。
  const comfortRest = brief.comfort.filter((c) => c.kind !== "pitfall");

  // 竖屏：小地图在上、时间轴在下（单列流）；到达段折叠不占首屏。
  const mapCol = (
    <div className="guide-screen__map-col">
      <h2 className="guide-screen__col-title">单向游玩路线</h2>
      {brief.spots.length === 0 && (
        // 空点位时 GuideMiniMap 返回 null——只剩标题的空卡看起来像渲染坏了
        //（2026-08-29 长隆走查病例）。空要空得明白：说清缺的是什么、怎么补。
        <p className="guide-screen__empty">本次没有查到必玩点位，路线画不出来——可返回后再试一次。</p>
      )}
      <GuideMiniMap
        spots={brief.spots}
        orderSource={brief.routeOrderSource}
        theme={theme}
        origin={
          firstParking
            ? { name: firstParking.name, lat: firstParking.lat, lon: firstParking.lon }
            : undefined
        }
      />
      {brief.routeOrderSource === "editorial" && (
        <p className="guide-screen__order-note">顺序来自攻略整理（未经坐标校验）</p>
      )}
      {brief.transportAdvice && (
        <p className="guide-screen__transport">园内代步：{brief.transportAdvice}</p>
      )}
      {brief.routeAdvice && <p className="guide-screen__transport">{brief.routeAdvice}</p>}
    </div>
  );

  return (
    <section className={rootClass} aria-label={`${spotName} 导览`}>
      <Header
        spotName={spotName}
        onBack={onBack}
        sub={portrait ? undefined : brief.access?.arrivalAdvice}
        action={
          onRegenerate ? (
            <button
              type="button"
              className="guide-screen__regen"
              onClick={onRegenerate}
              aria-label="重新采集这个景点的导览"
            >
              ⟳ 重新采集
            </button>
          ) : undefined
        }
      />
      {portrait && brief.access?.arrivalAdvice && (
        <details className="guide-screen__arrival-fold">
          <summary>自驾到达（停哪儿、怎么进景区）</summary>
          <p>{brief.access.arrivalAdvice}</p>
        </details>
      )}

      <div className={`guide-screen__body${portrait ? " is-portrait" : ""}`}>
        {portrait && mapCol}
        <div className="guide-screen__timeline-col">
          <h2 className="guide-screen__col-title">游玩时间轴</h2>
          <ol className="guide-timeline">
            {timeline.map((e) => (
              <li key={e.index} className={`guide-timeline__row is-${e.kind}`}>
                <span className="guide-timeline__seq" aria-hidden="true">
                  {e.index}
                </span>
                <span className={`guide-timeline__kind is-${e.kind}`}>{KIND_LABEL[e.kind]}</span>
                <span className="guide-timeline__name">{e.name}</span>
                {e.note && <span className="guide-timeline__note">{e.note}</span>}
              </li>
            ))}
          </ol>
          {timeline.length === 0 && (
            <p className="guide-screen__empty">本次没有查到可排入时间轴的点位。</p>
          )}
        </div>

        {!portrait && mapCol}
      </div>

      {(comfortRest.length > 0 || pitfalls.length > 0) && (
        <div className="guide-screen__comfort">
          {comfortRest.length > 0 && (
            <div className="guide-screen__comfort-block">
              <h2 className="guide-screen__col-title">休息 · 吃饭 · 厕所</h2>
              <ul>
                {comfortRest.map((c, i) => (
                  <li key={i}>
                    <span className={`guide-comfort__kind is-${c.kind}`}>{COMFORT_LABEL[c.kind]}</span>
                    {c.name && <b>{c.name}</b>} {c.note}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pitfalls.length > 0 && (
            <div className="guide-screen__comfort-block is-pitfall">
              <h2 className="guide-screen__col-title">避雷提醒</h2>
              <ul>
                {pitfalls.map((c, i) => (
                  <li key={i}>
                    <span className="guide-comfort__kind is-pitfall">{COMFORT_LABEL.pitfall}</span>
                    {c.name && <b>{c.name}</b>} {c.note}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {brief.caveats.length > 0 && (
        <footer className="guide-screen__caveats">
          {brief.caveats.map((c, i) => (
            <span key={i}>⚠ {c}</span>
          ))}
        </footer>
      )}
    </section>
  );
}
