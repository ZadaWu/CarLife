/**
 * ④车辆档案端点（施工单 M14-04，F-01-06 档案 tab 的数据面 / F-23-05 建档地基）。
 *
 * GET  /v1/vehicles               → 当前用户全部车辆，默认车排最前
 * POST /v1/vehicles               → 建档 / 更新（vin 缺省时生成占位 VIN，见下）
 * POST /v1/vehicles/:vin/default  → 设默认车
 * POST /v1/vehicles/:vin/odometer → 里程上报（只前进）
 *
 * # 网关红线：薄转发 + 治理，不含业务逻辑
 *
 * 校验（VIN 格式 / 里程 / 年款）是治理，留在这里；推算、判定不在这里做。
 *
 * # 建档不过权限门，但归属校验一步不少
 *
 * 权限门管的是 **Agent 替用户做事**；用户在自己设备上填表建档是用户自己做事，
 * 不经 LLM、不弹确认。但 `ownerId` 只认鉴权上下文、按 VIN 写前校验归属——
 * 跨用户读改档案是严重事故（M7-01 同一条纪律）。
 *
 * # 占位 VIN（M14-05 向导的落地方案 b）
 *
 * 建档向导首启不采集 VIN（Brief 定稿）。`Vehicle` 表以 VIN 为主键，
 * 所以无 VIN 建档由服务端生成 `PEND-` 前缀占位主键——**含 `-`，
 * 永不可能与真实 VIN（17 位字母数字）冲突**，也过不了 isValidVin，
 * 因此不会被当成真 VIN 流入检索文案。补录真 VIN 是后续动作（M14-05 占位说明）。
 */

import { randomUUID } from "node:crypto";

import { Router, json } from "express";
import type { Response } from "express";

import {
  forecastMaintenance,
  isEnergyType,
  isValidVin,
  type VehicleProfile,
  type VehicleStore,
} from "@carlife/memory";
import type { VehicleKnowledge } from "@carlife/shared";

import type { AuthedRequest } from "../auth";

/** 占位 VIN 前缀。判据函数导出：端上要靠它决定"补充 VIN"入口显不显示。 */
export const PENDING_VIN_PREFIX = "PEND-";

export function isPendingVin(vin: string): boolean {
  return vin.startsWith(PENDING_VIN_PREFIX);
}

