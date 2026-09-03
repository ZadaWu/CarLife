/**
 * 车辆状态与设置应用。
 *
 * # 这里只有"设置值"，没有"偏好"
 *
 * 本服务不知道副驾是妈妈还是小宝，只知道空调 23 度、座椅加热 2 档。
 * "冬天该几度、孩子在车上要不要锁屏"是 CarLife Agent 的偏好体系翻译出来的，
 * 翻译结果落到这里就是一组普通的设置操作。设备保持哑，偏好才换得掉。
 *
 * # 逐字段裁决，不整单成败
 *
 * 一次 apply 常是一个"场景"（主驾 22 度 + 座椅加热 + 氛围灯调暗）。
 * 某一项越界或此车不支持时，整单拒绝会让其它项白白失效；静默吞掉则更糟——
 * 上游会告诉用户"都设好了"，而车里什么都没变。所以每个字段单独裁决：
 * 越界的**夹到边界并说明**（clamped）、不支持的**跳过并说明**（skipped），
 * 上游拿着逐字段结果才说得出"座椅通风这款车没有，其它都已设好"。
 *
 * # 唯一的安全域出口
 *
 * 儿童锁**只能上、不能解**：解锁需要车内物理操作，远程解除属安全域，
 * 本服务直接拒绝（`safety_domain`）。这是舒适域 mock 里刻意保留的一条边界，
 * 让"安全域不可远程触碰"在设备层也成立，而不只是 Agent 侧的一条规则。
 */

import { advanceEnergy, initEnergy, overrideEnergy, rehydrateEnergy, type EnergyOverride, type EnergyState } from "./energy";
import { installExitHooks, load, markDirty, SNAPSHOT_VERSION, snapshotPath, type Snapshot } from "./persistence";
import {
  capsForModel,
  type AmbientZone,
  type CabinCapabilities,
  type ClimateZone,
  type MediaZone,
  type SeatZone,
} from "./capabilities";

// ── 状态形状 ────────────────────────────────────────────────

export interface ClimateState {
  tempC: number;
  fanLevel: number;
  mode: "auto" | "cool" | "heat" | "fanOnly";
  recirculation: boolean;
}

export interface SeatState {
  heating: number;
  ventilation: number;
  massage: string;
}

export interface AmbientState {
  color: string;
  brightness: number;
  mode: string;
}

export interface MediaState {
  source: string;
  volume: number;
  /** null = 无上限。设了之后，后续 volume 超限会被夹下来。 */
  volumeLimit: number | null;
  /** 设备不真播流，只记录"在放什么"（如"儿歌"），供端上显示。 */
  contentTag: string | null;
}

export interface CabinState {
  climate: Partial<Record<ClimateZone, ClimateState>>;
  climateSync: boolean;
  seats: Record<SeatZone, SeatState>;
  ambientLight: Partial<Record<AmbientZone, AmbientState>>;
  media: Partial<Record<MediaZone, MediaState>>;
  /** null = 此车型无香氛。 */
  fragrance: { intensity: string; scent: string } | null;
  childMode: Partial<Record<SeatZone, { screenLock: boolean; childLock: boolean }>>;
}

export interface Change {
  seq: number;
  at: string;
  domain: string;
  zone: string;
  field: string;
  from: unknown;
  to: unknown;
}

export interface VehicleRecord {
  vehicleId: string;
  model: string;
  caps: CabinCapabilities;
  state: CabinState;
  changes: Change[];
  /** 能量遥测（电量/油量仿真）。独立于设置与流水，见 energy.ts 文件头。 */
  energy: EnergyState;
  updatedAt: string;
}

// ── 应用请求/结果的形状（即对外接口的核心契约）──────────────

export interface CabinOp {
  domain?: string;
  /** 省略 = "all"（该域此车支持的全部分区）。 */
  zone?: string;
  set?: Record<string, unknown>;
}

