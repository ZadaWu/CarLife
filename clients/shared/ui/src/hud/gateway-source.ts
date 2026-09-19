/**
 * HUD 的网关数据源（施工单 M13-04 起在 cockpit；M65-02/01 上提到 `clients/shared/ui`，两端共用）。
 *
 * 取数函数由端注入，本文件不认识 Tauri——所以它能同时喂车机、手机与浏览器走查。
 */
import {
  tripDayIndex,
  tripPlanToHud,
  type DestinationHighlights,
  type HudSnapshot,
  type TripPlanListEntry,
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
  /**
   * 立即重拉一次（确认/取消动作完成后调，不等下个轮询周期）。
   *
   * 返回的 promise 在**这一跳落地之后**兑现（成功或失败都兑现），顶栏刷新按钮
   * 靠它决定转圈转到什么时候——不返回的话按钮只能按固定时长假转，
   * 网慢的时候图标已经停了数据还没到。
   *
   * `pretrip` 是「顺带按最新天气重算行前物品」的 opt-in，缺省 **false**：
   * 确认/取消之后的那次重拉是"把刚做的动作显示出来"，不是"又打开了一次 App"
   * （`hud-gateway-source.test.ts` 钉着这条）。顶栏那枚按钮是用户**明确要最新的**，
   * 所以它传 true——这正是它与 60 秒轮询的区别所在。
   */
  refresh(opts?: { pretrip?: boolean }): Promise<void>;
  /**
   * 选中某一程（M72-04）：主页此后展示它（地图、提示卡、出发卡都跟着切）。
   * 只在端上记、不落库、不改服务端「当前行程」的语义（出发导航仍按服务端首条）。
   * `null` = 回到当前行程。选中的那程在下一轮 `plans[]` 里不见了也回到当前。
   * 立即按上一次拉到的数据重投影，不等下一轮。
   */
  select(planId: string | null): void;
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
  /**
   * 活动行程列表（M72-04）：每项整份快照 + 最新核查。每次拉取都回调；
   * 老网关（回包没有 `plans`）给空数组，其余行为一字不变。
   */
  onPlans?: (entries: TripPlanListEntry[], currentPlanId?: string) => void;
}

/**
 * 这一跳**为什么**没成（2026-09-12）。
 *
 * # 401 不是"连不上"
 *
 * 车机拿的是车辆级凭证，本身不代表任何人（设计裁决 R4）。没做上车声明、
 * 或声明成了访客，`GET /v1/trip-plan/current` 一律 401——**服务端答了，而且答得很快**
 * （网关日志里 3～6 ms）。把它显示成「未连接」会把人支去查网络、查 Docker、查端口，
 * 而那些全是好的；2026-09-12 用户就是这么被支走的：「我的 mock 服务我自己在 docker 上
 * 运行了，但是点刷新按钮没用，依旧是断的」。
 *
 * 两者的**补救动作完全不同**，这才是必须分开的理由：连不上要重试，没身份要重新上车声明。
 * 对 401 重试一万次也还是 401，而刷新按钮长得像它能解决问题。
 */
export type HudSourceFailure = "unauthorized" | "unreachable";

/**
 * 判这次失败属于哪一类。判据是 Rust 侧 `NetError::Unauthorized` 的 `Display`
 * （`fetch_trip_plan` 把它原样 `to_string()` 交给 invoke 的 reject），
 * 以及浏览器那条路可能出现的裸 401 文本。认不出来的一律当"连不上"——
 * 那是更保守的一侧：它让人去查链路，而不是去怀疑自己没登录。
 */
export function hudSourceFailure(e: unknown): HudSourceFailure {
  const msg = e instanceof Error ? e.message : String(e);
  return /unauthorized|(^|\D)401(\D|$)/i.test(msg) ? "unauthorized" : "unreachable";
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

  /** 选中的行程（M72-04）与上一次拉到的回包——`select` 要能不发请求就重投影。 */
  let selectedPlanId: string | null = null;
  let lastBody: { plan: TripPlanSnapshot | null; plans: TripPlanListEntry[] } | undefined;

  /**
   * 此刻主页该展示哪一份（M73-02 改口径）：选中且仍在列表里的那份 → 否则**列表里第一条还没走完的**
   * （仓储排序：进行中 → 最近的未来 → 未定日期 → 已结束）→ 没有列表（老网关 / 无行程）才回落服务端「当前行程」。
   *
   * 首条而不是「当前行程」：后者是最新确认的那份，车主上周排的下个月行程会把本周正在走的挤下地图；
   * 而「出发」处置在服务端取的正是 `trip_plan_list` 首条——两边看到的必须是同一程。
   * 选中的行程不再在列表上（改掉 / 取消 / 结束）时回到首条，不挂着一份不存在的。
   *
   * 「还没走完」这一道（2026-09-16 走查）：`endDate` 列还空着的老行程走完了也留在活动列表里，
   * 而它的出发日最早、恰好排首条，于是默认展示的是一份**已结束**的行程——主页地图整块收起，
   * 看起来像地图坏了。仓储的排序已经把它们沉到末尾，这里再挑一次是因为端上还要面对
   * 没升级的服务端与老回包；两边是同一句话（第一条未结束的），所以「出发」取的仍是同一程。
   */
  const project = (body: { plan: TripPlanSnapshot | null; plans: TripPlanListEntry[] }) => {
    const chosen = selectedPlanId ? body.plans.find((p) => p.planId === selectedPlanId) : undefined;
    if (selectedPlanId && !chosen) selectedPlanId = null;
    const live = body.plans.find((p) => tripDayIndex(p.plan, today()) !== null);
    const raw = chosen ? chosen.plan : (live?.plan ?? body.plans[0]?.plan ?? body.plan);
    // 推荐页在这里补齐，之后 `plan` 只有一份——投影与 onPlan 不能看到两个版本。
    const plan = raw ? withStickyHighlights(raw) : null;
    const mapped = plan ? tripPlanToHud(plan, today(), base()) : null;
    /*
     * 整份快照交出去：地图标注/逐日切换吃它，不吃压缩过的 HudSnapshot。
     *
     * 已结束的那程 `tripPlanToHud` 判它"卡片收起"（mapped 为 null），可**车主自己点开的
     * 那一程照样交出去**（2026-09-16 走查：选中一份已结束的行程，地图停在装饰概览上）——
     * 点它就是为了看那一程的路线。没点就不交：回落的那份可能是几个月前走完的，
     * 交出去等于把上个月的行程一直挂在主页地图上。
     */
    opts.onPlan?.(mapped !== null || chosen !== undefined ? plan : null);
    // null = 没有可展示的行程——回落基线，不渲染空卡也不报错。
    onSnapshot?.(mapped ?? base());
  };

  const pull = async () => {
    const wantRefresh = refreshNext;
    refreshNext = false;
    try {
      const raw = await fetchPlanJson(wantRefresh);
      const body = JSON.parse(raw) as {
        plan: TripPlanSnapshot | null;
        home?: HomePlace;
        plans?: TripPlanListEntry[];
        currentPlanId?: string;
      };
      opts.onHome?.(body.home);
      const plans = Array.isArray(body.plans) ? body.plans : [];
      opts.onPlans?.(plans, typeof body.currentPlanId === "string" ? body.currentPlanId : undefined);
      lastBody = { plan: body.plan, plans };
      project(lastBody);
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
    refresh(opts) {
      if (opts?.pretrip) refreshNext = true;
      return pull();
    },
    select(planId) {
      selectedPlanId = planId;
      if (lastBody) project(lastBody);
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
