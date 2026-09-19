/**
 * 任务工作状态的仓储（施工单 M84-02，ACR-036 §4.9）。
 *
 * 与 `working-thread.ts` 是**两件不同的东西**：那边存"这个会话对应哪个图 thread"（管本轮的
 * 图状态与检查点），这边存"这个人手上正在办的事"（跨轮、跨会话）。形状真相源是
 * `@carlife/shared` 的 `TaskState`，本文件只负责行 ⇄ 对象的映射与并发控制。
 *
 * # 三条纪律
 *
 * 1. **每个读方法都带 `userId`**（ADR-011）。不带用户键的读只许写在 `repositories/research.ts`；
 *    这张表是车主面的数据，`agent-runtime` 会注入它，任何"顺手统计一下全量任务"的方法都不许加进来。
 * 2. **写一律 `updateMany` 看 `count`**。单条 `update` 在版本不匹配时抛 `P2025`，
 *    而那个异常与"行根本不存在"无法区分；`count === 0` 才是干净的"版本冲突"信号。
 * 3. **过期走同一套语义**：`loadActive` 遇到过期的行发 `task.expired` 事件经 `reduceTask` 推进，
 *    不在 SQL 里直接 `UPDATE status='expired'`——两处实现必然漂移。
 */

import { Prisma, type PrismaClient } from "@prisma/client";

import {
  CLOSED_STATUSES,
  reduceTask,
  type TaskKind,
  type TaskLastAction,
  type TaskPending,
  type TaskState,
  type TaskStatus,
} from "@carlife/shared";

/** 数据库行的形状（只列我们读写的列）。 */
interface WorkingTaskRow {
  id: string;
  userId: string;
  kind: string;
  status: string;
  draft: unknown;
  baseRef: string | null;
  baseVersion: number | null;
  baseCommittedAt: Date | null;
  pending: unknown;
  lastAction: unknown;
  constraints: string[];
  version: number;
  openedAt: Date;
  touchedAt: Date;
  expiresAt: Date;
  closedAt: Date | null;
  sessionIds: string[];
}

/**
 * 行 → `TaskState`。**导出成纯函数**，好让单测不连库也验得了形状（同 `trip-plan.ts` 的做法）。
 *
 * `base` 的两栏在库里是可空的两列，在对象里是一个可选的整体——只有 `baseRef` 在场才拼它。
 */
export function rowToTask(row: WorkingTaskRow): TaskState {
  const task: TaskState = {
    id: row.id,
    userId: row.userId,
    kind: row.kind as TaskKind,
    status: row.status as TaskStatus,
    draft: row.draft,
    constraints: row.constraints,
    version: row.version,
    openedAt: row.openedAt.getTime(),
    touchedAt: row.touchedAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
    sessionIds: row.sessionIds,
  };
  if (row.baseRef !== null) {
    task.base = {
      ref: row.baseRef,
      version: row.baseVersion ?? 1,
      // 单独一列。曾经想用 `touchedAt` 顶替它，而确认之后再问一句就会把 touchedAt 推到现在，
      // 回读出来的落库时刻比真实的晚——往返用例当场红。存量行没有这一列时退回 touchedAt。
      committedAt: (row.baseCommittedAt ?? row.touchedAt).getTime(),
    };
  }
  if (row.pending !== null && row.pending !== undefined) task.pending = row.pending as TaskPending;
  if (row.lastAction !== null && row.lastAction !== undefined) {
    task.lastAction = row.lastAction as TaskLastAction;
  }
  if (row.closedAt !== null) task.closedAt = row.closedAt.getTime();
  return task;
}

/**
 * `TaskState` → 行（不含 `id`，它是主键由调用方给）。
 *
 * 三个 `Json` 栏标成 Prisma 的输入类型而不是 `unknown`：`draft` 在契约里是 `unknown`
 * （见 `task-state.ts` 关于"不要顺手泛型化"的那段），而 Prisma 的 `Json` 列只收
 * `InputJsonValue`；在这里一次性转，好过每个调用点各 cast 一遍。
 * `null` 用 `Prisma.DbNull` 而不是字面 `null`——后者在 Prisma 里表示"JSON 里的 null 值"，
 * 与"这一列是 SQL NULL"是两回事。
 */
