/**
 * 车机端 HUD 快照契约（施工单 M1-03）
 *
 * `contracts` 是端云契约的唯一真相源。
 *
 * ⚠️ 可视化边界（Brief §4）：本契约**刻意不提供**以下字段，从类型层面杜绝越界展示——
 *   - Agent 推理链、工具调用细节；
 *   - 精确历史轨迹、同行人隐私；
 *   - VIN、维修档案、任何车辆控制入口；
 *   - 原始用车流水、驾驶评分；
 *   - 精确住址 / 工作地址 / 未授权日历内容。
 * 地点一律以「语义化名称」表达（如「亲子乐园」），不带地址。
 */

/**
 * 助手状态机五态（Brief §3.4）；不含任何“思考过程”文本。
 * M2-01 起唯一来源为 Rust 契约（`clients/shared/rust/carlife-core/src/contract/events.rs`），
 * 此处仅 re-export，语义与 M1-03 完全一致。
 */
import type { AssistantState } from "../generated/AssistantState";
export type { AssistantState };

import type { PoiKind } from "./poi-kind";

/**
 * 环境上下文：驱动助手服饰与提示卡物品类别，两者必须一致（Brief §3.3 §7-5）。
 *
 * # 值域与贴纸是**绑死**的（M20-05）
 *
 * 端上取图写的是 `sprites.weather[kind] ?? sprites.weather.sunny`——
 * 契约里多一个 kind 而贴纸没跟上，表现就是"那种天气永远显示太阳"且**零报错**。
 * 这正是 `rainy` 从 M1 起一直存在却从来没有过图的下场。
 * 所以加 kind 的顺序固定：**先有图 → 再进这张表**，`clients/shared/ui` 有一条对账测试守着。
 */
export const WEATHER_KINDS = ["sunny", "cloudy", "overcast", "rain", "snow", "haze"] as const;

export type WeatherKind = (typeof WEATHER_KINDS)[number];

/** 展示用短描述，`WeatherContext.label` 的唯一来源——与物品名同理，不接受调用方自带。 */
export const WEATHER_LABELS: Record<WeatherKind, string> = {
  sunny: "晴",
  cloudy: "多云",
  overcast: "阴",
  rain: "有雨",
  snow: "有雪",
  haze: "雾霾",
};

export function isWeatherKind(v: string): v is WeatherKind {
  return (WEATHER_KINDS as readonly string[]).includes(v);
}

export interface WeatherContext {
  kind: WeatherKind;
  /** 展示用短描述，例如「晴」。 */
  label: string;
}

/** 生活环节点。anchor 决定落位，name 为语义化地点名。 */
export interface TripNode {
  anchor: string;
  name: string;
  /**
   * 节点类型，仅用于展示分类（选贴纸），不含坐标或地址。
   * 新值域是贴纸品类 PoiKind；leisure/charging/rest/nature 是 M1 时代的旧语义，
   * mock 数据仍在用，HudScreen 的 KIND_SPRITE 负责把它们并进品类贴纸。
   */
  kind: PoiKind | "leisure" | "charging" | "rest" | "nature";
}

/** Brief §3.1：默认显示 3–5 个与当前行程相关的语义化地点。 */
export const MIN_TRIP_NODES = 3;
export const MAX_TRIP_NODES = 5;

export interface TripPlan {
  /** 出发锚点（家）。 */
  origin: TripNode;
  /** 途经与终点，按行程时间顺序排列，长度应落在 3–5。 */
  nodes: TripNode[];
  /** 已抵达的段数，驱动生活环亮度渐变。 */
  activeSegment: number;
}

/**
 * 实时能量读数（M27）。**三个变体互斥**，因为屏幕上它们必须长得不一样：
 *
 * - `battery` / `fuel`：这辆车烧什么由车辆档案决定，不由端上猜。给燃油车画
 *   一个电池图标、写"电量 63%"，是一句看起来完全正常的假话。
 * - `unavailable`：车机离线 / 未绑定 / 未接入。**必须与"真的很低"分得开**——
 *   把读不到显示成 0%，车主会立刻掉头去找充电桩。所以这一支不带数字。
 *
 * 放在 `shared` 而不是 `ui`：它是网关 `GET /v1/vehicles/:vin/energy` 的端上投影，
 * 属端云契约（§10 要点 6），组件库只是它的消费方之一。
 */
export type LiveEnergy =
  | { kind: "battery"; percent: number; rangeKm: number; charging: boolean }
  | { kind: "fuel"; percent: number; rangeKm: number }
  | { kind: "unavailable"; reason: string };

