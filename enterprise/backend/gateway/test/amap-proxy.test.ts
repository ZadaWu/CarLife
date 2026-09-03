/**
 * 高德服务接口代理（`/_AMapService/*`，ACR-019）。
 *
 * 盯四件事，每一件漏了都**不会报错**：
 *  1. **jscode 真的被追加**——漏了的表现是高德回鉴权错误码，而地图只是"某些
 *     功能不生效"（路径规划退直线、样式不吃），没有任何一侧会说"密钥没带上"。
 *  2. **三个上游分对**——照抄高德官方 nginx 示例的分法。分错的表现同样是静默：
 *     样式请求打到 restapi 上，回 404，地图退回默认样式。
 *  3. **它不是开放代理**——上游硬编码、方法白名单。这条不鉴权的路径是本单
 *     唯一的风险面，它的边界必须被测试钉住，而不是只写在注释里。
 *  4. **我们自己的凭证不外传**——`authorization` / `cookie` 对高德没有意义，
 *     带过去只是泄漏面。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { describe, it, before, after } from "node:test";
import express from "express";
import { createProxyMiddleware, type Options } from "http-proxy-middleware";

import type { ConfigStore } from "@carlife/db";

import {
  createAmapProxyRouter,
  withJsCode,
  upstreamFor,
  AMAP_SERVICE_PREFIX,
} from "../src/http/amap-proxy";

function storeOf(values: Record<string, string>): ConfigStore {
  return {
    async runtimeValues() {
      return new Map(Object.entries(values));
    },
  } as unknown as ConfigStore;
}

/** 假上游：把收到的 path 与 headers 原样回给测试断言。 */
interface Upstream {
  server: Server;
  origin: string;
  seen: Array<{ path: string; headers: Record<string, unknown>; host: string }>;
}

async function startUpstream(): Promise<Upstream> {
  const seen: Upstream["seen"] = [];
  const server = createServer((req, res) => {
    seen.push({
      path: req.url ?? "",
      headers: req.headers as Record<string, unknown>,
      // changeOrigin 会把 Host 改成目标域名——借它判"本来要打的是哪个上游"。
      host: String(req.headers.host ?? ""),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "1", infocode: "10000" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, origin: `http://127.0.0.1:${port}`, seen };
}

/**
 * 把真实中间件的上游改指到本机假服务器，其余选项（`on.proxyReq` 里的 jscode
 * 追加与头剥离）原样保留——测的是真正会跑的那份逻辑，不是它的复刻。
 */
function localFactory(upstreamOrigin: string) {
  return (options: Options) =>
    createProxyMiddleware({
      ...options,
      router: undefined,
      target: upstreamOrigin,
    });
}

function appWith(store: ConfigStore, upstreamOrigin: string) {
  const app = express();
  app.use(createAmapProxyRouter(store, { proxyFactory: localFactory(upstreamOrigin) }));
  return app;
}

async function call(
  app: express.Express,
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; text: string }> {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: init.method ?? "GET",
      ...(init.headers ? { headers: init.headers } : {}),
    });
    return { status: r.status, text: await r.text() };
  } finally {
    server.close();
  }
}

describe("withJsCode —— 密钥追加是纯函数，先把它钉死", () => {
  it("空 query 也能加上", () => {
    assert.equal(withJsCode("/v3/geocode/geo", "sec"), "/v3/geocode/geo?jscode=sec");
  });

  it("已有 query 时追加而不是覆盖整串", () => {
    const out = withJsCode("/v3/geocode/geo?address=%E5%B9%BF%E5%B7%9E", "sec");
    assert.match(out, /address=/);
    assert.match(out, /jscode=sec/);
  });

  it("**请求方自带的 jscode 会被我们的覆盖**——那是密钥，不接受外部指定", () => {
    const out = withJsCode("/v3/x?jscode=attacker", "ours");
    assert.equal(new URLSearchParams(out.split("?")[1]).get("jscode"), "ours");
  });

  it("没有密钥时原样返回——让高德回它自己的错误码，比我们编一个准", () => {
    assert.equal(withJsCode("/v3/x?a=1", ""), "/v3/x?a=1");
  });
});

