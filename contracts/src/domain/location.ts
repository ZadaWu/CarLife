/**
 * 定位（GPS）契约：授权状态、一次定位结果、以及**与定位无关的**地图视图状态。
 *
 * # 为什么"授权"与"地图视图"写在同一个文件里
 *
 * 因为它们最容易被当成一件事，而它们恰恰不是：
 *  - **授权（`LocationConsent`）** 管的是"能不能知道你在哪"——关掉之后端上不再
 *    发起任何定位请求，已经存下的 `LocationFix` 也一并丢掉；
 *  - **地图视图（`MapViewport`）** 管的是"上次屏幕停在哪一格地图上"——它是
 *    用户自己拖出来的，**与他在哪没有关系**。所以关掉定位不能把它一起清掉：
 *    那会让"我只是不想被定位"变成"每次打开地图都回到深圳市中心"。
 *
 * 两者放在一起是为了让下一个改这里的人一眼看到这条分界，而不是在两个文件里
 * 各写一半、然后在某次"清理隐私数据"时顺手把视图也清了。
 *
 * # 单一真相源
 *
 * Rust 侧（`clients/shared/rust/carlife-core/src/location.rs`）持久化的是同一组结构，字段名
 * 经 serde `camelCase` 对齐本文件。常量（网格大小、缩放上下限）两侧各有一份，
 * 都在注释里互相注明——改一侧必须改另一侧，Rust 侧的单测钉着这几个数值。
 */

/**
 * 授权粒度。
 *
 * - `precise`：系统 GPS 的原始坐标，米级；导航、"我附近的充电桩"这类要它。
 * - `coarse`：**先按 {@link COARSE_GRID_DEG} 网格取整再交出去**，约 1 公里量级。
 *   它不是"精度差一点的 GPS"，而是一次**有意的信息丢弃**：足够回答"我在哪个区、
 *   今天这边天气怎么样"，但回答不了"我停在哪一栋楼下"。
 */
export type LocationPrecision = "coarse" | "precise";

/** 定位来源。用于如实告诉用户"这个位置是怎么来的"，不参与任何逻辑判断。 */
export type LocationSource = "gps" | "network" | "ip" | "manual";

export interface LocationConsent {
  /** 总开关。**默认关**——见 {@link DEFAULT_LOCATION_CONSENT}。 */
  enabled: boolean;
  precision: LocationPrecision;
  /** 用户最后一次做出选择的时刻（ISO）。没选过 = `undefined`，此时用的是默认值。 */
  decidedAt?: string;
}

export interface LocationFix {
  lat: number;
  lon: number;
  /** 水平精度（米）。`coarse` 下**不小于** {@link COARSE_MIN_ACCURACY_M}。 */
  accuracyM: number;
  /** 这个坐标是按哪一档授权交出来的。 */
  precision: LocationPrecision;
  source: LocationSource;
  /** 采集时刻（ISO）。 */
  at: string;
}

/** 屏幕上那块地图停在哪：中心 + 缩放。**与定位无关**，见文件头。 */
export interface MapViewport {
  lat: number;
  lon: number;
  zoom: number;
  /** 最后一次落定的时刻（ISO）。只用于排查，不参与恢复逻辑。 */
  at?: string;
}

/**
 * 模糊定位的网格边长（度）。0.01° ≈ 纬向 1.11 km、深圳纬度上经向 1.03 km。
 *
 * ⚠️ 与 `clients/shared/rust/carlife-core/src/location.rs` 的 `COARSE_GRID_DEG` 必须同值。
 */
export const COARSE_GRID_DEG = 0.01;

/**
 * 模糊定位对外声明的最小精度（米）。
 *
 * 取整到网格点后的最大偏差约 757 m（半个格子的对角线），这里报 1100 m 是
 * **宁可说得更不准**：把 757 报成 757 会让上层以为这是一次真实的米级测量。
 *
 * ⚠️ 与 Rust 侧 `COARSE_MIN_ACCURACY_M` 必须同值。
 */
export const COARSE_MIN_ACCURACY_M = 1100;

/** 地图缩放的上下限（高德 JS API 2.0 的有效区间是 [2, 20]，这里再收一档）。 */
export const MAP_ZOOM_MIN = 3;
export const MAP_ZOOM_MAX = 20;