/** 出行能量摘要（只读，Brief §3.2）。 */
export interface EnergySummary {
  distanceKm: number;
  batteryPercent: number;
  requiredPercent: number;
  /**
   * 实时读数（M27）。缺席 = 还没读到（首帧）或这个环境没有那一路（浏览器走查），
   * 此时中段沿用 `batteryPercent` 这个基线值——**不显示"读不到"**，
   * 因为"没接"和"接了但断了"是两回事，只有后者值得报警。
   */
  live?: LiveEnergy;
}

/** 行前提示物品。icon 由端侧按主题解析，契约只给 key。 */
export interface TipItemRef {
  key: string;
  label: string;
}

/**
 * 行前物品全集：**key → 名字**（施工单 M20-02）。
 *
 * # 为什么名字必须查表，而不是让调用方自带
 *
 * `TipItemRef.label` 是自由字符串，于是谁都能往图标位上挂一句话——实际发生过：
 * 「先到酒店放行李再出发」被挂在水瓶图标上、当天的天气备注被挂在遮阳帽上，
 * 而去重保留先入者，真正的「水」「遮阳帽」反被顶掉（M20-01 的事故）。
 * 名字从 key 查出来之后，"图标下的字与图对不上"这件事在类型层面就没有入口了。
 *
 * # 这张表同时是**推荐的值域**
 *
 * `pretrip_items` 工具（M20-03）只能产出这里的 key；端上按 key 找贴纸。
 * 加物品的顺序是**先有贴纸、再进这张表、最后写推荐规则**——反过来做，
 * 卡上就会出现一个有名字没有图的格子。
 */
export const PRETRIP_ITEMS = {
  hat: { label: "遮阳帽" },
  sunscreen: { label: "防晒霜" },
  water: { label: "水" },
  umbrella: { label: "雨伞" },
  jacket: { label: "薄外套" },
  sunglasses: { label: "墨镜" },
  thermos: { label: "保温杯" },
  mask: { label: "口罩" },
} as const;

export type PretripItemKey = keyof typeof PRETRIP_ITEMS;

/** 快照里存的物品：**只存 key**，名字展示时查表。`reason` 仅供排障与轨迹，不上卡。 */
export interface PretripItemRef {
  key: PretripItemKey;
  reason?: string;
}

export function isPretripItemKey(key: string): key is PretripItemKey {
  return Object.prototype.hasOwnProperty.call(PRETRIP_ITEMS, key);
}

/** 未知 key 返回 undefined——调用方据此**跳过**这一格，而不是渲染一个没名字的框。 */
export function pretripItemLabel(key: string): string | undefined {
  return isPretripItemKey(key) ? PRETRIP_ITEMS[key].label : undefined;
}

/** key 列表 → 展示用物品（未知 key 直接丢弃，不上卡）。 */
export function tipItemsFromKeys(keys: readonly string[]): TipItemRef[] {
  const items: TipItemRef[] = [];
  for (const key of keys) {
    const label = pretripItemLabel(key);
    if (label !== undefined) items.push({ key, label });
  }
  return items;
}

/** Brief §3.3：每页最多 3 件。 */
export const MAX_ITEMS_PER_PAGE = 3;

// ── 目的地推荐（施工单 M32-02）────────────────────────────────────

/**
 * 一条推荐（一家店 / 一个打卡点）。
 *
 * `sourceUrl` **只有在工具那侧与搜索结果核对上时才有值**
 * （`enterprise/backend/shared/tools/src/destination-highlights.ts`：模型写的 URL 会被它自己改写）。
 * 契约里放 URL 而不是一个布尔 `hasSource`：出处要能被排障时核对，
 * 也要能在别的端上点开——车机不点，是端上的取舍，不是契约的。
 *
 * **没有 `sourceUrl` 的条目，展示层不许说任何"据某某"**——
 * 与 `pretrip_items` 的 `weatherAvailable=false` 时"不许说根据天气"同一条纪律。
 */
export interface HighlightEntry {
  name: string;
  /** 一行推荐理由（工具侧已限长）。 */
  note: string;
  sourceUrl?: string;
  sourceTitle?: string;
}

/** 一条拍照建议。`spot` 多数时候对应 `spots` 里的某个名字，但不强制。 */
export interface PhotoTipRef {
  spot: string;
  tip: string;
}

/**
 * 目的地推荐（M32-02）：到了那儿吃什么、拍哪儿。
 *
 * **它落在行程快照里**（M32-02 修订）：行程确认/变更后由 runtime 在后台算一次再写回
 * 那一行，所以从库里读出来就带着它。原先是"⑤环境缓存那一类、不落库、读时补齐"，
 * 而读时补齐只在带 opt-in 的那一跳有值——端上每 60 秒一轮的常规轮询会把这张卡
 * 擦掉一次（用户走查："有时候只能看到推荐物品"）。落库解决的正是这个。
 *
 * **改了目的地必须重算**：写回前会核对 `destination` 与行程一致，
 * 对不上的一律丢弃——把上一程的馆子挂到这一程不是过期，是错。
 *
 * 三段各自可以为空；**三段全空时上游根本不会造这个对象**（空卡比没有卡糟）。
 */
