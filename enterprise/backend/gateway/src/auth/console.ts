/**
 * 后台鉴权（施工单 M3-01）—— 与端上 `demoAuth` **完全独立的第二条路径**。
 *
 * POC 简化形态：环境注入的角色 token，不做用户表/密码/JWT/refresh。
 * **退出条件**：FL-07 F-07-01（JWT 签发与校验）落地后，角色声明改由 JWT claim 承载，
 * 下面的 `requireRole` / `requireAnyRole` 判定代码**不动**——这是把简化形态
 * 限制在"身份从哪来"这一层、不让它渗进"谁能做什么"的原因。
 *
 * 角色矩阵（M3-01 定案，全 Sprint 据此实现）：
 *   配置读写与探活          admin ✅ / ops ❌
 *   会话检索、对话浏览、提权  admin ✅ / ops ✅
 *   记忆浏览与提权          admin ✅ / ops ✅
 *   审计查询                admin ✅ / ops ✅
 *   删除审计                 **接口不存在**
 *
 * admin 能看用户对话是显式授权，代价用审计对称性兑付：admin 与 ops 的提权
 * 走同一张表同一套字段，`actorRole` 可区分，且任何角色都没有删除审计的路径。
 */

import type { NextFunction, Request, Response } from "express";

import type { AuditRole } from "@carlife/db";

export type ConsoleRole = AuditRole;

export interface ConsoleIdentity {
  subject: string;
  role: ConsoleRole;
}

export interface ConsoleRequest extends Request {
  console?: ConsoleIdentity;
}

/*
 * 两个 token 的来源与兜底都搬进了配置注册表（2026-09-01）。
 *
 * 这里原来是 `process.env.X ?? "admin-token"` 加一行 warn——**生产环境下那行
 * warn 挡不住任何事**：默认值写在公开仓库里，等于运营后台的全权凭证是公开的。
 * 现在与 `CARLIFE_JWT_SECRET` 同一条纪律：非生产由 `collectStartupReport`
 * 把 `devDefault` 写回 env 并逐次告警，生产缺失即进程退出。
 *
 * 所以这里**不再自己兜底**。读到空说明启动校验没跑过（例如某个测试直接
 * 构造了 app），此时给一个不可能被猜中的随机值而不是回落公开默认值——
 * 让它 401，而不是让它变成一把万能钥匙。
 */
function tokenOrUnguessable(key: "CARLIFE_ADMIN_TOKEN" | "CARLIFE_OPS_TOKEN"): string {
  const v = process.env[key]?.trim();
  if (v) return v;
  return `unset-${key}-${Math.random().toString(36).slice(2)}`;
}

function tokenTable(): Map<string, ConsoleIdentity> {
  const admin = tokenOrUnguessable("CARLIFE_ADMIN_TOKEN");
  const ops = tokenOrUnguessable("CARLIFE_OPS_TOKEN");

  // admin 与 ops 撞同一个值时，**取权限低的一方**：配置错误不应静默提权。
  const table = new Map<string, ConsoleIdentity>();
  table.set(admin, { subject: "console-admin", role: "admin" });
  table.set(ops, { subject: "console-ops", role: "ops" });
  return table;
}

/**
 * 解析后台身份。**不做拒绝**——未携带有效 token 时不挂 `req.console`，
 * 由 `requireRole` / `requireAnyRole` 统一返回 401/403，
 * 好处是审计中间件能先于角色判定挂上钩子，把 denied 也记下来。
 */
export function consoleAuth(req: ConsoleRequest, _res: Response, next: NextFunction): void {
  const header = req.header("authorization");
  if (header?.startsWith("Bearer ")) {
    const identity = tokenTable().get(header.slice("Bearer ".length));
    if (identity) req.console = identity;
  }
  next();
}

function deny(req: ConsoleRequest, res: Response): void {
  // 未识别身份 → 401；身份有效但角色不够 → 403。两者语义分明，
  // 但都不泄露"这个 token 是否存在"（沿用 FL-07 约束）。
  if (!req.console) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.status(403).json({ error: "forbidden" });
}

export function requireRole(role: ConsoleRole) {
  return (req: ConsoleRequest, res: Response, next: NextFunction): void => {
    if (req.console?.role === role) {
      next();
      return;
    }
    deny(req, res);
  };
}

export function requireAnyRole(roles: readonly ConsoleRole[]) {
  return (req: ConsoleRequest, res: Response, next: NextFunction): void => {
    if (req.console && roles.includes(req.console.role)) {
      next();
      return;
    }
    deny(req, res);
  };
}

/** 会话/记忆等"运营与管理员都能看"的资源统一用它，避免各处手写数组。 */
export const CONSOLE_READERS: readonly ConsoleRole[] = ["admin", "ops"];
