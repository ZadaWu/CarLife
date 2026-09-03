/**
 * 真实地图行程标注层（施工单 M13-06）。
 *
 * 与 `AmapBackdrop`（装饰底图）不同：这一层的地图**就是内容**——
 * 按行程停靠点的真实坐标标注（编号 + 名称胶囊）、琥珀路线按顺序串联、
 * 流动粒子沿线循环（`AMap.MoveAnimation`，插件缺失时静默降级为静态线）、
 * `setFitView` 自适应视野（右侧避开提示卡）。
 *
 * 回退仍是默认路径（M10-01 原则）：未配 key / 加载失败 → 程序化底图 + onFallback，
 * 由上层决定是否退回装饰概览视图。坐标缺失的停靠点**不标注**——
 * 真实性红线：宁可地图上少一个点，不能标一个猜的位置。
 *
 * stops 变化（切天）只重建覆盖物与视野，不重建地图实例。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";


import { MapBackdrop } from "../hud/MapBackdrop";
import { SPRITES } from "../hud/sprites";
import {
  enforceBaseStyle,
  isAmapConfigured,
  loadAmap,
  MAP_FEATURES,
  MAP_FEATURES_FOCUS,
  MAP_STYLE,
  type AMapInstance,
} from "./amap-loader";
import {
  planDrivingLegs,
  resampleEven,
  scheduleStops,
  splitByDay,
  walkConnectors,
  type RouteLeg,
  type StopSchedule,
} from "./trip-route";
import { createSimulatedNavSource, etaToNextStop, type NavLeg } from "./nav-position";
import { TRIP_MARKER_GUIDED_CLASS, tripMarkerHtml } from "./trip-marker";

export interface TripMapStop {
  name: string;
  /** 属于第几天（1 起）——全程模式下标记胶囊带天徽标。 */
  day: number;
  kind: "spot" | "hotel" | "charging";
  /** 贴纸品类（M13-07，@carlife/shared 的 PoiKind）；缺省按 kind 兜底。 */
  poiKind?: string;
  lat?: number;
  lon?: number;
  /** 建议时段（M34-02，规划层产出）；该天全带时 scheduleStops 直接用它。 */
  estStart?: string;
  estEnd?: string;
  /** 连住酒店覆盖的全部天（M34-02）：徽标标日范围（Day 1–2），不再只写首日。 */
  days?: number[];
}

export interface AmapTripLayerProps {
  theme?: "light" | "dark";
  stops: TripMapStop[];
  /** 是否显示天徽标（全程总览开，单日关）。 */
  showDayBadge?: boolean;
  /**
   * 闭环路线（单日视图）：首个停靠点是酒店时，路线从酒店出发、末位再折返酒店
   * ——先放行李/寄存 → 逐个景点 → 回酒店，用户走查定的场景语义。
   */
  closeLoop?: boolean;
  /** 弱网/降级时关闭流动动画。 */
  animated?: boolean;
  /**
   * 行程身份（M27-04）：换了一份行程（新确认/被更新）时它必须变。
   *
   * 「用户动过镜头就不碰」的否决权（M19-05）**只对着同一份行程成立**——
   * 看上一份行程时拖过一下地图，新行程确认落地后镜头就永远留在原地，
   * 站点在全国视野下挤成一摞卡片（真实走查：徐州→广州行程确认后满屏叠卡）。
   * 此值变化时收回否决权、重新框一次视野；同一份行程内的切天/拖动不受影响。
   */
  planKey?: string;
  /**
   * 跟车模式（M31-03）。非空 = 进 NavMode：车标沿真实道路行进、镜头跟随。
   * 值变化 = 换了一次导航（从头起跑）。
   *
   * **用 key 而不是对象**：调用方十有八九传内联对象，进依赖就是每次渲染
   * 重建整层覆盖物——与 `onFallback` 那条同一个坑。
   */
  navKey?: string;
  /**
   * 演示倍速（模拟位置源专用，见 `nav-position.ts`）。
   * 大于 1 时**界面上必须有「演示车速」角标**——那是「不标不猜」的直接推论，
   * 由外层渲染（本层是 aria-hidden 的地图容器，放不了可读的字）。
   */
  navSpeedup?: number;
  /** 跟车进度回调（顶栏的下一站/ETA 用）。走 ref，不进重建依赖。 */
  onNavProgress?: (p: NavTripProgress) => void;
  onFallback?: (reason: string) => void;
  /**
   * 点击**景点**标记的回调（M36-03，导览页入口）。走 ref，不进重建依赖
   * （与 onNavProgress 同一条纪律：调用方十有八九传内联函数）。
   * 只对 `kind === "spot"` 的标记触发——酒店/充电站没有"景区内导览"这回事。
   * 点击仍然先聚焦（既有行为不变），再通知调用方开页。
   */
  onStopClick?: (stop: TripMapStop) => void;
  /**
   * 导览已就绪的景点名（服务端 `/v1/guide/jobs` 里 state=ready 的行）。
   * 命中的景点胶囊挂「✓ 导览」角标——用户在主页就能看出哪些点开有东西看。
   *
   * **不进覆盖物重建依赖**：它随 10s 轮询随时会变，进依赖就是每次有景点采完
   * 都把标记、路线、视野、路径规划整套重做（与 stopsKey 那条同一个坑）。
   * 这里按名字找到已上图的胶囊只增删一个 class；重建时 markerHtml 读当前值。
   * 按名字对而不按下标：进度表来自库里真实确认的行程，地图上摆的可能是演示行程，
   * 对不上就不标（不标不猜）。
   */
  guidedSpots?: string[];
}

/** 跟车进度：顶栏与播报的全部原料。 */
export interface NavTripProgress {
  /** 下一站名字；已经走完时没有。 */
  nextStopName?: string;
  /** 距下一站的沿路米数。 */
  remainingM: number;
  /** 距下一站的秒数；**这一段车程没查到时缺省**（不猜，见 `etaToNextStop`）。 */
  remainingSec?: number;
  /** 刚刚到达的站名——**只在越过段尾的那一帧给一次**，用于播报。 */
  arrivedStopName?: string;
  finished: boolean;
}

/**
 * fitView 的避让（上/下/左/右），**必须按横竖屏分开给**。
 *
 * 单位是**地图容器的 CSS 像素**。竖屏那组实测自 420×900 的车机窗口
 * （`tauri.conf.json` 的窗口尺寸）：日期页签底边 y113、对话卡约 y560 起、
 * 提示卡 y680 起。上边距还要再加一个胶囊高（44）与外推量，
 * 因为标记锚在 bottom-center——胶囊长在落点**上方**，只留到页签底边会被压住。
 *
 * 横屏车机：提示卡在右侧（定稿卡宽 462 + 边距）→ 右边留一大块。
 * 竖屏：提示卡/电量/导航都在**底部**，日期页签在顶部，两侧没有遮挡——
 * 沿用横屏那份「右 520」会把标记全推到左边缘、地图缩到整个广东省（用户走查实测）。
 * 左右只留很窄一点：胶囊宽达屏宽七成，真按半个胶囊去避让，
 * 中间就只剩一条缝、fitView 又会缩回去；胶囊过宽改由竖屏 CSS 收窄解决。
 */
const FIT_AVOID_LANDSCAPE = [110, 150, 130, 520];
const FIT_AVOID_PORTRAIT = [200, 360, 30, 30];

/**
 * 点击地点胶囊后推近到的缩放级别，与镜头动画时长（毫秒）。
 *
 * 16 级大致是"一个街区连着几条路"的尺度——用户点开一个地点是想看
 * **它周围是什么**，再近就只剩脚下那条路、再远又回到看不清的总览。
 *
 * ⚠️ 光有 zoom 不够：总览的 `MAP_FEATURES` 把 POI 与建筑都滤掉了，
 * 只推近的话得到的是一张放大的空灰底。聚焦时必须同时换成 `MAP_FEATURES_FOCUS`，
 * 见那个常量的注释。
 */