export interface DestinationHighlights {
  destination: string;
  /** 美食排行榜，已按排名排序。 */
  foods: HighlightEntry[];
  /** 网红打卡点。 */
  spots: HighlightEntry[];
  photoTips: PhotoTipRef[];
  /** 这份数据是什么时候算出来的（ISO）。排障用——它不落库，没有别的时间锚。 */
  computedAt: string;
}

/**
 * 提示卡的一页。**两种形态**（M32-02）：
 *
 * - 缺省 / `kind: "items"` —— 行前物品（M1-02 起的原始形态）；
 * - `kind: "highlights"` —— 目的地推荐（左榜单 / 右拍照建议）。
 *
 * `kind` 做成**可选**是为了老快照：它们没有这个字段，而"没有"正是它们现在的语义。
 * 刻意**不**把 `items` 改成可选再并列一个新字段——那样每个消费点都要判两次空。
 * 消费点一律走 `isHighlightsPage()`，不要自己 `"highlights" in page`。
 */
export type TipPage =
  | { kind?: "items"; items: TipItemRef[] }
  | { kind: "highlights"; highlights: DestinationHighlights };

export function isHighlightsPage(
  page: TipPage,
): page is { kind: "highlights"; highlights: DestinationHighlights } {
  return page.kind === "highlights";
}

/** 有没有值得上卡的东西。三段全空 = 没有，调用方据此**不造这一页**。 */
export function hasHighlights(h: DestinationHighlights | undefined): h is DestinationHighlights {
  return (
    h !== undefined && h.foods.length + h.spots.length + h.photoTips.length > 0
  );
}

/**
 * 推荐 → 一页；没有可展示的东西时 `undefined`（调用方据此不加这一页）。
 *
 * 造页这件事有**两个**调用方：行程投影（`tripPlanToHud`）与车机 devbar 的演示开关。
 * 各写一份的话，"三段全空不造页"这条纪律迟早只在一边成立。
 */
export function highlightsPage(h: DestinationHighlights | undefined): TipPage | undefined {
  return hasHighlights(h) ? { kind: "highlights", highlights: h } : undefined;
}

export interface TipsBlock {
  /** 场景化提醒句，例如「行前温馨提示」。 */
  headline: string;
  pages: TipPage[];
}

/**
 * 数据新鲜度（Brief §6 弱网降级 / §4 禁止把过期数据伪装为实时）。
 * stale=true 时端侧保留最近有效值并标记「数据更新中」，不得空白或全屏遮挡。
 */
export interface Freshness {
  stale: boolean;
  /** 最近一次有效更新时间的展示文本。 */
  updatedAt?: string;
}

export interface HudSnapshot {
  trip: TripPlan;
  energy: EnergySummary;
  tips: TipsBlock;
  weather: WeatherContext;
  assistantState: AssistantState;
  freshness: Freshness;
}

/** 把物品列表按每页 ≤ 3 件分页（Brief §3.3）。 */
export function paginateTipItems(items: TipItemRef[]): TipPage[] {
  if (items.length === 0) return [{ items: [] }];
  const pages: TipPage[] = [];
  for (let i = 0; i < items.length; i += MAX_ITEMS_PER_PAGE) {
    pages.push({ items: items.slice(i, i + MAX_ITEMS_PER_PAGE) });
  }
  return pages;
}

/** 运行时校验快照是否满足 Brief 的硬约束，返回问题列表（空数组表示通过）。 */
export function validateHudSnapshot(s: HudSnapshot): string[] {
  const errs: string[] = [];
  if (s.trip.nodes.length < MIN_TRIP_NODES || s.trip.nodes.length > MAX_TRIP_NODES) {
    errs.push(
      `行程节点数应为 ${MIN_TRIP_NODES}–${MAX_TRIP_NODES}，实际 ${s.trip.nodes.length}`,
    );
  }
  s.tips.pages.forEach((p, i) => {
    // 推荐页没有物品，"每页最多 3 件"这条对它不适用（M32-02）。
    if (isHighlightsPage(p)) return;
    if (p.items.length > MAX_ITEMS_PER_PAGE) {
      errs.push(`提示卡第 ${i + 1} 页物品数 ${p.items.length} 超过 ${MAX_ITEMS_PER_PAGE}`);
    }
  });
  if (s.trip.activeSegment < 0 || s.trip.activeSegment > s.trip.nodes.length) {
    errs.push(`activeSegment 越界: ${s.trip.activeSegment}`);
  }
  return errs;
}
