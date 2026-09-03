/**
 * 采一次原始坐标。**三条路，按可用性顺次回退，一条都走不通就如实报错。**
 *
 * 1. **高德 `AMap.Geolocation`**（首选）：它自己会先试浏览器定位、失败再走
 *    IP 定位，在国内网络下比裸 `navigator.geolocation` 成功率高得多，
 *    而且返回的坐标已经是 GCJ-02，与我们这张地图同一套坐标系；
 * 2. **`navigator.geolocation`**：没配高德 key / 离线加载不出脚本时用它。
 *    ⚠️ 它给的是 WGS-84，与高德底图有几十到一百多米的系统性偏移——所以
 *    这条路上 `source` 记成 `network` 且**不声称米级精度**（见下方注释）；
 * 3. 都没有 → `throw`。**不编一个坐标**：编出来的位置和真实定位长得一模一样，
 *    而用户会照着它去开车。
 *
 * # 精确 / 模糊在这里只影响"要不要开高精度硬件"
 *
 * 真正的模糊化（网格取整）在 `applyPrecision`，由端口实现（Rust 或 localStorage）
 * 统一做。这里传 `enableHighAccuracy` 只是**别去启动 GPS 芯片**——模糊定位
 * 既然只需要一公里量级，就没有理由为它耗电、也没有理由向系统申请更高的权限。
 */
import type { LocationPrecision, LocationSource } from "@carlife/shared";

import { isAmapConfigured, loadAmap } from "../map/amap-loader";
import { getNativeLocator, type RawLocationFix } from "./port";

export interface AcquireOptions {
  /** 单次采集上限。车机弱网下宁可早点说"定位不到"，也不要一直转圈。 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;

/** 高德回调里的位置结果（只声明我们真正读的字段）。 */
interface AmapGeolocationResult {
  position?: { lat?: number; lng?: number; getLat?: () => number; getLng?: () => number };
  accuracy?: number;
  location_type?: string;
  message?: string;
  info?: string;
}

function readAmapPosition(result: AmapGeolocationResult): { lat: number; lon: number } | null {
  const p = result.position;
  if (!p) return null;
  const lat = typeof p.lat === "number" ? p.lat : p.getLat?.();
  const lon = typeof p.lng === "number" ? p.lng : p.getLng?.();
  return typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon)
    ? { lat, lon }
    : null;
}

/**
 * 高德的 `location_type` → 我们的来源标签。
 *
 * `ip` 那一档是**城市级**，精度动辄几公里。它照样是个有用的答案（"你大概在深圳"），
 * 但必须标出来——把它显示成一次定位，用户会以为屏幕上那个点就是他站的地方。
 */
function sourceOf(result: AmapGeolocationResult): LocationSource {
  const t = (result.location_type ?? "").toLowerCase();
  if (t === "ip") return "ip";
  if (t === "html5" || t === "sdk") {
    return (result.accuracy ?? Number.POSITIVE_INFINITY) <= 100 ? "gps" : "network";
  }
  return "network";
}

function viaAmap(precision: LocationPrecision, timeoutMs: number): Promise<RawLocationFix> {
  return loadAmap().then(
    (AMap) =>
      new Promise<RawLocationFix>((resolve, reject) => {
        const Geolocation = (AMap as unknown as Record<string, unknown>).Geolocation as
          | (new (opts: Record<string, unknown>) => {
              getCurrentPosition: (cb: (status: string, result: AmapGeolocationResult) => void) => void;
            })
          | undefined;
        // 插件没随脚本加载进来（`configureAmap` 的 plugins 漏了 "AMap.Geolocation"）：
        // 不是错误，交给下一条路。这种漏配的表现本来是"定位按钮永远转圈"。
        if (typeof Geolocation !== "function") {
          reject(new Error("高德定位插件未加载"));
          return;
        }
        const geo = new Geolocation({
          enableHighAccuracy: precision === "precise",
          timeout: timeoutMs,
          // 地址逆解析要另花配额，而我们只用坐标。
          needAddress: false,
          // 允许 IP 兜底：车机在地库里拿不到卫星，城市级答案好过没有答案。
          noIpLocate: 0,
          GeoLocationFirst: precision === "precise",
        });
        geo.getCurrentPosition((status, result) => {
          if (status !== "complete") {
            reject(new Error(result?.message || result?.info || "高德定位失败"));
            return;
          }
          const pos = readAmapPosition(result);
          if (!pos) {
            reject(new Error("高德定位返回了空坐标"));
            return;
          }
          resolve({
            ...pos,
            accuracyM: typeof result.accuracy === "number" ? result.accuracy : 0,
            source: sourceOf(result),
          });
        });
      }),
  );
}

function viaBrowser(precision: LocationPrecision, timeoutMs: number): Promise<RawLocationFix> {
  return new Promise<RawLocationFix>((resolve, reject) => {
    const geo = globalThis.navigator?.geolocation;
    if (!geo) {
      reject(new Error("本设备不支持定位"));
      return;
    }
    geo.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          // WGS-84 → GCJ-02 的偏移没在这里纠正，所以**不报系统给的那个精度值**：
          // 报 5 米会让 UI 画一个 5 米的圈，而这个点本身就可能偏出一百多米。
          accuracyM: Math.max(pos.coords.accuracy ?? 0, 150),
          source: "network",
        }),
      (err) => reject(new Error(err.message || "定位被拒绝或不可用")),
      { enableHighAccuracy: precision === "precise", timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}

/**
 * 采一次坐标。**调用方必须先确认已授权**——这里不查开关：
 * 端口的 `recordFix` 才是那道门（车机与手机各有一份 UI，门只该有一处）。
 */
function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function acquireRawFix(
  precision: LocationPrecision,
  options: AcquireOptions = {},
): Promise<RawLocationFix> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  /*
   * 每条路失败的原因都记下来，全都走不通时**一起抛**。
   *
   * 以前这里把前面几条的错 `catch {}` 吞掉、只抛最后一条，于是屏幕上永远
   * 只有一句「定位失败：User denied Geolocation」——那是**最后一条**路的错，
   * 而真正该看的是第一条为什么没成。排查时无从下手，只能靠猜。
   * 一条路成功就没人看得到这些原因，所以留着它们不花任何代价。
   */
  const reasons: string[] = [];

  // 0. 原生系统定位（手机端注入；见 port.ts 的 `NativeLocator`）。
  //    **排在最前**：只有它会弹系统授权框，也只有它给得出米级坐标。
  const native = getNativeLocator();
  if (native) {
    try {
      return await native(precision);
    } catch (e) {
      reasons.push(`系统定位：${reasonOf(e)}`);
    }
  }

  if (isAmapConfigured()) {
    try {
      return await viaAmap(precision, timeoutMs);
    } catch (e) {
      reasons.push(`高德定位：${reasonOf(e)}`);
    }
  }

  try {
    return await viaBrowser(precision, timeoutMs);
  } catch (e) {
    reasons.push(`浏览器定位：${reasonOf(e)}`);
    throw new Error(reasons.join("；"));
  }
}
