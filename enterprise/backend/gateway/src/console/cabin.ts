/**
 * 运营后台：客户座舱视图（施工单 M24-10，FL-51）。
 *
 * # 全族只读
 *
 * 本路由**只有 GET**（测试断言路由表）：偏好、组合、设置都没有运营写入口——
 * 运营代改是另一个授权模型，明确不做（AC-51-1）。
 *
 * # 打开视图 = 提权动作
 *
 * 视图含车主家人的称呼与偏好（他人 PII）。与 M3-05 的 `memory.reveal` 同一套规则：
 * **先写 strict 审计再放行**，审计写不进去就 503——"谁看了谁"不能缺页。
 * 状态/历史两个子端点不含 PII 之外的新增暴露，走普通读取（不逐条 strict）。
 *
 * # 离线如实
 *
 * 车机状态实时拉取（短超时）；不可达显示离线，**不用缓存值冒充在线**（AC-51-3）。
 * 本路由无任何跨请求缓存——"车主删了人、运营还看得到"是验收失败条件（AC-51-8）。
 */

import { Router } from "express";
import type { Response } from "express";

import type { AuditRepository, TripRepository } from "@carlife/db";
import type { CombinationStore, MemberStore, VehicleStore } from "@carlife/memory";
import { CabinUnboundError, ToolError, type CabinClient } from "@carlife/tools";

import { requireAnyRole, CONSOLE_READERS, type ConsoleRequest } from "../auth/console";
import { auditAction, auditLocals } from "./audit";

export interface ConsoleCabinDeps {
  vehicles: VehicleStore;
  members: MemberStore;
  combinations?: CombinationStore;
  /** 未接入（MOCK_CABIN_URL 未配）时状态区如实报 unconfigured。 */
  cabin?: CabinClient;
  trips: TripRepository;
  audit: AuditRepository;
}

const DAY = 24 * 60 * 60 * 1000;