export interface OpResult {
  index: number;
  domain: string;
  /** 实际落到的分区（"all" 展开之后）。 */
  zones: string[];
  status: "applied" | "partial" | "rejected" | "invalid";
  /** 最终写入的值（多分区时同值）。 */
  applied: Record<string, unknown>;
  /** 被夹到边界的字段：要什么、给了什么、为什么。 */
  clamped: Record<string, { requested: unknown; applied: unknown; note: string }>;
  /** 被跳过的字段与原因（此车不支持 / 未知字段 / 安全域）。 */
  skipped: Record<string, string>;
  reason?: string;
}

// ── 存储 ────────────────────────────────────────────────────

/**
 * 进程内存 + 本地快照文件（`persistence.ts`）。
 *
 * 仍然不占我们的 PG——落的是这辆车自己的一个 JSON，理由见 `persistence.ts` 文件头。
 * 内存是唯一的读路径，磁盘只是它的镜像：每次变更后 `persist()` 把整份写回去，
 * 启动时反过来灌回内存。**读操作一律不碰磁盘**，热路径不受落盘影响。
 */
const vehicles = new Map<string, VehicleRecord>();
/**
 * requestId → 上次 apply 的完整结果。同一次确认网络重发不改第二遍状态。
 *
 * **刻意不落盘**：它防的是"用户点了确认、网络重发"这种秒级重试，
 * 而跨重启的重发不存在（连接早断了）。存下来只会无界增长。
 */
const byRequestId = new Map<string, unknown>();
let changeSeq = 0;
let vehicleSeq = 0;

/** 车辆 id 由本服务发号——车是在这里"造"出来的，上游拿到 id 再存进自己的档案。 */
export function newVehicleId(): string {
  vehicleSeq += 1;
  return `VEH-${String(vehicleSeq).padStart(6, "0")}`;
}

/**
 * 每辆车保留多少条变更流水（环形，超了从头丢）。
 *
 * 落盘之前是 100——反正重启就没了，留多留少无所谓。现在它是**唯一一份**
 * 设置变更历史（后台「客户座舱」页直读它），100 条在一次演示里就会被挤掉，
 * 所以放宽到 500。上限存在的理由不变：快照要整份写，无界增长会让写入越来越慢。
 * 按一条约 120 字节算，500 条 × 几辆车仍是几十 KB。
 */
const MAX_CHANGES = Number(process.env.CABIN_MAX_CHANGES ?? 500);

export function defaultState(caps: CabinCapabilities): CabinState {
  const climate: CabinState["climate"] = {};
  for (const z of caps.climate.zones) {
    climate[z] = { tempC: 22, fanLevel: 2, mode: "auto", recirculation: false };
  }
  const seats = {} as Record<SeatZone, SeatState>;
  for (const z of Object.keys(caps.seats) as SeatZone[]) {
    seats[z] = { heating: 0, ventilation: 0, massage: "off" };
  }
  const ambient: CabinState["ambientLight"] = {};
  for (const z of caps.ambientLight.zones) {
    ambient[z] = { color: "#7AA2FF", brightness: 30, mode: "static" };
  }
  const media: CabinState["media"] = {};
  for (const z of caps.media.zones) {
    media[z] = { source: "off", volume: 20, volumeLimit: null, contentTag: null };
  }
  const childMode: CabinState["childMode"] = {};
  for (const z of caps.childMode.zones) {
    childMode[z] = { screenLock: false, childLock: false };
  }
  return {
    climate,
    climateSync: false,
    seats,
    ambientLight: ambient,
    media,
    fragrance: caps.fragrance.present ? { intensity: "off", scent: caps.fragrance.scents[0] ?? "" } : null,
    childMode,
  };
}

export function getVehicle(vehicleId: string): VehicleRecord | undefined {
  return vehicles.get(vehicleId);
}

export function createVehicle(vehicleId: string, model: string): VehicleRecord {
  const caps = capsForModel(model);
  const record: VehicleRecord = {
    vehicleId,
    model: caps.model,
    caps,
    state: defaultState(caps),
    changes: [],
    energy: initEnergy(vehicleId, caps.model, Date.now()),
    updatedAt: new Date().toISOString(),
  };
  vehicles.set(vehicleId, record);
  persist();
  return record;
}

export function resetVehicle(record: VehicleRecord): void {
  record.state = defaultState(record.caps);
  record.updatedAt = new Date().toISOString();
  pushChange(record, "system", "-", "reset", null, null);
}

