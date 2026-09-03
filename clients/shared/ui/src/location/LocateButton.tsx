/**
 * 地图上的「回到我这儿」按钮。
 *
 * # 为什么关着定位时也渲染它
 *
 * 组件库有一条纪律：不造点了没反应的东西。这个按钮在定位关着时**不是没反应**
 * ——它会当场说清楚"定位停用了，去设置里打开"。真正没反应的做法是把它藏起来：
 * 那样这个功能只有翻到设置页的人才知道存在。
 *
 * HUD 红线（不出现有后果的动作）不受影响：它只挪镜头，不下发任何指令。
 */
import { useCallback, useState } from "react";

import type { LocationFix } from "@carlife/shared";

import { useLocation } from "./useLocation";

export interface LocateButtonProps {
  /** 定位成功 → 把地图挪过去（通常接 `useMapViewport().focusOn`）。 */
  onLocated?: (fix: LocationFix) => void;
  /** 点了但定位是关的。不传就用内置的一句提示。 */
  onDisabled?: () => void;
  className?: string;
}

/** 提示自己消失的时长；长到能读完一句话，短到不挡地图。 */
const HINT_MS = 3200;

export function LocateButton({ onLocated, onDisabled, className }: LocateButtonProps) {
  const loc = useLocation();
  const [hint, setHint] = useState<string | null>(null);

  const flash = useCallback((text: string) => {
    setHint(text);
    setTimeout(() => setHint((cur) => (cur === text ? null : cur)), HINT_MS);
  }, []);

  const onClick = useCallback(() => {
    if (!loc.consent.enabled) {
      if (onDisabled) onDisabled();
      else flash("定位已停用 · 在「设置 › 定位」里打开");
      return;
    }
    void loc.locate().then((fix) => {
      if (fix) onLocated?.(fix);
      else flash(loc.error ? `定位失败：${loc.error}` : "定位失败");
    });
  }, [flash, loc, onDisabled, onLocated]);

  // 端上状态没读回来之前不渲染：那一瞬间它显示的是"关着"，点下去会误报。
  if (!loc.ready) return null;

  return (
    <div className={`cloc-locate${className ? ` ${className}` : ""}`}>
      {hint && <span className="cloc-locate__hint">{hint}</span>}
      <button
        type="button"
        className={`cloc-locate__btn${loc.consent.enabled ? "" : " is-off"}${
          loc.status === "locating" ? " is-busy" : ""
        }`}
        aria-label={loc.consent.enabled ? "定位到我的位置" : "定位已停用"}
        aria-busy={loc.status === "locating"}
        onClick={onClick}
      >
        {/* 十字准星：定位图标的通行画法，不依赖字体图标包 */}
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx="12" cy="12" r="1.6" fill="currentColor" />
          <path
            d="M12 1.6v3.4M12 19v3.4M1.6 12h3.4M19 12h3.4"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}
