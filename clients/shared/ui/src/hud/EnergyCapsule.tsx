/**
 * 出行能量摘要胶囊（施工单 M1-02）
 *
 * Brief §3.2：单条胶囊，**始终同时**表达预计里程 / 当前能量 / 预计需电量。
 * 中段的"当前能量"在 M27 接上实时读数：电车报剩余电量、油车报剩余油量、
 * 读不到就说读不到（`LiveEnergy` 三支，见契约注释）。
 * 该区域**只读**；数据更新异常时保留最近有效值及更新时间，且不遮挡生活环或助手。
 * Brief §4：不得展示 VIN、维修档案或任何车辆控制入口。
 */

import type { EnergySummary, LiveEnergy } from "@carlife/shared";

// 契约在 `@carlife/shared`（端云唯一真相源）。这里只转出，方便既有的
// `import { type EnergySummary } from "@carlife/ui"` 不必改。
export type { EnergySummary, LiveEnergy };

export interface EnergyCapsuleProps {
  summary: EnergySummary;
  /** 数据是否正在更新（弱网降级：保留最近有效值 + 标记，不空白）。 */
  stale?: boolean;
  /** 最近一次有效更新时间，stale 时展示。 */
  updatedAt?: string;
}

/** 低电/低油的告警阈值。与车机侧的自动补能阈值（10%）拉开，先黄后动作。 */
const LOW_PERCENT = 20;

/**
 * 中段：剩余电量 / 剩余油量。
 *
 * 三支各画各的，不共用一个"百分比"模板——共用会让燃油车悄悄挂上电池图标。
 */
function LiveMetric({ summary }: { summary: EnergySummary }) {
  const live = summary.live;

  if (live?.kind === "unavailable") {
    return (
      <div className="hud-energy__metric hud-energy__metric--muted" title={live.reason}>
        <svg className="hud-energy__glyph" viewBox="0 0 28 24" aria-hidden="true">
          <rect x="1.5" y="6" width="21" height="12" rx="3.5" fill="none" stroke="var(--hud-text-muted)" strokeWidth="2" />
          <path d="M6 12h12" stroke="var(--hud-text-muted)" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span className="hud-energy__caption">剩余</span>
        {/* 不给数字：读不到就是读不到，写 0 会被当成"快没电了" */}
        <span className="hud-energy__value hud-energy__value--none">读不到</span>
      </div>
    );
  }

  const fuel = live?.kind === "fuel";
  const percent = live ? live.percent : summary.batteryPercent;
  const low = percent <= LOW_PERCENT;
  const tint = low ? "var(--hud-amber)" : "var(--hud-ok)";
  const charging = live?.kind === "battery" && live.charging;

  return (
    <div className={`hud-energy__metric${low ? " is-low" : ""}`}>
      {fuel ? (
        <svg className="hud-energy__glyph" viewBox="0 0 24 24" aria-hidden="true">
          {/* 油枪：与电池轮廓一眼可分，不靠颜色区分（色觉差异下会失效） */}
          <path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16" fill="none" stroke={tint} strokeWidth="2" />
          <path d="M3 21h12" stroke={tint} strokeWidth="2" strokeLinecap="round" />
          <path d="M6 8h6" stroke={tint} strokeWidth="2" strokeLinecap="round" />
          <path d="M14 8h3a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0 3 0v-6" fill="none" stroke={tint} strokeWidth="2" />
        </svg>
      ) : (
        <svg className="hud-energy__glyph" viewBox="0 0 28 24" aria-hidden="true">
          <rect x="1.5" y="6" width="21" height="12" rx="3.5" fill={tint} />
          <rect x="24" y="10" width="3" height="4" rx="1.2" fill={tint} />
          {charging && <path d="M13 8.5 9.5 13h3l-.5 3.5L16 12h-3z" fill="#fff" />}
        </svg>
      )}
      <span className="hud-energy__caption">{fuel ? "剩余油量" : charging ? "充电中" : "剩余电量"}</span>
      <span className="hud-energy__value">{Math.round(percent)}</span>
      <span className="hud-energy__unit">%</span>
      {/* 早返回已排除 unavailable，此处 live 必是 battery | fuel */}
      {live && <span className="hud-energy__range">≈{live.rangeKm} km</span>}
    </div>
  );
}

export function EnergyCapsule({ summary, stale, updatedAt }: EnergyCapsuleProps) {
  return (
    <section
      className={`hud-card hud-energy${stale ? " is-stale" : ""}`}
      aria-label="出行能量摘要"
      aria-readonly="true"
    >
      <div className="hud-energy__metric">
        <svg className="hud-energy__glyph" viewBox="0 0 24 26" aria-hidden="true">
          <path
            d="M12 1.5c-3.6 0-6.5 2.9-6.5 6.5 0 4.7 6.5 12 6.5 12s6.5-7.3 6.5-12c0-3.6-2.9-6.5-6.5-6.5z"
            fill="var(--hud-pin)"
          />
          <circle cx="12" cy="8" r="2.5" fill="#fff" />
          {/* 虚线尾迹：呼应定稿中"路径里程"的语义 */}
          <path
            d="M4 23.5h16"
            fill="none"
            stroke="var(--hud-pin)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray="0.5 4"
            opacity="0.8"
          />
        </svg>
        <span className="hud-energy__caption">预计</span>
        <span className="hud-energy__value">{summary.distanceKm}</span>
        <span className="hud-energy__unit">km</span>
      </div>

      <span className="hud-energy__sep" aria-hidden="true" />

      <LiveMetric summary={summary} />

      <span className="hud-energy__sep" aria-hidden="true" />

      <div className="hud-energy__metric">
        <svg className="hud-energy__glyph" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M13.5 2 4 13.6h6.2L9.6 22 20 9.9h-6.6z" fill="var(--hud-amber)" />
        </svg>
        <span className="hud-energy__caption">预计需</span>
        <span className="hud-energy__value">{summary.requiredPercent}</span>
        <span className="hud-energy__unit">%</span>
      </div>

      {stale && (
        <span className="hud-energy__stale">
          数据更新中{updatedAt ? ` · ${updatedAt}` : ""}
        </span>
      )}
    </section>
  );
}
