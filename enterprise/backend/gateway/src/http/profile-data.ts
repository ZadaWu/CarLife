/**
 * 档案页的两个数据面缺口（施工单 M14-09 / M14-10）。
 *
 * GET /v1/vehicles/:vin/usage               → 这辆车的⑥用车画像
 * GET /v1/vehicles/:vin/members/:id/usage   → 某位成员的画像（常驾/常乘两种口径）
 * GET /v1/preferences                       → ③偏好（"我希望助手记住"）
 *
 * # 三个端点共用的那条纪律：不可用时给理由，不给数字
 *
 * ⑥的 `verdict.usable=false` 与 ③的 `degraded=true` 都**不是空数据**：
 * 前者是"样本不足/过期"，后者是"这次没查到不代表没有"。端上据此说清楚为什么，
 * 而不是显示 0 或"还没有记录"。所以响应把判定与理由**一起带出去**——
 * 只返回 `null` 会逼端上自己编一句话。
 *
 * # 未接入 ≠ 没有数据
 *
 * ⑥ / Mem0 没配时返回 503 且 `reason` 明说"未接入"。混成 200 空结果，
 * 会让"系统没接上"被说成"你开得太少 / 你没说过偏好"——
 * 这正是 `usage_profile` 工具文件头写下的那条。
 */

import { Router } from "express";
import type { Response } from "express";

import {
  loadCompanionProfile,
  memberProfileFallback,
  loadUsageProfile,
  type CompanionProfile,
  type MemberStore,
  type MemberUsageProfile,
  type TripStore,
  type UsageProfile,
  type VehicleStore,
} from "@carlife/memory";

import type { AuthedRequest } from "../auth";
import { hasVehicleAccess, isBoundCockpit, type VehicleRoleRequest } from "../auth/vehicle-role";

/** ③偏好的读取面。抽成接口是为了让测试不必起 Mem0——那是个真实的 PG+pgvector。 */
export interface PreferenceReader {
  list(userId: string, limit: number): Promise<{
    items: Array<{ id?: string; content: string; domain?: string; updatedAt?: number }>;
    degraded?: boolean;
    error?: string;
  }>;
  /**
   * 删除本人的一条③偏好（M-pref-del）。**实现方必须先验归属再删**——
   * Mem0 的删除只认 memoryId，不带用户维度，端上传一个猜来的 id 就能删掉别人的记忆。
   * 不给这个方法即视为不支持删除，端点返回 501（而不是假装删成功）。
   */
  remove?(userId: string, id: string): Promise<
    | { kind: "ok" }
    /** 不在这个用户名下（或本来就不存在）。**两者不分**：分开会变成一个探测他人记忆是否存在的接口。 */
    | { kind: "not_found" }
    /** 记忆库降级：**这时不许删**——验不了归属就动手，等于没验。 */
    | { kind: "degraded"; reason?: string }
  >;
}

export interface ProfileDataDeps {
  vehicles: VehicleStore;
  members: MemberStore;
  /** ⑥流水。未接入时相关端点 503。 */
  trips?: TripStore;
  /** ③偏好。未接入时相关端点 503。 */
  preferences?: PreferenceReader;
  now?: () => number;
}

/** 统计窗口。与 worker 聚合、双路检索用的是同一个默认值，别在这里另立一个。 */
export const USAGE_WINDOW_DAYS = 30;

