/**
 * 导览小地图的**真实底图**形态（2026-08-29 走查：加高德底图，点位落真实位置，
 * 方向与标准地图一致——即北朝上，由真实地图天然保证）。
 *
 * 与 `AmapTripLayer`（主页行程图）同一套底座（`map/amap-loader`），但轻得多：
 * 没有跟车、没有流动粒子、没有按天分段——景区内部是步行尺度，路线画**直连线**
 * 且不调驾车路径规划（园区里没有"驾车道路"，规划出来反而是错的）。
 * 方向用折线自带的 `showDir` 箭头表达单向。
 *
 * 回退仍是默认路径（M10-01 原则）：未配 key / 弱网加载失败 → `onFallback`，
 * 由 `GuideMiniMap` 退回程序化手绘小图。
 *
 * **坐标可以不齐**（0830 走查放宽了门槛，理由见 `GuideMiniMap` 文件头）：
 * 没坐标的点位在这里被**跳过**，不落到图上，也不进连线——真实底图上标猜的位置，
 * 比手绘示意图撒谎撒得更认真。跳过的那几个由 `GuideMiniMap` 在图下如实列出。
 *
 * ⚠️ **序号按点位在 `spots` 里的位置算，不是按落图的第几个**：
 * 跳过三个点之后重新从 1 数，图上的「3」会指向时间轴里的「5」——
 * 车主对着两处看的是同一份行程，序号对不上就是两份互相矛盾的说法。
 *
 * 同簇散开沿用两个先例（AmapTripLayer.spreadOffsets / GuideMiniMap.spreadClusteredPoints）：
 * **位置真相在原坐标，散开只为可读**——综合体点位共享坐标时按环形像素偏移让开，
 * 真实坐标上留一个小圆点承担位置真相。
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { GuideSpotItem } from "@carlife/shared";

import {
  isAmapConfigured,
  loadAmap,
  MAP_FEATURES_FOCUS,
  MAP_STYLE,
  type AMapInstance,
} from "../map/amap-loader";

export interface GuideMiniMapAmapProps {
  /**
   * 已按游玩顺序排好的**全部**点位（含没坐标的）。
   *
   * 传全量而不是先过滤：序号要按点位在这个数组里的位置算（见文件头），
   * 调用方先过滤的话这里就再也拿不到真序号了。
   */
  spots: GuideSpotItem[];
  origin?: { name: string; lat?: number; lon?: number };
  theme?: "light" | "dark";
  onFallback?: (reason: string) => void;
}

/** 同簇判定（度，≈40m）：景区综合体的点位常共享同一 POI 坐标。 */
const CLUSTER_DEG = 0.0004;
/** 簇内环形散开半径（屏幕像素）。 */
const RING_PX = 30;
/** fitView 的边距与最深缩放：整簇同点时不许怼到楼顶贴脸。 */
const FIT_AVOID = [40, 40, 40, 40];
const FIT_MAX_ZOOM = 17;

/**
 * 同簇环形像素偏移（纯函数，单测可断言）。与 GuideMiniMap.spreadClusteredPoints
 * 同一算法，只是输入是经纬度、输出是屏幕像素偏移：簇外点 [0,0] 不动，
 * 簇内成员按提交序沿小圆均布。
 */
export function spreadPixelOffsets(
  pts: ReadonlyArray<{ lat: number; lon: number }>,
): Array<[number, number]> {
  const clusters: { cLat: number; cLon: number; members: number[] }[] = [];
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i]!;
    const k = Math.cos((p.lat * Math.PI) / 180);
    const hit = clusters.find(
      (c) => Math.hypot((c.cLon - p.lon) * k, c.cLat - p.lat) < CLUSTER_DEG,
    );
    if (hit) {
      hit.members.push(i);
      hit.cLat += (p.lat - hit.cLat) / hit.members.length;
      hit.cLon += (p.lon - hit.cLon) / hit.members.length;
    } else {
      clusters.push({ cLat: p.lat, cLon: p.lon, members: [i] });
    }
  }
  const out: Array<[number, number]> = pts.map(() => [0, 0]);
  for (const c of clusters) {
    if (c.members.length < 2) continue;
    const n = c.members.length;
    c.members.forEach((idx, k) => {
      // 屏幕 y 轴朝下、起始角朝上，路线进簇后沿环转（与手绘版同语义）
      const a = -Math.PI / 2 + (2 * Math.PI * k) / n;
      out[idx] = [Math.round(RING_PX * Math.cos(a)), Math.round(RING_PX * Math.sin(a))];
    });
  }
  return out;
}