function pushChange(record: VehicleRecord, domain: string, zone: string, field: string, from: unknown, to: unknown): void {
  changeSeq += 1;
  record.changes.push({ seq: changeSeq, at: new Date().toISOString(), domain, zone, field, from, to });
  if (record.changes.length > MAX_CHANGES) record.changes.splice(0, record.changes.length - MAX_CHANGES);
  persist();
}

/**
 * 播放器回写媒体域字段的唯一入口（`media/player.ts` 用）。
 *
 * 为什么不让播放器直接改 `record.state.media[zone][field]`：那样绕开了变更日志，
 * `GET /changes` 会看不见"音乐起来了"这件事，而它恰恰是最该被看见的一条。
 * 走这里则与 apply 改出来的变更**在同一条流水里、同一种形状**，下游分不出
 * 也不需要分「这是谁改的」。
 *
 * 与 apply 的区别只有一个：不做能力表校验。调用方是设备自己，它写的是既成事实
 * （"这一刻正在放的是这首"），不是一条待裁决的请求。
 */
export function setMediaField(
  record: VehicleRecord,
  zone: string,
  field: "source" | "contentTag",
  value: string | null,
): void {
  const zs = record.state.media[zone as MediaZone];
  if (!zs) return;
  const prior = (zs as unknown as Record<string, unknown>)[field];
  if (prior === value) return;
  (zs as unknown as Record<string, unknown>)[field] = value;
  pushChange(record, "media", zone, field, prior, value);
  record.updatedAt = new Date().toISOString();
}

// ── 应用逻辑 ────────────────────────────────────────────────

interface FieldCtx {
  record: VehicleRecord;
  result: OpResult;
  /** 多分区时字段名带 zone 前缀，单分区不带——报告读起来才不啰嗦。 */
  key: (zone: string, field: string) => string;
}