function makePendingVin(): string {
  return `${PENDING_VIN_PREFIX}${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}

interface UpsertBody {
  vin?: string;
  model?: string;
  modelYear?: number;
  /** 购车时间（Unix ms）。Brief 只采集到月，端上传该月 1 号。 */
  purchasedAt?: number;
  odometerKm?: number;
  maintenanceIntervalKm?: number;
  energyType?: string;
}

const THIS_YEAR = () => new Date().getFullYear();

/** 校验并归一化建档请求；返回错误串或 null。**校验规则与端上向导一致**（Brief §2）。 */
function validateUpsert(b: UpsertBody): string | null {
  if (!b.model?.trim()) return "model 必填";
  if (typeof b.modelYear !== "number" || b.modelYear < 1990 || b.modelYear > THIS_YEAR() + 1) {
    return "modelYear 非法";
  }
  if (typeof b.purchasedAt !== "number" || b.purchasedAt <= 0 || b.purchasedAt > Date.now()) {
    return "purchasedAt 非法（未来时间不能是购车时间）";
  }
  if (typeof b.odometerKm !== "number" || b.odometerKm < 0 || b.odometerKm > 2_000_000) {
    return "odometerKm 非法";
  }
  if (b.maintenanceIntervalKm !== undefined) {
    if (typeof b.maintenanceIntervalKm !== "number" || b.maintenanceIntervalKm <= 0) {
      return "maintenanceIntervalKm 非法";
    }
  }
  // 能源类型：**非法值直接拒绝而不是写成 undefined**——
  // 端上传错词是接线 bug，静默吞掉会让"不知道"和"传错了"不可区分。
  if (b.energyType !== undefined && !isEnergyType(b.energyType)) return "energyType 非法";
  return null;
}

/**
 * 车型 → 关联到的知识库资料（M14-08）。**可选注入**：
 * 未接知识库时字段缺席，端上据此说"读不到"，而不是说"没有资料"。
 */
export type KnowledgeLookup = (model: string) => Promise<VehicleKnowledge>;

/**
 * 车主自助写路径的留痕（施工单 M29-01，AC-23-9）。**可选注入**，与 knowledge 同款取向：
 * 既有测试直接构造 store 调 router，不被迫全改签名；未注入时四条路由行为与此前逐字节相同。
 *
 * 只在**写入实际发生或被业务规则拒绝**时调用：校验失败（400）与归属未命中（404）不记——
 * 前者没有发生写入，后者写进去会把变更记录页弄成访问日志。
 * detail 只记字段名与数值摘要，不记自由文本原文（M3-01 边界）。
 */
export interface VehicleAuditEntry {
  action: string;
  vin: string;
  ownerId: string;
  result: "ok" | "denied";
  detail?: Record<string, unknown>;
}
export type VehicleAudit = (entry: VehicleAuditEntry) => void;

/**
 * 占位 VIN → 真 VIN 的主键迁移（M29-04）。**可选注入**：实现是 `enterprise/backend/shared/db`
 * 仓储的扩展方法（刻意不进 `VehicleStore`），既有测试不被迫实现它。
 * 未注入时补录端点返回 503——"没接"与"不允许"要可区分。
 */
export type ReplaceVin = (oldVin: string, newVin: string) => Promise<VehicleProfile>;

/**
 * 被授权使用（非自有）的车辆查询（M48-03，F-55-05）。
 *
 * **可选注入**：不注入时列表退化成"只有自己名下的"，即 M48-03 之前的行为——
 * 既有测试不必为此各造一份授权仓储。注入了才有"拥有 ∪ 被授权"的完整口径。
 */
export type GrantedVinsOf = (userId: string) => Promise<Array<{ vin: string; role: string }>>;

/**
 * 变更记录的读端（M29-05）。**可选注入**，形状是 `audit.page` 的裁剪——
 * 路由只需要按 target 翻页这一种查询，注入整个仓储会把 admin 侧查询能力也递进来。
 */
export interface AuditPageQuery {
  target: string;
  limit: number;
  cursor?: string;
}
export interface AuditPageRow {
  id: string;
  at: string;
  actorRole: string;
  action: string;
  result: string;
  detail: Record<string, unknown> | null;
}
export type AuditReader = (
  q: AuditPageQuery,
) => Promise<{ entries: AuditPageRow[]; hasMore: boolean; nextCursor: string | null }>;

/**
 * 动作白名单：变更记录页只回答"谁改了**档案**"。同一辆车的 vin 未来可能成为
 * 其他子系统审计的 target（车机绑定等），混进来会让这个问题失焦。
 * M29 各写入方 + M26 对话补录的 action 都在 `vehicle.` 前缀下。
 */
const PROFILE_CHANGE_ACTIONS = new Set([
  "vehicle.upsert",
  "vehicle.set_default",
  "vehicle.odometer",
  "vehicle.maintenance.append",
  "vehicle.vin.backfill",
  "vehicle.elicitation.fill",
]);

const FIELD_LABEL: Record<string, string> = {
  model: "车型",
  modelYear: "年款",
  purchasedAt: "购入时间",
  odometerKm: "里程",
  maintenanceIntervalKm: "保养周期",
  energyType: "动力形式",
};

/**
 * 把一条审计行拼成给车主看的一句话。**detail 不透传**——它的形状是各写入方的
 * 内部契约，原样丢给前端就把它变成了对外契约。
 */
export function changeSummary(row: Pick<AuditPageRow, "action" | "result" | "detail">): string {
  const d = row.detail ?? {};
  const km = d.odometerKm as [number, number] | undefined;
  const kmText = km ? `${Math.round(km[0]).toLocaleString()} → ${Math.round(km[1]).toLocaleString()} km` : "";
  switch (row.action) {
    case "vehicle.upsert": {
      if (d.created) return "建立了车辆档案";
      const fields = Array.isArray(d.fields) ? (d.fields as string[]) : [];
      const names = fields.map((f) => FIELD_LABEL[f] ?? f).join("、");
      return `修改了档案${names ? `（${names}）` : ""}${km ? `：里程 ${kmText}` : ""}`;
    }
    case "vehicle.set_default":
      return "设为默认车";
    case "vehicle.odometer":
      return row.result === "denied"
        ? `上报的里程低于当前值，未生效（${kmText}）`
        : `更新里程 ${kmText}`;
    case "vehicle.maintenance.append":
      return "记了一笔保养";
    case "vehicle.vin.backfill":
      return "补录了 VIN";
    case "vehicle.elicitation.fill": {
      if (row.result !== "ok") return "对话补录未获确认，没有写入";
      const written = Array.isArray(d.written) ? (d.written as string[]) : [];
      const names = written.map((f) => (f === "maintenance" ? "保养记录" : (FIELD_LABEL[f] ?? f))).join("、");
      return `对话里确认后写入档案${names ? `（${names}）` : ""}`;
    }
    default:
      return row.action;
  }
}

export function createVehicleRouter(
  store: VehicleStore,
  knowledge?: KnowledgeLookup,
  audit?: VehicleAudit,
  replaceVin?: ReplaceVin,
  auditReader?: AuditReader,
  grantedVinsOf?: GrantedVinsOf,
): Router {
  const router = Router();

  router.get("/v1/vehicles", async (req: AuthedRequest, res: Response) => {
    /*
     * 绑定车机的读法（M54-07，2026-09-01 走查"档案页 unauthorized"）。
     *
     * 车辆级 token 不代表任何人（R4），走不了下面"拥有 ∪ 被授权"的按人列表；
     * 但它**明确绑着一辆车**（鉴权中间件已核实 findActive 且 vin 一致），
     * 读这一辆的档案天经地义——R7 禁的是车机**写**车辆档案，读不在其列。
     * 此前没有这个分支，车机档案页恒 401，界面又把它说成"网关不可达"。
     *
     * myRole 给 "cockpit"：它不是 owner/driver/passenger 里的任何一个，
     * 谎报成 owner 会让端上渲染管理入口（driver 管理已按 myRole 裁剪）。
     * 端上判管理入口用 `=== "owner"`，任何新值都落在"不渲染"一侧。
     */
    if (!req.userId && req.vehicleVin) {
      const profile = await store.get(req.vehicleVin);
      // 空列表就是空列表（还没建档是常态）；形状与按人列表完全一致。
      if (!profile) {
        res.json({ vehicles: [] });
        return;
      }
      const link = knowledge ? await knowledge(profile.model) : undefined;
      res.json({
        vehicles: [{
          ...profile,
          myRole: "cockpit",
          ...(link ? { knowledge: link } : {}),
          forecast: forecastMaintenance(profile),
        }],
      });
      return;
    }
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    // 空列表就是空列表（200 []）：还没建档是常态不是异常，404 会让端上反复告警。
    const owned = await store.listByOwner(req.userId);
    /*
     * M48-03（F-55-05，AC-55-3）：列表 = **拥有的 ∪ 被授权的**。
     *
     * 只列自己名下的车，被分享的那辆就永远不出现——而叶琳（P-11）的整个使用
     * 场景就是开丈夫名下的车。取不到授权车的档案时跳过而不是塞个占位：
     * 档案读失败是"读不到"，不是"这辆车没了"。
     */
    const grantedRoles = new Map<string, string>();
    const grantedProfiles: VehicleProfile[] = [];
    if (grantedVinsOf) {
      for (const g of await grantedVinsOf(req.userId)) {
        if (owned.some((v) => v.vin === g.vin)) continue;
        const profile = await store.get(g.vin);
        if (!profile) continue;
        grantedRoles.set(g.vin, g.role);
        grantedProfiles.push(profile);
      }
    }
    const vehicles = [...owned, ...grantedProfiles];
    /*
     * 关联关系随档案带出（M14-08）：档案页要能回答"这辆车有没有对应的知识库"。
     * 底下是同一个带缓存的 provider，多辆车只会打一次 RAGFlow。
     * 拉不到时 knowledge.state = unavailable —— **不折叠成"没有资料"**。
     */
    const links = knowledge
      ? await Promise.all(vehicles.map((v) => knowledge(v.model)))
      : undefined;
    res.json({
      vehicles: vehicles.map((v, i) => ({
        ...v,
        // 本人对这辆车的角色：端上据此决定"我的车"还是"使用中·车主某某"，
        // 以及要不要渲染管理入口（driver 看不到管理入口，不是点开被拒）。
        myRole: grantedRoles.get(v.vin) ?? "owner",
        ...(links ? { knowledge: links[i] } : {}),
        /*
         * 保养推算随档案带出（M14-05）：常态页要"数值与依据同一视区"（Brief §2），
         * 端上**不另写一套推算**（M14-05 红线）。复用 forecastMaintenance 是
         * 网关红线允许的"确定性规则"，不是业务编排。
         * 日均里程这里拿不到（⑥画像在 Mem0，不属于本端点）→ etaDays 缺席，
         * 端上据此只显示剩余公里、不显示到期时间——**不猜**。
         */
        forecast: forecastMaintenance(v),
      })),
    });
  });

  router.post("/v1/vehicles", json(), async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const body = (req.body ?? {}) as UpsertBody;
    const problem = validateUpsert(body);
    if (problem) {
      res.status(400).json({ error: "invalid_body", detail: problem });
      return;
    }

    let vin: string;
    let existing: VehicleProfile | null = null;
    if (body.vin?.trim()) {
      vin = body.vin.trim().toUpperCase();
      // 占位 VIN 允许原样回传（编辑既有档案）；真实 VIN 必须过格式校验。
      if (!isPendingVin(vin) && !isValidVin(vin)) {
        res.status(400).json({ error: "invalid_vin", detail: "VIN 应为 17 位，不含 I/O/Q" });
        return;
      }
      existing = await store.get(vin);
      if (existing && existing.ownerId !== req.userId) {
        // 不区分"存在但不属于你"与"格式对但被占用"，不泄露他人车辆存在性。
        res.status(409).json({ error: "vin_conflict" });
        return;
      }
      // 里程只前进的纪律在编辑路径同样成立：upsert 不该成为改小里程的后门。
      if (existing && typeof body.odometerKm === "number" && body.odometerKm < existing.odometerKm) {
        res.status(400).json({
          error: "odometer_backwards",
          detail: `里程不能低于已有记录（${existing.odometerKm}km）`,
        });
        return;
      }
    } else {
      vin = makePendingVin();
    }

    const profile: VehicleProfile = {
      vin,
      ownerId: req.userId,
      model: body.model!.trim(),
      modelYear: body.modelYear!,
      purchasedAt: body.purchasedAt!,
      odometerKm: body.odometerKm!,
      maintenanceIntervalKm: body.maintenanceIntervalKm,
      energyType: body.energyType as VehicleProfile["energyType"],
      maintenance: [],
      repairs: [],
      updatedAt: Date.now(),
    };
    await store.upsert(profile);

    // 唯一一辆车自动设为默认：向导建完第一辆就该"有默认车"，
    // 否则检索侧拿不到车型限定，而用户根本不知道还有"设默认"这一步。
    const all = await store.listByOwner(req.userId);
    if (all.length === 1) {
      await store.setDefault(req.userId, vin);
    }

    const fresh = await store.get(vin);
    // 留痕（M29-01）：新建记 created，编辑记改了哪些字段名；里程带 [旧,新] 数值摘要。
    if (audit) {
      const fields = existing
        ? (["model", "modelYear", "purchasedAt", "odometerKm", "maintenanceIntervalKm", "energyType"] as const).filter(
            (k) => existing![k] !== profile[k],
          )
        : [];
      audit({
        action: "vehicle.upsert",
        vin,
        ownerId: req.userId,
        result: "ok",
        detail: {
          created: !existing,
          fields,
          ...(existing && existing.odometerKm !== profile.odometerKm
            ? { odometerKm: [existing.odometerKm, profile.odometerKm] }
            : {}),
        },
      });
    }
    res.status(201).json({ vehicle: fresh, pendingVin: isPendingVin(vin) });
  });

  router.post("/v1/vehicles/:vin/default", async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      // setDefault 自带归属校验：vin 不属于该 owner 时抛错，不静默改别人的车。
      const vehicle = await store.setDefault(req.userId, String(req.params.vin));
      // 404 路径不记：未命中归属的探测不是"档案被修改"（M29-01）。
      audit?.({ action: "vehicle.set_default", vin: vehicle.vin, ownerId: req.userId, result: "ok" });
      res.json({ vehicle });
    } catch {
      res.status(404).json({ error: "vehicle_not_found" });
    }
  });

  router.post("/v1/vehicles/:vin/odometer", json(), async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const vin = String(req.params.vin);
    const km = (req.body as { odometerKm?: unknown })?.odometerKm;
    if (typeof km !== "number" || km < 0 || km > 2_000_000) {
      res.status(400).json({ error: "invalid_body", detail: "odometerKm 非法" });
      return;
    }
    const existing = await store.get(vin);
    if (!existing || existing.ownerId !== req.userId) {
      res.status(404).json({ error: "vehicle_not_found" });
      return;
    }
    // 旧值必须在推进**之前**取出：store.get 不保证返回副本，推进后再读就是新值。
    const prevKm = existing.odometerKm;
    // 只前进：变小的上报由仓储忽略（返回的档案让端上看到真实值）。
    const vehicle = await store.advanceOdometer(vin, km);
    if (km > prevKm) {
      audit?.({
        action: "vehicle.odometer",
        vin,
        ownerId: req.userId,
        result: "ok",
        detail: { odometerKm: [prevKm, km] },
      });
    } else {
      // 被"只前进"规则忽略的上报也留痕：这是用户视角"我改了但没生效"的唯一解释来源。
      audit?.({
        action: "vehicle.odometer",
        vin,
        ownerId: req.userId,
        result: "denied",
        detail: { odometerKm: [prevKm, km], reason: "odometer_backwards_ignored" },
      });
    }
    res.json({ vehicle });
  });

  /*
   * 手动记一笔保养（施工单 M29-03，F-23-03 / F-23-11）。
   *
   * **不过权限门**：用户在自己设备上亲手填表是用户自己做事（M14-04 文件头的既有裁定）；
   * 对话路径（`vehicle_profile_write` 工具）才走权限门确认。
   *
   * ⚠️ **里程必须先写**（M26-04 真跑踩过）：`appendMaintenance` 会顺带推进里程，
   * 但它推的那一次不带来源——先写保养的话，等轮到 advanceOdometer 时里程已经
   * 等于目标值，"只前进"判定跳过，`odometerSource` 永远是空。
   */
  router.post("/v1/vehicles/:vin/maintenance", json(), async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const vin = String(req.params.vin);
    const body = (req.body ?? {}) as { at?: unknown; odometerKm?: unknown; items?: unknown };

    // 未来的保养时间不能是保养记录（同 validateUpsert 对 purchasedAt 的取向）。
    if (typeof body.at !== "number" || body.at <= 0 || body.at > Date.now()) {
      res.status(400).json({ error: "invalid_body", detail: "at 非法（未来时间不能是保养时间）" });
      return;
    }
    if (typeof body.odometerKm !== "number" || body.odometerKm < 0 || body.odometerKm > 2_000_000) {
      res.status(400).json({ error: "invalid_body", detail: "odometerKm 非法" });
      return;
    }
    if (typeof body.items !== "string" || !body.items.trim()) {
      res.status(400).json({ error: "invalid_body", detail: "items 必填（做了什么保养）" });
      return;
    }

    const existing = await store.get(vin);
    if (!existing || existing.ownerId !== req.userId) {
      res.status(404).json({ error: "vehicle_not_found" });
      return;
    }

    // 补录旧保养单（odometerKm < 当前表显）是合法场景：此时不推进里程、只落记录。
    if (body.odometerKm > existing.odometerKm) {
      await store.advanceOdometer(vin, body.odometerKm, "owner-manual");
    }
    const vehicle = await store.appendMaintenance(vin, {
      at: body.at,
      odometerKm: body.odometerKm,
      items: body.items.trim(),
      source: "owner-manual",
    });

    // 留痕（M29-01 注入口）。items 是用户自由文本，全文不进 detail（M3-01 边界）。
    audit?.({
      action: "vehicle.maintenance.append",
      vin,
      ownerId: req.userId,
      result: "ok",
      detail: { at: body.at, odometerKm: body.odometerKm, itemsLength: body.items.trim().length },
    });

    // 与 GET /v1/vehicles 同款：推算随档案带出，端上一次拿全、不另写一套推算。
    res.status(201).json({ vehicle: { ...vehicle, forecast: forecastMaintenance(vehicle) } });
  });

  /*
   * 占位 VIN → 真 VIN 补录（施工单 M29-04，F-23-05 / F-23-11）。
   *
   * **只接受 `isPendingVin(当前) === true` 的车**：真 VIN 换真 VIN 是过户/录错，
   * 另一件事，本入口拒绝并说清。目标已存在时不区分"被占用"与"属于别人"
   * （同 upsert 的不泄露纪律）。迁移本体在仓储（全有或全无），语义校验在这里。
   */
  router.post("/v1/vehicles/:vin/vin", json(), async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!replaceVin) {
      res.status(503).json({ error: "vin_backfill_unavailable", detail: "VIN 补录能力未接入" });
      return;
    }
    const oldVin = String(req.params.vin);
    const raw = (req.body as { vin?: unknown })?.vin;
    const newVin = typeof raw === "string" ? raw.trim().toUpperCase() : "";

    const existing = await store.get(oldVin);
    if (!existing || existing.ownerId !== req.userId) {
      res.status(404).json({ error: "vehicle_not_found" });
      return;
    }
    if (!isPendingVin(oldVin)) {
      res.status(409).json({
        error: "vin_already_set",
        detail: "这辆车已有 VIN。换 VIN 属于过户流程，本入口不受理。",
      });
      return;
    }
    if (!isValidVin(newVin)) {
      res.status(400).json({ error: "invalid_vin", detail: "VIN 应为 17 位，不含 I/O/Q" });
      return;
    }
    if (await store.get(newVin)) {
      res.status(409).json({ error: "vin_conflict" });
      return;
    }

    const vehicle = await replaceVin(oldVin, newVin);
    // target 记**新** vin：变更记录页按现 VIN 过滤；旧占位值进 detail 供跟查（M29-05）。
    audit?.({
      action: "vehicle.vin.backfill",
      vin: newVin,
      ownerId: req.userId,
      result: "ok",
      detail: { from: oldVin },
    });
    res.json({ vehicle: { ...vehicle, forecast: forecastMaintenance(vehicle) } });
  });

  /*
   * 档案变更记录（施工单 M29-05，F-23-11 / AC-23-9 的"留痕可见"一跳）。
   *
   * 车主视角端点：只回自己车的、只回档案类动作（白名单）。不提供任何过滤参数
   * 透传——车主不需要，开了就是给未来的越权查询留口子。actorRole 的用户措辞
   * （owner→"我自己"）在端上翻译，服务端只给角色值。
   *
   * # VIN 补录前的历史（跟查一层）
   *
   * 补录前的留痕 target 是旧 `PEND-` 值。改写审计行违反追加式红线（禁止），
   * 所以读侧跟查：本页出现 `vin.backfill` 且带 `detail.from` 时，对旧值再查一轮
   * 并入结果。只跟一层——占位 VIN 只会被补录一次（补录端点保证）。
   * 跟查条目并入**末页**：backfill 之前的事件都记在旧 vin 上，所以 backfill
   * 必然是新 vin 下最老的一条、必然落在最后一页——"末页且看到 backfill 才跟查"
   * 因此是精确条件而不是近似。nextCursor 语义保持在主查询上。
   */
  router.get("/v1/vehicles/:vin/changes", async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!auditReader) {
      res.status(503).json({ error: "changes_unavailable", detail: "变更记录能力未接入" });
      return;
    }
    const vin = String(req.params.vin);
    const existing = await store.get(vin);
    if (!existing || existing.ownerId !== req.userId) {
      res.status(404).json({ error: "vehicle_not_found" });
      return;
    }
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const page = await auditReader({ target: vin, limit: 50, cursor });

    let rows = page.entries.filter((e) => PROFILE_CHANGE_ACTIONS.has(e.action));
    // 跟查一层（见上）：末页 + 看到 backfill 才触发——这是精确条件，见路由头注释。
    const backfill = rows.find((e) => e.action === "vehicle.vin.backfill");
    const from = backfill?.detail?.from;
    if (typeof from === "string" && from && !page.hasMore) {
      const old = await auditReader({ target: from, limit: 50 });
      rows = rows.concat(old.entries.filter((e) => PROFILE_CHANGE_ACTIONS.has(e.action)));
      rows.sort((a, b) => (a.at < b.at ? 1 : -1));
    }

    res.json({
      changes: rows.map((e) => ({
        id: e.id,
        at: e.at,
        actorRole: e.actorRole,
        action: e.action,
        summary: changeSummary(e),
      })),
      nextCursor: page.hasMore ? page.nextCursor : null,
    });
  });

  return router;
}
