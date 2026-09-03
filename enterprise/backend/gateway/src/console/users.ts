/**
 * 账号管理路由（施工单 M48-02，FL-07 F-07-01）—— **admin 独有**。
 *
 * `POST /console/users`            建账号
 * `POST /console/users/:id/password` 重置口令（也是给种下来就锁定的 demo-user 解锁的路径）
 *
 * # 为什么账号由后台预置，而不是自助注册
 *
 * FL-07 的负向验收明写"不做注册、找回密码、第三方登录"。
 * REQ-0002 的场景是家庭：车主把车分享给妻子，妻子的账号从哪来？
 * POC 期答案是管理员预置（或车主线下要一个），**不是自助注册流程**——
 * 那会连带出邮箱验证、防刷、找回口令一整条链，与本 Sprint 的目标无关。
 *
 * # 为什么不在这里发口令给用户
 *
 * 响应里只回 id 与 username，**不回明文口令**。口令由调用者（管理员）在请求里给定，
 * 他本来就知道；让服务端生成再回显，就等于把它写进了 HTTP 日志与审计。
 */

import { Router, type Response } from "express";

import type { UserRepository } from "@carlife/db";
import { UsernameTakenError } from "@carlife/db";

import { requireRole, type ConsoleRequest } from "../auth/console";
import { hashPassword } from "../auth/password";
import { auditAction } from "./audit";

/** 口令下限。POC 期只挡"空的和明显敷衍的"，不做复杂度矩阵。 */
const MIN_PASSWORD_LEN = 8;

export function createUsersRouter(users: UserRepository): Router {
  const router = Router();

  router.post(
    "/console/users",
    auditAction("user.create"),
    requireRole("admin"),
    async (req: ConsoleRequest, res: Response) => {
      const { username, password, displayName } = (req.body ?? {}) as {
        username?: unknown;
        password?: unknown;
        displayName?: unknown;
      };
      if (typeof username !== "string" || username.trim().length < 3) {
        res.status(400).json({ error: "invalid_username" });
        return;
      }
      if (typeof password !== "string" || password.length < MIN_PASSWORD_LEN) {
        res.status(400).json({ error: "weak_password", minLength: MIN_PASSWORD_LEN });
        return;
      }
      try {
        const user = await users.create({
          username: username.trim(),
          passwordHash: await hashPassword(password),
          displayName: typeof displayName === "string" ? displayName : undefined,
        });
        res.status(201).json({
          id: user.id,
          username: user.username,
          displayName: user.displayName ?? null,
        });
      } catch (err) {
        if (err instanceof UsernameTakenError) {
          res.status(409).json({ error: "username_taken" });
          return;
        }
        throw err;
      }
    },
  );

  router.post(
    "/console/users/:id/password",
    auditAction("user.password.reset"),
    requireRole("admin"),
    async (req: ConsoleRequest, res: Response) => {
      const { password } = (req.body ?? {}) as { password?: unknown };
      if (typeof password !== "string" || password.length < MIN_PASSWORD_LEN) {
        res.status(400).json({ error: "weak_password", minLength: MIN_PASSWORD_LEN });
        return;
      }
      const raw = req.params.id;
      const id = Array.isArray(raw) ? raw[0] : raw;
      if (typeof id !== "string" || !id) {
        res.status(400).json({ error: "invalid_user_id" });
        return;
      }
      const existing = await users.findById(id);
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await users.setPasswordHash(id, await hashPassword(password));
      res.json({ ok: true });
    },
  );

  return router;
}
