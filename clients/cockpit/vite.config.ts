import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// envDir 指到仓库根：全仓只有一份 .env（.env.example 首行就是这么说的），
// 而 vite 默认只在自己的 root（clients/cockpit）下找。不指过去的话
// VITE_AMAP_JS_KEY 永远是 undefined，表现是"配了 key 但地图还是程序化底图"
// —— 一个不报错、只是悄悄回退的故障（M10-01）。
/*
 * 浏览器演示构建（ACR-049）：`VITE_WEB_SHIM=1` 时入口换成 web.html（它先装传输垫片再
 * import main），产物可挂在子路径下（`VITE_BASE=/mobile/` 这类）。
 * **缺省两项都不生效**：原生构建的入口仍是 index.html，base 仍是 "/"，
 * 产物里不含垫片——web.html 根本不在 rollup 的输入里。
 */
const WEB_SHIM = process.env.VITE_WEB_SHIM === "1";

/**
 * 把垫片用的 x-carlife-auth 翻回标准的 Authorization（与线上 nginx 做同一件事）。
 * 垫片不能直接发 Authorization——魔搭创空间的边缘把那个头保留给平台自己。
 * 开发期这里不翻，本机会 401 而线上正常，两边行为不一致正是最难查的那种。
 * 原生客户端不经过这个 proxy，对它没有影响。
 */
const viaGateway = {
  target: "http://localhost:8790",
  configure(proxy: { on(ev: "proxyReq", cb: (proxyReq: { setHeader(k: string, v: string): void }, req: { headers: Record<string, unknown> }) => void): void }) {
    proxy.on("proxyReq", (proxyReq, req) => {
      const v = req.headers["x-carlife-auth"];
      if (typeof v === "string" && v) proxyReq.setHeader("authorization", v);
    });
  },
};

export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? "/",
  envDir: "../../",
  server: {
    port: 1430,
    strictPort: true,
    // Compose 里的 Gateway 状态探针从容器访问宿主 Vite；绑定所有接口，
    // 否则只监听宿主 loopback，状态页会把实际运行的前端误报成 down。
    host: "0.0.0.0",
    allowedHosts: ["host.docker.internal"],
    // 浏览器走查形态（无 Rust 桥）用同源 /v1 代理到本机网关（M36-03）：
    // 网关没有 CORS 中间件（Tauri 下不需要），dev 里跨端口直连会死在预检上。
    // Tauri 客户端不走这条——它的网络在 Rust 侧（§2.2 C2）。
    // `/_AMapService` 是高德 SDK 的服务接口代理（ACR-019）——浏览器走查形态下
    // 同源转到本机网关，由它追加安全密钥。Tauri 客户端不走这条：它用的是
    // 端上设置里那个绝对网关地址（见各自 main.tsx 的 amapServiceHost）。
    proxy: { "/v1": viaGateway, "/_AMapService": "http://localhost:8790" },
  },
  build: {
    // 演示构建单独一个目录：别把 dist 覆盖了——原生的 tauri build 内嵌的是 dist
    outDir: WEB_SHIM ? "dist-web" : "dist",
    ...(WEB_SHIM ? { rollupOptions: { input: "web.html" } } : {}),
  },
});
