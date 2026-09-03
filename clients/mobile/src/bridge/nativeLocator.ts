/**
 * 原生系统定位（`tauri-plugin-geolocation` → CoreLocation / FusedLocationProvider）。
 *
 * # 为什么不能用 `navigator.geolocation`
 *
 * wry 的 `WKUIDelegate` 只实现了摄像头/麦克风的授权回调，**没有 geolocation
 * 那一条**。WebKit 在 delegate 不应答时直接 deny，所以 WebView 里的
 * `navigator.geolocation` 在 iOS / macOS 的 Tauri 壳里恒定失败，错误消息还偏偏是
 * WebCore 的字面量 "User denied Geolocation"——看起来像用户拒绝过，
 * 实际上系统授权框一次都没弹过，用户会去系统设置里找一个不存在的开关。
 *
 * 这个插件绕开 WebView 直接调原生定位，是**唯一**会真的弹系统授权框的那条路。
 *
 * # 授权要显式求一次
 *
 * 插件不会因为你调 `getCurrentPosition` 就自动申请。`prompt` / `prompt-with-rationale`
 * 时必须先 `requestPermissions`，否则拿回来的是一句权限错误——那又是一个
 * "看起来像被拒绝、其实根本没问过"的坏法。
 *
 * # 坐标系：这里给的是 WGS-84，不是高德那套
 *
 * CoreLocation 给 WGS-84，而底图是 GCJ-02，国内差着几十到一百多米。
 * 仓库的既定规矩是**不手写坐标转换**（`enterprise/backend/shared/tools/src/amap.ts`：
 * "转换错了比不转更难查"），所以这里走高德官方的 `AMap.convertFrom`；
 * 它不可用（离线 / 没配 key）时**不偷偷用原值冒充精确坐标**，
 * 而是把精度放大到 150 米——与 `acquire.ts` 里浏览器那条路同一处理。
 */
import { getCurrentPosition, checkPermissions, requestPermissions } from "@tauri-apps/plugin-geolocation";
import { loadAmap, isAmapConfigured, type NativeLocator, type RawLocationFix } from "@carlife/ui";

/** 未纠偏时报的精度下限（米）。见文件头「坐标系」一节。 */
const UNCONVERTED_ACCURACY_FLOOR_M = 150;

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** WGS-84 → GCJ-02，走高德官方接口。失败返回 `null`（调用方据此放大精度）。 */
async function toGcj02(lat: number, lon: number): Promise<{ lat: number; lon: number } | null> {
  if (!isAmapConfigured()) return null;
  try {
    const AMap = (await loadAmap()) as unknown as Record<string, unknown>;
    const convertFrom = AMap.convertFrom as
      | ((
          coords: [number, number],
          type: string,
          cb: (status: string, result: { info: string; locations?: Array<{ lat: number; lng: number }> }) => void,
        ) => void)
      | undefined;
    if (typeof convertFrom !== "function") return null;
    return await new Promise((resolve) => {
      // 别让一次转换把整条定位拖住：3 秒还没回来就按"没转成"处理。
      const timer = setTimeout(() => resolve(null), 3_000);
      convertFrom([lon, lat], "gps", (status, result) => {
        clearTimeout(timer);
        const p = status === "complete" && result.info === "ok" ? result.locations?.[0] : undefined;
        resolve(p ? { lat: p.lat, lon: p.lng } : null);
      });
    });
  } catch {
    return null;
  }
}

/**
 * 不在 Tauri 里（浏览器走查）返回 `undefined`——上层照旧走高德/浏览器两条路。
 * 桌面端也返回 `undefined`：插件只在 iOS/Android 存在，桌面调它必然报错。
 */
export function createTauriNativeLocator(): NativeLocator | undefined {
  if (!isTauriEnv()) return undefined;

  return async (precision): Promise<RawLocationFix> => {
    let perm = await checkPermissions();
    if (perm.location === "prompt" || perm.location === "prompt-with-rationale") {
      // 这一步才是那个"系统授权框"。用户点了不允许 → 下面按被拒处理。
      perm = await requestPermissions(["location"]);
    }
    if (perm.location !== "granted") {
      throw new Error(`系统未授权定位（当前：${perm.location}）——请到 iOS 设置 › 隐私与安全性 › 定位服务里打开`);
    }

    const pos = await getCurrentPosition({
      // 模糊档不启动 GPS 芯片：既然只要一公里量级，就没有理由为它耗电。
      enableHighAccuracy: precision === "precise",
      timeout: 10_000,
      maximumAge: 30_000,
    });

    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    const rawAccuracy = pos.coords.accuracy ?? 0;

    const gcj = await toGcj02(lat, lon);
    return gcj
      ? { ...gcj, accuracyM: rawAccuracy, source: "gps" }
      : // 没纠偏成：坐标原样带出去，但**不报系统给的那个精度**——
        // 报 5 米会让 UI 画一个 5 米的圈，而这个点本身就偏出一百多米。
        { lat, lon, accuracyM: Math.max(rawAccuracy, UNCONVERTED_ACCURACY_FLOOR_M), source: "gps" };
  };
}