const FOCUS_ZOOM = 16;
const FOCUS_MS = 520;

/** 单边避让不得超过该方向尺寸的这个比例——兜住任何未来的窗口尺寸。 */
const AVOID_MAX_RATIO = 0.4;

function fitAvoidFor(width: number, height: number): number[] {
  const [t, b, l, r] = height > width ? FIT_AVOID_PORTRAIT : FIT_AVOID_LANDSCAPE;
  const capY = height * AVOID_MAX_RATIO;
  const capX = width * AVOID_MAX_RATIO;
  return [Math.min(t, capY), Math.min(b, capY), Math.min(l, capX), Math.min(r, capX)];
}

/**
 * 标记按**相对中心的方位向外散开**（用户走查：地点视觉重叠）。
 * 偏上的更往上、偏下的更往下、偏左的更往左——重叠的胶囊因此互相让开。
 *
 * 单位是容器 CSS 像素，且**横竖不等量**：胶囊实测 213×50，扁的。
 * 竖直方向错开一整行只要 ~50px，水平方向要真正让开却得挪 200px 以上——
 * 各向同性地推等于把预算浪费在水平方向上。所以按椭圆推：竖直给足，水平少给。
 *
 * 偏移只作用于名字胶囊；真实坐标上另留一个小圆点（`hud-tripmark__dot`），
 * 否则胶囊就在谎报位置，而且路线折点会没有落点、看起来像断在半空。
 */
const SPREAD_X = 44;
const SPREAD_Y = 82;

/**
 * "谁算挤在一起"：与整体包围盒对角线的比值。
 * 用相对值而不是绝对距离，是因为 fitView 把包围盒铺满视野——
 * 同一个比值在任何缩放级别下都对应差不多的屏幕间距，不必知道 zoom。
 */
const CROWD_RATIO = 0.15;

/** 贴边夹持留的边距（容器 CSS 像素）。 */
const EDGE_PAD = 8;

/**
 * 刘海屏的上下安全区（CSS 像素）。
 *
 * 地图容器是整块视口，`getBoundingClientRect()` 的 top 就是屏幕顶边——但顶边那一条
 * 被状态栏与挖孔占着，**落在那里的胶囊用户根本看不见**。所以夹持要按安全区收边，
 * 不能按容器边。
 *
 * 用一个隐藏探针量 `env()` 而不是读 CSS 变量：自定义属性的计算值是未替换的
 * token（`env(...)` 原样返回），拿不到像素数；padding 会被真正解析成长度。
 * 非刘海屏与桌面上两者都是 0，夹持行为与从前逐字一致。
 */
function safeInsets(): { top: number; bottom: number } {
  if (typeof document === "undefined") return { top: 0, bottom: 0 };
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
    "padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);";
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const insets = {
    top: Number.parseFloat(cs.paddingTop) || 0,
    bottom: Number.parseFloat(cs.paddingBottom) || 0,
  };
  probe.remove();
  return insets;
}

/**
 * 状态切换的交叉淡入时长（毫秒，M19-05 用户走查："重绘制比较生硬"）。
 *
 * 原来是 `remove(旧) → add(新)` 同帧完成：图上先空一拍再整批蹦出来，
 * 切天和路线换真实道路时尤其明显。改成**新的一代先画好、透明地挂上去，
 * 再与旧的一代交叉淡入淡出**，画面上不再有空窗。
 */
const FADE_MS = 420;

/**
 * 路线的两层描边（白色底衬 + 琥珀主线）。
 *
 * 提成常量是因为淡入淡出要知道**每层的目标不透明度**——过渡期间要把它按
 * 0→base 插值，写死在构造参数里就取不到了。顺序即层序，索引与创建顺序对齐。
 */
const ROUTE_LAYERS = [
  { color: "#ffffff", weight: 12, opacity: 0.9, zIndex: 59, showDir: false },
  { color: "#f5a623", weight: 7, opacity: 0.95, zIndex: 60, showDir: true },
] as const;

/**
 * 步行接驳线：驾车折线端点 → 站点圆点的虚线。
 *
 * 驾车折线贴路网收尾，POI 不在马路上时端点够不到圆点（普陀山实测普济殿差
 * 76m、百步沙差 85m）——那段差距是真实的"下车走过去"。不画像断线，
 * 画实线是造假（等于宣称有条能开进大殿的路），虚线 + 灰色把"非车行"说清楚。
 * 阈值与配对逻辑在 trip-route.ts 的 `walkConnectors`（可单测）。
 */
const WALK_LAYER = { color: "#64748b", weight: 4, opacity: 0.85, zIndex: 58 } as const;

/**
 * 流动粒子：**跑完整条路线一圈**的时长，与沿线的等距采样点数。
 *
 * ⚠️⚠️ `moveAlong` 的 `duration` 是**每一段**的时长，不是整程
 *（官方参考手册 MoveAlongOptions："Duration of each segment in ms"）。
 * 这条读反的代价是粒子看起来**完全静止**，且全程零报错：真实道路折线动辄
 * 几百个点，原来那份 `duration: max(12_000, realPath.length * 60)` 折算下来
 * 是「每段几十秒」，跑完一圈要按小时计——用户走查看到的就是一颗钉在路口的光点，
 * 而放大到很近也只是从"不动"变成"几乎不动"。
 *
 * 所以这里只定义"一圈多久"，每段时长由它除以段数得出；
 * 而"每段等时"要成立，路径必须先等弧长重采样（见 `resampleEven`）。
 *
 * 一圈固定时长（而不是按点数缩放）也正好给出**恒定的屏幕流速**：
 * `fitView` 把整条路线铺满视野，路线本身多长都一样跑一圈。
 * 12s 对齐 Brief 的"低速流动粒子"（生活环上单段是 5–8s）。
 *
 * 采样点数决定每段时长：12s / 240 ≈ 50ms，约 3 帧。再密则每段短过一帧、
 * 补间失去意义；再疏则转弯处切角，粒子会从路面上抄近道。
 */
const RUNNER_LOOP_MS = 12_000;
const RUNNER_SAMPLES = 240;

/** 粒子标记只用到这两个方法；`stopMove` 在插件缺失时也不存在，一律可选调用。 */
type RunnerMarker = {
  moveAlong?: (p: unknown[], opts: Record<string, unknown>) => void;
  stopMove?: () => void;
};

/** 地点胶囊只用到事件注册；SDK 被裁剪时 `on` 可能不在，故可选。 */
type ClickableMarker = { on?: (event: string, handler: () => void) => void };

/** AMap 的 `on` / `off`：只用到"事件名 + 无参回调"这一种形态。 */
type MapEventBinder = (event: string, handler: () => void) => void;

/**
 * 让粒子沿 `p` 匀速循环一圈。直线路径与随后换上的真实道路都走这里，
 * 两处必须同一套时长口径——否则路线一换真实道路，流速就会跳一下。
 *
 * ⚠️ 必须在 marker **上图之后**调：挂图前调是静默 no-op（走查实测：粒子停在起点）。
 * 重启前先 `stopMove()`：换真实道路时上一轮循环还在跑，不停掉会两个动画抢同一个标记。
 * 动画是装饰，任何一步失败都只丢动画，不丢标注与路线。
 */
function startRunner(runner: RunnerMarker | undefined, p: Array<[number, number]>): void {
  if (!runner || p.length < 2) return;
  const even = resampleEven(p, RUNNER_SAMPLES);
  if (even.length < 2) return;
  try {
    runner.stopMove?.();
    runner.moveAlong?.(even, {
      duration: Math.max(16, Math.round(RUNNER_LOOP_MS / (even.length - 1))),
      circlable: true,
    });
  } catch {
    /* 丢动画不丢标注 */
  }
}

