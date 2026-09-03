/**
 * JWT 签发与校验（施工单 M48-02 / M49-01，FL-07 F-07-01）。HS256，`node:crypto` 实现，零依赖。
 *
 * # 为什么不引 jsonwebtoken / jose
 *
 * 与 `password.ts` 同一条：加依赖要走 ACR 变更单 + 人工确认。
 * HS256 的 JWT 是 `base64url(header).base64url(payload).base64url(hmac)` ——
 * 规范简单、我们**既签又验**（不需要支持别人签的各种算法），
 * 所以第三方库能带来的主要价值（算法协商、JWK、各种 alg 的坑）在这里都不适用。
 *
 * # 只接受 HS256，且不信 header 里的 alg
 *
 * 这是 JWT 最著名的坑（`alg: none` 与 alg 混淆攻击）：**校验时不看 payload 里说自己是什么
 * 算法，只按我们唯一支持的算法验**。header 里的 alg 与我们的不符就直接拒。
 *
 * # 两种 subject：人与车
 *
 *  - `kind: "user"`：登录的人，`sub` 是 userId；
 *  - `kind: "vehicle"`：车机终端（M48-04 发放），`sub` 是 deviceId，另带 `vin`。
 *
 * 车辆级 token **不携带也不推导 userId**——车机上"谁在用"由每次会话的上车声明
 * （`activeUserId`，M48-05）回答。把 vin 的 token 当成某个人的身份，
 * 表现就是妻子开车时助手用丈夫的偏好（设计裁决 R4）。
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { DEV_JWT_SECRET, isProductionEnv } from "@carlife/db";

/** access token 有效期（秒）。短，因为撤销靠的是"下一次请求查库"。 */
export const ACCESS_TTL_SEC = 15 * 60;
/**
 * refresh 有效期（秒），默认 14 天。
 *
 * 车机可能长时间离线（FL-07 F-07-02 的"长离线容忍"），太短会让车主每次上车都要重新绑。
 * 安全性由**每次刷新都查库**兜底（设备/授权撤销即刻生效，设计裁决 R11），
 * 而不是靠把有效期压到很短。
 */
export const REFRESH_TTL_SEC = 14 * 24 * 60 * 60;

export type TokenKind = "user" | "vehicle";
export type TokenUse = "access" | "refresh";

export interface TokenClaims {
  /** 人 token 是 userId；车辆 token 是 deviceId。 */
  sub: string;
  kind: TokenKind;
  use: TokenUse;
  /** 发起请求的设备（人 token 可选；车辆 token 恒等于 sub）。 */
  deviceId?: string;
  /** 车辆 token 绑定的车。 */
  vin?: string;
  /** 签发与过期（秒级 epoch）。 */
  iat: number;
  exp: number;
  /** 每个 token 唯一，便于日志关联。 */
  jti: string;
}

export class JwtConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JwtConfigError";
  }
}

/** 进程内只警告一次：否则每签一个 token 打一行，日志会被自己淹掉。 */
let warnedDevSecret = false;

/**
 * 签名密钥。**生产没有默认值，开发有**（施工单 M49-01）。
 *
 * 生产不给默认值的理由没变，只是范围收窄到生产：一个公开仓库里写着的签名密钥
 * 等于没有鉴权，而且不会以任何现象提示你——token 照常签发、照常通过。
 * 与 `config/crypto.ts` 的主密钥同一取向（那两把落盘加密主密钥则**连开发默认值都不给**，
 * 因为它们保护的是密文，泄露影响面不是一个量级）。
 *
 * 开发给默认值的理由：M48-02 之后，任何没配过它的机器一律起不来，
 * 而那是新克隆仓库的默认状态。
 *
 * 这里的兜底与 `startup.ts` 的写回是**同一个常量的两条路径**，不是两份默认值：
 * 单测、脚本、以及任何不经 `assertStartupConfig` 的调用路径都直接进这里。
 */
function secret(): Buffer {
  const raw = process.env.CARLIFE_JWT_SECRET?.trim();
  if (!raw || raw.length < 16) {
    if (isProductionEnv()) {
      throw new JwtConfigError(
        "缺少 CARLIFE_JWT_SECRET（至少 16 字符）。生产环境不提供默认值：默认密钥等于没有鉴权。" +
          "生成一个：openssl rand -hex 32",
      );
    }
    if (!warnedDevSecret) {
      warnedDevSecret = true;
      console.warn(
        "⚠ [auth] CARLIFE_JWT_SECRET 未配置或过短，正在使用开发默认密钥。" +
          "生产环境（NODE_ENV=production）会直接启动失败。",
      );
    }
    return Buffer.from(DEV_JWT_SECRET, "utf8");
  }
  return Buffer.from(raw, "utf8");
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string): string {
  return createHmac("sha256", secret()).update(data).digest("base64url");
}

export interface IssueInput {
  sub: string;
  kind: TokenKind;
  use: TokenUse;
  deviceId?: string;
  vin?: string;
  /** 覆盖默认有效期（秒），测试用。 */
  ttlSec?: number;
}

export function issueToken(input: IssueInput): string {
  const now = Math.floor(Date.now() / 1000);
  const ttl = input.ttlSec ?? (input.use === "access" ? ACCESS_TTL_SEC : REFRESH_TTL_SEC);
  const claims: TokenClaims = {
    sub: input.sub,
    kind: input.kind,
    use: input.use,
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    ...(input.vin ? { vin: input.vin } : {}),
    iat: now,
    exp: now + ttl,
    jti: randomUUID(),
  };
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  return `${header}.${payload}.${sign(`${header}.${payload}`)}`;
}

/**
 * 校验并解出 claims。**失败一律返回 null，不抛、不区分原因**——
 * "签名错"与"过期了"与"格式不对"对调用方是同一件事：这个 token 不可用。
 * 区分它们会变成一条探测通道。
 */
export function verifyToken(token: string): TokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];

  try {
    const head = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as {
      alg?: unknown;
    };
    // 只认 HS256：不按 token 自称的算法去验（alg=none / 算法混淆）。
    if (head.alg !== "HS256") return null;

    const expected = Buffer.from(sign(`${header}.${payload}`), "utf8");
    const actual = Buffer.from(signature, "utf8");
    if (expected.length !== actual.length) return null;
    if (!timingSafeEqual(expected, actual)) return null;

    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenClaims;
    if (typeof claims.sub !== "string" || !claims.sub) return null;
    if (claims.kind !== "user" && claims.kind !== "vehicle") return null;
    if (claims.use !== "access" && claims.use !== "refresh") return null;
    if (typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}
