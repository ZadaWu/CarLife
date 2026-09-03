// mobile — 手机端 WebView 入口（HUD 为默认视图）
import React from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { configureAmap, configureLocationPort, configureNativeLocator } from "@carlife/ui";
import "@carlife/ui/styles";
import "./styles/app.css";
import { App } from "./app";
import { resolveTheme, setRootTheme, systemPrefersDark, watchRootTheme } from "./app/theme";
import { LoginGate } from "./features/auth";
import { createTauriLocationPort } from "./bridge/locationPort";
import { createTauriNativeLocator } from "./bridge/nativeLocator";

/**
 * 高德服务接口的代理地址（ACR-019）。
 *
 * 安全密钥不再进产物：前端只告诉 SDK「服务接口去这里要」，密钥由网关的
 * `/_AMapService/*` 追加（`enterprise/backend/gateway/src/http/amap-proxy.ts`）。
 *
 * 传函数而不是字符串，是因为 Tauri 下网关地址要经 `invoke` 异步取，
 * 而本文件是同步执行的；`loadAmap()` 会在注入 script 前 await 它一次。
 *
 * 两条形态：
 *   - Tauri：以**端上设置里生效的网关地址**为准（ACR-018 起端上只认识网关，
 *     用户在设置页配什么就走什么）。
 *   - 浏览器走查：同源 `/_AMapService`，由 vite 的 proxy 转到本机网关。
 *
 * 拿不到就回 undefined——loader 会照常加载地图，只是服务接口按未授权处理。
 * 在这里抛异常等于整张地图不显示，那是更坏的降级方向。
 */
async function amapServiceHost(): Promise<string | undefined> {
  const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!inTauri) return `${window.location.origin}/_AMapService`;
  const view = await invoke<{ effectiveUrl: string }>("get_gateway_settings");
  const base = view.effectiveUrl?.trim().replace(/\/+$/, "");
  return base ? `${base}/_AMapService` : undefined;
}

// 高德 JS API key（同 cockpit）：clients/shared/ui 自己不读环境变量，
// 它要能在 Vite 之外的环境里编译。没配 = 用程序化底图，与离线同一条路径。
// ⚠️ **只有 jsKey 在产物里，安全密钥没有**（ACR-019，同 cockpit）。
configureAmap({
  jsKey: import.meta.env.VITE_AMAP_JS_KEY ?? "",
  serviceHost: amapServiceHost,
  // 与 cockpit 同一套：手机端复用 clients/shared/ui 的行程图层，插件清单必须跟着，
  // 少了 AMap.Driving 会静默退回点到点直线（M13-09）。
  // AMap.Geolocation 是**定位这条线的前置条件**：它没随脚本加载进来时，
  // 定位会静默退到浏览器 `navigator.geolocation`——在国内网络下成功率低得多，
  // 而且那条路给的是 WGS-84，与这张底图差着一个坐标系。
  plugins: ["AMap.MoveAnimation", "AMap.Driving", "AMap.Geolocation"],
});

// 定位授权与地图视图接到 Rust（落盘在设备上）。不在 Tauri 里时返回 undefined，
// `clients/shared/ui` 自动退回 localStorage 版端口——浏览器走查照样是真开关。
configureLocationPort(createTauriLocationPort());

// 原生系统定位（tauri-plugin-geolocation）。**这是唯一会弹系统授权框的那条路**：
// WebView 里的 navigator.geolocation 在 Tauri 壳里恒定被 WebKit 拒掉
// （wry 没实现 geolocation 授权回调），详见 bridge/nativeLocator.ts 文件头。
// 不在 Tauri / 桌面端时返回 undefined，定位照旧走高德与浏览器两条路。
configureNativeLocator(createTauriNativeLocator());

/*
 * 主题必须在**渲染之前**落到 <html> 上。
 *
 * `App` 里那份 effect 管不到登录门——它挂在 LoginGate 里面，登录页上不执行。
 * 少了这一行，登录页就是「深色底 + color-scheme: light」，iOS 会照浅色画键盘
 * 与输入辅助条，底部顶出一条浅蓝横带（详见 app/theme.ts 的 setRootTheme）。
 *
 * 第二行管的是**停在登录页时**用户切系统深浅色：`App` 里那个 matchMedia 监听器
 * 同样挂在登录门里面，那会儿还不存在。不取消订阅——它和 document 同寿。
 */
setRootTheme(document.documentElement, resolveTheme(window.location.search, systemPrefersDark()));
watchRootTheme(document.documentElement, window.location.search);

/*
 * 视口指标上报（真机联调，只在容器里有 netdiag.on 时 Rust 侧才落盘）。
 * 报的是「布局视口 vs 可视视口 vs 屏幕」三者的高度，以及底部导航离屏幕底边的距离——
 * 真机 HUD 底部那条 body 背景色，只能靠这几个数分辨是"WebView 本身矮"还是
 * "键盘收起后 WebKit 没把布局视口还回来"。
 */
if ("__TAURI_INTERNALS__" in window) {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
    "padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)";
  document.body.appendChild(probe);
  const report = (tag: string) => {
    const vv = window.visualViewport;
    const cs = getComputedStyle(probe);
    const nav = document.querySelector(".hud-bottom-nav")?.getBoundingClientRect();
    const root = document.getElementById("root")?.getBoundingClientRect();
    const active = document.activeElement?.tagName ?? "-";
    const line =
      `${new Date().toISOString().slice(11, 19)} ${tag.padEnd(9)} ` +
      `inner=${window.innerWidth}x${window.innerHeight} ` +
      `vv=${vv ? `${Math.round(vv.width)}x${Math.round(vv.height)}@${Math.round(vv.offsetTop)}` : "-"} ` +
      `screen=${window.screen.width}x${window.screen.height} ` +
      `docEl=${document.documentElement.clientHeight} root=${root ? Math.round(root.height) : "-"} ` +
      `safe=${cs.paddingTop}/${cs.paddingBottom} ` +
      `navGap=${nav ? Math.round(window.innerHeight - nav.bottom) : "-"} ` +
      `scrollY=${Math.round(window.scrollY)} active=${active}`;
    void invoke("report_ui_metrics", { line }).catch(() => {});
  };
  report("load");
  window.visualViewport?.addEventListener("resize", () => report("vv-resize"));
  window.addEventListener("resize", () => report("resize"));
  window.addEventListener("focusin", () => report("focusin"));
  window.addEventListener("focusout", () => setTimeout(() => report("focusout"), 300));
  for (const t of [1000, 3000, 8000, 20000]) setTimeout(() => report(`t+${t / 1000}s`), t);
}

const el = document.getElementById("root");
if (!el) throw new Error("#root not found");
createRoot(el).render(
  <React.StrictMode>
    {/* 未登录时整个应用无一处可用（网关全 401），所以挡在最外层——
        让 HUD 先渲染再逐个报错，看起来像"服务挂了"（M48-02）。 */}
    <LoginGate>
      <App />
    </LoginGate>
  </React.StrictMode>,
);
