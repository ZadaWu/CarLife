/**
 * 定位状态的读写口（装配注入）。
 *
 * # 为什么是注入而不是直接 invoke
 *
 * 与 `configureAmap` 同一条规矩：`clients/shared/ui` 不 import `@tauri-apps/api`，
 * 它要能在 Vite 之外的环境（tsc、node:test、浏览器走查）里编译并跑起来。
 * 两个端各自在 `main.tsx` 里把 Tauri 适配器注进来。
 *
 * # 缺省实现为什么不是"什么都不做"
 *
 * 车机端设置页对 Tauri-only 的偏好用的是"不可用就整组不渲染"，因为那些开关
 * 在浏览器里**根本没有对应的东西**。定位不一样：浏览器自己就有
 * `navigator.geolocation`，地图视图 `localStorage` 也存得下。所以缺省实现是
 * 一个 localStorage 版的真端口——走查时点开关是真的会生效，而不是一个假开关。
 *
 * 它同时是 Tauri 端的**兜底**：适配器注入失败（命令还没随版本发出去）时，
 * 功能退化成"这台设备上记得住"，而不是整块不可用。
 */
import {
  applyPrecision,
  DEFAULT_LOCATION_CONSENT,
  normalizeViewport,
  type LocationConsent,
  type LocationFix,
  type LocationPrecision,
  type LocationSource,
  type MapViewport,
} from "@carlife/shared";

/** WebView 侧采到的原始结果，尚未按粒度加工。 */
export interface RawLocationFix {
  lat: number;
  lon: number;
  accuracyM: number;
  source: LocationSource;
}

export interface LocationSnapshot {
  consent: LocationConsent;
  /** 上次屏幕停在哪。`null` = 没存过，调用方回落自己的默认中心。 */
  viewport: MapViewport | null;
  /** 最近一次定位结果。关掉定位时会被清掉。 */
  lastFix: LocationFix | null;
}

export interface LocationPort {
  getState(): Promise<LocationSnapshot>;
  setEnabled(enabled: boolean): Promise<LocationSnapshot>;
  setPrecision(precision: LocationPrecision): Promise<LocationSnapshot>;
  /** 记一次定位。**未授权必须 reject**——这道门在端口实现里，不在调用方。 */
  recordFix(raw: RawLocationFix): Promise<LocationFix>;
  getViewport(): Promise<MapViewport | null>;
  saveViewport(viewport: MapViewport): Promise<MapViewport | null>;
}

const STORAGE_KEY = "carlife.location.v1";

interface StoredShape {
  consent?: LocationConsent;
  viewport?: MapViewport | null;
  lastFix?: LocationFix | null;
}

function readStorage(): StoredShape {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as StoredShape) : {};
  } catch {
    // 隐私模式 / 配额满 / 上一版写的脏数据：一律按"没存过"，不让它拖垮页面。
    return {};
  }
}

function writeStorage(next: StoredShape): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 同上：丢的只是"跨重启保持"，本次会话内的状态已经生效 */
  }
}

function snapshotOf(stored: StoredShape): LocationSnapshot {
  return {
    consent: { ...DEFAULT_LOCATION_CONSENT, ...(stored.consent ?? {}) },
    viewport: normalizeViewport(stored.viewport),
    lastFix: stored.lastFix ?? null,
  };
}

