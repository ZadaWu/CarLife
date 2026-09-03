/**
 * 定时任务的租约与留痕仓储（施工单 M7-05，FL-32）。
 *
 * 实现 `enterprise/backend/worker` 的 `JobLease` / `JobJournal` 两个接口——**依赖方向是 db → worker 的接口形状**，
 * 但为了不让 db 反向依赖 service，这里只导出结构一致的实现，由 worker 侧做类型收敛。
 * 这与 `repositories/trip.ts` 实现 `@carlife/memory` 的 `TripStore` 是同一个套路。
 *
 * # 为什么租约用「条件更新」而不是「先查再写」
 *
 * `SELECT ... 然后 INSERT` 之间有窗口：两个实例同时查到"锁已过期"，于是都去抢，
 * 都成功。互斥必须落在**单条原子语句**上——这里用带 WHERE 的 UPDATE 与
 * INSERT ... ON CONFLICT DO UPDATE WHERE，把判断和写入压进一次往返。
 */

import { PrismaClient } from "@prisma/client";

export interface JobRunRecord {
  job: string;
  windowFrom: number;
  windowTo: number;
  isCatchUp: boolean;
  processed: number;
  changed: number;
  deleted: number;
  failures: string[];
  durationMs: number;
}

export interface JobRepository {
  /** 取得独占锁；返回 false 表示别的实例在跑（F-32-13）。 */
  acquire(job: string, ttlMs: number, holder: string): Promise<boolean>;
  release(job: string, holder: string): Promise<void>;
  /** 上次成功执行覆盖到的时间点；无记录表示从未跑过（F-32-06 的补偿起点）。 */
  lastSuccessTo(job: string): Promise<number | null>;
  /** 成功窗口留痕（F-32-10）。**失败窗口不写**，否则断点会前移并永久跳过它。 */
  record(entry: JobRunRecord): Promise<void>;
  /** 运维查询：某任务最近若干次执行。 */
  recent(job: string, limit?: number): Promise<(JobRunRecord & { createdAt: number })[]>;
}

export function createJobRepository(prisma: PrismaClient): JobRepository {
  return {
    async acquire(job, ttlMs, holder) {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlMs);

      /*
       * 一条语句里同时表达三种情形：
       *  · 没人持有 → 插入成功；
       *  · 持有者是自己 → 续租（同一实例重入不该被自己挡住）；
       *  · 别人持有但**租约已过期** → 抢占（持有者崩溃后锁不能永久卡死）。
       * 别人持有且未过期时 WHERE 不成立，DO UPDATE 不发生，受影响行数为 0。
       */
      const affected = await prisma.$executeRaw`
        INSERT INTO job_leases (job, holder, expires_at, acquired_at)
        VALUES (${job}, ${holder}, ${expiresAt}, ${now})
        ON CONFLICT (job) DO UPDATE
          SET holder = ${holder}, expires_at = ${expiresAt}, acquired_at = ${now}
          WHERE job_leases.expires_at < ${now} OR job_leases.holder = ${holder}
      `;
      return affected > 0;
    },

    async release(job, holder) {
      // 只释放自己持有的那把：抢占发生后，原持有者迟到的 release 不能把新持有者踢掉。
      await prisma.jobLease.deleteMany({ where: { job, holder } });
    },

    async lastSuccessTo(job) {
      const row = await prisma.jobRun.findFirst({
        where: { job },
        orderBy: { windowTo: "desc" },
        select: { windowTo: true },
      });
      return row ? row.windowTo.getTime() : null;
    },

    async record(entry) {
      await prisma.jobRun.create({
        data: {
          job: entry.job,
          windowFrom: new Date(entry.windowFrom),
          windowTo: new Date(entry.windowTo),
          isCatchUp: entry.isCatchUp,
          processed: entry.processed,
          changed: entry.changed,
          deleted: entry.deleted,
          failures: entry.failures,
          durationMs: entry.durationMs,
        },
      });
    },

    async recent(job, limit = 20) {
      const rows = await prisma.jobRun.findMany({
        where: { job },
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      return rows.map((r) => ({
        job: r.job,
        windowFrom: r.windowFrom.getTime(),
        windowTo: r.windowTo.getTime(),
        isCatchUp: r.isCatchUp,
        processed: r.processed,
        changed: r.changed,
        deleted: r.deleted,
        failures: r.failures,
        durationMs: r.durationMs,
        createdAt: r.createdAt.getTime(),
      }));
    },
  };
}
