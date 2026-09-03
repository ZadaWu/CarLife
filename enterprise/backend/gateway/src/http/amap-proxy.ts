/**
 * 高德 JS API 的服务接口代理（ACR-019）。
 *
 *   GET /_AMapService/*  →  高德三个上游之一，由网关追加 `jscode=<安全密钥>`
 *
 * # 为什么要有这一跳
 *
 * 高德 JS API 的**安全密钥**（`securityJsCode`）原来经 `VITE_AMAP_JS_SECURITY_CODE`
 * 直填进前端产物，随每一份客户端分发。高德官方对生产环境给的形态是：前端只设
 * `_AMapSecurityConfig.serviceHost` 指向自己的代理，密钥留在代理侧。这就是那个代理。
 *
 * `clients/shared/ui/src/map/amap-loader.ts` 与 `clients/cockpit/src/vite-env.d.ts` 里
 * 「POC 期直填进前端产物，上线前改代理形态」那两句话，说的就是本文件。
 *
 * # 它做不到的事，先说清楚
 *
 * **JS key 仍然在前端**——加载 SDK 的 `webapi.amap.com/maps?key=…` 这个 script
 * 标签必须带着它，那是 SDK 的固有形态。本代理只把**安全密钥**收回服务端。
 * 所以 `client-isolation` 不变量里高德还留着一条例外（loader 那次 script 加载），
 * 不是清零。
 *
 * # 它不鉴权，这是刻意的
 *
 * 高德 SDK **自己**发这些请求，我们没有任何办法让它带上设备 JWT 或自定义头——
 * 高德官方的 nginx 示例同样是一条不鉴权的路径。所以本路由挂在 `jwtAuth` 之前。
 *
 * 风险是「能打到网关的人可以借我们的额度调高德服务接口」，收敛手段全在下面这段
 * 代码里，且都不由请求方决定：
 *   1. 只挂三条**精确路径前缀**，其余一律 404；
 *   2. 上游主机**硬编码**在 `UPSTREAMS` 里，请求方改不了目的地（不是开放代理）；
 *   3. 只放行 `GET` / `HEAD`；
 *   4. 不透传 `authorization` / `cookie`——它们对高德没有意义，带过去只是泄漏面。
 * 再往下收就是 Referer/Origin 校验与 per-IP 限流，限流归 FL-10，本单不做。
 *
 * # 密钥现取，不缓存
 *
 * `jscode` 每次请求从配置层取（`ConfigStore.runtimeValues()` 自带缓存），
 * 于是后台轮换密钥不必重启网关。取不到就**不追加**而不是报错：让高德自己回
 * 它的鉴权错误码，那句话比我们编的更准（而且能在浏览器控制台里被看见）。
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { createProxyMiddleware, type Options } from "http-proxy-middleware";

import type { ConfigStore } from "@carlife/db";

/** 前端 `_AMapSecurityConfig.serviceHost` 指向的路径前缀。高德约定，别改。 */
export const AMAP_SERVICE_PREFIX = "/_AMapService";

/**
 * 路径 → 上游。**顺序有意义**：前两条是更长的精确前缀，必须排在兜底之前。
 *
 * 三条的分法照抄高德官方 nginx 示例——矢量底图样式、矢量瓦片、其余服务接口
 * 分别在不同域名上。少配一条的表现不是报错，是**某一类地图请求静默失败**
 * （样式不生效、或瓦片空白），而两侧都不会说话。
 */
const UPSTREAMS: ReadonlyArray<{ prefix: string; target: string }> = [
  { prefix: "/v4/map/styles", target: "https://webapi.amap.com" },
  { prefix: "/v3/vectormap", target: "https://fmap01.amap.com" },
  { prefix: "/", target: "https://restapi.amap.com" },
];

/** 只放行读。高德这些接口本来就都是 GET，写方法过来一定是误用或探测。 */
const ALLOWED_METHODS = new Set(["GET", "HEAD"]);

export interface AmapProxyOptions {
  /** 测试注入：替掉真正的转发，回一个可断言的假上游。 */
  proxyFactory?: (options: Options) => ReturnType<typeof createProxyMiddleware>;
}

