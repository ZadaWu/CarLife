import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// envDir 指到仓库根：全仓只有一份 .env（.env.example 首行就是这么说的），
// 而 vite 默认只在自己的 root（clients/cockpit）下找。不指过去的话
// VITE_AMAP_JS_KEY 永远是 undefined，表现是"配了 key 但地图还是程序化底图"
// —— 一个不报错、只是悄悄回退的故障（M10-01）。
export default defineConfig({
  plugins: [react()],
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
    proxy: { "/v1": "http://localhost:8790", "/_AMapService": "http://localhost:8790" },
  },
  build: { outDir: "dist" },
});
