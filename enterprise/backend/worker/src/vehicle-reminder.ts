/**
 * 保养/年检提醒任务（施工单 M7-05，FL-32 F-32-04，
 * 语义见 FL-17 F-17-07/F-17-12）。
 *
 * # 任务只生成提醒，不写日历
 *
 * 写日历是**有副作用的动作**，必须回到 §8.4 的权限门与 HITL 链路让用户确认；
 * 定时任务无权绕过。所以这里的产物是一条"待告知"记录，不是一个已安排的日程。
 * 把 calendar 工具直接接到这里，等于给了守夜人一条绕过权限门的旁路。
 *
 * # 推算复用 `forecastMaintenance`，不在这里另写一套
 *
 * ④档案（里程、保养间隔、历史）× ⑥画像（日均里程）的推算逻辑已经在
 * `@carlife/memory` 里且有测试。任务层只负责"扫谁、要不要提、写哪"。
 */

import { getPrisma, createTripRepository, createVehicleRepository } from "@carlife/db";
import {
  forecastMaintenance,
  loadUsageProfile,
  usableRate,
  type MaintenanceRate,
  type VehicleProfile,
} from "@carlife/memory";

import type { JobContext, JobDefinition, JobResult } from "./job-runner";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** 剩余里程低于此值即触发提醒。 */
export const REMIND_WITHIN_KM = 1_000;
/** 预计到期天数低于此值即触发提醒。 */
export const REMIND_WITHIN_DAYS = 30;

export interface ReminderCandidate {
  userId: string;
  vehicle: Pick<VehicleProfile, "vin" | "odometerKm" | "maintenanceIntervalKm" | "maintenance">;
  /** 日均里程；无⑥画像时 undefined，推算会走降级分支。 */
  /**
   * 可用的日均速率（M26-05 改）。**此前是一个裸 number**，而这里只判了
   * `sampleSize > 0`、没判 `verdict.usable`——于是 ⑥ **陈旧**的速率照样传进推算，
   * 提醒里会说"按当前用车强度约 N 天后到期"，而那个强度来自 `usage_profile`
   * 自己都判为不可用的数据。改成只能经 `usableRate` 构造，漏判就编译不过。
   */
  rate?: MaintenanceRate;
}

export interface ReminderDeps {
  candidates(): Promise<ReminderCandidate[]>;
  /** 用户的提醒开关与去重窗口；未配置则用默认（开、7 天）。 */
  settings(userId: string): Promise<{ enabled: boolean; dedupeDays: number }>;
  /** 该 (user, vin, kind) 最近一次提醒时间；无则 null。 */
  lastRemindedAt(userId: string, vin: string, kind: string): Promise<number | null>;
  emit(reminder: {
    userId: string;
    vin: string;
    kind: string;
    dueAt?: number;
    remainingKm?: number;
    message: string;
    basis: string[];
    degraded: boolean;
  }): Promise<void>;
  now?: () => number;
}

