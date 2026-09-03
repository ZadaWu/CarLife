/**
 * 控制台自己的高德 JS API 加载器（M-mem-cache-detail）。
 *
 * # 为什么不用 `clients/shared/ui` 那份
 *
 * ACR-020 的确认记录明写：共享目录跟着受众走，`clients/shared/ui` 只归车主端，
 * "有副作用的业务库永远不该同时被两侧依赖"。控制台要的只是"一张底图上落几个针"，
 * 为此把整个端侧组件库拉进企业侧，越过的是仓库的顶层边界。所以这里是一份
 * 六十行的最小实现，**只有 JS key、没有安全密钥代理**——服务接口（路径规划、
 * 搜索）在这里用不到，底图与覆盖物不需要它。
 *
 * # key 从哪里来
 *
 * `VITE_AMAP_JS_KEY`，与两个端同一把（根 `.env`，`vite.config.ts` 的 `envDir` 指到仓库根）。
 * JS key 本来就在端的产物里、靠高德控制台的域名白名单保护，控制台多一处引用不改变它的暴露面。
 * 没配 key 不是错误：`isAmapConfigured()` 为假，页面退回文字坐标。
 */

export interface AMapNs {
  Map: new (el: HTMLElement, opts: Record<string, unknown>) => AMapMap;
  Marker: new (opts: Record<string, unknown>) => unknown;
  Polyline: new (opts: Record<string, unknown>) => unknown;
  Pixel?: new (x: number, y: number) => unknown;
}

export interface AMapMap {
  add(overlays: unknown[]): void;
  destroy(): void;
  setFitView(overlays?: unknown[], immediately?: boolean, avoid?: number[], maxZoom?: number): void;
  setZoomAndCenter(zoom: number, center: [number, number], immediately?: boolean): void;
  setMapStyle?(style: string): void;
  setFeatures?(features: string[]): void;
}

declare global {
  interface Window {
    AMap?: AMapNs;
  }
}

const JS_KEY = (import.meta.env.VITE_AMAP_JS_KEY as string | undefined)?.trim() ?? "";

export function isAmapConfigured(): boolean {
  return JS_KEY.length > 0;
}

let loading: Promise<AMapNs> | undefined;

/** 幂等：多个弹窗先后打开只注入一次 script；失败清缓存，允许下次重试。 */
export function loadAmap(timeoutMs = 8_000): Promise<AMapNs> {
  if (window.AMap) return Promise.resolve(window.AMap);
  if (loading) return loading;
  if (!JS_KEY) return Promise.reject(new Error("未配置 VITE_AMAP_JS_KEY"));

  loading = new Promise<AMapNs>((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(JS_KEY)}`;
    const timer = setTimeout(() => {
      done();
      reject(new Error(`高德 JS API 加载超时（${timeoutMs}ms）`));
    }, timeoutMs);
    function done() {
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      loading = undefined;
    }
    script.onload = () => {
      const ns = window.AMap;
      done();
      if (ns) resolve(ns);
      else reject(new Error("脚本加载完成但 window.AMap 不存在"));
    };
    script.onerror = () => {
      done();
      reject(new Error("高德 JS API 脚本加载失败（离线，或 key 的域名白名单没有这个地址）"));
    };
    document.head.appendChild(script);
  });
  return loading;
}
