/**
 * HUD 的网关数据源（施工单 M13-04 起在 cockpit；M65-02/01 上提到 `clients/shared/ui`，两端共用）。
 *
 * 取数函数由端注入，本文件不认识 Tauri——所以它能同时喂车机、手机与浏览器走查。
 */
import {
  tripPlanToHud,
  type DestinationHighlights,
  type HudSnapshot,
  type TripPlanSnapshot,
} from "@carlife/shared";

export interface HudDataSource {
  /** 订阅快照更新，返回取消订阅函数。 */
  subscribe(onSnapshot: (s: HudSnapshot) => void, onError: (e: Error) => void): () => void;
}

/**
 * 演示用常住地，与服务端 `DEFAULT_HOME` 同值（浙江杭州）。
 *
 * 浏览器里没有 Tauri invoke，也就没有网关那一路——不给 mock 源配一份的话，
 * **HUD 的默认落点在浏览器里永远走查不到**，只能看到内置的深圳坐标。
 * 值要与服务端一致：两边各写一个城市，走查过的和真机看到的就不是一回事。
 */
export const MOCK_HOME = { city: "浙江杭州", lat: 30.2741, lon: 120.1551 };

/**
 * 真实数据源（施工单 M13-04）：轮询网关的已确认行程并映射成 HUD 快照。
 *
 * 通道是 **Rust 侧轮询 REST**（`fetch_trip_plan` 命令 → `GET /v1/trip-plan/current`），
 * 不建 SSE 新通道、不用 WS——行程变更频率是"分钟级、由一次确认触发"，
 * 为它建推送通道不成比例（设计文档已拍板；原设想的 /v1/hud/stream 留待
 * 有真实增量需求时再建）。网络在 Rust（§2.2 C2），WebView 只 invoke。
 *
 * 行为：订阅即拉 + 定时轮询；`refresh()` 供确认弹窗 resume 后立即刷新（M13-05）。
 * 没有可展示的行程（未确认/已取消/已过期）→ 推基线快照——"卡片收起"的落法。
 * 拉取失败 → onError（App 置 stale，保留最近有效快照，Brief §6）。
 */
export interface GatewayHudSource extends HudDataSource {
  /** 立即重拉一次（确认/取消动作完成后调，不等下个轮询周期）。 */
  refresh(): void;
}

export interface GatewayHudSourceOptions {
  /** 轮询间隔，默认 60s。 */
  intervalMs?: number;
  /** 基线快照：energy/weather 等不来自行程的部分（各端自己的 mock 快照）。 */
  base: () => HudSnapshot;
  /**
   * 取行程 JSON；`refreshPretrip` 为 true 时要求网关按最新天气重算（M20-06）。
   * **由端注入**（Tauri 里是 `invoke("fetch_trip_plan")`）：本包不 import `@tauri-apps/api`，
   * 否则它就不能在纯浏览器里用（两端 `bridge/index.ts` 文件头的理由）。
   */
  fetchPlanJson: (refreshPretrip?: boolean) => Promise<string>;
  /** 今天的本地日期（YYYY-MM-DD；测试注入）。 */
  today?: () => string;
  /**
   * 整份行程快照的出口（M13-06）：真实地图标注要的不止 HudSnapshot 的 5 个点。
   * 每次拉取都回调（无行程给 null）——App 据此驱动逐日切换与真实地图层。
   */
  onPlan?: (plan: TripPlanSnapshot | null) => void;
  /**
   * 车主常住地（M13-10）。**没有行程时 HUD 的地图落点**——与行程同一次轮询回来
   * （网关把两样一起给，见 gateway/http/trip-plan.ts 的说明）。
   * 网关没给就是 undefined，端上退回内置默认中心，不自己编一个城市。
   */
  onHome?: (home: HomePlace | undefined) => void;
}

/** 常住地。形状与网关返回一致，端上不重新拼。 */
export interface HomePlace {
  city: string;
  lat: number;
  lon: number;
}