/**
 * 没有任何历史时地图停在哪：深圳市中心。
 *
 * 与 `clients/shared/ui` 的 `<AmapBackdrop>` 共用这一份——此前那个默认中心写死在组件里，
 * 恢复视图这条线接上之后就会出现"两个默认中心"，而它们不一致时没有任何报错。
 */
export const DEFAULT_MAP_VIEWPORT: MapViewport = { lat: 22.5431, lon: 114.0579, zoom: 12 };

/**
 * 默认授权：**关，且粒度为模糊**。
 *
 * 默认开的话，用户第一次打开 App 就已经被定位了一次——"允许用户授权"这句话
 * 就成了摆设。默认粒度取模糊同理：用户点开开关时拿到的是更保守的那一档。
 */
export const DEFAULT_LOCATION_CONSENT: LocationConsent = { enabled: false, precision: "coarse" };

export function isValidLatLon(lat: unknown, lon: unknown): lat is number {
  return (
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/**
 * 把坐标吸附到 {@link COARSE_GRID_DEG} 网格点上。
 *
 * 用四舍五入而不是截断：截断会让整个格子里的点都偏向西南角，连续采样时
 * 表现为"位置总是往一个方向偏"，看起来像罗盘坏了。
 */
export function coarsenLatLon(lat: number, lon: number): { lat: number; lon: number } {
  const snap = (v: number) => Math.round(v / COARSE_GRID_DEG) * COARSE_GRID_DEG;
  // 先乘再除会留下 0.30000000000000004 这类尾巴，落进 JSON 很难看也难比对。
  const round2 = (v: number) => Number(snap(v).toFixed(6));
  return { lat: round2(lat), lon: round2(lon) };
}

/**
 * 按授权粒度加工一次原始定位结果。**所有交给上层的 fix 都必须过这一道**。
 *
 * 放在共享层而不是各端各写一遍，是因为"模糊定位其实交出了精确坐标"这种事
 * 不会有任何症状——除非有人去比对日志里的小数位。
 */
export function applyPrecision(
  raw: { lat: number; lon: number; accuracyM: number; source: LocationSource; at: string },
  precision: LocationPrecision,
): LocationFix {
  if (precision === "precise") {
    return { ...raw, precision, accuracyM: Math.max(0, raw.accuracyM) };
  }
  const { lat, lon } = coarsenLatLon(raw.lat, raw.lon);
  return {
    lat,
    lon,
    accuracyM: Math.max(raw.accuracyM, COARSE_MIN_ACCURACY_M),
    precision,
    source: raw.source,
    at: raw.at,
  };
}

/**
 * 校验并规范化一份"上次的地图视图"。
 *
 * 恢复视图的入参来自持久化文件 / localStorage，**它们都可能是上一版写的、
 * 被手改过的、或者半截的**。这里返回 `null` 表示"当它没存过"，调用方回落默认视图；
 * 绝不把 `NaN` 或 `zoom: 999` 交给地图——那会得到一张空白图，而空白图与
 * "地图没加载出来"长得一模一样。
 */
export function normalizeViewport(input: unknown): MapViewport | null {
  if (!input || typeof input !== "object") return null;
  const v = input as Record<string, unknown>;
  const { lat, lon, zoom } = v;
  if (!isValidLatLon(lat, lon)) return null;
  if (typeof zoom !== "number" || !Number.isFinite(zoom)) return null;
  const clamped = Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, zoom));
  const at = typeof v.at === "string" ? v.at : undefined;
  return { lat: lat as number, lon: lon as number, zoom: clamped, at };
}

/** 由一次定位结果得到"把镜头放到这里"的视图。zoom 缺省沿用当前档位。 */
export function viewportFromFix(fix: LocationFix, zoom = DEFAULT_MAP_VIEWPORT.zoom): MapViewport {
  return { lat: fix.lat, lon: fix.lon, zoom, at: fix.at };
}

/** 两个视图是否"实质相同"（避免把肉眼不可见的漂移写回存储）。 */
export function sameViewport(a: MapViewport | null, b: MapViewport | null): boolean {
  if (!a || !b) return a === b;
  // 1e-5 度 ≈ 1 米：比这更小的差异在任何缩放档位上都看不出来。
  return Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lon - b.lon) < 1e-5 && a.zoom === b.zoom;
}
