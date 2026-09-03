/**
 * 高德 JS API 2.0 的加载器（施工单 M10-01）。
 *
 * # 为什么是装配注入而不是读 import.meta.env
 *
 * 与 `enterprise/backend/shared/tools` 同一条规矩：组件库不读环境变量。key 由 app
 * （`clients/cockpit/src/main.tsx`）调 `configureAmap()` 传进来。这样 `clients/shared/ui`
 * 在 Vite 之外的环境（tsc、单测、Storybook）里也能编译。
 *
 * # 安全密钥走代理，JS key 走产物——两把 key 两条命（ACR-019）
 *
 * `securityJsCode` **不再进产物**。高德对生产环境给的形态是设
 * `_AMapSecurityConfig.serviceHost` 指向自己的代理，密钥留在代理侧；
 * 我们的代理是网关的 `/_AMapService/*`（`enterprise/backend/gateway/src/http/amap-proxy.ts`）。
 * M10-01 那条「POC 期直填、上线前改代理形态」的已知限制到此关闭。
 *
 * **JS key 仍然在产物里，而且没有办法不在**——下面拼的那个 script 标签必须带它，
 * 那是 SDK 的固有形态。它的安全性靠高德控制台的域名白名单，不靠我们。
 * 所以端上仍会连一次 `webapi.amap.com`，`client-isolation` 不变量为此留着
 * 唯一一条具名例外。别以为这个文件已经"干净"了。
 *
 * # 加载失败不是异常，是常态
 *
 * 车机可能没有网络。加载器把"没配 key / 脚本加载不出来 / 超时"三种情况
 * 统一表达成 reject，由 `<AmapBackdrop>` 回退到程序化底图——**回退是默认路径**。
 */

/**
 * 底图要素白名单（M13-09）：只留底色与路网，去掉 POI 点与建筑体块。
 *
 * 可选值：`bg` 底面 / `road` 路网 / `point` POI 点 / `building` 建筑。
 * 用户走查："高德地图显示的信息太多了，只需要和旅游出行相关的部分"。
 * 底图上的餐馆商场会和我们自己的标记/生活环抢注意力；
 * 路网必须留，否则看不出路线是怎么走的。
 *
 * ⚠️ **放在这里是因为它必须两处一致**：`AmapTripLayer`（行程图）与
 * `AmapBackdrop`（装饰底图）各建各的 map 实例，只改其中一个的后果是——
 * 主页没进行程模式时底图照样一片嘈杂，而改的人以为已经改完了（M13-09 走查实测）。
 * 新增任何 `new AMap.Map()` 都要带上它。
 */
export const MAP_FEATURES = ["bg", "road"] as const;

/**
 * **聚焦到单个地点时**的要素集合：在总览那份之上把 POI 点与建筑补回来。
 *
 * 上面那条"去掉 POI"的理由（信息太多、与行程标记抢注意力）只在**总览**成立。
 * 点开一个地点是为了看"它周围是什么"，而 `MAP_FEATURES` 下放到最大也只有
 * 灰底加几根路——**放大之后反而什么都看不到**，功能等于没做。
 * 所以聚焦态单独一份，退出聚焦（「回到全程」）时由 `enforceBaseStyle` 复位。
 */
export const MAP_FEATURES_FOCUS = ["bg", "road", "point", "building"] as const;