function localToday(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * 目的地推荐的**跨轮询保持**（M32-02 的缺口）。
 *
 * 推荐落库之后（M32-02 修订）主路已经稳了，这一层是**兜底**：修订之前确认的老行程、
 * 以及后台那次没算成的行程，仍然只有带 `refreshPretrip=1` 的那一跳才有值，
 * 而那一跳只发生在首帧与切回前台。可这里**每一轮都从新拿到的 plan 重算整份快照**，
 * 于是推荐页的实际寿命是「首帧 → 下一次轮询」——最长 60 秒，之后自己消失，
 * 再切走切回来又冒出来。用户看到的就是"这张卡时有时无"。
 *
 * 所以端上把最近一次拿到的那份记住，按**目的地 + 出发日**认身份——
 * 与服务端环境缓存的键完全一致（`tools/src/destination-highlights.ts`），
 * 这样"沿用"沿用的正是服务端此刻会返回的同一份，不是自己造的旧数据。
 * 换了行程（改目的地 / 改出发日）立刻作废，不会把上一程的馆子挂到这一程。
 */
interface StickyHighlights {
  key: string;
  value: DestinationHighlights;
}

/** 身份键：与服务端 `envCacheKey("dest-highlights", [destination, date])` 同源。 */
function highlightsKey(plan: TripPlanSnapshot): string {
  return `${plan.destination}|${plan.startDate ?? "-"}`;
}

/**
 * 与服务端 `ENV_TTL.destinationHighlights` 同为 2 周（2026-09-02 随服务端从 24 小时改来）。
 *
 * 端上这份沿用不该比服务端那份活得更久——超了就当没有，让下一次 opt-in 去重算。
 * 车机不关机，没有这道闸的话一份推荐能在屏幕上无限期挂着。
 */
const HIGHLIGHTS_STICKY_MS = 14 * 24 * 60 * 60 * 1000;

function stickyStillValid(s: StickyHighlights, now: number): boolean {
  const at = Date.parse(s.value.computedAt);
  return Number.isFinite(at) && now - at < HIGHLIGHTS_STICKY_MS;
}

export function createGatewayHudSource(opts: GatewayHudSourceOptions): GatewayHudSource {
  const intervalMs = opts.intervalMs ?? 60_000;
  const base = opts.base;
  const fetchPlanJson = opts.fetchPlanJson;
  /*
   * "打开 App 时按最新天气重算"（M20-06）。
   *
   * 只有**首帧**与**从后台切回前台**那一次带 opt-in：物品是确认那一刻算的，
   * 出发前几天天气变了就该更新一次。而 60 秒一轮的常规轮询也带上它，
   * 等于把天气接口按分钟打——重算是读时的，不落库，多打没有任何收益。
   */
  let refreshNext = true;
  const today = opts.today ?? localToday;

  let onSnapshot: ((s: HudSnapshot) => void) | undefined;
  let onVisible: (() => void) | undefined;
  let onError: ((e: Error) => void) | undefined;
  /** 最近一次拿到的目的地推荐（见 StickyHighlights）。 */
  let sticky: StickyHighlights | undefined;

  /**
   * 补回推荐页：这一跳没要求重算（或重算没成）时，沿用上一次那份。
   * **只补这一个字段**，行程本身一字不动——库里那份才是用户批准过的。
   */
  const withStickyHighlights = (plan: TripPlanSnapshot): TripPlanSnapshot => {
    const key = highlightsKey(plan);
    if (plan.destinationHighlights) {
      sticky = { key, value: plan.destinationHighlights };
      return plan;
    }
    if (!sticky || sticky.key !== key || !stickyStillValid(sticky, Date.now())) return plan;
    return { ...plan, destinationHighlights: sticky.value };
  };

  const pull = async () => {
    const wantRefresh = refreshNext;
    refreshNext = false;
    try {
      const raw = await fetchPlanJson(wantRefresh);
      const body = JSON.parse(raw) as { plan: TripPlanSnapshot | null; home?: HomePlace };
      opts.onHome?.(body.home);
      // 推荐页在这里补齐，之后 `plan` 只有一份——投影与 onPlan 不能看到两个版本。
      const plan = body.plan ? withStickyHighlights(body.plan) : null;
      const mapped = plan ? tripPlanToHud(plan, today(), base()) : null;
      // 整份快照先交出去：地图标注/逐日切换吃它，不吃压缩过的 HudSnapshot。
      opts.onPlan?.(mapped ? plan : null);
      // null = 没有可展示的行程——回落基线，不渲染空卡也不报错。
      onSnapshot?.(mapped ?? base());
    } catch (e) {
      /*
       * 这一跳没成，"打开时重算"就还没发生——把 opt-in 还回去，下一次拉再带。
       * 不还的话：车机冷启动首拉恒 401（声明之前没有身份，见 cockpit App.tsx
       * 接管声明会话那段），重算随之永远丢失，出门前那次天气更新就没了。
       */
      if (wantRefresh) refreshNext = true;
      onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    refresh() {
      void pull();
    },
    subscribe(next, err) {
      onSnapshot = next;
      onError = err;
      /*
       * 车机不会"退出 App"，但会切走（导航/音乐）再切回来——那一次等同于"打开"。
       * 切回来时补一次重算：这正是"出门前看一眼"的时刻。
       */
      if (typeof document !== "undefined") {
        onVisible = () => {
          if (document.visibilityState === "visible") {
            refreshNext = true;
            void pull();
          }
        };
        document.addEventListener("visibilitychange", onVisible);
      }
      void pull();
      timer = setInterval(() => void pull(), intervalMs);
      return () => {
        clearInterval(timer);
        if (onVisible && typeof document !== "undefined") {
          document.removeEventListener("visibilitychange", onVisible);
          onVisible = undefined;
        }
        onSnapshot = undefined;
        onError = undefined;
      };
    },
  };
}
