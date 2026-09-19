/**
 * 沿途服务点的地图标记（M93-05）。
 *
 * 与 `trip-marker.ts` 同一形态、同一理由：纯字符串拼接、不 `import "*.png"`——
 * 那是 Vite 的能力，`node --import tsx` 一 import 就炸。
 *
 * # 图标一套，两处用
 *
 * `SERVICE_ICON_PATHS` 是四类的 SVG path 数据：抽屉里由 `ServiceIcon` 渲染成 `<svg>`，
 * 地图这边拼进标记的 HTML。两处各画一套的话，地图上的闪电和格子里的闪电迟早长得不一样，
 * 而这一排格子与图上的点是**同一个开关的两端**，长得不像就等于开关没接上。
 *
 * # 它们是背景信息
 *
 * 服务点标记比行程胶囊小一档、不带名字气泡、不可点（`pointer-events:none`）。
 * 这一层回答的是"这附近有没有"，不是"去哪个"——给它加上点击弹窗，就会与行程胶囊抢同一个动作。
 *
 * 不可点也是它敢盖在胶囊上面的前提（`AmapTripLayer` 的 `zIndex: 150`）：
 * 压在胶囊下面时全程视野里一个点都露不出来，而盖上去又一个动作都不抢。
 */

import { escapeHtml } from "./trip-marker";

/** 四类沿途服务的键。与 `hud/trip-detail.ts` 的 `ServiceCategoryKey` 同一组值。 */
export type ServiceMarkerCategory = "charge" | "food" | "restroom" | "parking";

/**
 * 四类的 SVG path（`viewBox="0 0 24 24"`，描边画法，不填充）。
 *
 * `charge` 是电池 + 闪电：特斯拉车机用闪电表示充电桩，车主对这个形状有既成认知，
 * 换一个更"原创"的图形只会让人多看两秒。
 */
export const SERVICE_ICON_PATHS: Record<ServiceMarkerCategory, string> = {
  charge: "M7 4h7v16H7zM10 8l-1.5 4H12l-1.5 4M17 8v5a2 2 0 0 1-2 2",
  food: "M7 3v8a2 2 0 0 0 4 0V3M9 11v10M17 3c-1.5 1.5-2 3-2 5s.5 3 2 3v10",
  restroom:
    "M8 4.5a1.5 1.5 0 1 0 0-.01M6.5 20v-5H5l1.5-5h3L11 15H9.5v5zM16 4.5a1.5 1.5 0 1 0 0-.01M14 20l1-6h-1l2-5 2 5h-1l1 6z",
  parking: "M4 4h16v16H4zM9 16V8h3.5a2.5 2.5 0 0 1 0 5H9",
};

/** 标记根类名；四类各带一个修饰类，颜色在 `hud.css` 里给。 */
export const SERVICE_MARKER_CLASS = "hud-tripsvc";

export interface ServiceMarkerPoi {
  name: string;
  lat: number;
  lon: number;
}

/**
 * 名字标签**跟着缩放露出来**的门槛（地图缩放级别）。
 *
 * 2026-09-16 走查第四轮：「放大后没有展示出信息，不知道店名或者地点名称」。
 * 名字一直显示是不行的——一天四类最多 80 个点，全程视野下是一片糊字；
 * 而放大到看得清街道时，屏幕上通常只剩几个点，这时候名字才是有用的。
 *
 * 15 级 ≈ 一个街区连着几条路，比按天取景那一档（`DAY_FIT_MAX_ZOOM` 13）近两级：
 * 切到某一天先看"这一带有什么"，用户自己再推近才问"具体是哪家"。
 */
export const SERVICE_NAME_ZOOM = 15;

/** 地图容器在缩放过了门槛时挂的类；名字标签靠它露出来（CSS 在 hud.css）。 */
export const SERVICE_NAME_ON_CLASS = "hud-map--svcnames";

/**
 * 被碰撞消隐挤掉的那一枚标记挂的类（2026-09-16 走查第五轮：
 * 「很多沿途服务的地点集中在一个区域」）。
 *
 * 挂在**标记**上而不是标签上：藏的是名字，图标照常在图上——
 * 图标回答"这附近有几个"，藏掉就是谎报密度。判定本身在 `label-declutter.ts`。
 */
export const SERVICE_NAME_HIDDEN_CLASS = `${SERVICE_MARKER_CLASS}--noname`;

/**
 * 名字改摆到图标**上方**时挂的类（走查第六轮：名字压住了旁边那个点的图标）。
 *
 * 一个候选位是不够的：点位挤成一团时下方几乎必然被占，全都不摆等于名字又没了。
 * 给它上下两个位置，密集区里能摆下的数量翻一番还多。
 */
export const SERVICE_NAME_UP_CLASS = `${SERVICE_MARKER_CLASS}--nameup`;

/**
 * 名字与图标之间的间距（CSS 像素）。**必须与 `hud.css` 里那两条 `translate` 的 4px 一致**
 * ——上方那个候选位的盒子是算出来的（量一次只能量到 DOM 里当前那一边），算错就摆错。
 */
export const SERVICE_NAME_OFFSET = 4;

/**
 * 同屏最多摆几块名字。碰撞判定之外的第二道闸：点位散开时不会互相压，
 * 但二十几块白药丸铺满一屏同样不是信息。12 块≈一屏能一眼扫完的量。
 */
export const SERVICE_NAME_MAX = 12;

/** 两块名字之间至少留出的空隙（CSS 像素）；贴着就算压上，留一点才看得出是两块。 */
export const SERVICE_NAME_GAP = 4;

/**
 * 一个服务点的标记 HTML。
 *
 * 名字写进 `title` 与 `aria-label`（鼠标停上去、读屏都拿得到），同时带一个
 * **默认藏着**的标签：地图推近到 `SERVICE_NAME_ZOOM` 之后由容器上的
 * `SERVICE_NAME_ON_CLASS` 放出来。这一层的默认状态仍然是"一片安静的小圆点"。
 *
 * 标签跟着标记一起是纯 CSS 的事，不另开一层覆盖物——多一层就是多一批要
 * 增删、要跟着 mapEpoch 重建的东西，而它本来就该和图标同生共死。
 */
export function serviceMarkerHtml(poi: ServiceMarkerPoi, category: ServiceMarkerCategory): string {
  const name = escapeHtml(poi.name);
  return (
    `<div class="${SERVICE_MARKER_CLASS} ${SERVICE_MARKER_CLASS}--${category}"` +
    ` data-svc="${category}" title="${name}" aria-label="${name}">` +
    `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">` +
    `<path d="${SERVICE_ICON_PATHS[category]}" stroke-linecap="round" stroke-linejoin="round" />` +
    `</svg>` +
    `<span class="${SERVICE_MARKER_CLASS}__name" aria-hidden="true">${name}</span>` +
    `</div>`
  );
}
