/**
 * 行程标记胶囊的 HTML（纯函数，自 AmapTripLayer 抽出）。
 *
 * 抽成独立模块只为一件事：能在 `node --import tsx` 下 import。AmapTripLayer 引着
 * `hud/sprites`（`import x from "*.png"`，那是 Vite 的能力），测试一 import 就炸
 * （item-sprites.test 文件头讲过同一件事）。所以贴纸地址由调用方查好传进来，
 * 这里只拼字符串。
 *
 * 胶囊结构：贴纸 + 上行「序号 名称」+ 下行「Day N · 预计 hh:mm–hh:mm」（M13-09）；
 * 导览就绪时右上角挂「✓ 导览」角标——它是**绝对定位**的，不改胶囊宽度：
 * 宽度一变，贴边夹持（clampToEdges）的结论就作废，而角标是随轮询随时会亮起来的，
 * 不能每亮一个就把整层覆盖物重做一遍。
 */
import { formatDayRanges } from "@carlife/shared";

import type { StopSchedule } from "./trip-route";

/** 胶囊只用到的停靠点字段（TripMapStop 的子集，避免反向依赖组件文件）。 */
export interface TripMarkerStop {
  name: string;
  day: number;
  kind: "spot" | "hotel" | "charging";
  days?: number[];
}

export interface TripMarkerOptions {
  /** 景点序号；酒店/充电站为 null（徽章改画图标）。 */
  seq: number | null;
  showDayBadge: boolean;
  /** 时刻缺省（路径规划没成功）时下行只留 Day N——不猜时间，见 trip-route.ts 文件头。 */
  time?: StopSchedule;
  /** data-i：贴边夹持按下标精确配对的锚。 */
  index?: number;
  /** data-gen：交叉淡入淡出按代次选的锚。 */
  gen?: number;
  /**
   * 淡入的起点写进 HTML 而不是上图后再用 JS 设：AMap 2.0 的覆盖物 DOM 要下一帧
   * 才落地，那时再设 opacity=0 已经闪过一帧了。异步补时刻会重发一次 content，
   * 那次必须是 1，否则整排胶囊会在路径规划回来时凭空消失。
   */
  entering?: boolean;
  /** 该景点的导览已就绪（⑤缓存里有完整简报，点开即秒开）：挂角标。 */
  guided?: boolean;
  /** 品类贴纸地址；缺省不画贴纸。 */
  sticker?: string;
}

/** 导览就绪的修饰类；AmapTripLayer 在轮询结果变化时按 data-spot 增删它。 */
export const TRIP_MARKER_GUIDED_CLASS = "hud-tripmark--guided";

/** 角标文案——"能看了"必须是字，不是只有颜色的点：车机上一眼扫过去要读得出来。 */
export const TRIP_MARKER_GUIDED_LABEL = "✓ 导览";

export function tripMarkerHtml(stop: TripMarkerStop, o: TripMarkerOptions): string {
  const { seq, showDayBadge, time, index = 0, gen = 0, entering = false, guided = false, sticker } = o;
  const badge = seq !== null ? String(seq) : stop.kind === "hotel" ? "🏨" : "⚡";
  // 品类贴纸（M13-07）：与生活环同一套卡通图，地图标记与环上观感一致。
  const poi = sticker ? `<img class="hud-tripmark__poi" src="${escapeHtml(sticker)}" alt="" />` : "";
  // 连住酒店标日范围（M34-02）："D2 的酒店在哪"必须有答案——去重是对的，标注写死首日不对。
  const dayText = showDayBadge ? (stop.days?.length ? formatDayRanges(stop.days) : `Day ${stop.day}`) : "";
  // "预计"二字不可省：停留时长是本仓的假设值，不写清楚就成了看起来像真的时刻表。
  const timeText = time?.arrive ? `预计 ${time.arrive}–${time.depart}` : "";
  const meta = [dayText, timeText].filter(Boolean).join(" · ");
  const cls = `hud-tripmark hud-tripmark--${stop.kind}${guided ? ` ${TRIP_MARKER_GUIDED_CLASS}` : ""}`;
  return (
    // data-i 是贴边夹持用来**按下标精确配对**的锚（不能靠 DOM 顺序猜，
    // 顺序会随 zIndex/重绘变化，配错了就是把 A 的修正量加到 B 头上）。
    // data-gen 是交叉淡入淡出的锚：过渡期间新旧两代标记**同时在图上**，
    // 只有按代次才能分别淡入淡出——按 class 选会把两代一起选中。
    // data-spot 是导览角标的锚：轮询说"某景点就绪了"时按名字找到胶囊、只改一个 class，
    // 不重建覆盖物（重建 = 路线/视野/7 段路径规划全部重做，M19-05 的那个坑）。
    `<div class="${cls}" data-i="${index}" data-gen="${gen}" data-spot="${escapeHtml(stop.name)}"` +
    ` style="opacity:${entering ? 0 : 1}">` +
    poi +
    `<span class="hud-tripmark__text">` +
    `<span class="hud-tripmark__title">` +
    `<b class="hud-tripmark__badge">${badge}</b>` +
    `<span class="hud-tripmark__name">${escapeHtml(stop.name)}</span>` +
    `</span>` +
    (meta ? `<span class="hud-tripmark__meta">${escapeHtml(meta)}</span>` : "") +
    `</span>` +
    // 角标常驻在 DOM 里、由 class 决定显不显示：轮询把就绪态翻过来时只需加 class，
    // 不用重发 content（重发会把 AMap 已落地的 DOM 整个换掉）。
    `<i class="hud-tripmark__guided" aria-hidden="true">${TRIP_MARKER_GUIDED_LABEL}</i>` +
    `</div>`
  );
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