/**
 * 底图配色（M13-08 定，M13-09 收口到两层共用）。
 *
 * light 用**淡雅样式当"蒙版"**：高德默认样式（`normal`）的橙色高速与彩色轨交
 * 会淹掉前景的琥珀轨迹与 POI 贴纸。不能用 CSS 滤镜压——2.0 矢量引擎把
 * 覆盖物画在同一张 GL canvas 上，滤镜会连自己的路线一起压掉。
 *
 * ⚠️ 与 MAP_FEATURES 同理，**两层必须一致**：M13-08 只换了行程图层的样式，
 * 装饰底图仍停在 `normal`，于是主页默认视图照旧一片花花绿绿（M13-09 走查实测）。
 *
 * ⚠️⚠️ **这两项在 Tauri 端能否生效，取决于 `tauri.conf.json` 里的 `userAgent`**
 *（M19-05）。WKWebView 的默认 UA 下，高德 JS API 2.0 把底图降级成栅格
 * `AMap.TileLayer`，而**栅格瓦片既不吃 `mapStyle` 也不吃 `features`**——
 * 于是配了灰白样式却仍是彩色默认图、满屏 POI，且**全程零报错**：
 * `getMapStyle()`/`getFeatures()` 回读到的还是我们设的值，因为它们只是存下来了。
 * 排查时已排除：参数没设上、显现时机、第二个地图实例、WebGL 不可用
 *（实测 `gl=1 glc=1 r=Apple GPU`）、`viewMode:"3D"`。
 * 所以两个 src-tauri 的 `tauri.conf.json` 窗口配置里那行伪装成 Chrome 的
 *（别在块注释里写 `clients/<端>/src-tauri` 那种通配路径——星号加斜杠会把注释就地关掉，
 * 后面整段全被当成代码，tsc 报的却是十几行开外的语法错。这条就是这么坏过一次。）
 * `userAgent` 是这两个常量的**前置条件**，不是可有可无的调优——JSON 放不下注释，
 * 记在这里。新建 Tauri 端时要照抄那一行。
 */
export const MAP_STYLE = {
  light: "amap://styles/whitesmoke",
  dark: "amap://styles/dark",
} as const;

/**
 * 建图之后**把底色与要素再落一次**（M19-05 走查）。
 *
 * 构造参数里已经给过 `mapStyle` 与 `features` 了，这里为什么还要来一遍：
 * 车机窗口实测出现过「彩色默认底图 + 满屏 POI」——两项**同时**失效，
 * 而同一份代码在浏览器里跑出来是灰白的。关键证据是 POI 还在：`features`
 * 是纯客户端过滤、不发任何请求，它都没生效，说明那一份构造参数整体没落到实例上。
 *
 * 构造期传参属于"给了就默认生效"，而它失效时**没有任何报错**，
 * 表现是整张底图换了一张脸。所以这里改成建图后再显式设一次。
 *
 * ⚠️ **不做回读比较，无条件重设**：故障形态恰恰是 `getMapStyle()` 回读得到
 * 我们要的值、而画面上是默认样式。拿回读当判据会正好在出问题的那次跳过修复。
 *
 * 设不上就算了：底图观感不是功能，不能因为它让整层挂掉（回退底图另有其人）。
 */
export function enforceBaseStyle(map: AMapInstance, theme: keyof typeof MAP_STYLE): void {
  try {
    map.setMapStyle?.(MAP_STYLE[theme]);
    map.setFeatures?.([...MAP_FEATURES]);
  } catch {
    /* 同上：丢样式不丢地图 */
  }
}

/**
 * serviceHost 的解析方式。给字符串最简单；给函数是为了消除一个竞态——
 * Tauri 下网关地址要经 `invoke` 异步取，而 `configureAmap` 在 `main.tsx` 里
 * 是同步调的。`loadAmap()` 本来就是 async，在注入 script 前 await 一次，
 * 就不会出现"地图先加载、serviceHost 后到"的窗口。
 */
export type AmapServiceHost = string | (() => string | undefined | Promise<string | undefined>);

export interface AmapWebConfig {
  jsKey: string;
  /**
   * 高德服务接口的代理地址（形如 `http://<网关>/_AMapService`）。
   * 不给 = 不设 `_AMapSecurityConfig`，SDK 直连高德——那条路**没有安全密钥**，
   * 服务接口会被高德按未授权处理（地图能显示，路径规划这类会失败）。
   */
  serviceHost?: AmapServiceHost;
  /** JS API 版本，默认 2.0 */
  version?: string;
  /** 需要的插件，如 ["AMap.Driving"] */
  plugins?: string[];
  /** 脚本加载超时（毫秒）。车机弱网下宁可早点回退，也不要长时间空白 */
  timeoutMs?: number;
}

interface AMapNamespace {
  Map: new (container: HTMLElement, opts: Record<string, unknown>) => AMapInstance;
  [k: string]: unknown;
}

