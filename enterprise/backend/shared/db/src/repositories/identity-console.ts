/**
 * 用户体系的**后台只读**仓储（施工单 M68-01）。
 *
 * # 只给 `/console/*` 用——这是全仓唯一允许无键跨实体读的地方
 *
 * `user.ts` / `vehicle-grant.ts` / `device.ts` / `vehicle.ts` 的每个方法都刻意带
 * `userId` / `ownerId` / `vin` 键（M7-01 纪律：少一个条件读到的是别人家的数据）。
 * 运营面要的是"库里有几个账号、哪辆车授权给了谁、这台设备是谁的"——
 * 跨实体、无键、分页。把它塞进那几个文件，等于给端上路径顺手留一条无键入口，
 * 而且漏用的那一次不会有任何现象。所以另起一个文件，文件头就写明用途，
 * 端上代码 import 它是能被 review 一眼看出来的事。
 *
 * # 只读；写动作走既有仓储
 *
 * 撤销设备 / 撤销授权仍是 `DeviceRepository.revoke` / `VehicleGrantRepository.revoke`
 * ——软删的语义（R11：DB 软删是唯一真相源、下一请求失效）只在那里写一份。
 * 写端点区分 404 / 幂等 200 要用的按 id 单查（M68-02）也放在这里——仍是只读。
 *
 * # 分页一律复合游标
 *
 * 游标 = `<排序列 ISO>|<主键>`。`createdAt` 精确到毫秒，种子脚本一次插多行会撞同一毫秒，
 * 单列游标在同毫秒下会**静默丢行**——`identity-console.test.ts` 用同一毫秒插两行钉住。
 *
 * # 计数不做 N+1
 *
 * 列表每行的"名下车辆 n / 授权 n / 设备 n"用 `groupBy` 一次算完：
 * 一次请求的查询次数是固定的（主查询 + 固定几次 groupBy），不随行数增长。
 *
 * # 搜索的口径
 *
 * `contains` + `mode: "insensitive"` 在 PG 上走 `ILIKE`，`users.username` 只有 `@unique` 索引，
 * POC 数据量下全表扫可接受；流量大了再加 `pg_trgm`——不在本文件里预留。
 */

import { PrismaClient } from "@prisma/client";
import type { Device, DeviceType, GrantableRole } from "@carlife/shared";

import type { PublicUser } from "./user";

export interface IdentityOverview {
  users: number;
  vehicles: number;
  /** 生效授权**条数**（一人两车算两条），不是人数。 */
  activeGrants: { driver: number; passenger: number };
  /** 未撤销设备，按类型。车机记录的 `userId` 是绑定者，这里只按类型数。 */
  devices: { mobile: number; pad: number; cockpit: number };
  revokedDevices: number;
  /** 至少绑着一台未撤销车机的车辆数。 */
  vehiclesWithCockpit: number;
}

