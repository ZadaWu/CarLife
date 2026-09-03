/**
 * HUD 真实地图底图（施工单 M10-01）。
 *
 * 它是 `<MapBackdrop>` 的**上位替换**，不是替代：未配 key、脚本加载失败、超时、
 * 非浏览器环境——任意一种都直接渲染既有的程序化 SVG 底图。
 *
 * **回退是默认路径，不是异常路径**：车机没网是常态，而 Brief §5/§7-2 要求底图
 * 任何时候都可辨识道路/水系/绿地，不得出现大面积纯白或纯黑。所以这里没有
 * "加载中显示空白"这一档——一开始就是程序化底图，真实地图**加载成功后才盖上去**。
 *
 * 视觉优先级同样照 Brief §6：底图低于生活环、助手、序号与提示卡，因此
 * 沿用 `.hud-map-backdrop` 的定位与 z-index，并按主题切换高德的明暗样式。
 */
import { useEffect, useRef, useState } from "react";

import { DEFAULT_MAP_VIEWPORT } from "@carlife/shared";

import { MapBackdrop } from "../hud/MapBackdrop";
import { bindViewportReporter } from "./viewport-report";
import {
  enforceBaseStyle,
  isAmapConfigured,
  loadAmap,
  MAP_FEATURES,
  MAP_STYLE,
  type AMapInstance,
} from "./amap-loader";

export interface AmapBackdropProps {
  theme?: "light" | "dark";
  /** 地图中心（默认深圳市中心）。出行规划落地后由行程数据驱动。 */
  center?: { lat: number; lon: number };
  zoom?: number;
  /**
   * 主动把镜头挪过去（点「定位」按钮那一路）。
   *
   * **与 `center` 走两条路是刻意的**：`center` 一变就重建地图实例（见下方 deps
   * 的注释），而"挪一下镜头"如果也重建，用户会看到底图闪一下白再回来。
   * 这里用 `setZoomAndCenter` 平移，实例不动。`nonce` 让"同一个位置再点一次"
   * 也能生效——否则第二次点定位（人没怎么动）什么都不会发生。
   */
  focus?: { lat: number; lon: number; zoom?: number; nonce: number };
  /**
   * 用户把地图拖/缩到哪儿了。上层拿它记住"屏幕上次停在哪"。
   *
   * **回调不要引起父组件重渲染并回喂 `center`**：那会变成"拖一下重建一次"。
   * `useMapViewport().remember` 就是按这条约定写的（只落盘，不进 state）。
   */
  onViewportChange?: (viewport: { lat: number; lon: number; zoom: number }) => void;
  /** 加载失败时回调，便于上层记录——**不弹提示**，用户不需要知道底图是哪一种。 */
  onFallback?: (reason: string) => void;
}

const DEFAULT_CENTER = { lat: DEFAULT_MAP_VIEWPORT.lat, lon: DEFAULT_MAP_VIEWPORT.lon };

/** 把镜头平移过去（带 400ms 动画：瞬移会让人分不清"地图跳了"和"我点错了"）。 */
function applyFocus(
  map: AMapInstance,
  focus: { lat: number; lon: number; zoom?: number },
  fallbackZoom: number,
): void {
  map.setZoomAndCenter?.(
    focus.zoom ?? map.getZoom?.() ?? fallbackZoom,
    [focus.lon, focus.lat],
    false,
    400,
  );
}

/** amap 资源请求安静这么久，视为瓦片到齐。 */
const TILE_QUIET_MS = 600;
/** 等待上限：弱网下永远不安静时也要显现，否则真实地图等于没接。 */
const TILE_MAX_WAIT_MS = 10_000;