describe("upstreamFor —— 三个上游的分流（照高德官方 nginx 示例）", () => {
  it("矢量底图样式走 webapi", () => {
    assert.equal(upstreamFor("/v4/map/styles?s=1"), "https://webapi.amap.com");
  });

  it("矢量瓦片走 fmap01", () => {
    assert.equal(upstreamFor("/v3/vectormap?x=1"), "https://fmap01.amap.com");
  });

  it("其余服务接口兜底到 restapi", () => {
    assert.equal(upstreamFor("/v3/geocode/geo"), "https://restapi.amap.com");
    assert.equal(upstreamFor("/"), "https://restapi.amap.com");
  });

  it("上游集合是**闭集**：只有这三个域名，请求方给不了第四个", () => {
    const hosts = new Set(
      ["/v4/map/styles", "/v3/vectormap", "/v3/geocode/geo", "/../../evil", "/"].map((p) =>
        upstreamFor(p),
      ),
    );
    assert.deepEqual(
      [...hosts].sort(),
      ["https://fmap01.amap.com", "https://restapi.amap.com", "https://webapi.amap.com"],
    );
  });
});

describe(`${AMAP_SERVICE_PREFIX}/* 路由`, () => {
  let upstream: Upstream;

  before(async () => {
    upstream = await startUpstream();
  });

  after(() => {
    upstream.server.close();
  });

  it("GET 透传到上游，且 jscode 被追加", async () => {
    const r = await call(
      appWith(storeOf({ AMAP_JS_SECURITY_CODE: "sec-from-db" }), upstream.origin),
      `${AMAP_SERVICE_PREFIX}/v3/geocode/geo?address=x`,
    );
    assert.equal(r.status, 200);
    const last = upstream.seen.at(-1);
    assert.ok(last, "上游应当收到请求");
    // 挂载前缀被剥掉，高德看到的是它自己的原始路径。
    assert.match(last.path, /^\/v3\/geocode\/geo\?/);
    assert.match(last.path, /jscode=sec-from-db/);
    assert.match(last.path, /address=x/);
  });

  it("**密钥不回显给调用方**——它只出现在发往上游的那一跳", async () => {
    const r = await call(
      appWith(storeOf({ AMAP_JS_SECURITY_CODE: "sec-must-not-leak" }), upstream.origin),
      `${AMAP_SERVICE_PREFIX}/v3/geocode/geo`,
    );
    assert.equal(r.text.includes("sec-must-not-leak"), false);
  });

  it("我们自己的凭证不外传给高德", async () => {
    await call(
      appWith(storeOf({ AMAP_JS_SECURITY_CODE: "sec" }), upstream.origin),
      `${AMAP_SERVICE_PREFIX}/v3/geocode/geo`,
      { headers: { authorization: "Bearer device-jwt", cookie: "sid=abc" } },
    );
    const last = upstream.seen.at(-1);
    assert.equal(last?.headers.authorization, undefined, "authorization 不该到高德");
    assert.equal(last?.headers.cookie, undefined, "cookie 不该到高德");
  });

  it("POST 405——只放行读", async () => {
    const r = await call(
      appWith(storeOf({ AMAP_JS_SECURITY_CODE: "sec" }), upstream.origin),
      `${AMAP_SERVICE_PREFIX}/v3/geocode/geo`,
      { method: "POST" },
    );
    assert.equal(r.status, 405);
  });

  it("配置层挂了也不让地图整个瞎掉：不追加 jscode，照样转发", async () => {
    const broken = {
      async runtimeValues() {
        throw new Error("db down");
      },
    } as unknown as ConfigStore;
    const r = await call(
      appWith(broken, upstream.origin),
      `${AMAP_SERVICE_PREFIX}/v3/geocode/geo`,
    );
    assert.equal(r.status, 200);
    assert.equal(upstream.seen.at(-1)?.path.includes("jscode="), false);
  });

  it("前缀之外的路径不归它管（不是开放代理的另一半）", async () => {
    const r = await call(
      appWith(storeOf({ AMAP_JS_SECURITY_CODE: "sec" }), upstream.origin),
      "/v3/geocode/geo",
    );
    assert.equal(r.status, 404);
  });
});