function clampNumber(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 夹到范围并对齐步进。返回最终值；与请求不同则由调用方记 clamped。 */
function snapTemp(v: number, [min, max]: [number, number], step: number): number {
  const clamped = clampNumber(v, min, max);
  const snapped = min + Math.round((clamped - min) / step) * step;
  return clampNumber(Number(snapped.toFixed(1)), min, max);
}

function writeField(ctx: FieldCtx, domain: string, zone: string, field: string, target: Record<string, unknown>, value: unknown): void {
  const prior = target[field];
  if (prior !== value) pushChange(ctx.record, domain, zone, field, prior, value);
  target[field] = value;
  ctx.result.applied[field] = value;
}

function resolveZones(requested: string | undefined, allowed: string[], domainLabel: string): { zones?: string[]; reason?: string } {
  if (requested === undefined || requested === "all") return { zones: allowed };
  if (allowed.includes(requested)) return { zones: [requested] };
  return { reason: `unknown_zone: ${domainLabel}分区为 ${allowed.join("/")}，没有 ${requested}` };
}

function applyClimate(ctx: FieldCtx, op: CabinOp): void {
  const { record, result } = ctx;
  const caps = record.caps.climate;
  const resolved = resolveZones(op.zone, caps.zones, "此车型空调");
  if (!resolved.zones) {
    result.status = "invalid";
    result.reason = resolved.reason;
    return;
  }
  result.zones = resolved.zones;
  const set = op.set ?? {};

  for (const [field, raw] of Object.entries(set)) {
    if (field === "sync") {
      if (!caps.hasSync) {
        result.skipped.sync = "unsupported_on_this_vehicle: 此车型空调不支持同步";
      } else if (typeof raw === "boolean") {
        const prior = record.state.climateSync;
        if (prior !== raw) pushChange(record, "climate", "-", "sync", prior, raw);
        record.state.climateSync = raw;
        result.applied.sync = raw;
      } else {
        result.skipped.sync = "invalid_value: 需要 boolean";
      }
      continue;
    }

    for (const zone of resolved.zones) {
      const zs = record.state.climate[zone as ClimateZone]!;
      const key = ctx.key(zone, field);
      if (field === "tempC") {
        if (typeof raw !== "number" || !Number.isFinite(raw)) {
          result.skipped[key] = "invalid_value: 需要数字";
          continue;
        }
        const applied = snapTemp(raw, caps.tempRangeC, caps.tempStepC);
        if (applied !== raw) {
          result.clamped[key] = {
            requested: raw,
            applied,
            note: `范围 ${caps.tempRangeC[0]}~${caps.tempRangeC[1]}℃，步进 ${caps.tempStepC}`,
          };
        }
        writeField(ctx, "climate", zone, field, zs as unknown as Record<string, unknown>, applied);
      } else if (field === "fanLevel") {
        if (typeof raw !== "number" || !Number.isInteger(raw)) {
          result.skipped[key] = "invalid_value: 需要整数";
          continue;
        }
        const applied = clampNumber(raw, 0, caps.fanLevels);
        if (applied !== raw) result.clamped[key] = { requested: raw, applied, note: `风量 0~${caps.fanLevels}` };
        writeField(ctx, "climate", zone, field, zs as unknown as Record<string, unknown>, applied);
      } else if (field === "mode") {
        const modes = ["auto", "cool", "heat", "fanOnly"];
        if (typeof raw !== "string" || !modes.includes(raw)) {
          result.skipped[key] = `invalid_value: 可选 ${modes.join("/")}`;
          continue;
        }
        writeField(ctx, "climate", zone, field, zs as unknown as Record<string, unknown>, raw);
      } else if (field === "recirculation") {
        if (typeof raw !== "boolean") {
          result.skipped[key] = "invalid_value: 需要 boolean";
          continue;
        }
        writeField(ctx, "climate", zone, field, zs as unknown as Record<string, unknown>, raw);
      } else {
        result.skipped[key] = "unknown_field";
      }
    }
  }
}

function applySeat(ctx: FieldCtx, op: CabinOp): void {
  const { record, result } = ctx;
  const seatZones = Object.keys(record.caps.seats);
  const resolved = resolveZones(op.zone, seatZones, "座椅");
  if (!resolved.zones) {
    result.status = "invalid";
    result.reason = resolved.reason;
    return;
  }
  result.zones = resolved.zones;
  const set = op.set ?? {};

  for (const zone of resolved.zones) {
    const cap = record.caps.seats[zone as SeatZone];
    const zs = record.state.seats[zone as SeatZone];
    for (const [field, raw] of Object.entries(set)) {
      const key = ctx.key(zone, field);
      if (field === "heating" || field === "ventilation") {
        const levels = field === "heating" ? cap.heatingLevels : cap.ventilationLevels;
        if (levels === 0) {
          result.skipped[key] = `unsupported_on_this_vehicle: ${zone} 无座椅${field === "heating" ? "加热" : "通风"}`;
          continue;
        }
        if (typeof raw !== "number" || !Number.isInteger(raw)) {
          result.skipped[key] = "invalid_value: 需要整数";
          continue;
        }
        const applied = clampNumber(raw, 0, levels);
        if (applied !== raw) result.clamped[key] = { requested: raw, applied, note: `档位 0~${levels}` };
        writeField(ctx, "seat", zone, field, zs as unknown as Record<string, unknown>, applied);
      } else if (field === "massage") {
        if (typeof raw !== "string" || !cap.massageModes.includes(raw)) {
          result.skipped[key] =
            cap.massageModes.length <= 1
              ? `unsupported_on_this_vehicle: ${zone} 无按摩`
              : `invalid_value: 可选 ${cap.massageModes.join("/")}`;
          continue;
        }
        writeField(ctx, "seat", zone, field, zs as unknown as Record<string, unknown>, raw);
      } else {
        result.skipped[key] = "unknown_field";
      }
    }
  }
}

function applyAmbient(ctx: FieldCtx, op: CabinOp): void {
  const { record, result } = ctx;
  const caps = record.caps.ambientLight;
  const resolved = resolveZones(op.zone, caps.zones, "此车型氛围灯");
  if (!resolved.zones) {
    result.status = "invalid";
    result.reason = resolved.reason;
    return;
  }
  result.zones = resolved.zones;
  const set = op.set ?? {};

  for (const zone of resolved.zones) {
    const zs = record.state.ambientLight[zone as AmbientZone]!;
    for (const [field, raw] of Object.entries(set)) {
      const key = ctx.key(zone, field);
      if (field === "color") {
        if (typeof raw !== "string" || !/^#[0-9a-fA-F]{6}$/.test(raw)) {
          result.skipped[key] = "invalid_value: 需要 #RRGGBB";
          continue;
        }
        writeField(ctx, "ambientLight", zone, field, zs as unknown as Record<string, unknown>, raw.toUpperCase());
      } else if (field === "brightness") {
        if (typeof raw !== "number" || !Number.isInteger(raw)) {
          result.skipped[key] = "invalid_value: 需要整数";
          continue;
        }
        const [lo, hi] = caps.brightnessRange;
        const applied = clampNumber(raw, lo, hi);
        if (applied !== raw) result.clamped[key] = { requested: raw, applied, note: `亮度 ${lo}~${hi}` };
        writeField(ctx, "ambientLight", zone, field, zs as unknown as Record<string, unknown>, applied);
      } else if (field === "mode") {
        if (typeof raw !== "string" || !caps.modes.includes(raw)) {
          result.skipped[key] = `invalid_value: 可选 ${caps.modes.join("/")}`;
          continue;
        }
        writeField(ctx, "ambientLight", zone, field, zs as unknown as Record<string, unknown>, raw);
      } else {
        result.skipped[key] = "unknown_field";
      }
    }
  }
}

function applyMedia(ctx: FieldCtx, op: CabinOp): void {
  const { record, result } = ctx;
  const caps = record.caps.media;
  const resolved = resolveZones(op.zone, caps.zones, "此车型媒体");
  if (!resolved.zones) {
    result.status = "invalid";
    result.reason = resolved.reason;
    return;
  }
  result.zones = resolved.zones;
  const set = op.set ?? {};
  // volumeLimit 先于 volume 应用：同一单里"设上限 40 + 音量 80"应得到 40。
  const fields = Object.entries(set).sort(([a], [b]) => (a === "volumeLimit" ? -1 : b === "volumeLimit" ? 1 : 0));

  for (const zone of resolved.zones) {
    const zs = record.state.media[zone as MediaZone]!;
    for (const [field, raw] of fields) {
      const key = ctx.key(zone, field);
      const [lo, hi] = caps.volumeRange;
      if (field === "source") {
        if (typeof raw !== "string" || !caps.sources.includes(raw)) {
          result.skipped[key] = `invalid_value: 可选 ${caps.sources.join("/")}`;
          continue;
        }
        writeField(ctx, "media", zone, field, zs as unknown as Record<string, unknown>, raw);
      } else if (field === "volume") {
        if (typeof raw !== "number" || !Number.isInteger(raw)) {
          result.skipped[key] = "invalid_value: 需要整数";
          continue;
        }
        let applied = clampNumber(raw, lo, hi);
        let note = `音量 ${lo}~${hi}`;
        if (zs.volumeLimit !== null && applied > zs.volumeLimit) {
          applied = zs.volumeLimit;
          note = `该分区音量上限 ${zs.volumeLimit}`;
        }
        if (applied !== raw) result.clamped[key] = { requested: raw, applied, note };
        writeField(ctx, "media", zone, field, zs as unknown as Record<string, unknown>, applied);
      } else if (field === "volumeLimit") {
        if (raw !== null && (typeof raw !== "number" || !Number.isInteger(raw))) {
          result.skipped[key] = "invalid_value: 需要整数或 null（清除上限）";
          continue;
        }
        const applied = raw === null ? null : clampNumber(raw, lo, hi);
        if (applied !== raw) result.clamped[key] = { requested: raw, applied: applied as number, note: `上限 ${lo}~${hi}` };
        writeField(ctx, "media", zone, field, zs as unknown as Record<string, unknown>, applied);
        // 上限压下来时现播音量也得跟着降——设备行为，不是上游的事。
        if (applied !== null && zs.volume > applied) {
          writeField(ctx, "media", zone, "volume", zs as unknown as Record<string, unknown>, applied);
        }
      } else if (field === "contentTag") {
        if (raw !== null && typeof raw !== "string") {
          result.skipped[key] = "invalid_value: 需要字符串或 null";
          continue;
        }
        const applied = typeof raw === "string" ? raw.slice(0, 40) : null;
        writeField(ctx, "media", zone, field, zs as unknown as Record<string, unknown>, applied);
      } else {
        result.skipped[key] = "unknown_field";
      }
    }
  }
}

function applyFragrance(ctx: FieldCtx, op: CabinOp): void {
  const { record, result } = ctx;
  const caps = record.caps.fragrance;
  if (!caps.present || !record.state.fragrance) {
    result.status = "rejected";
    result.reason = "unsupported_on_this_vehicle: 此车型无香氛系统";
    return;
  }
  result.zones = ["cabin"];
  const set = op.set ?? {};
  const fs = record.state.fragrance;

  for (const [field, raw] of Object.entries(set)) {
    if (field === "intensity") {
      if (typeof raw !== "string" || !caps.intensities.includes(raw)) {
        result.skipped[field] = `invalid_value: 可选 ${caps.intensities.join("/")}`;
        continue;
      }
      writeField(ctx, "fragrance", "cabin", field, fs as unknown as Record<string, unknown>, raw);
    } else if (field === "scent") {
      if (typeof raw !== "string" || !caps.scents.includes(raw)) {
        result.skipped[field] = `invalid_value: 可选 ${caps.scents.join("/")}`;
        continue;
      }
      writeField(ctx, "fragrance", "cabin", field, fs as unknown as Record<string, unknown>, raw);
    } else {
      result.skipped[field] = "unknown_field";
    }
  }
}

function applyChildMode(ctx: FieldCtx, op: CabinOp): void {
  const { record, result } = ctx;
  const resolved = resolveZones(op.zone, record.caps.childMode.zones, "儿童模式");
  if (!resolved.zones) {
    result.status = "invalid";
    result.reason = resolved.reason;
    return;
  }
  result.zones = resolved.zones;
  const set = op.set ?? {};

  for (const zone of resolved.zones) {
    const zs = record.state.childMode[zone as SeatZone]!;
    for (const [field, raw] of Object.entries(set)) {
      const key = ctx.key(zone, field);
      if (field === "screenLock") {
        if (typeof raw !== "boolean") {
          result.skipped[key] = "invalid_value: 需要 boolean";
          continue;
        }
        writeField(ctx, "childMode", zone, field, zs as unknown as Record<string, unknown>, raw);
      } else if (field === "childLock") {
        if (typeof raw !== "boolean") {
          result.skipped[key] = "invalid_value: 需要 boolean";
          continue;
        }
        // 上锁可以远程，解锁不行——见文件头"唯一的安全域出口"。
        if (raw === false && zs.childLock) {
          result.skipped[key] = "safety_domain: 解除儿童锁需在车内物理操作，不提供远程解除";
          continue;
        }
        writeField(ctx, "childMode", zone, field, zs as unknown as Record<string, unknown>, raw);
      } else {
        result.skipped[key] = "unknown_field";
      }
    }
  }
}

const DOMAINS: Record<string, (ctx: FieldCtx, op: CabinOp) => void> = {
  climate: applyClimate,
  seat: applySeat,
  ambientLight: applyAmbient,
  media: applyMedia,
  fragrance: applyFragrance,
  childMode: applyChildMode,
};

export function applyOps(record: VehicleRecord, ops: CabinOp[]): OpResult[] {
  const results: OpResult[] = [];
  ops.forEach((op, index) => {
    const result: OpResult = {
      index,
      domain: String(op.domain ?? ""),
      zones: [],
      status: "applied",
      applied: {},
      clamped: {},
      skipped: {},
    };
    const handler = op.domain ? DOMAINS[op.domain] : undefined;
    if (!handler) {
      result.status = "invalid";
      result.reason = `unknown_domain: 可选 ${Object.keys(DOMAINS).join("/")}`;
      results.push(result);
      return;
    }
    const multiZone = op.zone === undefined || op.zone === "all";
    const ctx: FieldCtx = {
      record,
      result,
      key: (zone, field) => (multiZone ? `${zone}.${field}` : field),
    };
    handler(ctx, op);

    if (result.status !== "invalid" && result.status !== "rejected") {
      const appliedCount = Object.keys(result.applied).length;
      const issueCount = Object.keys(result.clamped).length + Object.keys(result.skipped).length;
      if (appliedCount === 0 && issueCount > 0) {
        result.status = "rejected";
        result.reason = "no_applicable_fields: 没有一个字段能落到这辆车上，逐字段原因见 skipped";
      } else if (appliedCount === 0) {
        result.status = "rejected";
        result.reason = "empty_set: set 里没有任何字段";
      } else if (issueCount > 0) {
        result.status = "partial";
      }
    }
    results.push(result);
  });
  record.updatedAt = new Date().toISOString();
  persist();
  return results;
}

// ── 幂等 ────────────────────────────────────────────────────

export function priorResponse(requestId: string | undefined): unknown {
  return requestId ? byRequestId.get(requestId) : undefined;
}

export function rememberResponse(requestId: string | undefined, response: unknown): void {
  if (requestId) byRequestId.set(requestId, response);
}

// ── 能量遥测 ────────────────────────────────────────────────

/** 读电量/油量：把仿真推进到现在。推进改了 asOf 与数值，所以要落盘。 */
export function readEnergy(record: VehicleRecord, now = Date.now()): EnergyState {
  record.energy = advanceEnergy(record.energy, now);
  persist();
  return record.energy;
}

/** 演示控制：直接设电量/油量/模式。越界抛 RangeError（不夹——操作者笔误要被看见）。 */
export function setEnergy(record: VehicleRecord, o: EnergyOverride, now = Date.now()): EnergyState {
  record.energy = overrideEnergy(record.energy, o, now);
  persist();
  return record.energy;
}

// ── 落盘与灌回 ──────────────────────────────────────────────

/** 磁盘上的一辆车。`caps` **不存**——它是车型的派生属性，见 `rehydrate` 的理由。 */
interface PersistedVehicle {
  vehicleId: string;
  model: string;
  state: unknown;
  changes: Change[];
  /** v1 快照没有这个字段——灌回时按初值补，不算不兼容，所以版本号不动。 */
  energy?: unknown;
  updatedAt: string;
}

function takeSnapshot(): Snapshot {
  const list: PersistedVehicle[] = [];
  for (const v of vehicles.values()) {
    list.push({ vehicleId: v.vehicleId, model: v.model, state: v.state, changes: v.changes, energy: v.energy, updatedAt: v.updatedAt });
  }
  return { version: SNAPSHOT_VERSION, savedAt: new Date().toISOString(), vehicleSeq, changeSeq, vehicles: list };
}

function persist(): void {
  markDirty(takeSnapshot);
}

/**
 * 同名同类型才覆盖回去。
 *
 * 磁盘上的值是**上一版代码**写的。字段改了名、换了类型、或某个分区在新的能力表里
 * 已经不存在时，硬塞回去会造出一个"车机自己都描述不了"的状态对象——
 * 而它接下来会被原样发给上游当作事实。所以以新的默认状态为骨架，只认得出来的才收。
 *
 * `a === null || b === null` 那一支是为 `volumeLimit` / `contentTag` 这类
 * "默认 null、设过之后是数字/字符串"的字段准备的：光比 typeof 会把它们全挡掉。
 */
function overlayFields(target: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const key of Object.keys(target)) {
    if (!(key in src)) continue;
    const a = target[key];
    const b = src[key];
    if (a === null || b === null || typeof a === typeof b) target[key] = b;
  }
}