export function createConsoleCabinRouter(deps: ConsoleCabinDeps): Router {
  const router = Router();

  /** 按用户或 VIN 解析目标车。查无按 404，与控制台其它检索一致。 */
  async function resolveVehicle(q: string): Promise<{ vin: string; ownerId: string; model: string } | null> {
    const trimmed = q.trim();
    if (!trimmed) return null;
    const byVin = await deps.vehicles.get(trimmed.toUpperCase()).catch(() => null);
    if (byVin) return byVin;
    const list = await deps.vehicles.listByOwner(trimmed).catch(() => []);
    return list[0] ?? null;
  }

  // ── 座舱视图（提权：先审计后放行）─────────────────────────
  router.get(
    "/console/cabin/view",
    auditAction("cabin.view"),
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const q = String(req.query.q ?? "");
      const vehicle = await resolveVehicle(q);
      if (!vehicle) {
        res.status(404).json({ error: "vehicle_not_found", hint: "按用户 id 或 VIN 检索" });
        return;
      }
      // 与 memory.reveal 同规则：审计写入失败 → 拒绝放行（谁看了谁不能缺页）。
      try {
        await deps.audit.recordStrict({
          actor: req.console?.subject ?? "unknown",
          actorRole: req.console!.role,
          action: "cabin.view",
          result: "ok",
          target: vehicle.vin,
          detail: { ownerId: vehicle.ownerId },
          sessionId: null,
          ip: req.ip ?? null,
        });
      } catch (err) {
        console.error(`[console] cabin.view 审计写入失败，拒绝放行 vin=${vehicle.vin}`, err);
        res.status(503).json({ error: "audit_unavailable" });
        return;
      }
      auditLocals(res).auditHandled = true;

      // 无缓存：每次现查（AC-51-8 删除即时生效靠的就是"没有缓存层"）。
      const members = await deps.members.listByVehicle(vehicle.ownerId, vehicle.vin);
      const combinations = deps.combinations
        ? await deps.combinations.listByVehicle(vehicle.ownerId, vehicle.vin)
        : null;

      res.json({
        vehicle: { vin: vehicle.vin, ownerId: vehicle.ownerId, model: vehicle.model },
        members: members.map((m) => ({
          id: m.id,
          displayName: m.displayName,
          relation: m.relation ?? null,
          ageBand: m.ageBand ?? null,
          // 只读展示；运营端点没有任何写这份数据的路（AC-51-1）
          cabinPreference: m.cabinPreference ?? null,
        })),
        combinations:
          combinations?.map((c) => ({
            id: c.id,
            label: c.label,
            memberIds: c.memberIds,
            override: c.override,
            invalidReason: c.invalidReason ?? null,
          })) ?? null,
        combinationsUnconfigured: combinations === null,
      });
    },
  );

  // ── 车机实时状态（离线如实；不缓存）───────────────────────
  router.get(
    "/console/cabin/state",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const vehicle = await resolveVehicle(String(req.query.q ?? ""));
      if (!vehicle) {
        res.status(404).json({ error: "vehicle_not_found" });
        return;
      }
      if (!deps.cabin) {
        res.json({ state: "unconfigured", reason: "车机能力未接入（MOCK_CABIN_URL 未配）" });
        return;
      }
      try {
        const r = await deps.cabin.status(vehicle.vin);
        res.json({
          state: "online",
          cabinVehicleId: r.vehicleId,
          model: r.model,
          deviceState: r.state,
          rebuilt: r.rebuilt,
          provenance: "simulated",
          fetchedAt: new Date().toISOString(),
        });
      } catch (err) {
        if (err instanceof CabinUnboundError) {
          res.json({ state: "unbound" });
          return;
        }
        if (err instanceof ToolError && err.category === "upstream") {
          res.json({ state: "offline", reason: "车机离线", fetchedAt: new Date().toISOString() });
          return;
        }
        if (err instanceof ToolError && err.category === "unconfigured") {
          res.json({ state: "unconfigured", reason: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // ── 历史时间线：设置变更（车机流水）+ 行程 + 保养维修 ─────
  router.get(
    "/console/cabin/history",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const vehicle = await resolveVehicle(String(req.query.q ?? ""));
      if (!vehicle) {
        res.status(404).json({ error: "vehicle_not_found" });
        return;
      }
      const days = Math.min(Number(req.query.days ?? 30) || 30, 90);
      const now = Date.now();

      // 三个来源各自失败各自降级——历史区不被一台不在线的车拖住（非功能约束）。
      const [trips, profile, changes] = await Promise.all([
        deps.trips.range(vehicle.ownerId, now - days * DAY, now, vehicle.vin).catch(() => []),
        deps.vehicles.get(vehicle.vin).catch(() => null),
        deps.cabin
          ? deps.cabin.changes(vehicle.vin).then((c) => c.changes).catch(() => null)
          : Promise.resolve(null),
      ]);

      res.json({
        vin: vehicle.vin,
        windowDays: days,
        // 无记录如实空数组（"暂无"由前端措辞）；截断显式
        trips: trips.slice(-50).map((t) => ({
          id: t.id,
          startedAt: t.startedAt,
          endedAt: t.endedAt,
          distanceKm: t.distanceKm,
        })),
        maintenance: (profile?.maintenance ?? []).slice(0, 20),
        repairs: (profile?.repairs ?? []).slice(0, 20),
        /*
         * 设置变更直读车机流水：覆盖窗口仍短于我方审计（车机侧是每车 500 条的环形
         * 缓冲），但**不再随重启清空**——mock-cabin 已把状态与流水落到本地快照。
         * 这行说明必须跟着实现走：告诉运营"重启即清"而其实还在，与反过来一样是误导。
         *
         * requestId 级对齐（AC-51-4 完整形态）仍待轨迹侧提供按车检索——先如实标注
         * 来源与局限，不做"看起来对齐了"的假拼接。
         */
        cabinChanges: changes,
        cabinChangesNote:
          changes === null
            ? "车机流水不可用（离线/未绑定/未接入）"
            : "来自车机（模拟系统，已持久化；每车保留最近 500 条）；与审计的 requestId 级对齐见轨迹回放",
      });
    },
  );

  return router;
}