export interface IdentityPage<T> {
  rows: T[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface UserListRow extends PublicUser {
  createdAt: Date;
  ownedVehicles: number;
  activeGrants: number;
  /** 未撤销的**私人**终端数（不含他绑定的车机——那是车的设备，不是他的）。 */
  activeDevices: number;
  /** 其设备最近一次活跃时刻；一台设备都没有则为 null。 */
  lastActiveAt: Date | null;
}

export interface OwnedVehicleRow {
  vin: string;
  model: string;
  modelYear: number;
  energyType: string | null;
  isDefault: boolean;
  activeGrants: number;
  /** 绑着的未撤销车机数。 */
  cockpits: number;
}

export interface UserGrantRow {
  id: string;
  vin: string;
  role: GrantableRole;
  grantedAt: Date;
  revokedAt?: Date;
  vehicleModel: string | null;
  owner: PublicUser | null;
  /** 是否关联了影子档案（F-55-06）。只回布尔，档案内容不出本仓储（F-46-13）。 */
  linkedMember: boolean;
}

export interface UserDetail {
  user: PublicUser & { createdAt: Date };
  ownedVehicles: OwnedVehicleRow[];
  /** 含已撤销的，按授予时间倒序。 */
  grants: UserGrantRow[];
  /** 含已撤销、含其绑定的车机，按注册时间倒序。 */
  devices: Device[];
}

export interface VehicleListRow {
  vin: string;
  model: string;
  modelYear: number;
  energyType: string | null;
  isDefault: boolean;
  createdAt: Date;
  owner: PublicUser | null;
  activeGrants: number;
  cockpits: number;
}

export interface VehicleGrantRow {
  id: string;
  userId: string;
  user: PublicUser | null;
  role: GrantableRole;
  grantedAt: Date;
  revokedAt?: Date;
  linkedMember: boolean;
}

export interface VehicleDetail {
  vehicle: VehicleListRow & { odometerKm: number; purchasedAt: Date };
  owner: PublicUser | null;
  /** 含已撤销的，按授予时间倒序。车主**不在**这里——他不是授权。 */
  grants: VehicleGrantRow[];
  /** 绑过的车机，含已撤销。 */
  cockpits: Device[];
  /** 影子档案条数。**只有计数**：称呼 / 关系 / 手机号属他人 PII（F-46-13），要看去「客户座舱」。 */
  shadowMemberCount: number;
}

export interface DeviceListRow extends Device {
  user: PublicUser | null;
  vehicleModel?: string;
}

export type DeviceStatusFilter = "active" | "revoked" | "all";

export interface DevicePageQuery {
  type?: DeviceType;
  status: DeviceStatusFilter;
  userId?: string;
  vin?: string;
  limit: number;
  cursor?: string;
}

export interface IdentityConsoleRepository {
  overview(): Promise<IdentityOverview>;
  userPage(q: { q?: string; limit: number; cursor?: string }): Promise<IdentityPage<UserListRow>>;
  userDetail(id: string): Promise<UserDetail | null>;
  vehiclePage(q: { q?: string; limit: number; cursor?: string }): Promise<IdentityPage<VehicleListRow>>;
  vehicleDetail(vin: string): Promise<VehicleDetail | null>;
  devicePage(q: DevicePageQuery): Promise<IdentityPage<DeviceListRow>>;
  /**
   * 按 id 单查一台设备，**含已撤销**（M68-02）。`DeviceRepository.findActive` 只回未撤销的，
   * 分不出"不存在 → 404"与"已撤销 → 幂等 200"，写端点要的正是这个区分。
   */
  deviceById(id: string): Promise<Device | null>;
  /** 一条授权现在的状态（M68-02）：active / revoked / missing。 */
  grantState(userId: string, vin: string): Promise<RecordState>;
}

/** 一条记录现在的状态：给写端点区分"不存在 → 404"与"已撤销 → 幂等 200"。 */
export type RecordState = "active" | "revoked" | "missing";

// ── 游标 ────────────────────────────────────────────────────────────────

interface Cursor {
  at: Date;
  key: string;
}

export function encodeCursor(at: Date, key: string): string {
  return `${at.toISOString()}|${key}`;
}

/** 解析失败返回 undefined（当没传）：一个拼坏的游标不该让整页 500。 */
export function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined;
  const i = raw.indexOf("|");
  if (i <= 0) return undefined;
  const at = new Date(raw.slice(0, i));
  const key = raw.slice(i + 1);
  if (Number.isNaN(at.getTime()) || !key) return undefined;
  return { at, key };
}

/** `(排序列, 主键)` 严格小于游标：同一毫秒里按主键继续，不丢行。 */
function afterCursor(col: string, keyCol: string, c: Cursor | undefined): Record<string, unknown> {
  if (!c) return {};
  return { OR: [{ [col]: { lt: c.at } }, { [col]: c.at, [keyCol]: { lt: c.key } }] };
}

/** 去空；空串当没传——传空串给 `contains` 会命中"全部有值的"，与没筛看起来很像。 */
function trimmed(q: string | undefined): string | undefined {
  const t = q?.trim();
  return t ? t : undefined;
}

const INSENSITIVE = "insensitive" as const;

type DeviceRow = {
  id: string;
  userId: string;
  deviceType: string;
  modelName: string;
  vehicleVin: string | null;
  registeredAt: Date;
  lastActiveAt: Date;
  revokedAt: Date | null;
};

function toDevice(r: DeviceRow): Device {
  return {
    id: r.id,
    userId: r.userId,
    deviceType: r.deviceType as DeviceType,
    modelName: r.modelName,
    vehicleVin: r.vehicleVin ?? undefined,
    registeredAt: r.registeredAt,
    lastActiveAt: r.lastActiveAt,
    revokedAt: r.revokedAt ?? undefined,
  };
}

export function createIdentityConsoleRepository(prisma: PrismaClient): IdentityConsoleRepository {
  /** 与 `user.ts` 的 `publicByIds` 同形状；这里不依赖那个仓储，避免后台仓储反过来持有端上仓储。 */
  async function publicUsers(ids: readonly string[]): Promise<Map<string, PublicUser>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, username: true, displayName: true },
    });
    return new Map(
      rows.map((r) => [r.id, { id: r.id, username: r.username, displayName: r.displayName ?? undefined }]),
    );
  }

  /** 每辆车的生效授权数与未撤销车机数，各一次 groupBy。 */
  async function vehicleCounts(vins: readonly string[]) {
    const grants = new Map<string, number>();
    const cockpits = new Map<string, number>();
    if (vins.length === 0) return { grants, cockpits };
    const [g, d] = await Promise.all([
      prisma.vehicleGrant.groupBy({
        by: ["vin"],
        where: { vin: { in: [...vins] }, revokedAt: null },
        _count: { _all: true },
      }),
      prisma.device.groupBy({
        by: ["vehicleVin"],
        where: { vehicleVin: { in: [...vins] }, revokedAt: null },
        _count: { _all: true },
      }),
    ]);
    for (const row of g) grants.set(row.vin, row._count._all);
    for (const row of d) if (row.vehicleVin) cockpits.set(row.vehicleVin, row._count._all);
    return { grants, cockpits };
  }

  return {
    async overview() {
      const [users, vehicles, driver, passenger, mobile, pad, cockpit, revokedDevices, vehiclesWithCockpit] =
        await Promise.all([
          prisma.user.count(),
          prisma.vehicle.count(),
          prisma.vehicleGrant.count({ where: { role: "driver", revokedAt: null } }),
          prisma.vehicleGrant.count({ where: { role: "passenger", revokedAt: null } }),
          prisma.device.count({ where: { deviceType: "mobile", revokedAt: null } }),
          prisma.device.count({ where: { deviceType: "pad", revokedAt: null } }),
          prisma.device.count({ where: { deviceType: "cockpit", revokedAt: null } }),
          prisma.device.count({ where: { revokedAt: { not: null } } }),
          prisma.vehicle.count({ where: { devices: { some: { revokedAt: null } } } }),
        ]);
      return {
        users,
        vehicles,
        activeGrants: { driver, passenger },
        devices: { mobile, pad, cockpit },
        revokedDevices,
        vehiclesWithCockpit,
      };
    },

    async userPage({ q, limit, cursor }) {
      const term = trimmed(q);
      const search = term
        ? {
            OR: [
              { username: { contains: term, mode: INSENSITIVE } },
              { displayName: { contains: term, mode: INSENSITIVE } },
              { id: term },
            ],
          }
        : {};
      const rows = await prisma.user.findMany({
        where: { AND: [search, afterCursor("createdAt", "id", decodeCursor(cursor))] },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        select: { id: true, username: true, displayName: true, createdAt: true },
      });
      const page = rows.slice(0, limit);
      const ids = page.map((r) => r.id);
      const [veh, grants, devs] =
        ids.length === 0
          ? [[], [], []]
          : await Promise.all([
              prisma.vehicle.groupBy({ by: ["ownerId"], where: { ownerId: { in: ids } }, _count: { _all: true } }),
              prisma.vehicleGrant.groupBy({
                by: ["userId"],
                where: { userId: { in: ids }, revokedAt: null },
                _count: { _all: true },
              }),
              prisma.device.groupBy({
                by: ["userId"],
                where: { userId: { in: ids }, revokedAt: null, vehicleVin: null },
                _count: { _all: true },
                _max: { lastActiveAt: true },
              }),
            ]);
      const vehBy = new Map(veh.map((r) => [r.ownerId, r._count._all]));
      const grantBy = new Map(grants.map((r) => [r.userId, r._count._all]));
      const devBy = new Map(devs.map((r) => [r.userId, r]));
      const last = page[page.length - 1];
      return {
        rows: page.map((r) => ({
          id: r.id,
          username: r.username,
          displayName: r.displayName ?? undefined,
          createdAt: r.createdAt,
          ownedVehicles: vehBy.get(r.id) ?? 0,
          activeGrants: grantBy.get(r.id) ?? 0,
          activeDevices: devBy.get(r.id)?._count._all ?? 0,
          lastActiveAt: devBy.get(r.id)?._max.lastActiveAt ?? null,
        })),
        hasMore: rows.length > limit,
        nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    },

    async userDetail(id) {
      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, username: true, displayName: true, createdAt: true },
      });
      if (!user) return null;
      const [owned, grantRows, deviceRows] = await Promise.all([
        prisma.vehicle.findMany({
          where: { ownerId: id },
          orderBy: [{ isDefault: "desc" }, { purchasedAt: "desc" }],
          select: { vin: true, model: true, modelYear: true, energyType: true, isDefault: true },
        }),
        prisma.vehicleGrant.findMany({
          where: { userId: id },
          orderBy: { grantedAt: "desc" },
          include: { vehicle: { select: { model: true, ownerId: true } } },
        }),
        prisma.device.findMany({ where: { userId: id }, orderBy: { registeredAt: "desc" } }),
      ]);
      const [counts, owners] = await Promise.all([
        vehicleCounts(owned.map((v) => v.vin)),
        publicUsers(grantRows.map((g) => g.vehicle.ownerId)),
      ]);
      return {
        user: { id: user.id, username: user.username, displayName: user.displayName ?? undefined, createdAt: user.createdAt },
        ownedVehicles: owned.map((v) => ({
          vin: v.vin,
          model: v.model,
          modelYear: v.modelYear,
          energyType: v.energyType,
          isDefault: v.isDefault,
          activeGrants: counts.grants.get(v.vin) ?? 0,
          cockpits: counts.cockpits.get(v.vin) ?? 0,
        })),
        grants: grantRows.map((g) => ({
          id: g.id,
          vin: g.vin,
          role: g.role as GrantableRole,
          grantedAt: g.grantedAt,
          revokedAt: g.revokedAt ?? undefined,
          vehicleModel: g.vehicle.model,
          owner: owners.get(g.vehicle.ownerId) ?? null,
          linkedMember: g.vehicleMemberId !== null,
        })),
        devices: deviceRows.map((d) => toDevice(d as DeviceRow)),
      };
    },

    async vehiclePage({ q, limit, cursor }) {
      const term = trimmed(q);
      let search: Record<string, unknown> = {};
      if (term) {
        // 车主 username 模糊：先查人再 `ownerId in`。上限 50——搜"a"命中一千个人不是这个框的用法。
        const owners = await prisma.user.findMany({
          where: { username: { contains: term, mode: INSENSITIVE } },
          select: { id: true },
          take: 50,
        });
        search = {
          OR: [
            { vin: { startsWith: term.toUpperCase() } },
            { model: { contains: term, mode: INSENSITIVE } },
            ...(owners.length > 0 ? [{ ownerId: { in: owners.map((o) => o.id) } }] : []),
          ],
        };
      }
      const rows = await prisma.vehicle.findMany({
        where: { AND: [search, afterCursor("createdAt", "vin", decodeCursor(cursor))] },
        orderBy: [{ createdAt: "desc" }, { vin: "desc" }],
        take: limit + 1,
        select: {
          vin: true,
          model: true,
          modelYear: true,
          energyType: true,
          isDefault: true,
          createdAt: true,
          ownerId: true,
        },
      });
      const page = rows.slice(0, limit);
      const [counts, owners] = await Promise.all([
        vehicleCounts(page.map((v) => v.vin)),
        publicUsers(page.map((v) => v.ownerId)),
      ]);
      const last = page[page.length - 1];
      return {
        rows: page.map((v) => ({
          vin: v.vin,
          model: v.model,
          modelYear: v.modelYear,
          energyType: v.energyType,
          isDefault: v.isDefault,
          createdAt: v.createdAt,
          owner: owners.get(v.ownerId) ?? null,
          activeGrants: counts.grants.get(v.vin) ?? 0,
          cockpits: counts.cockpits.get(v.vin) ?? 0,
        })),
        hasMore: rows.length > limit,
        nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.vin) : null,
      };
    },

    async vehicleDetail(vin) {
      const v = await prisma.vehicle.findUnique({
        where: { vin },
        select: {
          vin: true,
          model: true,
          modelYear: true,
          energyType: true,
          isDefault: true,
          createdAt: true,
          ownerId: true,
          odometerKm: true,
          purchasedAt: true,
        },
      });
      if (!v) return null;
      const [grantRows, cockpitRows, shadowMemberCount] = await Promise.all([
        prisma.vehicleGrant.findMany({ where: { vin }, orderBy: { grantedAt: "desc" } }),
        prisma.device.findMany({ where: { vehicleVin: vin }, orderBy: { registeredAt: "desc" } }),
        // **只 count**：不 select 任何文本列（F-46-13）。
        prisma.vehicleMember.count({ where: { vin } }),
      ]);
      const [users, counts] = await Promise.all([
        publicUsers([v.ownerId, ...grantRows.map((g) => g.userId)]),
        vehicleCounts([vin]),
      ]);
      const owner = users.get(v.ownerId) ?? null;
      return {
        vehicle: {
          vin: v.vin,
          model: v.model,
          modelYear: v.modelYear,
          energyType: v.energyType,
          isDefault: v.isDefault,
          createdAt: v.createdAt,
          owner,
          activeGrants: counts.grants.get(vin) ?? 0,
          cockpits: counts.cockpits.get(vin) ?? 0,
          odometerKm: v.odometerKm,
          purchasedAt: v.purchasedAt,
        },
        owner,
        grants: grantRows.map((g) => ({
          id: g.id,
          userId: g.userId,
          user: users.get(g.userId) ?? null,
          role: g.role as GrantableRole,
          grantedAt: g.grantedAt,
          revokedAt: g.revokedAt ?? undefined,
          linkedMember: g.vehicleMemberId !== null,
        })),
        cockpits: cockpitRows.map((d) => toDevice(d as DeviceRow)),
        shadowMemberCount,
      };
    },

    async deviceById(id) {
      const row = await prisma.device.findUnique({ where: { id } });
      return row ? toDevice(row as DeviceRow) : null;
    },

    async grantState(userId, vin) {
      const row = await prisma.vehicleGrant.findUnique({
        where: { userId_vin: { userId, vin } },
        select: { revokedAt: true },
      });
      if (!row) return "missing";
      return row.revokedAt ? "revoked" : "active";
    },

    async devicePage({ type, status, userId, vin, limit, cursor }) {
      const where: Record<string, unknown> = {
        ...(type ? { deviceType: type } : {}),
        ...(status === "active" ? { revokedAt: null } : status === "revoked" ? { revokedAt: { not: null } } : {}),
        ...(trimmed(userId) ? { userId: trimmed(userId) } : {}),
        ...(trimmed(vin) ? { vehicleVin: trimmed(vin) } : {}),
      };
      const rows = await prisma.device.findMany({
        where: { AND: [where, afterCursor("registeredAt", "id", decodeCursor(cursor))] },
        orderBy: [{ registeredAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });
      const page = rows.slice(0, limit);
      const vins = [...new Set(page.map((d) => d.vehicleVin).filter((x): x is string => Boolean(x)))];
      const [users, vehicles] = await Promise.all([
        publicUsers(page.map((d) => d.userId)),
        vins.length === 0
          ? Promise.resolve([] as Array<{ vin: string; model: string }>)
          : prisma.vehicle.findMany({ where: { vin: { in: vins } }, select: { vin: true, model: true } }),
      ]);
      const modelBy = new Map(vehicles.map((v) => [v.vin, v.model]));
      const last = page[page.length - 1];
      return {
        rows: page.map((d) => {
          const dev = toDevice(d as DeviceRow);
          const model = d.vehicleVin ? modelBy.get(d.vehicleVin) : undefined;
          return { ...dev, user: users.get(d.userId) ?? null, ...(model ? { vehicleModel: model } : {}) };
        }),
        hasMore: rows.length > limit,
        nextCursor: rows.length > limit && last ? encodeCursor(last.registeredAt, last.id) : null,
      };
    },
  };
}
