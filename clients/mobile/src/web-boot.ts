/**
 * 浏览器演示构建的入口（ACR-049）。**原生构建不经过这个文件**——
 * 它只被 `web.html` 引用，而 `web.html` 只在 `VITE_WEB_SHIM=1` 时才是构建入口；
 * `index.html` 与 `main.tsx` 一个字节都没动。
 *
 * 为什么必须单独一个入口、而不是在 main.tsx 顶上加几行：
 * main.tsx 在**模块求值期**就会判 `"__TAURI_INTERNALS__" in window`
 * （定位端口、视口探针、高德代理地址），而 ES 的 import 是提升的——
 * 写在 main.tsx 里的任何代码都跑在那些判断之后。垫片必须先装好，再去 import main。
 */

import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { browserMicPermission, createBrowserRecorder, installWebShim } from "@carlife/ui/web-shim";

declare global {
  interface Window {
    __CARLIFE_DEMO__?: { demoUser?: string; demoPassword?: string; amapJsKey?: string };
  }
}

const injected = window.__CARLIFE_DEMO__;

void installWebShim({
  mockIPC,
  emit,
  origin: window.location.origin,
  // 按住说话：浏览器采 16k PCM，交给网关既有的音频入口转写。需要 HTTPS 与麦克风授权——
  // 拿不到时界面如实显示「麦克风未授权」，不是静默失效
  recorder: createBrowserRecorder(),
  micPermission: browserMicPermission,
  /*
   * **手机端不出声，所以这里不给 speaker**（产品定调 2026-09-17；F-02-12 原本就是「车机播报 / 手机静默」）。
   * 手机常在公共场合，出声是打扰。原生手机端连 `carlife-tts` 依赖都没有、设置页也没有「播报」组；
   * 垫片当初两端抄了同一份装配，于是浏览器演示版成了唯一会自己念出来的手机端——
   * 那是这份垫片引入的偏离，不是产品意图。车机的 web-boot 保持接着，别「对齐」回来。
   *
   * 不传 = 这个环境不播报（`WebShimDeps.createSpeaker` 的契约），SSE 收尾的 idle 照常直出。
   */
  // 公开演示的账号本来就是公开的，安全性靠账号本身的权限与限流，不靠藏。
  // 线上值由容器的 /config.js 注入；这里的缺省只服务本机开发。
  credentials: { username: injected?.demoUser ?? "demo", password: injected?.demoPassword ?? "carlife-dev" },
  // 只存裸 token：nginx 侧补 "Bearer "（带空格的值在 cookie 里非法）
  setCookie: (token) => {
    document.cookie = token
      ? "carlife_auth=" + token + "; path=/; SameSite=Lax; max-age=900"
      : "carlife_auth=; path=/; max-age=0";
  },
}).then(() => import("./main"));
