/**
 * 缓存详情里的地图（M-mem-cache-detail）：一张底图 + 若干带徽标的点 +（可选）一条连线。
 *
 * 形态照车机端的景区小地图（`clients/shared/ui/src/guide/GuideMiniMapAmap.tsx`）：
 * 序号圆徽标 + 名字小圆片、停车场方形「停」徽标、点位之间直连线。**只抄形态不 import**
 * （理由见 `./amap.ts` 文件头）。
 *
 * 三种退回都要**把坐标以文字给出**：没配 key / 脚本加载失败 / 一个点都没有。
 * 弹窗存在的意义是把缓存里的东西读出来，地图画不出来不该连坐标也一起消失。
 */

import { useEffect, useRef, useState } from "react";

import { coordText } from "./env-cache-format";
import { isAmapConfigured, loadAmap, type AMapMap } from "./amap";

export interface MapPoint {
  lat: number;
  lon: number;
  /** 徽标里的字：序号、「停」、「起」「终」…… */
  badge: string;
  /** 徽标旁的名字。 */
  label: string;
  kind?: "spot" | "photo" | "origin" | "pin" | "aux";
}

export interface CacheMapProps {
  points: MapPoint[];
  /** 按 points 顺序连成一条线（导览路线、行车路线）。 */
  path?: boolean;
  /** 额外的折线（路线规划的逐段坐标），与 `points` 无关。 */
  polyline?: Array<[number, number]>;
  height?: number;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function CacheMap({ points, path, polyline, height = 320 }: CacheMapProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [fallback, setFallback] = useState<string | undefined>(undefined);

  const pointsKey = JSON.stringify(points.map((p) => [p.lat, p.lon, p.badge]));
  const polyKey = polyline ? polyline.length : 0;

  useEffect(() => {
    setFallback(undefined);
    if (points.length === 0 && !polyline?.length) {
      setFallback("这条缓存里没有可以定位的坐标。");
      return;
    }
    if (!isAmapConfigured()) {
      setFallback("未配置高德 JS key（VITE_AMAP_JS_KEY），只给文字坐标。");
      return;
    }
    let map: AMapMap | undefined;
    let cancelled = false;
    void loadAmap()
      .then((AMap) => {
        if (cancelled || !hostRef.current) return;
        const first = points[0] ?? { lon: polyline![0]![0], lat: polyline![0]![1] };
        map = new AMap.Map(hostRef.current, {
          zoom: 13,
          center: [first.lon, first.lat],
          viewMode: "2D",
          mapStyle: "amap://styles/dark",
          // 聚焦到单个地点要看得见"周围是什么"，POI 留着；建筑体块在这个尺寸上只添噪
          features: ["bg", "road", "point"],
          resizeEnable: true,
        });
        map.setMapStyle?.("amap://styles/dark");
        map.setFeatures?.(["bg", "road", "point"]);

        const overlays: unknown[] = [];
        const anchors: unknown[] = [];
        const Pixel = AMap.Pixel;

        if (path && points.length >= 2) {
          overlays.push(
            new AMap.Polyline({
              path: points.map((p) => [p.lon, p.lat]),
              strokeColor: "#f5a623",
              strokeWeight: 4,
              strokeOpacity: 0.9,
              lineJoin: "round",
              lineCap: "round",
              showDir: true,
              zIndex: 50,
            }),
          );
        }
        if (polyline && polyline.length >= 2) {
          const line = new AMap.Polyline({
            path: polyline,
            strokeColor: "#4c8dff",
            strokeWeight: 5,
            strokeOpacity: 0.9,
            lineJoin: "round",
            lineCap: "round",
            showDir: true,
            zIndex: 40,
          });
          overlays.push(line);
          anchors.push(line);
        }

        points.forEach((p, i) => {
          const cls =
            p.kind === "origin"
              ? "cd-mark__badge cd-mark__badge--origin"
              : p.kind === "photo"
                ? "cd-mark__badge cd-mark__badge--photo"
                : p.kind === "aux"
                  ? "cd-mark__badge cd-mark__badge--aux"
                  : "cd-mark__badge";
          const badge = new AMap.Marker({
            position: [p.lon, p.lat],
            content: `<b class="${cls}">${escapeHtml(p.badge)}</b>`,
            anchor: "center",
            zIndex: 100 + i,
          });
          overlays.push(badge);
          anchors.push(badge);
          if (p.label) {
            overlays.push(
              new AMap.Marker({
                position: [p.lon, p.lat],
                content: `<span class="cd-mark__name">${escapeHtml(p.label)}</span>`,
                anchor: "top-center",
                ...(Pixel ? { offset: new Pixel(0, 15) } : {}),
                zIndex: 80 + i,
              }),
            );
          }
        });

        map.add(overlays);
        if (anchors.length === 1 && points.length === 1) {
          // 只有一个点时 fitView 会怼到最大级别贴脸；固定一个能看见街区的级别
          map.setZoomAndCenter(15, [points[0]!.lon, points[0]!.lat], true);
        } else {
          map.setFitView(anchors, true, [40, 40, 40, 40], 16);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setFallback(`地图加载失败：${err instanceof Error ? err.message : String(err)}`);
      });
    return () => {
      cancelled = true;
      try {
        map?.destroy();
      } catch {
        /* 销毁失败不影响关闭弹窗 */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointsKey, polyKey, path]);

  return (
    <div className="cd-map-wrap">
      {!fallback && <div ref={hostRef} className="cd-map" style={{ height }} aria-label="地图" />}
      {fallback && (
        <div className="cd-map-fallback">
          <p className="muted tiny">{fallback}</p>
          {points.length > 0 && (
            <ul className="cd-coord-list">
              {points.map((p, i) => (
                <li key={i}>
                  <b className="cd-mark__badge cd-mark__badge--inline">{p.badge}</b> {p.label || "（未命名）"}
                  <span className="mono muted"> {coordText(p)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
