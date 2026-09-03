/**
 * 用户体系后台路由（施工单 M68-01 只读面 / M68-02 治理动作）——`/console/identity/*`。
 *
 * # 它回答运营的四个问题
 *
 * 找到这个人（`users?q=`）→ 看他名下有什么（`users/:id`：车、被授权的车、设备、最近会话）
 * → 这辆车是谁的、授权给了谁、绑了哪几台车机（`vehicles/:vin`）→ 这台设备是谁的、还活着吗（`devices`）。
 * 数据全部来自 `@carlife/db` 的 `IdentityConsoleRepository`——全仓唯一允许无键跨实体读的仓储，
 * 网关这里只做参数收口与角色判定，不碰 Prisma。
 *
 * # 六条 GET 都是 ops + admin；两条 POST 只有 admin
 *
 * 客服查询面的常态是 ops。没有 admin-only 的读——"看得见但改不了"才是 ops 的形状。
 * 治理动作（撤销设备 / 解绑车机 / 撤销授权）走 `requireRole("admin")` 并经 `auditAction()` 命名：
 * 越权尝试同样落 `denied`（审计中间件挂在角色判定之前，M3-01）。请求体可带 `reason`（≤200 字）进审计
 * `detail`——审计页回答"谁、什么时候、动过谁"，`reason` 让它还能回答"为什么"。
 *
 * # 后台只收回、不代授
 *
 * 授权的发起方是车主（设计 §4.2，owner-only）。客服场景里"帮他撤掉"是常见且可逆的（车主随时可重新授权），
 * "替他加人"则是替车主把隐私边界往外推，不该由运营代劳。所以这里没有 `POST .../grants`。
 *
 * # 撤销复用既有仓储的软删，这里不写第二份
 *
 * `DeviceRepository.revoke` / `VehicleGrantRepository.revoke`——R11（DB 软删是唯一真相源、下一请求失效）
 * 因此对后台动作自动成立。车机的"解绑"就是撤销那条 `vehicleVin` 非空的设备记录（设计 §3.2），
 * 同一端点、响应用 `kind` 区分，界面据此措辞。
 *
 * # 响应里不出现的两样东西
 *
 *  - `passwordHash`：仓储返回的是 `PublicUser` 形状，这里再无从取到它；单测对 JSON 全文断言。
 *  - VehicleMember 的称呼 / 关系 / 手机号：那是车主给家人起的叫法（F-46-13）。
 *    车辆详情只有 `shadowMemberCount`，授权行只有 `linkedMember` 布尔。
 */

import { Router, type Response } from "express";

import type {
  ChatRepository,
  DeviceRepository,
  IdentityConsoleRepository,
  VehicleGrantRepository,
} from "@carlife/db";
import { isDeviceType } from "@carlife/shared";

import { requireAnyRole, requireRole, CONSOLE_READERS, type ConsoleRequest } from "../auth/console";
import { auditAction, auditLocals } from "./audit";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** 审计里的"为什么"。超过这个长度的不是理由，是别的东西。 */
export const MAX_REASON_LEN = 200;

export interface IdentityConsoleDeps {
  identity: IdentityConsoleRepository;
  /** 账号详情顺带的"最近会话"（5 条），与「会话与对话」页同一接口口径。 */
  chat: Pick<ChatRepository, "consoleSessionPage">;
  /**
   * 写动作（M68-02）复用端上同一份仓储的软删。**成对可缺省**——不注入时两条 POST 不挂
   * （只读部署形态下，一个必然 404 的按钮比没有按钮更难解释，界面按 404 隐藏）。
   */
  devices?: Pick<DeviceRepository, "revoke">;
  grants?: Pick<VehicleGrantRepository, "roleFor" | "revoke">;
}

/**
 * 解析 `reason`：可选、去空、≤200 字。空串当没传。
 * 返回 `{ error }` 时调用方直接 400——这里不 res，好让两条写端点共用。
 */