/** 只灌"这辆车现在仍然有"的分区：能力表里没了的分区不得复活。 */
function overlayZones(target: Record<string, unknown>, src: unknown): void {
  if (!src || typeof src !== "object") return;
  const from = src as Record<string, unknown>;
  for (const zone of Object.keys(target)) {
    const one = from[zone];
    if (one && typeof one === "object") {
      overlayFields(target[zone] as Record<string, unknown>, one as Record<string, unknown>);
    }
  }
}

function overlayState(fresh: CabinState, saved: unknown): void {
  if (!saved || typeof saved !== "object") return;
  const s = saved as Record<string, unknown>;
  if (typeof s.climateSync === "boolean") fresh.climateSync = s.climateSync;
  overlayZones(fresh.climate as Record<string, unknown>, s.climate);
  overlayZones(fresh.seats as unknown as Record<string, unknown>, s.seats);
  overlayZones(fresh.ambientLight as Record<string, unknown>, s.ambientLight);
  overlayZones(fresh.media as Record<string, unknown>, s.media);
  overlayZones(fresh.childMode as Record<string, unknown>, s.childMode);
  // 此车型无香氛时 fresh.fragrance 是 null——旧快照有值也不给它变出来
  if (fresh.fragrance && s.fragrance && typeof s.fragrance === "object") {
    overlayFields(fresh.fragrance as unknown as Record<string, unknown>, s.fragrance as Record<string, unknown>);
  }
}

