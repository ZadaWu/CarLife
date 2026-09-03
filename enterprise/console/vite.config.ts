import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `/console/*` 代理到网关，避免开发期 CORS；生产由部署层同源承载（M3-01）。
// 网关地址沿用仓库根 `.env` 的约定（与两个服务同源），已存在的环境变量优先。
function gatewayUrl(): string {
  if (process.env.CARLIFE_GATEWAY_URL) return process.env.CARLIFE_GATEWAY_URL;
  const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
  if (existsSync(rootEnv)) {
    const match = /^\s*CARLIFE_GATEWAY_URL\s*=\s*"?([^"\n]+)"?/m.exec(readFileSync(rootEnv, "utf8"));
    if (match) return match[1];
  }
  return "http://localhost:8790"; // 与 .env.example / dev.sh / 文档同一口径（M39-01）
}

const GATEWAY = gatewayUrl();

export default defineConfig({
  plugins: [react()],
  // envDir 指到仓库根：全仓只有一份 .env（与两个端同一约定）。控制台目前只读
  // `VITE_AMAP_JS_KEY`（记忆浏览的缓存详情地图，M-mem-cache-detail）。
  envDir: "../../",
  server: {
    port: 5173,
    strictPort: true,
    // Compose 里的 Gateway 状态探针从容器访问宿主 Vite；绑定所有接口，
    // 否则只监听宿主 loopback，状态页会把实际运行的前端误报成 down。
    host: "0.0.0.0",
    allowedHosts: ["host.docker.internal"],
    proxy: { "/console": { target: GATEWAY, changeOrigin: true } },
  },
  build: { outDir: "dist" },
});
