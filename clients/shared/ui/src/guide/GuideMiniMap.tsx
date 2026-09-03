/**
 * 导览小地图（施工单 M36-03；走查追修 2026-08-29：同簇散开 + 平滑路线 + 可缩放平移）。
 *
 * 两种画法，由数据决定、图上如实标注（不做半真半假的顺路）：
 *  - `geo`：全部点带真实坐标 → 按经纬度投影落位，形状就是真实相对方位；
 *  - `editorial`：坐标不齐 → 蛇形示意布点，只表达顺序不表达方位。
 *
 * # 同簇散开（走查病例：观音法界）
 *
 * 综合体类景区的多个点位（圣坛/大厅/抄经室…）共享几乎同一坐标，投影后序号点
 * 全叠在一处。处理沿用主地图 `AmapTripLayer.spreadOffsets` 的先例：**位置真相在
 * 簇心，散开只为可读**——同簇成员按小圆环绕簇心展开（按游玩序排角度，路线进簇
 * 后沿环走一圈再出簇），标签沿径向朝外放，不再互相压字。
 *
 * # 标签排布
 *
 * 名字标签的位置是**求解**出来的（候选位 + 冲突求解），不是一串按布局写死的
 * 左右/奇偶规则——细节与理由见下方「标签排布」一节。
 *
 * # 缩放与平移
 *
 * 滚轮 / 双指捏合 / 右下 ＋－ 按钮缩放，按住拖动平移，双击就地放大，⟲ 复位。
 * 关键取舍：**缩放作用在点位坐标上，不作用在图元尺寸上**——线宽、圆点、字号
 * 恒定，放大只拉开点与点的距离（真地图的做法）。若整体 scale 一个 `<g>`，
 * 密集簇放大后字也等比变大，相对压字程度一点没变，等于白缩。
 * 缩放钳在 [1,6]，平移钳在画布内（k=1 时自然钳成不动，拖了也不歪）。
 * 滚轮监听用原生 `{passive:false}` 挂——React 的 onWheel 在根上是 passive 的，
 * `preventDefault` 拦不住页面滚动。
 *
 * # 底图（2026-08-29 走查修订了 M36 总览决策 7；0830 走查再修订门槛）
 *
 * 原决策"程序化底图、不引地图 SDK"改为**分派**：够得着真实位置 → 真实底图
 * （`GuideMiniMapAmap`，复用主地图既有的 amap-loader，不是新依赖）；
 * 点位坐标太少 / 未配 key / 加载失败 → 本文件的手绘小图。回退仍是默认路径。
 *
 * ## 门槛是「有几个点带坐标」，不是「是不是全带坐标」（0830 走查）
 *
 * 原判据要求 `orderSource === "geo"`，而 `orderSpots` 只要**有一个点没坐标**
 * 就判 editorial。实测后果：库里 12 份导览简报**12 份全是 editorial**，
 * `GuideMiniMapAmap` 一次都没渲染过——写了的真实底图形态是死代码。
 *
 * 补坐标补不出来这条路：寺内「上来就好」大石、佛顶顶佛墙这类非正式地标
 * 本来就没有高德 POI 词条，`poi_search` 永远命中不了，而 prompt 明写
 * "lat/lon 只在 poi_search 命中同名点位时带"。也就是说"全齐"对多数景区
 * 是个**永远达不到的条件**。
 *
 * 放宽之后仍然不违反那条原则（"真地图上标猜的位置，比手绘示意图性质更坏"）：
 * **图上画出来的每一个点都是真坐标**，没坐标的点不画进图里，
 * 而是在图下如实列出"未在图上标出、位置未校验"。猜的位置一个都没有。
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";

import type { GuideSpotItem } from "@carlife/shared";

import { isAmapConfigured } from "../map/amap-loader";
import { GuideMiniMapAmap } from "./GuideMiniMapAmap";

export interface GuideMiniMapProps {
  /** 已按游玩顺序排好（merge 的产物，这里不重排）。 */
  spots: GuideSpotItem[];
  orderSource?: "geo" | "editorial";
  /** 起点（第一个停车场）；有坐标且 geo 模式时画进图里。 */
  origin?: { name: string; lat?: number; lon?: number };
  /** 底图主题（真实底图形态用）；缺省 light。 */
  theme?: "light" | "dark";
}

/**
 * W 只是 SSR/首帧的**默认**画布宽：挂载后由 ResizeObserver 按容器宽高比
 * 重算 viewBox 宽（高恒为 H），否则 preserveAspectRatio=meet 会在宽容器里
 * 左右留白——浅蓝底只有 viewBox 那么大，看起来像画布没铺满。
 */