export function reasonOf(body: unknown): { reason?: string } | { error: string } {
  const raw = (body as { reason?: unknown } | null)?.reason;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string") return { error: "invalid_reason" };
  const t = raw.trim();
  if (!t) return {};
  if (t.length > MAX_REASON_LEN) return { error: "reason_too_long" };
  return { reason: t };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function limitOf(v: unknown): number {
  return Math.min(Number(v ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, MAX_LIMIT);
}

export function param(req: ConsoleRequest, name: string): string {
  const raw = req.params[name];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" ? v : "";
}

export function createIdentityConsoleRouter(deps: IdentityConsoleDeps): Router {
  const router = Router();
  const { identity } = deps;

  router.get("/console/identity/overview", requireAnyRole(CONSOLE_READERS), async (_req, res: Response) => {
    res.json(await identity.overview());
  });

  router.get("/console/identity/users", requireAnyRole(CONSOLE_READERS), async (req: ConsoleRequest, res) => {
    res.json(
      await identity.userPage({ q: str(req.query.q), limit: limitOf(req.query.limit), cursor: str(req.query.cursor) }),
    );
  });

  router.get("/console/identity/users/:id", requireAnyRole(CONSOLE_READERS), async (req: ConsoleRequest, res) => {
    const id = param(req, "id");
    const detail = id ? await identity.userDetail(id) : null;
    if (!detail) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // 访客会话（userId NULL）永远不会算到谁头上——`consoleSessionPage({ userId })` 是精确匹配。
    const recent = await deps.chat.consoleSessionPage({ userId: id, limit: 5 });
    res.json({ ...detail, recentSessions: recent.sessions });
  });

  router.get("/console/identity/vehicles", requireAnyRole(CONSOLE_READERS), async (req: ConsoleRequest, res) => {
    res.json(
      await identity.vehiclePage({ q: str(req.query.q), limit: limitOf(req.query.limit), cursor: str(req.query.cursor) }),
    );
  });

  router.get("/console/identity/vehicles/:vin", requireAnyRole(CONSOLE_READERS), async (req: ConsoleRequest, res) => {
    const vin = param(req, "vin");
    const detail = vin ? await identity.vehicleDetail(vin) : null;
    if (!detail) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(detail);
  });

  router.get("/console/identity/devices", requireAnyRole(CONSOLE_READERS), async (req: ConsoleRequest, res) => {
    const type = str(req.query.type);
    if (type !== undefined && !isDeviceType(type)) {
      res.status(400).json({ error: "invalid_type" });
      return;
    }
    // 缺省只看未撤销：运营默认要看的是活着的；已撤销的要能翻到，否则"我上周撤过吗"答不了。
    const status = str(req.query.status) ?? "active";
    if (status !== "active" && status !== "revoked" && status !== "all") {
      res.status(400).json({ error: "invalid_status" });
      return;
    }
    res.json(
      await identity.devicePage({
        ...(type ? { type } : {}),
        status,
        userId: str(req.query.userId),
        vin: str(req.query.vin),
        limit: limitOf(req.query.limit),
        cursor: str(req.query.cursor),
      }),
    );
  });

  // ── 治理动作（M68-02）：admin 独有，全部经审计 ──────────────────────────────

  if (deps.devices && deps.grants) {
    const { devices, grants } = deps;

    /**
     * 撤销一台设备。私人终端与车机同一端点：车机的"解绑"就是置 `revokedAt`（设计 §3.2）。
     * 不存在 → 404；已撤销 → 200 幂等（客服重复点一下不该看到红字，审计照记 `alreadyRevoked`）。
     */
    router.post(
      "/console/identity/devices/:id/revoke",
      auditAction("device.revoke"),
      requireRole("admin"),
      async (req: ConsoleRequest, res: Response) => {
        const id = param(req, "id");
        const parsed = reasonOf(req.body);
        if ("error" in parsed) {
          res.status(400).json({ error: parsed.error, maxLength: MAX_REASON_LEN });
          return;
        }
        auditLocals(res).auditTarget = id;
        // 撤之前先看它是什么——撤完就只剩一个时刻，审计里得留着"撤的是谁的哪台"。
        const known = await identity.deviceById(id);
        if (!known) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        const kind = known.vehicleVin ? "cockpit" : "personal";
        const alreadyRevoked = Boolean(known.revokedAt);
        if (!alreadyRevoked) await devices.revoke(id);
        auditLocals(res).auditDetail = {
          deviceType: known.deviceType,
          vehicleVin: known.vehicleVin ?? null,
          userId: known.userId,
          ...(parsed.reason ? { reason: parsed.reason } : {}),
          alreadyRevoked,
        };
        res.json({ ok: true, kind, ...(known.vehicleVin ? { vehicleVin: known.vehicleVin } : {}), alreadyRevoked });
      },
    );

    /**
     * 撤销一条授权。车主不是授权（`roleFor` 回 owner）→ 409：所有权只在 `Vehicle.ownerId`，
     * 这里撤不掉也不该撤。从未授权 → 404；已撤销 → 200 幂等。
     */
    router.post(
      "/console/identity/vehicles/:vin/grants/:userId/revoke",
      auditAction("grant.revoke"),
      requireRole("admin"),
      async (req: ConsoleRequest, res: Response) => {
        const vin = param(req, "vin");
        const userId = param(req, "userId");
        const parsed = reasonOf(req.body);
        if ("error" in parsed) {
          res.status(400).json({ error: parsed.error, maxLength: MAX_REASON_LEN });
          return;
        }
        auditLocals(res).auditTarget = vin;
        const role = await grants.roleFor(userId, vin);
        if (role === "owner") {
          auditLocals(res).auditDetail = { userId, role, ...(parsed.reason ? { reason: parsed.reason } : {}) };
          res.status(409).json({ error: "owner_cannot_be_revoked" });
          return;
        }
        let alreadyRevoked = false;
        if (role === null) {
          // roleFor 回 null 有两种原因：从未授权，或授权已撤销——只有后者是幂等 200。
          const state = await identity.grantState(userId, vin);
          if (state === "missing") {
            res.status(404).json({ error: "not_found" });
            return;
          }
          alreadyRevoked = true;
        } else {
          await grants.revoke(userId, vin);
        }
        auditLocals(res).auditDetail = {
          userId,
          role: role ?? null,
          ...(parsed.reason ? { reason: parsed.reason } : {}),
          alreadyRevoked,
        };
        res.json({ ok: true, role: role ?? null, alreadyRevoked });
      },
    );
  }

  return router;
}