/**
 * 启动时把快照灌回内存。
 *
 * **能力表按车型重新推导，不从快照读。** 车型决定这辆车有什么，代码是那件事的
 * 真相源；`capsForModel` 修了 bug 或加了分区之后，存量的车必须跟着变，
 * 否则演示用的那辆车会把旧能力表一直背到底，而没有任何东西会提示。
 * 代价是能力收窄时旧值会被丢掉——这正是想要的方向。
 *
 * 已知不做的一件事：**不按新的取值范围重新夹**。老快照里的 28℃ 遇上新上限 26℃
 * 会原样留着，直到下一次 apply 触到它。补这一步要把 `applyOps` 的夹取逻辑
 * 复制一份出来，为一个模拟系统不值得——写在这里，免得以后当成 bug 查。
 */
function rehydrate(): void {
  const snapshot = load();
  const path = snapshotPath();
  if (!path) {
    console.log("[mock-cabin] 落盘已关闭（CABIN_PERSIST=off），状态重启即清");
    return;
  }
  if (snapshot) {
    for (const raw of snapshot.vehicles) {
      const v = raw as PersistedVehicle;
      if (!v?.vehicleId || typeof v.model !== "string") continue;
      const caps = capsForModel(v.model);
      const state = defaultState(caps);
      overlayState(state, v.state);
      vehicles.set(v.vehicleId, {
        vehicleId: v.vehicleId,
        model: caps.model,
        caps,
        state,
        changes: Array.isArray(v.changes) ? v.changes.slice(-MAX_CHANGES) : [],
        energy: rehydrateEnergy(v.energy, v.vehicleId, caps.model, Date.now()),
        updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : new Date().toISOString(),
      });
    }
    /*
     * 发号器取"存下来的值"与"实际见到的最大值"的较大者：快照写在发号之后被截断、
     * 或有人手工编辑过文件时，这一步保证不会把已经用掉的号再发一次。
     */
    vehicleSeq = Math.max(Number(snapshot.vehicleSeq) || 0, ...[...vehicles.keys()].map(idNum), 0);
    changeSeq = Math.max(
      Number(snapshot.changeSeq) || 0,
      ...[...vehicles.values()].flatMap((v) => v.changes.map((c) => c.seq)),
      0,
    );
    const total = [...vehicles.values()].reduce((n, v) => n + v.changes.length, 0);
    console.log(`[mock-cabin] 已从 ${path} 恢复 ${vehicles.size} 辆车、${total} 条变更流水`);
  } else {
    console.log(`[mock-cabin] 无历史快照，按空白启动；将写入 ${path}`);
  }
  installExitHooks();
}

/** `VEH-000007` → 7；认不出来的返回 0（不参与发号器取最大值）。 */
function idNum(vehicleId: string): number {
  const m = /^VEH-(\d+)$/.exec(vehicleId);
  return m ? Number(m[1]) : 0;
}

rehydrate();

export function vehicleCount(): number {
  return vehicles.size;
}

/**
 * 仅测试用：清掉全部状态，让用例之间互不污染。
 *
 * **不落盘**——测试进程必须带 `CABIN_PERSIST=off`（见 package.json 的 test 脚本），
 * 否则用例会把彼此的车写进同一个快照文件，还会在仓库里留下垃圾。
 */
export function __resetAll(): void {
  vehicles.clear();
  byRequestId.clear();
  changeSeq = 0;
  vehicleSeq = 0;
}