export interface AMapInstance {
  destroy(): void;
  /** `complete` 在**瓦片画完**时触发——构造函数返回时地图还是白的 */
  on?(event: string, handler: () => void): void;
  setFitView?(overlays?: unknown[]): void;
  add?(overlay: unknown): void;
  /** 见 `enforceBaseStyle`：两项都要建图后再设一次，构造参数不足以保证生效。 */
  setMapStyle?(style: string): void;
  setFeatures?(features: string[]): void;
  /** 解绑（见 `viewport-report.ts`：地图销毁前要把上抛摘掉）。 */
  off?(event: string, handler: () => void): void;
  /** 记住"屏幕停在哪"用（`AmapBackdrop.onViewportChange`）。2.0 返回 LngLat。 */
  getCenter?(): { lat: number; lng: number } | undefined;
  getZoom?(): number | undefined;
  /** 点击地点胶囊聚焦用。`immediately=false` + `duration` 才是带动画的推近。 */
  setZoomAndCenter?(
    zoom: number,
    center: [number, number],
    immediately?: boolean,
    duration?: number,
  ): void;
  [k: string]: unknown;
}

declare global {
  interface Window {
    AMap?: AMapNamespace;
    _AMapSecurityConfig?: { securityJsCode?: string; serviceHost?: string };
  }
}

let config: AmapWebConfig | undefined;
let loading: Promise<AMapNamespace> | undefined;

/**
 * 由 app 装配层调用。传空 key（未配置）等同于不接入——
 * **不要把空串传下去然后等高德报错**，那会在控制台留下一条误导性的鉴权失败。
 */
export function configureAmap(cfg: AmapWebConfig | undefined): void {
  if (!cfg?.jsKey?.trim()) {
    config = undefined;
    return;
  }
  config = cfg;
}

export function isAmapConfigured(): boolean {
  return config !== undefined;
}

/** 幂等加载：多个组件同时挂载只注入一次 script。 */
/**
 * 解析 serviceHost。函数形态的解析器**失败不抛**——拿不到代理地址只意味着
 * 服务接口会被高德按未授权处理（地图还能显示），而在这里抛出去等于
 * 整张地图不加载。降级的方向永远是"少点功能"而不是"整块空白"。
 */
async function resolveServiceHost(v: AmapServiceHost | undefined): Promise<string | undefined> {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v !== "function") return undefined;
  try {
    const out = await v();
    return out?.trim() || undefined;
  } catch (err) {
    console.warn("[amap] 代理地址解析失败，服务接口将按未授权处理", err);
    return undefined;
  }
}

export function loadAmap(): Promise<AMapNamespace> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("非浏览器环境"));
  }
  if (window.AMap) return Promise.resolve(window.AMap);
  if (loading) return loading;

  const cfg = config;
  if (!cfg) return Promise.reject(new Error("高德 JS API 未配置（AMAP_JS_KEY 为空）"));

  /*
   * 先 await 代理地址、再注入 script：`_AMapSecurityConfig` **必须在 script 之前**
   * 挂到 window 上，晚了不生效（而且不会报错，只是服务接口全部未授权）。
   * `loading` 在这一整段之前就被赋值，所以并发调用仍然共享同一个 promise。
   */
  loading = resolveServiceHost(cfg.serviceHost).then((host) => {
    if (host) window._AMapSecurityConfig = { serviceHost: host };
    return injectScript(cfg);
  });

  return loading;
}

/** 注入 script 标签并等它就绪。与代理地址无关的那一半，原样保留。 */
function injectScript(cfg: AmapWebConfig): Promise<AMapNamespace> {
  const version = cfg.version ?? "2.0";
  const timeoutMs = cfg.timeoutMs ?? 8_000;
  const src =
    `https://webapi.amap.com/maps?v=${encodeURIComponent(version)}` +
    `&key=${encodeURIComponent(cfg.jsKey)}` +
    (cfg.plugins?.length ? `&plugin=${encodeURIComponent(cfg.plugins.join(","))}` : "");

  return new Promise<AMapNamespace>((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.src = src;

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`高德 JS API 加载超时（${timeoutMs}ms）`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      // 失败后允许重试：清掉 promise 缓存，否则一次弱网会让这个页面永远没有地图。
      loading = undefined;
    }

    script.onload = () => {
      const ns = window.AMap;
      cleanup();
      if (ns) resolve(ns);
      else reject(new Error("高德 JS API 加载完成但 window.AMap 不存在"));
    };
    script.onerror = () => {
      cleanup();
      reject(new Error("高德 JS API 脚本加载失败（离线或域名白名单未配置）"));
    };

    document.head.appendChild(script);
  });
}