/**
 * 落图点位 + 它在 `spots` 里的序号（纯函数，单测可断言）。
 *
 * 抽出来是因为**它是这份改动里最容易错又最看不出来的一处**：覆盖物建在 effect 里，
 * SSR 测不到，序号错了页面照常渲染——图上标「3」而时间轴里那条是「5」，
 * 两处都言之凿凿。判据必须能在单测里钉住。
 */
export function locatedWithSeq(
  spots: readonly GuideSpotItem[],
): Array<{ s: GuideSpotItem; seq: number }> {
  return spots
    .map((s, i) => ({ s, seq: i + 1 }))
    .filter(({ s }) => s.lat !== undefined && s.lon !== undefined);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** 路线两层描边：白衬 + 琥珀主线（底图主干道也是橙色系，单层会融进路网）。 */
const ROUTE_LAYERS = [
  { color: "#ffffff", weight: 9, opacity: 0.9, zIndex: 59, showDir: false },
  { color: "#f5a623", weight: 5, opacity: 0.95, zIndex: 60, showDir: true },
] as const;

export function GuideMiniMapAmap({ spots, origin, theme = "light", onFallback }: GuideMiniMapAmapProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<AMapInstance | null>(null);
  const overlaysRef = useRef<unknown[]>([]);
  const [epoch, setEpoch] = useState(0);

  // 回调与数据走 ref，不进重建依赖（AmapTripLayer 同一条纪律：内联函数进依赖
  // 就是每次渲染销毁重建地图，覆盖物加到已销毁实例上直接白屏）。
  const onFallbackRef = useRef(onFallback);
  onFallbackRef.current = onFallback;
  const spotsRef = useRef(spots);
  spotsRef.current = spots;
  const originRef = useRef(origin);
  originRef.current = origin;

  /** 内容指纹：名字/类别/坐标不变就不重建覆盖物（引用变化不算变化）。 */
  const spotsKey = useMemo(
    () =>
      [
        origin && origin.lat !== undefined && origin.lon !== undefined
          ? `停|${origin.lat}|${origin.lon}`
          : "",
        ...spots.map((s) => `${s.name}|${s.kind ?? ""}|${s.lat}|${s.lon}`),
      ].join(";"),
    [spots, origin],
  );

  // ── 地图实例：只随主题重建 ──
  useEffect(() => {
    if (!isAmapConfigured()) {
      onFallbackRef.current?.("未配置 AMAP_JS_KEY");
      return;
    }
    let cancelled = false;
    loadAmap()
      .then((AMap) => {
        const host = hostRef.current;
        if (cancelled || !host) return;
        const first = spotsRef.current.find((s) => s.lat !== undefined && s.lon !== undefined);
        const map = new AMap.Map(host, {
          // center 必须显式给：不给时 AMap 异步 IP 定位，未就绪前 add 会抛（主图同款坑）
          center: [first?.lon ?? 116.4, first?.lat ?? 39.9],
          zoom: 15,
          mapStyle: MAP_STYLE[theme],
          // 景区内部视角：周边 POI/建筑是有用信息，取聚焦态那份要素（先例见 amap-loader）
          features: MAP_FEATURES_FOCUS,
          dragEnable: true,
          zoomEnable: true,
          scrollWheel: true,
          touchZoom: true,
          doubleClickZoom: true,
          keyboardEnable: false, // 容器 aria-hidden，可聚焦元素藏进去是无障碍错误
        });
        mapRef.current = map;
        map.on?.("complete", () => {
          if (cancelled) return;
          // 构造参数会静默失效（enforceBaseStyle 的教训），建图后再落一次
          try {
            map.setMapStyle?.(MAP_STYLE[theme]);
            map.setFeatures?.([...MAP_FEATURES_FOCUS]);
          } catch {
            /* 丢样式不丢地图 */
          }
          setEpoch((n) => n + 1);
        });
      })
      .catch((e: unknown) => {
        if (!cancelled) onFallbackRef.current?.(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      overlaysRef.current = [];
      mapRef.current?.destroy();
      mapRef.current = null;
    };
  }, [theme]);

  // ── 覆盖物：数据变化只换标注与视野，不重建地图 ──
  useEffect(() => {
    const map = mapRef.current;
    const AMap = typeof window !== "undefined" ? window.AMap : undefined;
    if (!map || !AMap) return;
    type MapFn = (...args: unknown[]) => void;

    if (overlaysRef.current.length) {
      (map.remove as MapFn | undefined)?.call(map, overlaysRef.current);
      overlaysRef.current = [];
    }

    // 带上原序号一起过滤：`seq` 是它在 spots 里的位置，图上标的就是它。
    const located = locatedWithSeq(spotsRef.current);
    if (located.length === 0) return;
    const o = originRef.current;
    const withOrigin = Boolean(o && o.lat !== undefined && o.lon !== undefined);

    const MarkerCtor = AMap.Marker as new (opts: Record<string, unknown>) => unknown;
    const PolylineCtor = AMap.Polyline as new (opts: Record<string, unknown>) => unknown;
    const PixelCtor = AMap.Pixel as (new (x: number, y: number) => unknown) | undefined;
    const overlays: unknown[] = [];

    // 单向路线：停 → 1 → … → n 直连线 + showDir 方向箭头（步行尺度不调驾车规划）
    const pathPts: Array<[number, number]> = [
      ...(withOrigin ? [[o!.lon!, o!.lat!] as [number, number]] : []),
      ...located.map(({ s }) => [s.lon!, s.lat!] as [number, number]),
    ];
    if (pathPts.length >= 2) {
      for (const l of ROUTE_LAYERS) {
        overlays.push(
          new PolylineCtor({
            path: pathPts,
            strokeColor: l.color,
            strokeWeight: l.weight,
            strokeOpacity: l.opacity,
            lineJoin: "round",
            lineCap: "round",
            showDir: l.showDir,
            zIndex: l.zIndex,
          }),
        );
      }
    }

    // 同簇散开：像素偏移（位置真相在原坐标，见文件头）；含起点一起归簇
    const allPts = [
      ...(withOrigin ? [{ lat: o!.lat!, lon: o!.lon! }] : []),
      ...located.map(({ s }) => ({ lat: s.lat!, lon: s.lon! })),
    ];
    const offsets = spreadPixelOffsets(allPts);

    /** 序号点 + 标签 +（被散开时）真实坐标小圆点。返回参与 fitView 的锚。 */
    const anchors: unknown[] = [];
    const addMark = (
      lon: number,
      lat: number,
      [ox, oy]: [number, number],
      badgeHtml: string,
      name: string,
      i: number,
    ) => {
      const spreadOut = ox !== 0 || oy !== 0;
      const badge = new MarkerCtor({
        position: [lon, lat],
        content: badgeHtml,
        anchor: "center",
        ...(PixelCtor ? { offset: new PixelCtor(ox, oy) } : {}),
        zIndex: 100 + i,
      });
      overlays.push(badge);
      anchors.push(badge);
      // 标签：散开成员沿环角放外侧（左右由方位定），普通点放序号点下方
      const label = spreadOut
        ? new MarkerCtor({
            position: [lon, lat],
            content: `<span class="guide-amark__name">${escapeHtml(name)}</span>`,
            anchor: ox >= 0 ? "middle-left" : "middle-right",
            ...(PixelCtor ? { offset: new PixelCtor(ox + Math.sign(ox || 1) * 16, oy) } : {}),
            zIndex: 80 + i,
          })
        : new MarkerCtor({
            position: [lon, lat],
            content: `<span class="guide-amark__name">${escapeHtml(name)}</span>`,
            anchor: "top-center",
            ...(PixelCtor ? { offset: new PixelCtor(0, 15) } : {}),
            zIndex: 80 + i,
          });
      overlays.push(label);
      if (spreadOut) {
        // 位置真相：散开后原坐标留个小圆点，否则序号在谎报位置
        overlays.push(
          new MarkerCtor({
            position: [lon, lat],
            content: `<i class="guide-amark__dot"></i>`,
            anchor: "center",
            zIndex: 70,
          }),
        );
      }
    };

    if (withOrigin) {
      addMark(
        o!.lon!,
        o!.lat!,
        offsets[0]!,
        `<b class="guide-amark__badge guide-amark__badge--origin">停</b>`,
        o!.name,
        0,
      );
    }
    located.forEach(({ s, seq }, i) => {
      const off = offsets[(withOrigin ? 1 : 0) + i]!;
      addMark(
        s.lon!,
        s.lat!,
        off,
        // 徽标写 `seq`（在 spots 里的位置）而不是 `i + 1`（落图的第几个）——见文件头。
        `<b class="guide-amark__badge${s.kind === "photo" ? " guide-amark__badge--photo" : ""}">${seq}</b>`,
        s.name,
        seq,
      );
    });

    (map.add as MapFn | undefined)?.call(map, overlays);
    overlaysRef.current = overlays;
    // 框住全部序号点；maxZoom 兜住"整簇同点"的病例（不带上限会怼到 20 级贴脸）
    (map.setFitView as ((...a: unknown[]) => void) | undefined)?.call(
      map,
      anchors,
      true,
      FIT_AVOID,
      FIT_MAX_ZOOM,
    );
  }, [spotsKey, epoch]);

  return <div ref={hostRef} className="guide-minimap-amap" aria-hidden="true" />;
}
