/**
 * 高德服务接口代理的连通性自检（ACR-019）。
 *
 * 单测证明不了这一跳是通的：它们打的是本机假上游，验的是"我们有没有把 jscode
 * 拼上去"。**真正要验的是高德认不认这把安全密钥**——只有走真实网络才知道
 * （M7 的教训：绿灯掩盖了"根本没有数据源"）。
 *
 * # 判据是一组**对照**，不是一次成功
 *
 * 「经代理的请求成功了」单独不能说明任何事——如果这把 key 压根没开启安全密钥
 * 校验，那么不带 jscode 也一样成功。所以要两组对照：
 *
 *   ① 直连高德、**不带** jscode → 期望被拒（`INVALID_USER_SCODE` / 10008）。
 *      这一条确立"这个端点确实在校验安全密钥"，是控制组。
 *   ② 经网关代理、调用方**什么都不带** → 期望**不是** `INVALID_USER_SCODE`。
 *      与 ① 的差别只可能来自网关注入的 jscode，所以它证明注入生效。
 *   ③ 安全密钥不出现在回给调用方的响应里。
 *
 * # 为什么打样式端点而不是地理编码
 *
 * 2026-09-02 实测：拿 **Web 端(JS API)** 的 key 去打 `restapi.amap.com/v3/geocode/geo`
 * （那是 **Web 服务** API）恒回 `USERKEY_PLAT_NOMATCH`（10009）——**带不带 jscode 都一样**。
 * 平台不匹配是在安全密钥之前就判掉的，用它做探针会把"平台错"误读成"密钥没注入"。
 * `/v4/map/styles` 才是 JS SDK 真正会经代理去要的东西，也正是被安全密钥保护的那一类。
 *
 * ② 期望的成功形态是 `errcode 20000（styleid 非法）`：**业务参数不全但鉴权过了**。
 * 本脚本刻意不补 `styleid`——补全它只会让判据依赖一个随高德改版而变的参数，
 * 而我们要证明的是"鉴权那一关过没过"。
 *
 * 前置：网关在跑（`CARLIFE_GATEWAY_URL`，默认 http://localhost:8790）；
 *       `.env` 里有 `AMAP_JS_KEY` 与 `AMAP_JS_SECURITY_CODE`。
 * 运行（根目录）：corepack pnpm probe:amap-proxy
 */

import { readFileSync } from "node:fs";

const ROOT = new URL("../../../", import.meta.url);

/** 高德在"没有安全密钥"时回的错误码。判据 ① 与 ② 都盯它。 */
const INVALID_SCODE = 10008;

/** 从仓库根 .env 读一项（与其它 probe 脚本同款，不引入 dotenv）。 */
function envFromDotenv(key: string): string | undefined {
  if (process.env[key]?.trim()) return process.env[key]!.trim();
  try {
    const text = readFileSync(new URL(".env", ROOT), "utf8");
    const m = new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\n]*)"?`, "m").exec(text);
    return m?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

interface StyleReply {
  errcode?: number;
  errmsg?: string;
  errdetail?: string;
}

let passed = 0;
let failed = 0;
const ok = (m: string) => {
  passed += 1;
  console.log(`✓ ${m}`);
};
const bad = (m: string) => {
  failed += 1;
  console.error(`✗ ${m}`);
};

async function fetchStyle(url: string): Promise<{ text: string; reply: StyleReply }> {
  const r = await fetch(url);
  const text = await r.text();
  let reply: StyleReply = {};
  try {
    reply = JSON.parse(text) as StyleReply;
  } catch {
    // 真正拿到样式时回的是二进制/非 JSON——那也是"鉴权过了"的一种，交给调用方判。
  }
  return { text, reply };
}

async function main(): Promise<void> {
  const gateway = (envFromDotenv("CARLIFE_GATEWAY_URL") ?? "http://localhost:8790").replace(/\/+$/, "");
  const jsKey = envFromDotenv("AMAP_JS_KEY");
  const securityCode = envFromDotenv("AMAP_JS_SECURITY_CODE");

  if (!jsKey) {
    console.error("缺 AMAP_JS_KEY——没有它连不上高德，这个自检无从谈起");
    process.exit(1);
  }
  if (!securityCode) {
    console.error("缺 AMAP_JS_SECURITY_CODE——ACR-019 之后它是**服务端配置**，网关靠它给代理请求签名");
    process.exit(1);
  }

  const query = new URLSearchParams({
    s: "rsv1",
    platform: "JS",
    logo: "1",
    sdkversion: "2.0",
    ver: "1",
    style: "normal",
    key: jsKey,
  }).toString();

  // ── 判据 ①：控制组。直连、不带 jscode，应当被拒。
  let controlRejected = false;
  try {
    const { reply } = await fetchStyle(`https://webapi.amap.com/v4/map/styles?${query}`);
    if (reply.errcode === INVALID_SCODE) {
      controlRejected = true;
      ok(`控制组：直连高德不带 jscode → ${reply.errmsg}（${reply.errcode}），该端点确实在校验安全密钥`);
    } else {
      bad(
        `控制组异常：直连不带 jscode 却没被拒（errcode=${reply.errcode}）——` +
          "说明这把 key 没开启安全密钥校验，判据 ② 因此证明不了代理有没有注入。" +
          "请在高德控制台为该 key 开启「安全密钥」",
      );
    }
  } catch (e) {
    bad(`控制组请求失败（网络问题，本次无结论）：${e instanceof Error ? e.message : String(e)}`);
  }

  // ── 判据 ②：经代理，调用方什么都不带，应当不再是"没有安全密钥"。
  let proxyText = "";
  try {
    const { text, reply } = await fetchStyle(`${gateway}/_AMapService/v4/map/styles?${query}`);
    proxyText = text;
    if (reply.errcode === INVALID_SCODE) {
      bad("经网关代理仍报 INVALID_USER_SCODE——网关**没有**把 jscode 注入进去");
    } else if (!controlRejected) {
      bad("经网关代理通过了，但控制组没被拒，无法归因（见上一条）");
    } else {
      const how = reply.errcode ? `errcode=${reply.errcode}（${reply.errdetail ?? reply.errmsg}）` : "非错误响应";
      ok(`经网关代理：${how}——鉴权那一关过了，与控制组的差别只可能来自注入的 jscode`);
    }
  } catch (e) {
    bad(`经网关代理请求不通（网关没起？）：${e instanceof Error ? e.message : String(e)}`);
  }

  // ── 判据 ③：密钥不回显
  if (proxyText && proxyText.includes(securityCode)) {
    bad("**安全密钥出现在回给调用方的响应里**——它只该出现在网关发往高德的那一跳");
  } else {
    ok("安全密钥不出现在响应里");
  }

  console.log(`\n高德代理自检：${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

await main();