export function taskToRow(task: TaskState): Omit<WorkingTaskRow, "id" | "draft" | "pending" | "lastAction"> & {
  draft: Prisma.InputJsonValue;
  pending: Prisma.InputJsonValue | typeof Prisma.DbNull;
  lastAction: Prisma.InputJsonValue | typeof Prisma.DbNull;
} {
  return {
    userId: task.userId,
    kind: task.kind,
    status: task.status,
    draft: task.draft as Prisma.InputJsonValue,
    baseRef: task.base?.ref ?? null,
    baseVersion: task.base?.version ?? null,
    baseCommittedAt: task.base ? new Date(task.base.committedAt) : null,
    pending: (task.pending as Prisma.InputJsonValue | undefined) ?? Prisma.DbNull,
    lastAction: (task.lastAction as Prisma.InputJsonValue | undefined) ?? Prisma.DbNull,
    constraints: [...task.constraints],
    version: task.version,
    openedAt: new Date(task.openedAt),
    touchedAt: new Date(task.touchedAt),
    expiresAt: new Date(task.expiresAt),
    closedAt: task.closedAt === undefined ? null : new Date(task.closedAt),
    sessionIds: [...task.sessionIds],
  };
}

export function createWorkingTaskStore(prisma: PrismaClient) {
  const table = prisma.workingTask;

  /** 关掉一行。`status` 必须是终态之一，否则调用方想表达的不是"关掉"。 */
  async function close(id: string, status: TaskStatus, at: number): Promise<void> {
    if (!CLOSED_STATUSES.includes(status)) {
      throw new Error(`close 只接受终态，收到 ${status}（id=${id}）`);
    }
    await table.update({
      where: { id },
      data: { status, closedAt: new Date(at), touchedAt: new Date(at) },
    });
  }

  return {
    /**
     * 这个人还活着的任务。**顺带做懒过期**：`expiresAt` 已过的行在这里被置 `expired` 并关掉，
     * 不进返回值。已经 `closedAt` 的行一律不碰——"他取消过"是审计事实，不能被改写成"过期了"。
     */
    async loadActive(userId: string, now: number): Promise<TaskState[]> {
      const rows = (await table.findMany({
        where: { userId, closedAt: null },
        orderBy: { touchedAt: "desc" },
      })) as unknown as WorkingTaskRow[];

      const alive: TaskState[] = [];
      for (const row of rows) {
        const task = rowToTask(row);
        if (task.expiresAt <= now) {
          const expired = reduceTask(task, { type: "task.expired", at: now });
          await close(task.id, expired.status, now);
          continue;
        }
        alive.push(task);
      }
      return alive;
    },

    /** 这个人这种任务里还活着的那一份（活跃唯一性由 `open` 保证，这里取最近触碰的）。 */
    async get(userId: string, kind: TaskKind): Promise<TaskState | null> {
      const row = (await table.findFirst({
        where: { userId, kind, closedAt: null },
        orderBy: { touchedAt: "desc" },
      })) as unknown as WorkingTaskRow | null;
      return row ? rowToTask(row) : null;
    },

    /**
     * 开一件事。**同一事务里先把这个人这种任务的旧活跃行关掉**——
     * 活跃唯一性放应用层而不是部分唯一索引：懒过期是"装载时才判"，
     * 旧行被关与新行被开之间必然有一个瞬间两行并存，做成 DB 约束会让那一刻直接抛异常。
     */
    async open(task: TaskState): Promise<void> {
      await prisma.$transaction([
        table.updateMany({
          where: { userId: task.userId, kind: task.kind, closedAt: null },
          data: { status: "cancelled", closedAt: new Date(task.openedAt) },
        }),
        table.create({ data: { id: task.id, ...taskToRow(task) } }),
      ]);
    },

    /**
     * 写一次推进。`false` = 版本冲突（别处先写了），调用方该重读重放。
     * **不抛异常**：冲突是正常并发，不是故障。
     */
    async apply(id: string, expectedVersion: number, next: TaskState): Promise<boolean> {
      const { count } = await table.updateMany({
        where: { id, version: expectedVersion },
        data: taskToRow(next),
      });
      return count === 1;
    },

    close,
  };
}

export type WorkingTaskStore = ReturnType<typeof createWorkingTaskStore>;