/**
 * 徽章语义（用户走查修正）：**只有景点参与编号**——酒店/补能是驻点与补给，
 * 不是"第几站"，编号里混进它们会让"第3站"对不上玩的第 3 个地方。
 * 酒店徽章 🏨、补能 ⚡，游玩顺序一目了然。
 */
/** kind → 品类贴纸兜底（poiKind 缺省时）：身份即品类。 */
const KIND_FALLBACK: Record<TripMapStop["kind"], string> = {
  spot: "spot",
  hotel: "hotel",
  charging: "charge",
};

/** 品类贴纸两主题共用（透明底），取 light 一套即可。 */
const POI_STICKERS = SPRITES.light.poi;

/**
 * 标记胶囊（M13-09）：查贴纸，其余交给纯函数 `tripMarkerHtml`（抽出去是为了能测，
 * 本文件引着 png 贴纸、node 测试 import 不了）。
 */
function markerHtml(
  stop: TripMapStop,
  seq: number | null,
  showDayBadge: boolean,
  time?: StopSchedule,
  index = 0,
  gen = 0,
  entering = false,
  guided = false,
): string {
  // 品类贴纸（M13-07）：与生活环同一套卡通图，地图标记与环上观感一致。
  const sticker = POI_STICKERS[stop.poiKind ?? ""] ?? POI_STICKERS[KIND_FALLBACK[stop.kind]];
  return tripMarkerHtml(stop, { seq, showDayBadge, time, index, gen, entering, guided, sticker });
}

/**
 * 每个标记要往哪个方向让开——**相对它自己那一簇**的屏幕方位单位向量。
 *
 * 为什么不是相对全体中心：一份行程往往是几个片区各自成簇（如天河一簇、番禺一簇）。
 * 按全体中心算，同一簇里所有点的方位几乎一样，整簇一起平移过去，
 * **簇内该叠还叠**——而肉眼看到的重叠恰恰是簇内的。所以先找出每个点身边的
 * 「邻居簇」，朝背离邻居的方向让；身边没人时才退回相对全体中心（即最朴素的那条规则）。
 *
 * 屏幕 y 轴朝下，所以纬度要取反；经度按纬度做 cos 收缩，
 * 否则在广州（约 23°N）算出来的方位会整体偏东，"偏左的往左"就成了斜的。
 * 与参照点完全重合时没有方位可言，按序号均匀分角——否则它们原地不动、继续叠着。
 */
function spreadOffsets(pts: Array<{ lat: number; lon: number }>): Array<[number, number]> {
  const n = pts.length;
  const cLat = pts.reduce((a, p) => a + p.lat, 0) / n;
  const cLon = pts.reduce((a, p) => a + p.lon, 0) / n;
  const kx = Math.cos((cLat * Math.PI) / 180);
  // 屏幕坐标系下的平面坐标（x 向右、y 向下），后面的距离与方位都在这个系里算。
  const xy = pts.map((p) => [(p.lon - cLon) * kx, cLat - p.lat] as [number, number]);

  const spanX = Math.max(...xy.map((p) => p[0])) - Math.min(...xy.map((p) => p[0]));
  const spanY = Math.max(...xy.map((p) => p[1])) - Math.min(...xy.map((p) => p[1]));
  const crowdDist = Math.hypot(spanX, spanY) * CROWD_RATIO;

  return xy.map(([x, y], i) => {
    // 邻居簇的重心；身边没人就用全体中心（平面原点）。
    let sx = 0;
    let sy = 0;
    let count = 0;
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      if (Math.hypot(xy[j][0] - x, xy[j][1] - y) <= crowdDist) {
        sx += xy[j][0];
        sy += xy[j][1];
        count += 1;
      }
    }
    const dx = count ? x - sx / count : x;
    const dy = count ? y - sy / count : y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-12) {
      const a = (i / n) * Math.PI * 2;
      return [Math.cos(a) * SPREAD_X, Math.sin(a) * SPREAD_Y];
    }
    return [(dx / len) * SPREAD_X, (dy / len) * SPREAD_Y];
  });
}

/**
 * 把某一代**标记 DOM**的不透明度设成 v，补间交给 CSS transition（见 map.css）。
 * 按 `data-gen` 选，不按 class——过渡期间两代同时在图上，按 class 会连旧的一起改。
 */
function setDomOpacity(host: HTMLElement | null, gen: number, v: number): void {
  host?.querySelectorAll<HTMLElement>(`[data-gen="${gen}"]`).forEach((el) => {
    el.style.opacity = String(v);
  });
}

/**
 * 各折线的基准不透明度。步行接驳（虚线）混进同一个淡入淡出数组后，
 * 「按索引 % 2 查 ROUTE_LAYERS」的旧算法就会串层，所以基准在创建时逐条登记；
 * WeakMap 不持有折线，随折线被移除一起回收。
 */
const lineBaseOpacity = new WeakMap<object, number>();

/**
 * 折线的不透明度补间。折线画在 GL canvas 上，**吃不到 CSS transition**，
 * 只能自己按帧插值。`from`/`to` 是相对各层基准不透明度的系数（0=全透明，1=原样）。
 * 返回取消函数——重跑或卸载时必须调，否则它会去改已经被移除的折线。
 */
function setLinesOpacity(lines: unknown[], f: number): void {
  lines.forEach((o, i) => {
    const base = lineBaseOpacity.get(o as object) ?? ROUTE_LAYERS[i % ROUTE_LAYERS.length].opacity;
    (o as { setOptions?: (opt: Record<string, unknown>) => void }).setOptions?.({
      strokeOpacity: base * f,
    });
  });
}

function rampLines(lines: unknown[], from: number, to: number, onDone?: () => void): () => void {
  const t0 = performance.now();
  let raf = 0;
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / FADE_MS);
    setLinesOpacity(lines, from + (to - from) * k);
    if (k < 1) raf = requestAnimationFrame(step);
    else onDone?.();
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

