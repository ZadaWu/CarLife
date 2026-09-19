import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/*
 * 开发期把 `/v1/*` 代理到本机网关——与线上同一形态：
 * 线上是容器里的 nginx 反代（infra/modelscope/nginx.conf.template），
 * 开发期是 vite 的 proxy。两边都保证**浏览器眼里是同源**，
 * 所以这个页面永远不需要跨源、不需要网关支持 CORS，也不会撞混合内容。
 */
function gatewayUrl(): string {
  if (process.env.CARLIFE_GATEWAY_URL) return process.env.CARLIFE_GATEWAY_URL;
  const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
  if (existsSync(rootEnv)) {
    const match = /^\s*CARLIFE_GATEWAY_URL\s*=\s*"?([^"\n]+)"?/m.exec(readFileSync(rootEnv, "utf8"));
    if (match) return match[1];
  }
  return "http://localhost:8790";
}

const GATEWAY = gatewayUrl();

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      // SSE 要关代理侧缓冲，否则 token 会攒成一坨再吐，演示看不出"流式"
      "/v1": {
        target: GATEWAY,
        changeOrigin: true,
        /*
         * 与线上 nginx 做同一件事：把页面用的 x-carlife-auth 翻回标准的 Authorization。
         * 页面不能直接发 Authorization——魔搭把那个头保留给平台自己了（见 api.ts 顶部）。
         * 开发期这里不翻的话，本机一切正常而线上 403，两边行为不一致正是最难查的那种。
         */
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq, req) => {
            const v = req.headers["x-carlife-auth"];
            if (typeof v === "string" && v) proxyReq.setHeader("authorization", v);
          });
        },
      },
    },
  },
  build: { outDir: "dist" },
});