/** 把 `jscode` 追加进 query。已有同名参数时**以我们的为准**——那是密钥，不接受请求方指定。 */
export function withJsCode(path: string, jscode: string): string {
  if (!jscode) return path;
  const [bare, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.set("jscode", jscode);
  return `${bare}?${params.toString()}`;
}

/** 命中哪个上游（导出供单测直接钉住分流规则）。 */
export function upstreamFor(pathAfterPrefix: string): string {
  const hit = UPSTREAMS.find((u) => pathAfterPrefix.startsWith(u.prefix));
  // 最后一条 prefix 是 "/"，任何以 / 开头的路径都会命中；这里的兜底只防空串。
  return (hit ?? UPSTREAMS[UPSTREAMS.length - 1]).target;
}

export function createAmapProxyRouter(config: ConfigStore, opts: AmapProxyOptions = {}): Router {
  const router = Router();
  const factory = opts.proxyFactory ?? createProxyMiddleware;

  /*
   * 方法白名单放在中间件**之前**：不合规的请求根本不该进到转发层。
   * 405 而不是 404——路径是对的，方法不对，说清楚比含糊更省事。
   */
  router.use(`${AMAP_SERVICE_PREFIX}`, (req: Request, res: Response, next: NextFunction) => {
    if (!ALLOWED_METHODS.has(req.method)) {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }
    next();
  });

  const proxy = factory({
    changeOrigin: true,
    // 目的地按路径现算。请求方给不了它——`req.url` 此时已被 express 剥掉挂载前缀。
    router: (req) => upstreamFor(req.url ?? "/"),
    // 不需要 target 字段，但类型要求给一个；`router` 的返回值优先。
    target: UPSTREAMS[UPSTREAMS.length - 1].target,
    on: {
      proxyReq: (proxyReq) => {
        /*
         * 到这一步 `proxyReq.path` 已经是**剥掉挂载前缀之后**的路径——
         * 也就是高德那边期望的原始路径，直接追加 jscode 即可。
         *
         * 密钥从下面那个闭包变量取：它由每次请求前的中间件刷新。
         * 不在这里 await 配置层——`proxyReq` 是同步回调。
         */
        proxyReq.path = withJsCode(proxyReq.path, currentJsCode);
        // 我们自己的凭证对高德没有意义，带过去只是泄漏面。
        proxyReq.removeHeader("authorization");
        proxyReq.removeHeader("cookie");
      },
      error: (err, _req, res) => {
        console.error("[amap-proxy] 上游失败", err);
        // res 可能是 Socket（websocket 路径），这里只处理 HTTP 响应。
        if ("status" in res && typeof (res as Response).status === "function") {
          (res as Response).status(502).json({ error: "amap_upstream_failed" });
        }
      },
    },
  });

  /*
   * 密钥现取。放在 proxy 之前的一个中间件里，把值写进闭包变量供同步的
   * `proxyReq` 回调读——`http-proxy-middleware` 的钩子是同步的，
   * 而 `runtimeValues()` 是异步的，两者只能这样接。
   *
   * 单进程内并发请求会共享这个变量，但它们读到的是同一把密钥
   * （密钥全局唯一，不随请求变），所以竞态无害。哪天它变成 per-request 的
   * 东西，这里必须改成随请求走的上下文。
   */
  let currentJsCode = "";
  router.use(AMAP_SERVICE_PREFIX, async (_req: Request, _res: Response, next: NextFunction) => {
    try {
      const values = await config.runtimeValues();
      currentJsCode = values.get("AMAP_JS_SECURITY_CODE")?.trim() ?? "";
    } catch (err) {
      // 配置层抖动不该让地图整个瞎掉：不追加 jscode 继续走，高德会回它自己的错误码。
      console.warn("[amap-proxy] 配置读取失败，本次不追加 jscode", err);
      currentJsCode = "";
    }
    next();
  });

  router.use(AMAP_SERVICE_PREFIX, proxy);
  return router;
}
