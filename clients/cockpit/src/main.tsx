// cockpit — 车机端 WebView 入口（HUD 为默认视图）
import React from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { configureAmap, configureLocationPort } from "@carlife/ui";
import "@carlife/ui/styles";
import "./styles.css";
import { App } from "./App";
import { BoardingGate, LoginGate } from "./features/auth";
import { createTauriLocationPort } from "./bridge/locationPort";

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

// 高德 JS API 的 key 在这里注入（M10-01）——`clients/shared/ui` 自己不读环境变量，
// 它要能在 Vite 之外的环境里编译。vite 只注入 VITE_ 前缀的变量，所以 .env 里
// 除了服务端那把 AMAP_JS_KEY，还要有一份同值的 VITE_AMAP_JS_KEY。
//
// ⚠️ **只有 jsKey 在产物里，安全密钥没有**（ACR-019）：加载 SDK 的 script 标签
// 必须带 jsKey，那是 SDK 的固有形态，靠高德控制台的域名白名单兜；
// 安全密钥则已经收进网关代理。
//
// 没配 = 车机 HUD 用程序化底图，与离线时是同一条路径，不需要额外处理。
configureAmap({
  jsKey: import.meta.env.VITE_AMAP_JS_KEY ?? "",
  serviceHost: amapServiceHost,
  // 行程路线的流动粒子（M13-06）与真实道路路径规划（M13-09）。
  // 插件跟脚本一起注入；加载失败只丢动画/退回直线，不丢标注。
  // AMap.Geolocation 是**定位这条线的前置条件**：它没随脚本加载进来时，
  // 定位会静默退到浏览器 `navigator.geolocation`——在国内网络下成功率低得多，
  // 而且那条路给的是 WGS-84，与这张底图差着一个坐标系。
  plugins: ["AMap.MoveAnimation", "AMap.Driving", "AMap.Geolocation"],
});

// 定位授权与地图视图接到 Rust（落盘在设备上）。不在 Tauri 里时返回 undefined，
// `clients/shared/ui` 自动退回 localStorage 版端口——浏览器走查照样是真开关。
configureLocationPort(createTauriLocationPort());

const el = document.getElementById("root");
if (!el) throw new Error("#root not found");
/**
 * 车机形态下先过绑定与上车声明（M48-05）。
 *
 * 挡在 App 之前而不是塞进 App 里：未绑定/未声明时车机拿不到任何会话，
 * HUD 渲染出来也只会满屏报错——那看起来像"服务挂了"。
 * 私人身份与浏览器走查下 `BoardingGate` 自己返回 null，不拦。
 */
/**
 * 访客态的常驻标记（M49-04，F-56-06）。
 *
 * **播报会过去，标记不会**——中途上车的人也得知道现在读不到个人偏好。
 * 只在访客态渲染：非访客时多一条横幅是噪声。
 */
function GuestBadge() {
  return (
    <div className="cockpit-guest-badge" role="status">
      访客模式 · 不读取个人偏好与日历
    </div>
  );
}

function Root() {
  const [ready, setReady] = React.useState(false);
  const [guest, setGuest] = React.useState(false);
  /**
   * 上车声明建出来的会话（M50-02）。
   *
   * 车机是车辆级 token，`POST /v1/session` 必须显式声明谁在用（M48-05），
   * 所以**这道门是车机唯一能建出会话的地方**——把 sid 交给 App，
   * 否则懒建之后车机的第一句话没有会话可用。
   * 此前这里只取了 `guest`，`sessionId` 被丢掉，App 再自己建一个。
   */
  const [declaredSessionId, setDeclaredSessionId] = React.useState<string | undefined>(undefined);

  const onDeclared = React.useCallback((result: { sessionId: string; guest: boolean }) => {
    setGuest(result.guest);
    setDeclaredSessionId(result.sessionId);
    setReady(true);
    /*
     * 降级要说出来（AC-56-7）。静默降级的后果是用户以为助手"忘了他的偏好"，
     * 而那与"进了访客模式"在他眼里是两件完全不同的事。
     * 非访客不播报——每次上车都念一遍会让人把声音关掉。
     */
    if (result.guest) {
      void invoke("announce_downgrade", {
        text: "访客模式，不读取个人偏好与日历。",
      }).catch((err) => {
        /*
         * **不再静默吞掉**（M54-01）。浏览器走查里没有 Tauri，这里必然抛——
         * 那是预期的，所以不能让它把界面带崩；但**吞得一声不吭是另一回事**：
         * 2026-08-31 走查 W10「有横幅、没声音」，而这一行让"到底调没调成"
         * 完全无从查起。横幅照常在（它不依赖这次调用），错误照常打出来。
         */
        console.warn("[boarding] 降级播报没调成（浏览器走查里这是正常的）：", err);
      });
    }
  }, []);

  /**
   * 会话过期后再说话，服务端会要求重新声明谁在用——把门挂回来（M50-02）。
   *
   * **不静默重建**：车机上"谁在用车"是每次上车都要回答的问题，
   * 悄悄按上一个人继续，等于把 M48-05 那道门绕过去了。
   */
  const onNeedBoarding = React.useCallback(() => {
    setDeclaredSessionId(undefined);
    setReady(false);
  }, []);

  return (
    /*
     * 两道门的顺序（M54-06）：LoginGate 只拦 personal 角色（账号凭证），
     * BoardingGate 只拦 cockpit 角色（车辆凭证）——互斥，不会同时出现。
     * LoginGate 在外层是因为它还承担 G4 的"切成车机"出口：切完重载后
     * 它对 cockpit 角色放行，BoardingGate 接管。
     */
    <LoginGate>
      {!ready ? <BoardingGate onDeclared={onDeclared} /> : null}
      {ready && guest ? <GuestBadge /> : null}
      <App declaredSessionId={declaredSessionId} onNeedBoarding={onNeedBoarding} />
    </LoginGate>
  );
}

createRoot(el).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