export function AmapBackdrop({
  theme = "light",
  center = DEFAULT_CENTER,
  zoom = DEFAULT_MAP_VIEWPORT.zoom,
  focus,
  onViewportChange,
  onFallback,
}: AmapBackdropProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<AMapInstance | null>(null);
  const [ready, setReady] = useState(false);
  /**
   * 上抛回调走 ref。
   *
   * 直接进 effect 的 deps 会让"父组件每次渲染新建一个箭头函数"变成
   * **每次渲染重建一次地图**——而这条路上没有任何报错，只是底图一直在闪。
   */
  const viewportCb = useRef(onViewportChange);
  viewportCb.current = onViewportChange;
  /**
   * 最新的一次「挪镜头」请求。
   *
   * 地图是异步建起来的（脚本要下载），而定位按钮在那之前就能点——**点了之后
   * 那次定位不能就这么丢掉**：镜头没动，用户只会再点一次，还是没动。
   * 所以建图完成时补做一次。
   */
  const focusRef = useRef(focus);
  focusRef.current = focus;

  useEffect(() => {
    if (!isAmapConfigured()) {
      onFallback?.("未配置 AMAP_JS_KEY");
      return;
    }
    let cancelled = false;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    let observer: PerformanceObserver | undefined;
    let unbindReporter: (() => void) | undefined;

    function stopWatch() {
      if (quietTimer) clearTimeout(quietTimer);
      if (capTimer) clearTimeout(capTimer);
      observer?.disconnect();
      observer = undefined;
    }

    /**
     * 瓦片请求安静 QUIET_MS 后回调；最多等 MAX_WAIT_MS。
     *
     * **只认瓦片请求**（`get_tile` / 切片域名），不认 amap 的其它资源：
     * 第一版把 SDK 脚本、样式数据也算进去，于是脚本一到就开始倒计时，
     * 600ms 后瓦片还没开始下就把白底盖了上去——比不做还糟。
     *
     * 注：走查时截到的几张白图后来查明是浏览器面板被隐藏时 rAF 被节流导致的
     * **截图产物**，不是产品缺陷；但"complete 早于瓦片到齐"是实测事实，
     * 这个等待本身仍然有必要。
     */
    function watchTilesQuiet(done: () => void) {
      capTimer = setTimeout(done, TILE_MAX_WAIT_MS);

      // PerformanceObserver 在老 WebView 上可能没有——那就只留兜底延时，
      // 而不是因为缺一个 API 就永远不显现。
      if (typeof PerformanceObserver === "undefined") return;
      try {
        observer = new PerformanceObserver((list) => {
          const sawTile = list
            .getEntries()
            .some((e) => /get_tile|\.is\.autonavi\.com|vdata\.amap\.com/i.test(e.name));
          if (!sawTile) return;
          if (quietTimer) clearTimeout(quietTimer);
          quietTimer = setTimeout(done, TILE_QUIET_MS);
        });
        observer.observe({ type: "resource", buffered: true });
      } catch {
        observer = undefined;
      }
    }

    loadAmap()
      .then((AMap) => {
        const host = hostRef.current;
        if (cancelled || !host) return;
        const map = new AMap.Map(host, {
          center: [center.lon, center.lat],
          zoom,
          mapStyle: MAP_STYLE[theme],
          // 要素级裁剪（M13-09）：只留底色与路网。这一层是**生活环的背景**，
          // 满屏餐馆商场标注会盖过前景的 POI 贴纸与琥珀轨迹。见 MAP_FEATURES 注释。
          features: MAP_FEATURES,
          /*
           * 缩放与平移（M19-05 用户要求），与行程图层同一套。
           *
           * ⚠️ 这一层要单独提醒一句：主页的生活环是**固定构图**（HudScene 等比缩放、
           * 位置写死），它不跟着地图走。所以把底图拖走之后，环上的"出发→①→②"
           * 与底下的真实地理就对不上了——这不是 bug，是两套坐标系本来就没绑定。
           * 行程图层没有这个问题（标记锚在真实坐标上，跟着地图一起动）。
           * 若只想在行程视图里能拖，把这几项改回 false 即可，两层互不影响。
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
         * 地图动了 → 上抛（上层去抖后落盘）。订哪些事件、为什么订这么多，
         * 见 `viewport-report.ts` —— 那一份可以脱离 DOM 单测，这里只接一行。
         */
        unbindReporter = bindViewportReporter(map, zoom, (v) => {
          if (!cancelled) viewportCb.current?.(v);
        });

        // 建图之前点过「定位」的话，在这儿补上（见 focusRef 的说明）。
        const pending = focusRef.current;
        if (pending) applyFocus(map, pending, zoom);
        // 底色与要素再落一次——构造参数会静默失效，见 enforceBaseStyle 的注释。
        // 挂在 complete 上而不是这里立刻调：此刻样式数据还没回来，设了会被随后的
        // 初始化盖掉。这一层不用 complete 判显现（那是瓦片监听器的活），只借它的时机。
        map.on?.("complete", () => {
          if (!cancelled) enforceBaseStyle(map, theme);
        });

        // **显现时机不能靠猜。**
        //
        // `new AMap.Map()` 返回时地图还是白的，`complete` 事件也**早于瓦片到齐**
        // ——走查实测：construct 后不到 300ms 就 complete，而最后一个 `get_tile`
        // 的响应在 2.8~3.8s 才结束。此刻显现这一层，就是拿一块白盖住程序化底图，
        // 正是 Brief §5/§7-2 禁止的"大面积纯白"。
        //
        // 所以看**瓦片请求本身**：瓦片请求安静 QUIET_MS 之后才显现，
        // 并留 MAX_WAIT_MS 兜底（弱网下永远不安静时，宁可显示画了一半的地图，
        // 也不要永远停在程序化底图上）。
        const reveal = () => {
          if (cancelled) return;
          stopWatch();
          setReady(true);
        };
        watchTilesQuiet(reveal);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        onFallback?.(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
      stopWatch();
      unbindReporter?.();
      mapRef.current?.destroy();
      mapRef.current = null;
      setReady(false);
    };
    // theme 变化要重建地图（高德的 mapStyle 热切换在 2.0 上不稳定），
    // center/zoom 同理——它们在 HUD 上变化频率极低，重建的代价可以接受。
  }, [theme, center.lat, center.lon, zoom, onFallback]);

  /**
   * 主动挪镜头。**不重建实例**——重建会闪，而"定位到我"是个高频动作。
   * 地图还没建起来时这里什么都不做，由建图那一步补做（见 `focusRef`）。
   *
   * 这里**不需要**再往上抛一次视图：`useMapViewport().focusOn` 自己已经把
   * 目标记下来了。高德若同时发了 moveend，上层的去重（米级以下不算变化）
   * 会把它吃掉，不会写两遍盘。
   */
  useEffect(() => {
    if (!focus) return;
    const map = mapRef.current;
    if (map) applyFocus(map, focus, zoom);
  }, [focus, zoom]);

  return (
    <>
      {/* 程序化底图始终在最底下：真实地图没上来之前它就是底图，
          上来之后它被完全覆盖，用户看不到两层叠加。 */}
      <MapBackdrop />
      <div
        ref={hostRef}
        className="hud-map-backdrop hud-map-amap"
        data-ready={ready ? "1" : "0"}
        aria-hidden="true"
      />
    </>
  );
}