/** localStorage 版端口。行为与 Rust 侧 `carlife_core::location` 逐条对齐。 */
export function createBrowserLocationPort(): LocationPort {
  const read = () => snapshotOf(readStorage());
  const commit = (next: LocationSnapshot) => {
    writeStorage({ consent: next.consent, viewport: next.viewport, lastFix: next.lastFix });
    return next;
  };
  return {
    async getState() {
      return read();
    },
    async setEnabled(enabled) {
      const cur = read();
      return commit({
        consent: { ...cur.consent, enabled, decidedAt: new Date().toISOString() },
        viewport: cur.viewport, // ← 关掉定位不清地图视图（见 shared/domain/location.ts 文件头）
        lastFix: enabled ? cur.lastFix : null,
      });
    },
    async setPrecision(precision) {
      const cur = read();
      return commit({
        consent: { ...cur.consent, precision, decidedAt: new Date().toISOString() },
        viewport: cur.viewport,
        // 降级到模糊时把已存的精确坐标一起降级，否则存储里还躺着刚才那个米级坐标。
        lastFix: cur.lastFix ? applyPrecision(cur.lastFix, precision) : null,
      });
    },
    async recordFix(raw) {
      const cur = read();
      if (!cur.consent.enabled) throw new Error("定位已停用");
      const fix = applyPrecision({ ...raw, at: new Date().toISOString() }, cur.consent.precision);
      commit({ ...cur, lastFix: fix });
      return fix;
    },
    async getViewport() {
      return read().viewport;
    },
    async saveViewport(viewport) {
      const clean = normalizeViewport(viewport);
      if (!clean) return read().viewport;
      const cur = read();
      commit({ ...cur, viewport: clean });
      return clean;
    },
  };
}

/**
 * 状态变更广播。
 *
 * **为什么必须有它**：`useLocation()` 会被多处同时用（设置页那一组开关、
 * HUD 右上角那个定位按钮），而车机端**切到设置页时 HUD 仍然挂着**
 * （`display:none`，为了切回来不丢状态机）。没有广播的话，用户在设置里
 * 打开定位、切回主页点那个按钮，按钮还停在挂载时读到的"已停用"，
 * 于是提示他"去设置里打开"——而他刚刚就是从那儿过来的。
 */
type LocationListener = (snapshot: LocationSnapshot) => void;
const listeners = new Set<LocationListener>();

export function subscribeLocationState(fn: LocationListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 由改动状态的那一方调用（`useLocation` 的三个写入口）。 */
export function publishLocationState(snapshot: LocationSnapshot): void {
  for (const fn of listeners) fn(snapshot);
}

/**
 * 「问系统要一次坐标」的注入口（`RawLocationFix`，尚未按粒度加工）。
 *
 * # 为什么这条也得注入
 *
 * 与 `LocationPort` 同一条规矩：`clients/shared/ui` 不 import `@tauri-apps/api`。
 * 端在自己的 `main.tsx` 里把实现注进来（手机端接 `tauri-plugin-geolocation`）。
 *
 * # 为什么非要有它——WebView 那条路在客户端里是死路
 *
 * wry 的 `WKUIDelegate` 只实现了摄像头/麦克风的授权回调，**没有 geolocation
 * 那一条**；WebKit 在 delegate 不应答时直接 deny，于是 `navigator.geolocation`
 * 在 macOS / iOS 的 Tauri 壳里恒定失败，错误消息还偏偏是 WebCore 的字面量
 * "User denied Geolocation"——看起来像用户拒绝过，实际上系统授权框一次都没弹。
 * 用户于是会去系统设置里翻一个根本不存在的开关。
 *
 * 注入了它，才有真正会弹系统授权框的那条路。没注入（浏览器走查、桌面端）
 * 就还是高德 / 浏览器两条路，行为一个字不变。
 */
export type NativeLocator = (precision: LocationPrecision) => Promise<RawLocationFix>;

let nativeLocator: NativeLocator | undefined;

/** 由 app 装配层调用。传 `undefined` = 没有原生定位（回到高德/浏览器两条路）。 */
export function configureNativeLocator(fn: NativeLocator | undefined): void {
  nativeLocator = fn;
}

export function getNativeLocator(): NativeLocator | undefined {
  return nativeLocator;
}

let injected: LocationPort | undefined;
let browserFallback: LocationPort | undefined;

/** 由 app 装配层调用（两个端各自的 `main.tsx`）。传 `undefined` = 回到缺省实现。 */
export function configureLocationPort(port: LocationPort | undefined): void {
  injected = port;
}

export function getLocationPort(): LocationPort {
  if (injected) return injected;
  browserFallback ??= createBrowserLocationPort();
  return browserFallback;
}

/** 端上有没有接真正的持久化（设置页据此措辞：是"这台车记住了"还是"这个浏览器记住了"）。 */
export function hasNativeLocationPort(): boolean {
  return injected !== undefined;
}