export function AmapTripLayer({
  theme = "light",
  stops,
  showDayBadge = true,
  closeLoop = false,
  animated = true,
  planKey,
  navKey,
  navSpeedup = 1,
  onNavProgress,
  onFallback,
  onStopClick,
  guidedSpots,
}: AmapTripLayerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<AMapInstance | null>(null);
  const overlaysRef = useRef<unknown[]>([]);
  /** 贴边夹持那一帧；切天/卸载时必须取消，否则它会去改已经被 remove 的覆盖物。 */
  const rafRef = useRef<number | undefined>(undefined);
  const [ready, setReady] = useState(false);
  // stops 同步依赖地图就绪；用 state 触发覆盖物 effect 重跑。
  const [mapEpoch, setMapEpoch] = useState(0);

  /*
   * ── 镜头归属（M19-05 用户走查）────────────────────────────────
   *
   * 规矩只有一条：**用户手动动过镜头之后，程序就再也不碰它**，想回去自己点按钮。
   *
   * 原来 `setFitView` 跟在"画标记"后面，画一次框一次。在拖动被禁用的年代这没有
   * 代价（用户本来也动不了镜头），可交互一开，每次重画都会把用户正在看的位置抢走。
   *
   * `userMoved` 是**只进不退**的：一旦为真，只有按钮能清掉它。
   * `programmatic` 用来把我们自己调的 fitView 排除在"用户动了"之外——
   * setFitView 会触发 zoomend/moveend，不隔离的话它会把自己判成用户操作。
   */
  const userMovedRef = useRef(false);
  /** 上一次画的是哪份行程——planKey 否决权收回的比较基准（M27-04）。 */
  const planKeyRef = useRef<string | undefined>(undefined);
  const programmaticRef = useRef(false);
  const [userMoved, setUserMoved] = useState(false);
  /** 当前这一代的落点圆点，按钮要拿它重新框视野。 */
  const dotsRef = useRef<unknown[]>([]);
  /** 交叉淡出的收尾定时器；切天/卸载时要清，否则它会去 remove 已销毁的覆盖物。 */
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** 淡出定时器要删的那一代覆盖物（M34-03）：提前打断淡出时必须删**它**，不是当前代。 */
  const fadePendingRef = useRef<unknown[]>([]);
  /** 覆盖物代次：新旧两代过渡期间同时在图上，靠它区分谁淡入谁淡出。 */
  const genRef = useRef(0);
  /** 当前路线折线（与 overlaysRef 分开存：异步换真实道路时它会被整组替换）。 */
  const routeLinesRef = useRef<unknown[]>([]);
  /** 所有在跑的淡入淡出帧循环，重跑/卸载时统一取消。 */
  const cancelsRef = useRef<Array<() => void>>([]);

  /*
   * onFallback 走 ref，**绝不进重建依赖**。调用方十有八九传内联箭头函数——
   * 进依赖就是每次渲染销毁重建地图，覆盖物随后加到已销毁的实例上，
   * AMap 内部读 `.am` 直接崩整棵树（走查实测，白屏）。
   */
  const onFallbackRef = useRef(onFallback);
  onFallbackRef.current = onFallback;
  /** 同上：跟车进度回调也必然是内联函数，进依赖就是每帧重建。 */
  const onNavProgressRef = useRef(onNavProgress);
  onNavProgressRef.current = onNavProgress;
  // 同款 ref：点击开导览页（M36-03）。进依赖会让每次渲染重建整层覆盖物。
  const onStopClickRef = useRef(onStopClick);
  onStopClickRef.current = onStopClick;
  /*
   * 导览就绪集合：按**内容**出 key（排序去重后拼接），不按数组引用——调用方每次
   * 渲染都会给一个新数组。ref 给重建路径读（那一刻要知道谁已就绪），
   * 下面那个小 effect 给"轮询翻了一个点"的增量路径用。
   */
  const guidedKey = useMemo(
    () => Array.from(new Set(guidedSpots ?? [])).sort().join("\u0000"),
    [guidedSpots],
  );
  const guidedSet = useMemo(
    () => new Set(guidedKey ? guidedKey.split("\u0000") : []),
    [guidedKey],
  );
  const guidedRef = useRef(guidedSet);
  guidedRef.current = guidedSet;
  /** 建图取初始 center 用；不进依赖——stops 变化走覆盖物 effect，不重建地图。 */
  const stopsRef = useRef(stops);
  stopsRef.current = stops;

  /*
   * 覆盖物按 stops 的**内容**重建，不按数组引用（M19-05 用户走查：
   * "主页行程过一段时间会动一下"）。
   *
   * 数据源每 60 秒轮询一次，每次 `JSON.parse` 都产出全新对象，于是即便行程一个字
   * 没变，`stops` 的引用也变了。引用进依赖 = 每分钟把标记、路线、视野、
   * 甚至 7 段路径规划全部重做一遍——用户看到的就是"过一会儿自己动一下"。
   * 指纹里放的是所有会影响画面的字段；只要它们没变，这一层就该纹丝不动。
   */
  const stopsKey = useMemo(
    () =>
      stops
        .map((s) => `${s.name}|${s.day}|${s.kind}|${s.poiKind ?? ""}|${s.lat ?? ""}|${s.lon ?? ""}`)
        .join(";"),
    [stops],
  );

  // ── 地图实例：只随主题重建 ──
  useEffect(() => {
    if (!isAmapConfigured()) {
      onFallbackRef.current?.("未配置 AMAP_JS_KEY");
      return;
    }
    let cancelled = false;
    loadAmap()
      .then((AMap) => {
        const host = hostRef.current;
        if (cancelled || !host) return;
        // center 必须显式给（首个有坐标的停靠点，兜底任意合法点）：
        // 不给时 AMap 走异步 IP 定位，视图未就绪前 `map.add` 内部读 `.am` 直接抛
        // ——walkthrough 实测整棵 React 树白屏。真实视野随后由 fitView 接管。
        const first = stopsRef.current.find((s) => s.lat !== undefined && s.lon !== undefined);
        const map = new AMap.Map(host, {
          center: [first?.lon ?? 113.32, first?.lat ?? 23.1],
          zoom: 11,
          mapStyle: MAP_STYLE[theme],
          // 要素级裁剪（M13-09）：只留底色与路网，**去掉 POI 点与建筑体块**。
          // 用户走查：底图信息太多。默认的 point 层把餐馆商场全画出来，
          // 与我们自己的行程标记抢注意力——这张图上唯一该被读到的 POI 是行程站点。
          // 比自定义样式（要去高德控制台配 styleId、再随产物下发）轻得多，
          // 实测 getFeatures() 回读确认生效。
          features: MAP_FEATURES,
          /*
           * 缩放与平移（M19-05 用户要求）。原来这四项全关，理由是"视野由 fitView
           * 管理，拖没影的地图在车机上找不回来"——找不回来这条仍然成立，只是现在
           * 由用户自己承担：**换行程（planKey 变化）时 fitView 会重新框一次视野**；
           * 同一份行程内则要点「回到全程」。此前这行注释写的是「stops 变化就框」，
           * 与实现不符——否决权一旦置起，切天也不会框（M27-04 修正）。
           *
           * keyboardEnable 保持关：开了会给容器加 tabindex，而容器带着
           * `aria-hidden="true"`——可聚焦元素藏在 aria-hidden 里是实打实的无障碍错误。
           * 缩放平移用鼠标/触摸已经够，不值得为它引一个新问题进来。
           */
          dragEnable: true,
          zoomEnable: true,
          scrollWheel: true,
          touchZoom: true,
          doubleClickZoom: true,
          keyboardEnable: false,
        });
        mapRef.current = map;

        /*
         * 用户动过镜头就交出控制权。只认**用户发起**的三个事件：
         * dragstart（拖动）、mousewheel（滚轮）、touchstart（触摸/双指）。
         * 不用 moveend/zoomend —— 我们自己的 fitView 也会触发它们，
         * 那会让地图刚框好视野就立刻把自己判成"用户动过了"。
         */
        const markUserMoved = () => {
          if (programmaticRef.current || userMovedRef.current) return;
          userMovedRef.current = true;
          setUserMoved(true);
        };
        map.on?.("dragstart", markUserMoved);
        map.on?.("mousewheel", markUserMoved);
        map.on?.("touchstart", markUserMoved);

        // 覆盖物同样等 complete：epoch 在这里才 bump，早挂一样会踩 `.am`。
        map.on?.("complete", () => {
          if (cancelled) return;
          // 底色与要素再落一次——构造参数会静默失效，见 enforceBaseStyle 的注释。
          // 这一层尤其要紧：满屏 POI 会和行程标记抢注意力，而彩色路网会淹掉琥珀轨迹。
          enforceBaseStyle(map, theme);
          setReady(true);
          setMapEpoch((n) => n + 1);
        });
      })
      .catch((e: unknown) => {
        if (!cancelled) onFallbackRef.current?.(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      if (fadeTimerRef.current !== undefined) clearTimeout(fadeTimerRef.current);
      fadePendingRef.current = []; // 地图实例整个销毁，挂账的旧代一并作废
      overlaysRef.current = [];
      dotsRef.current = [];
      mapRef.current?.destroy();
      mapRef.current = null;
      setReady(false);
    };
  }, [theme]);

  /**
   * 框住全部落点。**唯一**会动镜头的地方——自动调用与按钮都走它。
   *
   * `programmatic` 在调用期间置位，把随之而来的 zoomend/moveend 与用户操作区分开；
   * `immediately=true` 是同步完成，所以下一帧解除就够。
   */
  const fitToStops = useCallback(() => {
    const map = mapRef.current;
    const dots = dotsRef.current;
    if (!map || dots.length === 0) return;
    const host = hostRef.current;
    const avoid = fitAvoidFor(host?.clientWidth ?? 0, host?.clientHeight ?? 0);
    programmaticRef.current = true;
    (map.setFitView as ((...a: unknown[]) => void) | undefined)?.call(map, dots, true, avoid);
    /*
     * 解除隔离用定时器，**不能用 rAF**：窗口不可见时 rAF 是完全暂停的，
     * 那样这个标记会一直挂着 true，之后用户的每一次拖动都被当成"程序自己动的"
     * 而被忽略——镜头再也交不出去，按钮也永远不出现。定时器在后台只是降频，仍会触发。
     * setFitView 带 immediately=true 是同步完成的，所以 0ms 足够。
     */
    setTimeout(() => {
      programmaticRef.current = false;
    }, 0);
  }, []);

  /**
   * 点击地点胶囊 → 推近并把它摆到屏幕中央，看清周边环境。
   *
   * 这是**用户自己发起的取景**，所以和拖动/缩放一视同仁：镜头就此归用户，
   * `userMoved` 置位让「回到全程」冒出来——那是退出聚焦的唯一入口，
   * 顺手也就有了"点错了怎么退回去"的答案。**不能**走 programmatic 隔离，
   * 否则程序会在下一次 stops 变化时把用户正在看的地点又框回总览。
   */
  const focusStop = useCallback((lon: number, lat: number) => {
    const map = mapRef.current;
    if (!map) return;
    userMovedRef.current = true;
    setUserMoved(true);
    try {
      // 先补要素再推镜头：反过来的话推近动画的头几百毫秒是空灰底，会闪一下。
      map.setFeatures?.([...MAP_FEATURES_FOCUS]);
    } catch {
      /* 要素设不上只是看得少一点，不该拦住聚焦本身 */
    }
    map.setZoomAndCenter?.(FOCUS_ZOOM, [lon, lat], false, FOCUS_MS);
  }, []);

  /** 「回到全程」：把镜头交还给程序，并立刻框一次。 */
  const handleRecenter = useCallback(() => {
    userMovedRef.current = false;
    setUserMoved(false);
    // 退出聚焦要连**要素**一起复位，否则回到总览时满屏 POI 又和行程标记抢注意力
    //（M13-09 那条走查结论）。enforceBaseStyle 同时把底色也落一次，正好复用。
    const map = mapRef.current;
    if (map) enforceBaseStyle(map, theme);
    fitToStops();
  }, [fitToStops, theme]);

  // ── 覆盖物：stops 变化只换标注与视野，不重建地图 ──
  useEffect(() => {
    const map = mapRef.current;
    const AMap = typeof window !== "undefined" ? window.AMap : undefined;
    if (!map || !AMap) return;

    // ⚠️ 方法必须**带着 map 调**（map.xxx?.()）：解构成裸函数会丢 this，
    // AMap 内部读 this.am 直接抛——第一次白屏就是这么来的。
    type MapFn = (...args: unknown[]) => void;
    // 上一轮的夹持帧还没跑就先取消：它引用的是马上要被 remove 的覆盖物。
    if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
    // 上一次过渡没收尾就先结掉：两次过渡的清理会互相踩（后一次会去 remove 前一次
    // 已经 remove 过的覆盖物），而且旧的帧循环还在改早已不存在的折线。
    cancelsRef.current.forEach((c) => c());
    cancelsRef.current = [];
    if (fadeTimerRef.current !== undefined) {
      clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = undefined;
      /*
       * 删**那个定时器本来要删的一代**（fadePendingRef），不是 overlaysRef.current
       * ——后者是当前代（马上会走正常的淡出流程）。删错对象的后果（M34-03 修复）：
       * 上上代的折线从此没人删，且上一行的 cancels 已把它的淡出动画掐断在半透明，
       * 图上于是留着一段没有任何标注的旧路线（真实走查：右上角延伸出画面的线，
       * 正是上一份行程东北角的华南植物园段）。
       */
      if (fadePendingRef.current.length) {
        (map.remove as MapFn | undefined)?.call(map, fadePendingRef.current);
        fadePendingRef.current = [];
      }
    }

    /*
     * 旧的一代**先不删**（M19-05 用户走查："重绘制比较生硬"）：
     * 新的一代先整代画好、透明地挂上去，两代交叉淡入淡出之后才移除旧的。
     * 原来是同帧 remove→add，图上会空一拍再整批蹦出来。
     */
    const outgoing = overlaysRef.current;
    const outgoingGen = genRef.current;
    const outgoingLines = routeLinesRef.current;
    const gen = (genRef.current += 1);
    // 本轮是否已作废。淡入的两条调度路径与后面的异步路径规划共用它，
    // 所以必须在最前面声明——写在下面会让上面的闭包落进 TDZ。
    let cancelled = false;

    // 读 ref 而不是闭包里的 stops：依赖是内容指纹 stopsKey，
    // 指纹相同的两个数组不该重跑，但真跑起来时要拿到最新那一份。
    const located = stopsRef.current.filter((s) => s.lat !== undefined && s.lon !== undefined);
    if (located.length === 0) {
      if (outgoing.length) (map.remove as MapFn | undefined)?.call(map, outgoing);
      overlaysRef.current = [];
      routeLinesRef.current = [];
      dotsRef.current = [];
      return;
    }

    const MarkerCtor = AMap.Marker as new (opts: Record<string, unknown>) => unknown;
    const PolylineCtor = AMap.Polyline as new (opts: Record<string, unknown>) => unknown;
    /*
     * 折线**按天分段**（M34-03）：一天一段，跨天不连线——跨天衔接发生在
     * "回酒店之后"，画出来就是一段不存在的行车（走查里 D1/D2 交叉成麻花的根源）。
     * 单日视图只有一段，行为与从前一致。
     */
    const daySegs = splitByDay(located).map((seg) => seg.map((s) => [s.lon, s.lat] as [number, number]));
    // 闭环：酒店出发 → 景点 → 回酒店（标记不重复，只有路径折返）。单日模式才有此语义。
    if (closeLoop && daySegs.length === 1 && daySegs[0].length >= 2 && located[0].kind === "hotel") {
      daySegs[0].push(daySegs[0][0]);
    }
    // 跟车/粒子仍然要一条整线可走：单段时它就是那一段（nav 模式恒为单日）。
    const path = daySegs.length === 1 ? daySegs[0] : located.map((s) => [s.lon, s.lat] as [number, number]);

    const overlays: unknown[] = [];
    /*
     * 路线在标记之下：先加线再加点。白色底衬 + 琥珀主线两层——
     * 高德底图的主干道也是橙色系，单层琥珀线会融进路网里。
     *
     * 这里先画**点到点直线**，随后的异步路径规划回来再换成真实道路（M13-09）。
     * 不等规划就先出图：车机弱网下规划可能要几秒甚至失败，
     * 那期间空着一张没有路线的地图，比先给一条粗略的线糟。
     */
    const makeRouteLines = (p: Array<[number, number]>, opacityFactor = 1): unknown[] =>
      p.length >= 2 && PolylineCtor
        ? ROUTE_LAYERS.map((l) => {
            const line = new PolylineCtor({
              path: p,
              strokeColor: l.color,
              strokeWeight: l.weight,
              strokeOpacity: l.opacity * opacityFactor,
              lineJoin: "round",
              lineCap: "round",
              showDir: l.showDir,
              zIndex: l.zIndex,
            });
            lineBaseOpacity.set(line as object, l.opacity);
            return line;
          })
        : [];
    // 步行接驳（见 WALK_LAYER）：从站点圆点画到驾车折线的落路点。
    const makeWalkLines = (
      pairs: Array<[[number, number], [number, number]]>,
      opacityFactor = 1,
    ): unknown[] =>
      PolylineCtor
        ? pairs.map(([stop, road]) => {
            const line = new PolylineCtor({
              path: [road, stop],
              strokeColor: WALK_LAYER.color,
              strokeWeight: WALK_LAYER.weight,
              strokeOpacity: WALK_LAYER.opacity * opacityFactor,
              strokeStyle: "dashed",
              strokeDasharray: [4, 8],
              lineCap: "round",
              zIndex: WALK_LAYER.zIndex,
            });
            lineBaseOpacity.set(line as object, WALK_LAYER.opacity);
            return line;
          })
        : [];
    // 建成全透明，随这一代一起淡入。逐段建线（M34-03），跨天之间没有线。
    let routeLines = daySegs.flatMap((seg) => makeRouteLines(seg, 0));
    overlays.push(...routeLines);
    // 真实坐标上的落点圆点：胶囊要向外偏移，位置真相由它承担（见 SPREAD_PX 注释）。
    const dots: unknown[] = located.map(
      (s) =>
        new MarkerCtor({
          position: [s.lon, s.lat],
          content:
            `<i class="hud-tripmark__dot hud-tripmark__dot--${s.kind}"` +
            ` data-gen="${gen}" style="opacity:0"></i>`,
          anchor: "center",
          zIndex: 90,
        }),
    );
    overlays.push(...dots);

    const PixelCtor = AMap.Pixel as (new (x: number, y: number) => unknown) | undefined;
    const offsets = spreadOffsets(located as Array<{ lat: number; lon: number }>);
    let seq = 0;
    const marks: unknown[] = located.map((s, i) => {
      const [ox, oy] = offsets[i];
      const mark = new MarkerCtor({
        position: [s.lon, s.lat],
        content: markerHtml(
          s,
          s.kind === "spot" ? ++seq : null,
          showDayBadge,
          undefined,
          i,
          gen,
          true,
          guidedRef.current.has(s.name),
        ),
        anchor: "bottom-center",
        // Pixel 缺失（SDK 裁剪）时退化成不偏移——散不开总比不上图强。
        ...(PixelCtor ? { offset: new PixelCtor(ox, oy) } : {}),
        zIndex: 100 + i,
      });
      /*
       * 点它就推近看周边（用户要求）。**聚焦的是真实坐标**（s.lon/s.lat），
       * 不是胶囊被推开后的位置——胶囊带着 spreadOffsets 的外推量与贴边夹持，
       * 拿它当中心等于把镜头对到旁边几十米的空地上。
       *
       * 绑在 Marker 上而不是给 DOM 加 onclick：这一代胶囊会因为补时刻而被
       * `setContent` 整个换掉（见下面的异步增强），挂在 DOM 上的监听会跟着没。
       *
       * 只认鼠标/触摸，不做键盘可达——地图容器是 aria-hidden 的，
       * 往里塞可聚焦元素是实打实的无障碍错误（同 keyboardEnable 那条）。
       */
      (mark as ClickableMarker).on?.("click", () => {
        focusStop(s.lon!, s.lat!);
        // 景点标记同时是导览页入口（M36-03）：先聚焦（既有行为），再开页。
        // 酒店/充电站不开——"景区内导览"对它们没有意义。
        if (s.kind === "spot") onStopClickRef.current?.(s);
      });
      return mark;
    });
    overlays.push(...marks);

    // 流动粒子（AMap.MoveAnimation）：插件缺失时静默降级为静态线。
    // 先收集、add 之后再由 startRunner 启动——挂图前调 moveAlong 是静默 no-op。
    // **只在单段（单日视图）跑**（M34-03）：分天之后段与段不相连，
    // 粒子跨段会沿一条不存在的直线飞过半个城。
    let runner: RunnerMarker | undefined;
    if (animated && daySegs.length === 1 && path.length >= 2 && MarkerCtor) {
      try {
        runner = new MarkerCtor({
          position: path[0],
          content: `<div class="hud-tripmark__runner" data-gen="${gen}" style="opacity:0"></div>`,
          anchor: "center",
          zIndex: 200,
        }) as RunnerMarker;
        if (typeof runner.moveAlong === "function") overlays.push(runner);
        else runner = undefined;
      } catch {
        runner = undefined; // 动画是装饰，不因它失败丢标注。
      }
    }

    (map.add as MapFn | undefined)?.call(map, overlays);
    startRunner(runner, path);
    overlaysRef.current = overlays;
    routeLinesRef.current = routeLines;
    // 视野框**真实落点**（dots）而不是偏移后的胶囊：胶囊带外推量，
    // 拿它算视野等于每次都多留一圈白边，越缩越小。含线会被 showDir 的箭头撑歪，也不用。
    dotsRef.current = dots;

    /*
     * 镜头：**用户动过就彻底不碰**（M19-05）——但否决权只对着同一份行程成立。
     * 换了行程（planKey 变了）先收回否决权再判：不收回的话，看旧行程时拖过
     * 一下地图，新行程就永远framed不上——站点在旧视野下挤成一摞（M27-04）。
     */
    if (planKeyRef.current !== planKey) {
      planKeyRef.current = planKey;
      userMovedRef.current = false;
      setUserMoved(false);
    }
    if (!userMovedRef.current) fitToStops();

    /*
     * 交叉淡入淡出：新的一代此刻已经在图上但整代透明，下一帧才开始淡入
     * ——要先让浏览器把 `opacity:0` 落成已渲染的初值，同帧改成 1 不会有过渡。
     */
    const fadeHost = hostRef.current;
    let faded = false;
    /**
     * `instant` 是给**窗口不可见**那条路准备的。
     *
     * rAF 在窗口隐藏时是**完全暂停**而不是变慢的，于是"下一帧再淡入"永远等不到，
     * 这一代就会一直停在 opacity:0——用户切回来看到的是一张只有底图的空地图。
     * 所以 rAF 与定时器同时挂：谁先到谁执行（faded 保证只跑一次）。
     * 定时器在后台也会触发（只是被降频），那条路直接给终值、不做补间——
     * 反正没人看得见过渡，重要的是**状态一定要落地**。
     */
    const startFade = (instant: boolean) => {
      if (faded || cancelled) return;
      faded = true;
      setDomOpacity(fadeHost, gen, 1);
      if (instant) setLinesOpacity(routeLines, 1);
      else cancelsRef.current.push(rampLines(routeLines, 0, 1));

      if (outgoing.length) {
        setDomOpacity(fadeHost, outgoingGen, 0);
        if (instant) setLinesOpacity(outgoingLines, 0);
        else cancelsRef.current.push(rampLines(outgoingLines, 1, 0));
        fadePendingRef.current = outgoing;
        fadeTimerRef.current = setTimeout(
          () => {
            fadeTimerRef.current = undefined;
            fadePendingRef.current = [];
            // 期间可能已经换过地图实例（主题切换），别往别人身上删。
            if (mapRef.current === map) (map.remove as MapFn | undefined)?.call(map, outgoing);
          },
          instant ? 0 : FADE_MS,
        );
      }
    };
    const fadeRaf = requestAnimationFrame(() => startFade(false));
    const fadeFallback = setTimeout(() => startFade(true), FADE_MS);
    cancelsRef.current.push(() => {
      cancelAnimationFrame(fadeRaf);
      clearTimeout(fadeFallback);
    });

    /*
     * 贴边夹持：胶囊宽度取决于名字长短，**只有上图后才知道**，
     * 所以外推之后再量一次，超出容器就把水平偏移拉回来。
     * 不夹的话靠边的长名字会被裁掉半截（走查实测：「广州正佳广场万豪酒店」只剩前几个字），
     * 而名字看不全比它没散开更糟。
     *
     * 放在 rAF 里：AMap 2.0 的覆盖物变换在下一帧才落到 DOM，同步量到的是旧位置。
     */
    const clampToEdges = () => {
      const el = hostRef.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      const safe = safeInsets();
      for (let i = 0; i < marks.length; i += 1) {
        // 按 data-i 取，不按 DOM 顺序——顺序会随 zIndex/重绘变化。
        // 还要带上 data-gen：过渡期间上一代的胶囊也还在图上，同一个 data-i
        // 会选中两个，夹持量就会算到正在淡出的那一个头上。
        const cap = el.querySelector<HTMLElement>(
          `.hud-tripmark[data-i="${i}"][data-gen="${gen}"]`,
        );
        if (!cap) continue;
        // 先归零再量：上一轮夹持的位移会污染这一轮的测量结果。
        cap.style.setProperty("--clamp-x", "0px");
        cap.style.setProperty("--clamp-y", "0px");
        const r = cap.getBoundingClientRect();

        /*
         * **只夹"露了一半"的，不夹"整个在屏外"的。**
         *
         * 夹持的正当性是"名字看不全比它没散开更糟"——那说的是胶囊还在视野里、
         * 只是探出了一条边。如果地点整个在视野之外（用户把地图拖走了），把它拽回来
         * 就不是修正而是**谎报位置**：屏幕上会出现一枚指着别处的标记，
         * 而且一排都被拽到同一条边上叠成一堆。宁可让它诚实地留在屏外。
         */
        if (r.right <= box.left || r.left >= box.right || r.bottom <= box.top || r.top >= box.bottom) {
          continue;
        }

        let fix = 0;
        if (r.left < box.left + EDGE_PAD) fix = box.left + EDGE_PAD - r.left;
        else if (r.right > box.right - EDGE_PAD) fix = box.right - EDGE_PAD - r.right;
        if (fix !== 0) cap.style.setProperty("--clamp-x", `${Math.round(fix)}px`);

        /*
         * 纵向同理，但收边按**安全区**而不是容器边：容器顶边下面那一条是状态栏
         * 与挖孔，胶囊落进去就等于不存在。下边同理让开 home indicator。
         * 顶边优先：两边同时超出时（胶囊比可视高度还高，理论上不会发生）
         * 宁可露出上半截——序号与地点名在上面。
         */
        let fixY = 0;
        const top = box.top + safe.top + EDGE_PAD;
        const bottom = box.bottom - safe.bottom - EDGE_PAD;
        if (r.top < top) fixY = top - r.top;
        else if (r.bottom > bottom) fixY = bottom - r.bottom;
        if (fixY !== 0) cap.style.setProperty("--clamp-y", `${Math.round(fixY)}px`);
      }
    };
    const raf = requestAnimationFrame(clampToEdges);
    rafRef.current = raf;

    /*
     * 地图一动就重夹一次。
     *
     * 夹持量是**按屏幕坐标**算的，镜头一变它就作废：`setFitView` 的收拢动画结束、
     * 用户拖动或缩放之后，原本在中间的地点可能落到边缘或落进顶部挖孔区，而上一轮
     * 算出来的 `--clamp-x/y` 还挂在那儿——表现是标注被裁掉半截且**再也不会自愈**。
     * 2026-09-02 在 iPhone 16 Pro Max 上，左下角那张卡片就是这么一直缺着左半边的。
     *
     * 这里**要**用 moveend/zoomend：上面 markUserMoved 刻意避开它们，是因为那件事
     * 要区分"谁动的镜头"；夹持不区分——我们自己的 fitView 造成的错位同样得修。
     * 每次只排一帧（先 cancel 再 request），连续拖动不会堆出一串回调。
     */
    const scheduleClamp = () => {
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(clampToEdges);
    };
    const mapEvents = map as { on?: MapEventBinder; off?: MapEventBinder };
    mapEvents.on?.("moveend", scheduleClamp);
    mapEvents.on?.("zoomend", scheduleClamp);
    mapEvents.on?.("resize", scheduleClamp);

    /*
     * 异步增强（M13-09，M34-03 改逐段）：真实道路路径 + 由真实车程推出的时刻。
     * 拿到结果才替换直线；失败就保持直线且不显示时刻——不猜路也不猜时间。
     * 逐段（逐天）规划、串行发起：段集合与从前一致（少了跨天衔接那几段），
     * planDrivingLegs 内部的 350ms 限流仍然成立。
     */
    const planAllSegs = async (): Promise<Array<Array<RouteLeg | null>>> => {
      const out: Array<Array<RouteLeg | null>> = [];
      for (const seg of daySegs) {
        if (cancelled) break;
        out.push(seg.length >= 2 ? await planDrivingLegs(AMap as Record<string, unknown>, seg) : []);
      }
      return out;
    };
    void planAllSegs().then((segLegsRaw) => {
      if (cancelled || mapRef.current !== map) return;
      /*
       * 越界防御（M34-03）：某段的 legs 数与点数不齐（换行程竞态/上游异常）时，
       * 逐对补直线会把 `path[i+1]` 连到早已换掉的点上——错位的"真实路径"比直线
       * 更糟。整段放弃真实路径、保留直线，并说一声。
       */
      const segLegs = daySegs.map((seg, i) => {
        const want = Math.max(seg.length - 1, 0);
        const got = segLegsRaw[i] ?? [];
        if (got.length !== want) {
          console.warn(`[trip-map] 第 ${i + 1} 段 legs=${got.length} 与点数不齐（应 ${want}），保留直线`);
          return new Array<RouteLeg | null>(want).fill(null);
        }
        return got;
      });

      if (segLegs.some((legs) => legs.some((l) => l !== null))) {
        // 真实道路折线：段内逐对首尾相接，缺的那对用两端直连补上；段与段之间不连。
        const segRealPaths = daySegs.map((seg, gi) => {
          const legs = segLegs[gi];
          const realPath: Array<[number, number]> = [];
          for (let i = 0; i + 1 < seg.length; i += 1) {
            const leg = legs[i];
            if (leg) realPath.push(...leg.path);
            else realPath.push(seg[i], seg[i + 1]);
          }
          return realPath;
        });
        // 直线换真实道路同样交叉淡入：先把真实道路透明地加上去，
        // 与直线对淡之后再删直线。原来是同帧 remove→add，路线会硬跳一下。
        const nextGroups = segRealPaths.map((rp, gi) =>
          rp.length >= 2 ? makeRouteLines(rp, 0) : makeRouteLines(daySegs[gi], 0),
        );
        /*
         * 步行接驳与真实道路同一代出场：直线阶段线端就是站点，无缝可接；
         * 真实道路贴路网收尾才产生"端点够不到圆点"的差距（普陀山实测 76~85m）。
         * 混进同一个 next 数组，淡入淡出与代际清理都不用另立机制
         * （基准不透明度由 lineBaseOpacity 逐条登记，见 setLinesOpacity）。
         */
        const walkPairs = daySegs.flatMap((seg, gi) => walkConnectors(seg, segLegs[gi] ?? []));
        const next = [...nextGroups.flat(), ...makeWalkLines(walkPairs, 0)];
        if (next.length) {
          const prev = routeLines;
          (map.add as MapFn | undefined)?.call(map, next);
          cancelsRef.current.push(rampLines(next, 0, 1));
          cancelsRef.current.push(
            rampLines(prev, 1, 0, () => {
              if (mapRef.current === map) (map.remove as MapFn | undefined)?.call(map, prev);
            }),
          );
          overlaysRef.current = overlaysRef.current.filter((o) => !prev.includes(o));
          overlaysRef.current.push(...next);
          routeLines = next;
          routeLinesRef.current = next;
          // 粒子改跟真实路径跑，否则它会沿着已经不存在的直线飘。
          // 与直线那次同一个 startRunner：一圈仍是 RUNNER_LOOP_MS，换线不换流速。
          // runner 只在单段模式存在（见上），跟第一段即可。
          if (runner && segRealPaths[0] && segRealPaths[0].length >= 2) {
            startRunner(runner, segRealPaths[0]);
          }
        }
      }
      // 跟车与时刻要的是"逐对"的平铺视图：段内取规划结果，跨天对恒 null。
      const legs: Array<RouteLeg | null> = [];
      {
        let gi = 0;
        let li = 0;
        for (let i = 0; i + 1 < located.length; i += 1) {
          if (located[i + 1].day !== located[i].day) {
            legs.push(null);
            gi += 1;
            li = 0;
          } else {
            legs.push(segLegs[gi]?.[li] ?? null);
            li += 1;
          }
        }
        // 闭环段多出的"回酒店"一对（单日模式）：补在末尾，跟车与粒子要用。
        if (closeLoop && daySegs.length === 1 && segLegs[0] && segLegs[0].length === located.length) {
          legs.push(segLegs[0][segLegs[0].length - 1]);
        }
      }
      /*
       * ── 跟车（M31-03）────────────────────────────────────────
       *
       * 起在这里而不是上面画直线那一步：跟车要沿**真实道路**走。
       * 直线上跟车会让车横穿楼房与江面——那正是 M13-09 当初把连线换成
       * `AMap.Driving` 的理由，跟车这一层不该把它退回去。
       *
       * 某一段规划失败（`legs[i] === null`）时那一段仍然跟，只是走两端直连、
       * 且**不产生 ETA**（`etaToNextStop` 见到没有 durationS 的段不给时间）。
       * 少一段跟车比整程不跟车好，猜一个时间则比不给时间糟。
       */
      if (navKey) {
        const navLegs: NavLeg[] = [];
        for (let i = 0; i + 1 < path.length; i += 1) {
          const leg = legs[i];
          navLegs.push(
            leg
              ? { path: leg.path, durationS: leg.durationS }
              : { path: [path[i], path[i + 1]] }, // 直线回落：跟得动，但没有车程
          );
        }
        // 闭环那一圈的终点回到首个站点；越界一律落回它，免得报出 undefined。
        const stopNameAt = (i: number) => (located[i] ?? located[0])?.name;

        let car: unknown;
        try {
          car = new MarkerCtor({
            position: navLegs[0]?.path[0] ?? path[0],
            content: `<div class="hud-navcar" data-gen="${gen}"><span class="hud-navcar__dot" /></div>`,
            anchor: "center",
            zIndex: 260, // 在流动粒子（200）之上：车是主角，粒子是装饰
          });
        } catch {
          car = undefined; // 车标建不出来不该让整张图失败
        }

        if (car && navLegs.length > 0) {
          (map.add as MapFn | undefined)?.call(map, [car]);
          overlaysRef.current = [...overlaysRef.current, car];

          const source = createSimulatedNavSource(navLegs, { speedup: navSpeedup });
          let lastLeg = -1;
          const stop = source.subscribe((pos) => {
            if (cancelled || mapRef.current !== map) return;
            (car as { setPosition?: (p: [number, number]) => void }).setPosition?.(pos.at);
            const el = hostRef.current?.querySelector<HTMLElement>(
              `.hud-navcar[data-gen="${gen}"]`,
            );
            if (el && pos.headingDeg !== undefined) {
              el.style.setProperty("--heading", `${Math.round(pos.headingDeg)}deg`);
            }
            /*
             * 镜头跟随，但**用户动过就不碰**——与 M19-05 同一条规矩。
             * 跟车时抢镜头尤其难受：用户想看看下一站附近，镜头每 200 毫秒
             * 把他拽回车上。想跟回来点「回到全程」（那里会清掉否决权）。
             */
            if (!userMovedRef.current) {
              programmaticRef.current = true;
              (map.setCenter as MapFn | undefined)?.call(map, pos.at);
              programmaticRef.current = false;
            }
            // 到站：段号往前跳的那一帧给一次站名，播报由外层做（只播一次）。
            const arrived = pos.legIndex > lastLeg && lastLeg >= 0 ? stopNameAt(pos.legIndex) : undefined;
            lastLeg = pos.legIndex;
            const eta = etaToNextStop(navLegs, pos);
            onNavProgressRef.current?.({
              nextStopName: pos.finished ? undefined : stopNameAt(pos.legIndex + 1),
              remainingM: eta.remainingM,
              ...(eta.remainingSec === undefined ? {} : { remainingSec: eta.remainingSec }),
              ...(arrived ? { arrivedStopName: arrived } : {}),
              finished: pos.finished,
            });
          });
          cancelsRef.current.push(stop);
        }
      }

      // 时刻：段数不足或有段失败时 scheduleStops 整体返回空，标记只留 Day N。
      const times = scheduleStops(located, legs);
      if (times.some((t) => t.arrive)) {
        let s2 = 0;
        located.forEach((stop, i) => {
          const setContent = (marks[i] as { setContent?: (h: string) => void }).setContent;
          setContent?.call(
            marks[i],
            // entering=false：这一次是补时刻，不是入场，必须直接可见。
            markerHtml(
              stop,
              stop.kind === "spot" ? ++s2 : null,
              showDayBadge,
              times[i],
              i,
              gen,
              false,
              guidedRef.current.has(stop.name),
            ),
          );
        });
        // 补了时刻行胶囊会变宽，上一轮的夹持结论作废——必须按新宽度重夹一次。
        rafRef.current = requestAnimationFrame(clampToEdges);
      }
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      mapEvents.off?.("moveend", scheduleClamp);
      mapEvents.off?.("zoomend", scheduleClamp);
      mapEvents.off?.("resize", scheduleClamp);
    };
    // 依赖是 stopsKey（内容指纹）而不是 stops（数组引用）——见 stopsKey 的注释：
    // 轮询每分钟造一个新数组，进依赖就是每分钟把这一整套重做一遍。
    // navKey/navSpeedup 进依赖：换一次导航要从头起跑，改倍速要按新速度重来。
  }, [
    stopsKey,
    showDayBadge,
    closeLoop,
    animated,
    mapEpoch,
    fitToStops,
    focusStop,
    planKey,
    navKey,
    navSpeedup,
  ]);

  // ── 导览角标：轮询结果变了只翻已上图胶囊的 class，不碰覆盖物 ──
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // 两代胶囊过渡期间都在图上，一起翻——按 data-spot 找，不按 data-gen。
    // dataset 读出来的是解码后的名字，与 guidedSet 里的原文直接可比。
    host.querySelectorAll<HTMLElement>(".hud-tripmark[data-spot]").forEach((el) => {
      const name = el.dataset.spot ?? "";
      el.classList.toggle(TRIP_MARKER_GUIDED_CLASS, guidedSet.has(name));
    });
    // mapEpoch 进依赖：地图重建后 host 里是全新一批 DOM，重建那一路已按 ref 标过，
    // 这里再走一遍只是幂等兜底。
  }, [guidedSet, mapEpoch]);

  return (
    <>
      {/* 真实地图未就绪前，程序化底图垫底（Brief §5：不得大面积纯白/纯黑）。 */}
      <MapBackdrop />
      <div
        ref={hostRef}
        className="hud-map-backdrop hud-map-amap hud-map-trip"
        data-ready={ready ? "1" : "0"}
        aria-hidden="true"
      />
      {/*
        「回到全程」只在用户自己动过镜头之后出现（M19-05）。
        它是镜头被交出去之后**唯一**的回程入口，所以不能藏进 aria-hidden 的地图容器里，
        这里与地图并列，是一个真正可聚焦、可读屏的按钮。
      */}
      {ready && userMoved && (
        <button type="button" className="hud-map-recenter" onClick={handleRecenter}>
          回到全程
        </button>
      )}
    </>
  );
}