const W = 400;
const H = 430;
/** 画布高（viewBox 单位）。标签越界判据要拿它做断言，故导出。 */
export const MINIMAP_H = H;
const PAD = 52;
/** 自适应画布宽的钳制：太窄标签放不下，太宽点位被拉得过散。 */
const MIN_W = 320;
const MAX_W = 1200;
/** 同簇判定半径（viewBox 单位）：投影后比它近的点视为同一处。 */
const CLUSTER_R = 34;
/** 缩放范围：1 = 整图（下限，不许缩得比整图还小），6 = 看清最密的簇足够。 */
const MIN_K = 1;
const MAX_K = 6;

interface Pt {
  x: number;
  y: number;
}

/** 最终落位 + 展开元数据（标签方向要用）。 */
interface Placed extends Pt {
  /** 属于散开簇时：从簇心指向本点的角度（弧度），标签沿它朝外。 */
  spreadAngle?: number;
}

/** 视图变换：屏上坐标 = tx + k·x。 */
interface ViewT {
  k: number;
  tx: number;
  ty: number;
}

const f = (n: number) => n.toFixed(1);

/** 经纬度 → viewBox 投影（经度按中纬余弦缩放，景区尺度下形状不失真）。 */
function projectGeo(spots: GuideSpotItem[], origin: GuideMiniMapProps["origin"], w = W): Pt[] {
  const all = [
    ...(origin && origin.lat !== undefined && origin.lon !== undefined
      ? [{ lat: origin.lat, lon: origin.lon }]
      : []),
    ...spots.map((s) => ({ lat: s.lat!, lon: s.lon! })),
  ];
  const midLat = all.reduce((a, p) => a + p.lat, 0) / all.length;
  const k = Math.cos((midLat * Math.PI) / 180);
  const xs = all.map((p) => p.lon * k);
  const ys = all.map((p) => p.lat);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  // 等比缩放取短边，避免东西向狭长的景区被拉成一条竖线。
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const scale = (Math.min(w, H) - PAD * 2) / span;
  const ox = (w - (maxX - minX) * scale) / 2;
  const oy = (H - (maxY - minY) * scale) / 2;
  return all.map((p) => ({
    x: ox + (p.lon * k - minX) * scale,
    // 纬度向上为北：y 轴反向。
    y: H - (oy + (p.lat - minY) * scale),
  }));
}

/** 蛇形示意布点：每行 3 个、左右折返——只表达顺序。 */
function projectEditorial(count: number, w = W): Pt[] {
  const cols = 3;
  const rows = Math.max(1, Math.ceil(count / cols));
  const cellW = (w - PAD * 2) / (cols - 1 || 1);
  const cellH = rows > 1 ? (H - PAD * 2) / (rows - 1) : 0;
  return Array.from({ length: count }, (_, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const x = row % 2 === 0 ? col : cols - 1 - col; // 折返，让连线不跨图跳回
    return { x: PAD + x * cellW, y: PAD + row * cellH };
  });
}

/**
 * 同簇散开。贪心归簇（与簇心距 < CLUSTER_R 即同簇），簇内按**游玩序**沿小圆
 * 均布——起始角取"进簇方向"（上一个簇外点 → 簇心），路线进簇后沿环转、
 * 不来回横跳。确定性纯函数，单测可断言。
 */
export function spreadClusteredPoints(pts: readonly Pt[], w = W): Placed[] {
  const clusters: { cx: number; cy: number; members: number[] }[] = [];
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i]!;
    const hit = clusters.find((c) => Math.hypot(c.cx - p.x, c.cy - p.y) < CLUSTER_R);
    if (hit) {
      hit.members.push(i);
      // 簇心随成员更新（增量均值），后续归簇按新簇心判
      hit.cx += (p.x - hit.cx) / hit.members.length;
      hit.cy += (p.y - hit.cy) / hit.members.length;
    } else {
      clusters.push({ cx: p.x, cy: p.y, members: [i] });
    }
  }

  const out: Placed[] = pts.map((p) => ({ ...p }));
  for (const c of clusters) {
    if (c.members.length < 2) continue;
    const n = c.members.length;
    const r = Math.min(34, 16 + 4 * n);
    // 进簇方向：簇的首个成员之前最近的簇外点；没有（整图一簇）则朝上。
    const first = Math.min(...c.members);
    const memberSet = new Set(c.members);
    let baseAngle = -Math.PI / 2;
    for (let j = first - 1; j >= 0; j -= 1) {
      if (!memberSet.has(j)) {
        baseAngle = Math.atan2(pts[j]!.y - c.cy, pts[j]!.x - c.cx);
        break;
      }
    }
    const ordered = [...c.members].sort((a, b) => a - b);
    ordered.forEach((idx, k) => {
      const a = baseAngle + (2 * Math.PI * k) / n;
      out[idx] = {
        // 钳入画布：簇本身可能落在投影极值上，环再向外一推就出界
        x: Math.min(Math.max(c.cx + r * Math.cos(a), 26), w - 26),
        y: Math.min(Math.max(c.cy + r * Math.sin(a), 26), H - 26),
        spreadAngle: a,
      };
    });
  }
  return out;
}

