/**
 * HUD 视口与等比缩放场景（施工单 M1-02 / M1-04 自适应）
 *
 * 车机屏比例跨度极大（条形屏 2.67:1 ~ 竖屏 0.63:1），不能只锁一个 16:9 画布，
 * 否则条形屏上会出现大片信箱黑边。分三层各自负责：
 *
 *   1. 地图底图 —— 铺满整个视口（程序化 SVG，任意比例都成立）；
 *   2. HudScene —— 生活环与 POI 的固定比例场景（1672:941），等比缩放并居中，
 *      保证行程构图不被拉伸（Brief §1）；
 *   3. 悬浮层 —— 提示卡 / 能量胶囊 / 助手锚在**视口边缘**，宽屏自然向两侧展开。
 *
 * 在 16:9 上三者重合，与定稿逐像素一致；比例越偏离，地图承担越多的富余空间。
 */
import type { ReactNode } from "react";

export type HudLayoutMode = "wide" | "standard" | "compact" | "portrait";

/** 按视口宽高比划分布局档位，用于差异化悬浮层排布。 */
export function resolveLayoutMode(ratio: number): HudLayoutMode {
  if (ratio >= 2.1) return "wide"; // 1920×720 / 2880×1080 条形屏
  if (ratio >= 1.5) return "standard"; // 16:9 / 16:10，定稿基准
  if (ratio >= 1.0) return "compact"; // 4:3、近方形（如蔚来 1728×1888 横置）
  return "portrait"; // 竖屏（Tesla S/X 1200×1920）
}

export interface HudStageProps {
  children: ReactNode;
  theme?: "light" | "dark";
  /** 覆盖自动判定的布局档位，仅用于测试与预览。 */
  mode?: HudLayoutMode;
}

export function HudStage({ children, theme = "light", mode }: HudStageProps) {
  return (
    <div className="hud-viewport" data-theme={theme} data-mode={mode}>
      {children}
    </div>
  );
}

/**
 * 固定比例场景：生活环与 POI 落在这里，等比缩放、居中。
 * 尺寸直接由 --hud-unit 推导（--hud-unit = min(vw/1672, vh/941)），
 * 因此天然是"contain"行为，无需 JS 测量。
 */
export function HudScene({ children }: { children: ReactNode }) {
  return (
    <div className="hud-scene">{children}</div>
  );
}