export async function runVehicleReminder(_ctx: JobContext, deps: ReminderDeps): Promise<JobResult> {
  const now = (deps.now ?? Date.now)();
  const result: JobResult = { processed: 0, changed: 0, deleted: 0, failures: [] };

  for (const candidate of await deps.candidates()) {
    result.processed += 1;
    const { userId, vehicle } = candidate;
    try {
      const setting = await deps.settings(userId);
      // 开关关掉就是彻底不提，不是"降低频率"——F-17-07 要求跨会话保持。
      if (!setting.enabled) continue;

      const last = await deps.lastRemindedAt(userId, vehicle.vin, "maintenance");
      // 去重窗口内已提过就跳过。宁可少提醒（FL-17 默认值偏保守）。
      if (last !== null && now - last < setting.dedupeDays * DAY_MS) continue;

      const forecast = forecastMaintenance(vehicle, { rate: candidate.rate });
      const dueSoon =
        forecast.remainingKm <= REMIND_WITHIN_KM ||
        (forecast.etaDays !== undefined && forecast.etaDays <= REMIND_WITHIN_DAYS);
      if (!dueSoon) continue;

      const overdue = forecast.remainingKm < 0;
      const etaText =
        forecast.etaDays !== undefined ? `，按当前用车强度约 ${Math.round(forecast.etaDays)} 天后到期` : "";
      const message = overdue
        ? `车辆 ${vehicle.vin} 保养已超期 ${Math.abs(forecast.remainingKm)} 公里`
        : `车辆 ${vehicle.vin} 距下次保养还剩 ${forecast.remainingKm} 公里${etaText}`;

      await deps.emit({
        userId,
        vin: vehicle.vin,
        kind: "maintenance",
        dueAt:
          forecast.etaDays !== undefined ? now + forecast.etaDays * DAY_MS : undefined,
        remainingKm: forecast.remainingKm,
        message,
        basis: forecast.basis,
        degraded: forecast.degraded,
      });
      result.changed += 1;
    } catch (err) {
      result.failures.push(
        `${userId}/${vehicle.vin}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return result;
}

export function createReminderDeps(): ReminderDeps {
  const prisma = getPrisma();
  const trips = createTripRepository(prisma);
  const vehicles = createVehicleRepository(prisma);

  return {
    async candidates() {
      // 车主列表走原始查询，车辆本身走 VehicleRepository——
      // 档案的行→领域对象映射只该有一处（`repositories/vehicle.ts`），这里抄一遍必然漂移。
      const owners = await prisma.vehicle.findMany({
        select: { ownerId: true },
        distinct: ["ownerId"],
      });
      const out: ReminderCandidate[] = [];
      for (const { ownerId } of owners) {
        for (const vehicle of await vehicles.listByOwner(ownerId)) {
          let rate: MaintenanceRate | undefined;
          try {
            const profile = await loadUsageProfile(trips, ownerId, Date.now(), 30, vehicle.vin);
            /*
             * **判据是 `verdict.usable`，不是 `sampleSize > 0`**（M26-05 修）。
             *
             * 两者不等价：⑥ 可能样本够但**已经陈旧**（`staleDays > MAX_STALE_DAYS`），
             * 那时 `usage_profile` 明确说不可用，而旧代码照样把速率传下去，
             * 算出一个基于过期数据的 `etaDays`——提醒里那句"按当前用车强度约 N 天后到期"
             * 就建立在它上面。`usableRate` 强制把这个判定摆出来。
             */
            rate = usableRate(profile.summary.avgDailyKm, profile.verdict.usable);
          } catch {
            rate = undefined;
          }
          out.push({ userId: ownerId, vehicle, rate });
        }
      }
      return out;
    },
    async settings(userId) {
      const row = await prisma.reminderSetting.findUnique({ where: { userId } });
      return { enabled: row?.enabled ?? true, dedupeDays: row?.dedupeDays ?? 7 };
    },
    async lastRemindedAt(userId, vin, kind) {
      const row = await prisma.vehicleReminder.findFirst({
        // 只认未失效的行（M14-02，F-17-08）：保养完成后旧提醒已被标记，
        // 去重窗口不该再压住"按新基线重算"的下一条提醒。
        where: { userId, vin, kind, invalidatedAt: null },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      return row ? row.createdAt.getTime() : null;
    },
    async emit(reminder) {
      await prisma.vehicleReminder.create({
        data: {
          userId: reminder.userId,
          vin: reminder.vin,
          kind: reminder.kind,
          dueAt: reminder.dueAt ? new Date(reminder.dueAt) : null,
          remainingKm: reminder.remainingKm ?? null,
          message: reminder.message,
          basis: reminder.basis,
          degraded: reminder.degraded,
        },
      });
    },
  };
}

export const vehicleReminderJob: JobDefinition = {
  name: "vehicle-reminder",
  intervalMs: 24 * HOUR_MS,
  // 补 3 天足够：到期提醒晚一两天仍有意义，晚一周补出来的"还剩 1000 公里"已经不准了。
  maxCatchUpWindows: 3,
  run: (ctx) => runVehicleReminder(ctx, createReminderDeps()),
};