export function createProfileDataRouter(deps: ProfileDataDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => Date.now());

  /**
   * 归属校验：不区分"车不存在"与"车不属于你"，不泄露他人车辆的存在性。
   *
   * M48-03 起判据从"是车主"放宽到"是成员"——整车用车画像属**车辆共享域**
   * （设计 §4.1），被授权的驾驶人看得到。没挂角色中间件时回落到只有车主，
   * 见 `hasVehicleAccess`。
   */
  async function canReadVehicle(req: VehicleRoleRequest, vin: string): Promise<boolean> {
    const v = await deps.vehicles.get(vin);
    return Boolean(v && hasVehicleAccess(req, v.ownerId, "member"));
  }

  router.get("/v1/vehicles/:vin/usage", async (req: AuthedRequest, res: Response) => {
    const vin = String(req.params.vin);
    /*
     * 绑定车机（M54-07 续）：**不是权限问题，是取不出来**。
     * ⑥用车流水按 userId 分存（loadUsageProfile 的红线：无用户维度必须失败，
     * 不能读全量），而车辆 token 不代表任何人——放行也只会 500。
     * 复用 usage_unconfigured 语义让端上显示"未接入"灰字，
     * 而不是 401 的"unauthorized"红字把人引向查凭证。
     */
    if (!req.userId && isBoundCockpit(req, vin)) {
      res.status(503).json({ error: "usage_unconfigured", reason: "车机屏暂不提供用车画像（数据按用户维度存储）" });
      return;
    }
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!(await canReadVehicle(req, vin))) {
      res.status(404).json({ error: "vehicle_not_found" });
      return;
    }
    if (!deps.trips) {
      res.status(503).json({ error: "usage_unconfigured", reason: "⑥用车数据未接入" });
      return;
    }
    const profile: UsageProfile = await loadUsageProfile(
      deps.trips,
      req.userId,
      now(),
      USAGE_WINDOW_DAYS,
      vin,
    );
    res.json(profile);
  });

  router.get(
    "/v1/vehicles/:vin/members/:id/usage",
    async (req: AuthedRequest, res: Response) => {
      if (!req.userId) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      const vin = String(req.params.vin);
      const memberId = String(req.params.id);
      if (!(await canReadVehicle(req, vin))) {
        res.status(404).json({ error: "vehicle_not_found" });
        return;
      }
      const roster = await deps.members.listByVehicle(req.userId, vin);
      const member = roster.find((m) => m.id === memberId);
      if (!member) {
        res.status(404).json({ error: "member_not_found" });
        return;
      }
      if (!deps.trips) {
        res.status(503).json({ error: "usage_unconfigured", reason: "⑥用车数据未接入" });
        return;
      }
      /*
       * 只坐车不开车的人算里程与充电时段没有意义（M17-02 已经定过：
       * "不要为了字段齐全而算"）。所以纯乘客走同行口径，其余走驾驶口径。
       */
      const passengerOnly = member.roles.includes("passenger") && !member.roles.includes("driver");
      if (passengerOnly) {
        const p: CompanionProfile = await loadCompanionProfile(
          deps.trips,
          req.userId,
          memberId,
          now(),
          USAGE_WINDOW_DAYS,
          vin,
        );
        res.json({ kind: "companion", ...p });
        return;
      }
      /*
       * `memberProfileFallback` 不可用时回落整车口径并带 `scope: "vehicle"`。
       * **那个标记必须原样传到端上**——隐式回落等于用整车数字冒充个人结论。
       */
      const p: MemberUsageProfile = await memberProfileFallback(
        deps.trips,
        req.userId,
        memberId,
        now(),
        USAGE_WINDOW_DAYS,
        vin,
      );
      res.json({ kind: "driver", ...p });
    },
  );

  router.get("/v1/preferences", async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!deps.preferences) {
      res.status(503).json({ error: "memory_unconfigured", reason: "③偏好存储未接入" });
      return;
    }
    const r = await deps.preferences.list(req.userId, 20);
    // degraded 原样带出：端上据此说"读不到"，**不得当成"用户没有偏好"**。
    res.json({ preferences: r.items, degraded: r.degraded === true, reason: r.error });
  });

  /**
   * 删除本人的一条③偏好。
   *
   * 只删自己的：id 来自路径，而 `req.userId` 来自鉴权，归属校验在后端做（见接口注释）。
   * 幂等：已经不在了返回 404，端上按"本来就没了"处理即可，不必报错给用户。
   */
  router.delete("/v1/preferences/:id", async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!deps.preferences) {
      res.status(503).json({ error: "memory_unconfigured", reason: "③偏好存储未接入" });
      return;
    }
    if (!deps.preferences.remove) {
      // 后端不支持删除时**明说**，不返回 200——否则端上会把行删掉，刷新后它又回来了。
      res.status(501).json({ error: "delete_unsupported" });
      return;
    }
    const r = await deps.preferences.remove(req.userId, String(req.params.id));
    if (r.kind === "ok") {
      res.json({ deleted: true });
      return;
    }
    if (r.kind === "not_found") {
      res.status(404).json({ error: "preference_not_found" });
      return;
    }
    res.status(503).json({ error: "memory_degraded", reason: r.reason });
  });

  return router;
}
