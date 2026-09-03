/**
 * 后台操作审计中间件（施工单 M3-01）。
 *
 * 挂在**角色判定之前**，用响应完成钩子记录结果——因此 403（越权尝试）
 * 同样被记下，这比记录成功操作更有价值。
 *
 * 记什么：`/console/*` 的全部非 GET 请求 + 被 `auditAction()` 显式标注的 GET。
 * 不记什么：普通读取（列表、详情）——它们量大且无后果；**提权查看原文除外**，
 * 那条由路由自己用 `auditAction("message.reveal")` 标注。
 */

import type { NextFunction, Request, Response } from "express";

import type { AuditRepository, AuditResult } from "@carlife/db";

import type { ConsoleRequest } from "../auth/console";

/**
 * 审计相关的 `res.locals` 约定。
 * 不用 `declare module "express-serve-static-core"` 做全局增强——那需要
 * 依赖树里恰好存在该模块的类型，express 4/5 的 @types 组合下并不稳定。
 */
export interface AuditLocals {
  auditAction?: string;
  auditTarget?: string;
  auditDetail?: Record<string, unknown>;
  /** 置位后由路由自行落审计（如提权路径的"先写后放行"），中间件不再重复记录。 */
  auditHandled?: boolean;
}

export function auditLocals(res: Response): AuditLocals {
  return res.locals as AuditLocals;
}

/** 在角色判定之前标注动作名，保证 denied 也能落到正确的 action 上。 */
export function auditAction(action: string) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    auditLocals(res).auditAction = action;
    next();
  };
}

function resultOf(status: number): AuditResult {
  if (status < 400) return "ok";
  if (status === 401 || status === 403) return "denied";
  return "error";
}

export function consoleAudit(audit: AuditRepository) {
  return (req: ConsoleRequest, res: Response, next: NextFunction): void => {
    res.on("finish", () => {
      const locals = auditLocals(res);
      if (locals.auditHandled) return;

      /*
       * 兜底动作名只给**真正的后台请求**（2026-08-27 修）。
       *
       * 本中间件挂在无路径前缀的 console 路由上，于是 `res.on("finish")`
       * 对**每一个**流经网关的请求都会触发——包括端上的 `/v1/asr/transcribe`、
       * `/v1/cabin/media/duck`。实测库里 4084 条审计有 3734 条是它们，
       * 占 91%：10 条改配置、3 条删除被埋在里面，页面看起来像一份 HTTP 访问日志。
       * 用户走查时的原话是"这是接口的调用么？"——是的，而那正是审计失效的样子。
       *
       * 判据：**审计记的是治理动作，不是业务流量**。业务流量本来就有去处
       * （轨迹表、messages 表），记进审计只会淹没治理记录。
       * 端上确实需要留痕的动作（`vehicle.*` / `cabin.view`）都显式声明了
       * `auditAction()`，走上面那一支，不受这条影响。
       */
      const isConsoleRequest = req.originalUrl.startsWith("/console/");
      const action =
        locals.auditAction ??
        (req.method !== "GET" && isConsoleRequest ? `console.${req.method.toLowerCase()}` : undefined);
      if (!action) return;

      audit.record({
        actor: req.console?.subject ?? "anonymous",
        // 未识别身份时用 ops 占位（权限低的一方），避免匿名尝试被记成 admin。
        actorRole: req.console?.role ?? "ops",
        action,
        result: resultOf(res.statusCode),
        target: locals.auditTarget ?? req.originalUrl,
        detail: {
          method: req.method,
          status: res.statusCode,
          ...(locals.auditDetail ?? {}),
        },
        ip: req.ip ?? null,
      });
    });
    next();
  };
}