function lerp(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * 第 i 段（pts[i] → pts[i+1]）的三次贝塞尔控制点。
 *
 * 画线与方向箭头**共用这一个函数**，因为它们必须是同一条曲线。箭头原先自己
 * 按两端点算（弦的 55% 处落点、弦的角度当朝向），而线是 Catmull-Rom 曲线——
 * 弯得越厉害弦离曲线越远，于是箭头悬在路线外面、指的也不是路线的走向
 * （0902 走查：一屏三个箭头，两个脱线）。
 */
function segmentBezier(pts: readonly Pt[], i: number): [Pt, Pt, Pt, Pt] {
  const p1 = pts[i]!;
  const p2 = pts[i + 1]!;
  // 两点时画的是直线 L：控制点取三等分点，与那条直线完全重合
  if (pts.length === 2) return [p1, lerp(p1, p2, 1 / 3), lerp(p1, p2, 2 / 3), p2];
  const p0 = pts[i - 1] ?? p1;
  const p3 = pts[i + 2] ?? p2;
  return [
    p1,
    { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
    { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
    p2,
  ];
}

/** 三次贝塞尔在 t 处的落点与切向。 */
function bezierAt(seg: readonly [Pt, Pt, Pt, Pt], t: number): { p: Pt; d: Pt } {
  const [a, b, c, e] = seg;
  const u = 1 - t;
  return {
    p: {
      x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * e.x,
      y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * e.y,
    },
    d: {
      x: 3 * u * u * (b.x - a.x) + 6 * u * t * (c.x - b.x) + 3 * t * t * (e.x - c.x),
      y: 3 * u * u * (b.y - a.y) + 6 * u * t * (c.y - b.y) + 3 * t * t * (e.y - c.y),
    },
  };
}

/** Catmull-Rom → 三次贝塞尔：过每个点的平滑曲线（游览路线的手绘感）。 */
export function smoothPathD(pts: readonly Pt[]): string {
  if (pts.length < 2) return "";
  const d = [`M ${f(pts[0]!.x)} ${f(pts[0]!.y)}`];
  if (pts.length === 2) {
    d.push(`L ${f(pts[1]!.x)} ${f(pts[1]!.y)}`);
    return d.join(" ");
  }
  for (let i = 0; i < pts.length - 1; i += 1) {
    const [, c1, c2, p2] = segmentBezier(pts, i);
    d.push(`C ${f(c1.x)} ${f(c1.y)}, ${f(c2.x)} ${f(c2.y)}, ${f(p2.x)} ${f(p2.y)}`);
  }
  return d.join(" ");
}

/** 缩放/平移钳制：k 进 [MIN_K,MAX_K]，画布不许拖出可视区（k=1 时钳成原位）。 */
export function clampMiniMapView(v: ViewT, w = W): ViewT {
  const k = Math.min(Math.max(v.k, MIN_K), MAX_K);
  return {
    k,
    tx: Math.min(Math.max(v.tx, w * (1 - k)), 0),
    ty: Math.min(Math.max(v.ty, H * (1 - k)), 0),
  };
}

/** 屏幕像素 → viewBox 坐标（preserveAspectRatio=meet 有对中留白，要扣掉）。 */
function clientToView(el: SVGSVGElement, clientX: number, clientY: number, w = W): Pt {
  const rect = el.getBoundingClientRect();
  const s = Math.min(rect.width / w, rect.height / H) || 1;
  const ox = (rect.width - w * s) / 2;
  const oy = (rect.height - H * s) / 2;
  return { x: (clientX - rect.left - ox) / s, y: (clientY - rect.top - oy) / s };
}

/** 屏幕像素距离 → viewBox 单位的换算系数。 */
function viewScaleOf(el: SVGSVGElement, w = W): number {
  const rect = el.getBoundingClientRect();
  return Math.min(rect.width / w, rect.height / H) || 1;
}

/** 只给长段配方向 chevron：短段的方向由序号表达，每段都插只会糊成一团。 */
const CHEVRON_MIN_SEG = 64;

/* ────────────────────────── 标签排布 ──────────────────────────
 *
 * 名字标签压字，原先靠一串「见招拆招」的规则挡：按下标奇偶左右分、贴右缘
 * 强制朝左、贴左缘强制朝右、散开点再走一套径向。每条规则都只对着当时那张
 * 布局成立——换个画布宽、换个点数、换几个长名字就又压上，于是每发现一种
 * 布局就得补一条规则。
 *
 * 这里换成通用做法（就是地图学里的 point-feature label placement）：
 *
 *  1. 每个标签按文字算出**占位盒**（SSR 量不了字，按全角/半角折算，确定性）；
 *  2. 围着点位生成一圈**候选位**（12 个方向 × 3 档距离 × 3 档文字长度），
 *     每个候选带一个偏好代价（横放优于竖放、近优于远、全名优于缩写，
 *     散开点偏好径向朝外）；
 *  3. 求解：先筛掉出画布和压图元的候选，再按「可选位最少的先排」逐个占位，
 *     取代价最低且不与已占盒相撞的那个。
 *
 * 于是「不压字」是**求解出来的结果**，不是某条规则的副作用——判据也就能写成
 * 一条与布局无关的不变量（任意布局下盒子两两不相交），由随机布局的用例来守，
 * 而不是每来一张截图补一条断言。
 *
 * 实在排不下的标签**不画**（序号还在，全名在左侧时间轴同一序号那行，
 * 另外每个点位都带 <title>）——宁可少一个名字，也不要两个名字叠在一起，
 * 后者是两个都读不出来。
 */

/** 与 guide.css 的 `.guide-minimap__name` 对齐——改那边的字号要回来改这里。 */
const LABEL_FONT = 11;
/** 图元避让半径：圆点 r=11，留 1 的描边余量。 */
const MARKER_R = 12;
/** 盒与盒之间至少留的空隙：贴着也算读不开。 */
const LABEL_GAP = 4;
/** 距离档位（在贴着图元的基础上再往外推）。 */
const LABEL_STEPS = [0, 10, 22] as const;
/** 候选方向数（每 30° 一个）。 */
const LABEL_DIRS = 12;

export interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedLabel {
  /** `<text>` 的落笔点：x 是盒心，y 是基线（textAnchor 恒为 middle）。 */
  x: number;
  y: number;
  text: string;
  /** 占位盒——碰撞判定与单测都只看它。 */
  box: LabelBox;
}

/**
 * 文字宽度估算。SSR 里没有测量能力，按全角/半角折算：中日韩、全角标点算一个
 * 字宽，其余算 0.55——宁可估宽一点，估窄了就是压字。
 */
export function textWidth(text: string, fontSize = LABEL_FONT): number {
  let units = 0;
  for (const ch of text) {
    units += /[\u1100-\u115F\u2E80-\u9FFF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch)
      ? 1
      : 0.55;
  }
  return units * fontSize;
}

/** 逐级缩短：全名 → 6 字 → 4 字。全名任何时候都在 `<title>` 里，不会丢。 */
export function labelVariants(name: string): string[] {
  const chars = [...name];
  const out = [name];
  for (const n of [6, 4]) {
    if (chars.length > n + 1) out.push(`${chars.slice(0, n).join("")}…`);
  }
  return out;
}

function boxesHit(a: LabelBox, b: LabelBox, gap = LABEL_GAP): boolean {
  return !(
    a.x + a.w + gap <= b.x ||
    b.x + b.w + gap <= a.x ||
    a.y + a.h + gap <= b.y ||
    b.y + b.h + gap <= a.y
  );
}

/** 两角之差（弧度），归到 [0,π]。 */
function angleGap(a: number, b: number): number {
  const d = Math.abs(((a - b) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
}

interface Candidate extends PlacedLabel {
  cost: number;
}

function candidatesFor(p: Placed, name: string): Candidate[] {
  const out: Candidate[] = [];
  const h = LABEL_FONT + 3;
  labelVariants(name).forEach((text, vi) => {
    const w = textWidth(text) + 2; // 描边（paint-order: stroke，3px）的余量
    LABEL_STEPS.forEach((extra, si) => {
      for (let d = 0; d < LABEL_DIRS; d += 1) {
        const a = (2 * Math.PI * d) / LABEL_DIRS;
        const ux = Math.cos(a);
        const uy = Math.sin(a);
        // 盒心推到刚好贴出图元之外：沿该方向的半径 = 盒在这个方向上的半长
        const dist = MARKER_R + LABEL_GAP + extra + Math.abs(ux) * (w / 2) + Math.abs(uy) * (h / 2);
        const cx = p.x + ux * dist;
        const cy = p.y + uy * dist;
        out.push({
          x: cx,
          // 基线：字号 11 时视觉中心约在基线上方 4
          y: cy + LABEL_FONT * 0.36,
          text,
          box: { x: cx - w / 2, y: cy - h / 2, w, h },
          cost:
            vi * 60 + // 缩写是下策，能放全名就放全名
            si * 5 + // 离得越远越难认是给谁的
            Math.abs(uy) * 3 + // 横放最好读
            (ux < 0 ? 0.5 : 0) + // 同等条件下朝右（顺阅读方向）
            // 散开簇：位置真相在簇心，标签朝外才不盖住簇里别的点
            (p.spreadAngle === undefined ? 0 : (angleGap(a, p.spreadAngle) / Math.PI) * 6),
        });
      }
    });
  });
  return out.sort((x, y) => x.cost - y.cost);
}

/**
 * 给每个点位排一个不压字的标签位；排不下的返回 `null`（该标签不画）。
 *
 * @param items 要标名字的点位（顺序即渲染顺序，返回值一一对应）
 * @param markers 所有要避开的图元中心（含起点方块与没标名字的点）
 * @param w 画布宽（viewBox 单位）
 */
export function placeLabels(
  items: readonly { p: Placed; name: string }[],
  markers: readonly Pt[],
  w: number,
): Array<PlacedLabel | null> {
  const markerBoxes: LabelBox[] = markers.map((m) => ({
    x: m.x - MARKER_R,
    y: m.y - MARKER_R,
    w: MARKER_R * 2,
    h: MARKER_R * 2,
  }));
  const inCanvas = (b: LabelBox) => b.x >= 2 && b.y >= 2 && b.x + b.w <= w - 2 && b.y + b.h <= H - 2;

  // 先筛掉「怎么排都不行」的候选（出画布、压图元），剩下的按代价排好
  const feasible = items.map(({ p, name }) =>
    candidatesFor(p, name).filter(
      (c) => inCanvas(c.box) && !markerBoxes.some((m) => boxesHit(m, c.box, 0)),
    ),
  );

  // 可选位最少的先排：让最难安置的点先挑，比按序号排能多安置几个
  const order = items
    .map((_, i) => i)
    .sort((a, b) => feasible[a]!.length - feasible[b]!.length || a - b);

  const taken: LabelBox[] = [];
  const out: Array<PlacedLabel | null> = items.map(() => null);
  for (const i of order) {
    const pick = feasible[i]!.find((c) => !taken.some((t) => boxesHit(t, c.box)));
    if (!pick) continue;
    taken.push(pick.box);
    out[i] = { x: pick.x, y: pick.y, text: pick.text, box: pick.box };
  }
  return out;
}

/**
 * 长段中点的方向箭头：落点与朝向都取自**画出来的那条曲线**（t=0.55 处的点与
 * 切向），不是两端点连线的中点与弦角度——理由见 `segmentBezier`。
 *
 * 入不入选仍按弦长判：弦短的段是原地绕，曲线再长也不值一个箭头。
 */
export function routeChevrons(pts: readonly Pt[]): Array<{ x: number; y: number; deg: number }> {
  const out: Array<{ x: number; y: number; deg: number }> = [];
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) < CHEVRON_MIN_SEG) continue;
    const { p, d } = bezierAt(segmentBezier(pts, i), 0.55);
    // 切向退化（两端点与控制点重合）时没有方向可言，宁可不画
    if (Math.hypot(d.x, d.y) < 1e-6) continue;
    out.push({ x: p.x, y: p.y, deg: (Math.atan2(d.y, d.x) * 180) / Math.PI });
  }
  return out;
}

/**
 * 走真实底图的最少**带坐标点位数**（见文件头）。
 *
 * 取 2 而不是 1：这一栏叫「单向游玩路线」，一个点连不成路线，
 * 真实底图上一枚孤零零的序号点并不比手绘示意图多说明什么。
 */
const MIN_AMAP_SPOTS = 2;

/**
 * 回退到手绘图的原因——**要在图上如实标注，不能只默默换一张图**。
 *
 * 手绘图与真实底图长得不一样，但没有一句说明时，车主只会把示意布点当成真实
 * 方位来看（"照着图往东边走"）。标注要回答的是"为什么这里不是地图"。
 *
 * 判定顺序 = 哪个原因**单独成立就已经画不出真实底图**：带坐标的点不够两个时，
 * 配没配 key、SDK 加载成不成功都改变不了结果，所以它排在最前。
 */
export type MiniMapFallbackReason = "few-located" | "amap-failed" | "unconfigured";

export function fallbackReasonOf(
  locatedCount: number,
  amapFailed: boolean,
  amapConfigured: boolean,
): MiniMapFallbackReason {
  if (locatedCount < MIN_AMAP_SPOTS) return "few-located";
  if (amapFailed) return "amap-failed";
  return "unconfigured";
}

/**
 * 文案只说得出根据的那部分。
 *
 * `few-located` 说"景点太小"——它的实际含义是这些点位在高德没有 POI 词条，
 * 冷门、小众、非正式地标就是这么回事；后半句限定这张图能读出什么，
 * 免得把示意顺序当方位。
 * `unconfigured` 是部署侧没配 key，跟这个景点大小无关，说"景点太小"就是编造
 * 原因，所以那一档不出注。
 */
const FALLBACK_NOTE: Record<MiniMapFallbackReason, string | undefined> = {
  "few-located":
    "景点太小无法加载地图 —— 下图是按游玩顺序画的示意路线，只表示先后，不表示真实方位与距离。",
  "amap-failed":
    "地图没能加载出来 —— 下图是按游玩顺序画的示意路线，只表示先后，不表示真实方位与距离。",
  unconfigured: undefined,
};

export function GuideMiniMap({ spots, orderSource, origin, theme }: GuideMiniMapProps) {
  /*
   * 形态分派（2026-08-29 走查加高德底图；0830 走查把门槛从"全齐"改成"够两个"）：
   *  - ≥2 个点带真实坐标且高德已配 → 真实底图（GuideMiniMapAmap），北朝上；
   *  - 坐标不够 / 未配 key / 加载失败 → 本文件的程序化手绘小图（回退是默认路径）。
   * 没坐标的点**不进真实底图**：图上画的每个点都是真坐标，缺席的在图下列出来。
   */
  const [amapFailed, setAmapFailed] = useState(false);
  /** 没查到坐标的点位（带它在 spots 里的序号——序号要与图上、时间轴对得上）。 */
  const unplaced = spots
    .map((s, i) => ({ name: s.name, seq: i + 1, located: s.lat !== undefined && s.lon !== undefined }))
    .filter((x) => !x.located);
  const locatedCount = spots.length - unplaced.length;
  const amapConfigured = isAmapConfigured();
  const useAmap = locatedCount >= MIN_AMAP_SPOTS && !amapFailed && amapConfigured;
  /** 回退时给图配一句"为什么不是地图"；走真实底图时没有这句。 */
  const fallbackNote = useAmap
    ? undefined
    : FALLBACK_NOTE[fallbackReasonOf(locatedCount, amapFailed, amapConfigured)];
  /**
   * 自适应画布宽：按容器实际宽高比重算 viewBox 宽（高恒为 H）。
   * viewBox 比例与容器一致后 meet 不再留白，浅蓝底正好铺满整卡。
   * SSR/首帧用默认 W；面板隐藏时量到 0 直接忽略，别把画布归零。
   */
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [vbW, setVbW] = useState(W);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = (width: number, height: number) => {
      // 面板/窗口隐藏时会量到 0：直接忽略，别把画布归零
      if (width <= 0 || height <= 0) return;
      const next = Math.round(Math.min(Math.max((H * width) / height, MIN_W), MAX_W));
      // 8px 死区：滚动条出没等亚像素抖动不值得整图重投影
      setVbW((prev) => (Math.abs(prev - next) > 8 ? next : prev));
    };
    // 首次同步量一次：RO 的回调随渲染帧投递，页面在后台/隐藏时一帧都不来，
    // 首帧尺寸不能指望它（gBCR 强制布局，不依赖渲染管线）。
    const r0 = el.getBoundingClientRect();
    apply(r0.width, r0.height);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) apply(r.width, r.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { placed, hasOrigin } = useMemo(() => {
    if (orderSource === "geo" && spots.every((s) => s.lat !== undefined && s.lon !== undefined)) {
      const withOrigin = Boolean(origin && origin.lat !== undefined && origin.lon !== undefined);
      return { placed: spreadClusteredPoints(projectGeo(spots, origin, vbW), vbW), hasOrigin: withOrigin };
    }
    return { placed: spreadClusteredPoints(projectEditorial(spots.length, vbW), vbW), hasOrigin: false };
  }, [spots, orderSource, origin, vbW]);

  const [view, setView] = useState<ViewT>({ k: 1, tx: 0, ty: 0 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  /** 活跃触点（pointerId → 上次客户端坐标）：一指拖动平移，两指捏合缩放。 */
  const pointers = useRef(new Map<number, Pt>());
  const clipId = useId();

  // 画布宽变了（开页首量、拖窗口）：缩放语义整个失效，回整图最诚实
  useEffect(() => {
    setView({ k: 1, tx: 0, ty: 0 });
  }, [vbW]);

  const zoomAt = (p: Pt, factor: number) =>
    setView((v) => {
      const k = Math.min(Math.max(v.k * factor, MIN_K), MAX_K);
      const r = k / v.k;
      // 以 p 为不动点缩放：p 底下那个点位缩放前后停在原地
      return clampMiniMapView({ k, tx: p.x - r * (p.x - v.tx), ty: p.y - r * (p.y - v.ty) }, vbW);
    });

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setView((v) => {
        const p = clientToView(el, e.clientX, e.clientY, vbW);
        const k = Math.min(Math.max(v.k * Math.exp(-e.deltaY * 0.0015), MIN_K), MAX_K);
        const r = k / v.k;
        return clampMiniMapView({ k, tx: p.x - r * (p.x - v.tx), ty: p.y - r * (p.y - v.ty) }, vbW);
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [vbW]);

  if (spots.length === 0) return null;

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const el = e.currentTarget;
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    const s = viewScaleOf(el, vbW);
    const other = [...pointers.current.entries()].find(([id]) => id !== e.pointerId)?.[1];
    if (pointers.current.size >= 2 && other) {
      // 捏合：另一指不动点近似，距离比作缩放系数，中点位移作平移
      const oldDist = Math.hypot(prev.x - other.x, prev.y - other.y);
      const newDist = Math.hypot(cur.x - other.x, cur.y - other.y);
      if (oldDist > 0) {
        zoomAt(clientToView(el, (cur.x + other.x) / 2, (cur.y + other.y) / 2, vbW), newDist / oldDist);
      }
      setView((v) =>
        clampMiniMapView(
          { ...v, tx: v.tx + (cur.x - prev.x) / 2 / s, ty: v.ty + (cur.y - prev.y) / 2 / s },
          vbW,
        ),
      );
    } else {
      setView((v) =>
        clampMiniMapView({ ...v, tx: v.tx + (cur.x - prev.x) / s, ty: v.ty + (cur.y - prev.y) / s }, vbW),
      );
    }
    pointers.current.set(e.pointerId, cur);
  };

  const endPointer = (e: ReactPointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
  };

  const onDoubleClick = (e: ReactMouseEvent<SVGSVGElement>) =>
    zoomAt(clientToView(e.currentTarget, e.clientX, e.clientY, vbW), 1.6);

  // 视图变换只作用在**点位坐标**上（理由见文件头）：先变换再画线/箭头/标签，
  // 于是线宽、圆点、字号恒定，放大拉开的是点与点的距离。
  const { k, tx, ty } = view;
  const tPlaced: Placed[] = placed.map((p) => ({ ...p, x: tx + k * p.x, y: ty + k * p.y }));

  // hasOrigin 时 tPlaced[0] 是停车场，其后才是景点。
  const spotPts = hasOrigin ? tPlaced.slice(1) : tPlaced;
  const path = smoothPathD(tPlaced);

  // 长段中点的方向 chevron（按变换后的屏上距离算：放大后长段浮现，方向更清楚）；
  // 与 path 同源于 tPlaced，所以缩放平移后箭头仍钉在线上
  const chevrons = routeChevrons(tPlaced);

  // 标签排布：候选位 + 冲突求解（见上方「标签排布」一节）。避开的图元是**全部**
  // 点位，不只是要标名字的那些——起点方块同样会被名字盖住。
  const labels = placeLabels(
    spotPts.map((p, i) => ({ p, name: spots[i]!.name })),
    tPlaced,
    vbW,
  );

  if (useAmap) {
    return (
      <>
        <div className="guide-minimap-wrap" ref={wrapRef}>
          <GuideMiniMapAmap
            spots={spots}
            origin={origin}
            theme={theme}
            onFallback={() => setAmapFailed(true)}
          />
        </div>
        {/*
          缺席要说出来。图上少了两个序号而下面一句话都没有，车主只会当成
          "地图画漏了"——而真相是"这两个点没查到坐标"，两者该怎么处理完全不同。
          连线也要点明：它只经过图上这些点，不是完整游玩顺序。
        */}
        {unplaced.length > 0 && (
          // 整句用一个模板串，不靠 JSX 的文本节点拼：JSX 对表达式两侧的换行与缩进
          // 处理不一致（`}` 后的换行被吃掉、行间换行变成一个空格），中文里那一个
          // 多出来或少掉的空格是看得见的——「大石—— 没查到」「坐标、 位置」都是这么来的。
          <p className="guide-minimap__unplaced">
            {`未在图上标出：${unplaced.map((u) => `${u.seq} ${u.name}`).join("、")} —— ` +
              `没查到坐标、位置未校验，路线连线也不经过它们（游玩顺序以左侧时间轴为准）。`}
          </p>
        )}
      </>
    );
  }

  return (
    <>
      {fallbackNote && <p className="guide-minimap__fallback-note">{fallbackNote}</p>}
      <div className="guide-minimap-wrap" ref={wrapRef}>
        <svg
          ref={svgRef}
          className="guide-minimap"
          viewBox={`0 0 ${vbW} ${H}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`游玩路线小地图，${spots.length} 个点位按单向顺序连线，可缩放拖动`}
          // k=1 时留 pan-y：手机上摸着地图仍能滚页面；放大后地图接管手势
          style={{ touchAction: k > 1 ? "none" : "pan-y", cursor: k > 1 ? "grab" : "default" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onDoubleClick={onDoubleClick}
        >
          <defs>
            <clipPath id={clipId}>
              <rect width={vbW} height={H} rx={18} />
            </clipPath>
          </defs>
          <rect width={vbW} height={H} rx={18} className="guide-minimap__bg" />

          <g clipPath={`url(#${clipId})`}>
            {tPlaced.length >= 2 && (
              <>
                <path d={path} className="guide-minimap__route-halo" />
                <path d={path} className="guide-minimap__route" />
              </>
            )}

            {chevrons.map((c, i) => (
              <path
                key={`c${i}`}
                className="guide-minimap__chevron"
                d="M -5 -4.5 L 4 0 L -5 4.5"
                transform={`translate(${f(c.x)} ${f(c.y)}) rotate(${c.deg.toFixed(0)})`}
              />
            ))}

            {hasOrigin && (
              <g className="guide-minimap__origin" transform={`translate(${f(tPlaced[0]!.x)} ${f(tPlaced[0]!.y)})`}>
                <rect x={-11} y={-11} width={22} height={22} rx={7} />
                <text y={4.5} textAnchor="middle">停</text>
              </g>
            )}

            {spotPts.map((p, i) => {
              const s = spots[i]!;
              return (
                <g key={`${s.name}-${i}`} className="guide-minimap__stop" transform={`translate(${f(p.x)} ${f(p.y)})`}>
                  <circle r={11} className={`guide-minimap__dot${s.kind === "photo" ? " is-photo" : ""}`} />
                  {/* 全名始终在这里：标签缩写了、甚至没排下，悬停与读屏都还读得到 */}
                  <title>{`${i + 1} ${s.name}`}</title>
                  <text y={4} textAnchor="middle" className="guide-minimap__seq">
                    {i + 1}
                  </text>
                </g>
              );
            })}

            {/* 名字单独一层画在最后：它不属于任何一个点位的坐标系（位置是求解出来
                的绝对位），而且要压在圆点之上，否则密集处会被后画的点盖掉 */}
            {labels.map((lb, i) =>
              lb === null ? null : (
                <text
                  key={`n${i}`}
                  x={f(lb.x)}
                  y={f(lb.y)}
                  textAnchor="middle"
                  className="guide-minimap__name"
                >
                  {lb.text}
                </text>
              ),
            )}
          </g>
        </svg>

        <div className="guide-minimap__controls">
          <button
            type="button"
            aria-label="放大"
            disabled={k >= MAX_K}
            onClick={() => zoomAt({ x: vbW / 2, y: H / 2 }, 1.5)}
          >
            ＋
          </button>
          <button
            type="button"
            aria-label="缩小"
            disabled={k <= MIN_K}
            onClick={() => zoomAt({ x: vbW / 2, y: H / 2 }, 1 / 1.5)}
          >
            －
          </button>
          {k > MIN_K && (
            <button type="button" aria-label="复位" onClick={() => setView({ k: 1, tx: 0, ty: 0 })}>
              ⟲
            </button>
          )}
        </div>
      </div>
    </>
  );
}
