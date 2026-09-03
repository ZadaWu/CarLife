/**
 * 补录询问的拒答冷却仓储（施工单 M26-03，F-53-09，架构文档 §4.6 约束 2/4）。
 *
 * # 为什么落 PG 而不是图状态
 *
 * 冷却**必须活过会话与进程重启**：只放图状态等于没有冷却——车主今天说了"不用了"，
 * 明天上车又被问一遍，而"每次都问一遍"是最快让人关掉功能的做法。
 *
 * # 为什么独立成表
 *
 * §4.6 约束 4：**拒答不构成新的信息**。挂进 `Vehicle` 就会跟着 `VehicleProfile`
 * 的读路径流到每个下游，让出行/座舱/售后/购车都"顺便知道"车主拒答过。
 * 独立成表是那条"两态逐字段相同"不变量最便宜的保证。
 *
 * # 只追加更新，不删
 *
 * 拒答是审计事实。冷却过期靠时间判定（`listActive` 的 `since`），不靠删行。
 */

import { PrismaClient } from "@prisma/client";

import type { ElicitationCooldown, ElicitationKind } from "@carlife/shared";

export interface ElicitationCooldownRepository {
  /**
   * 记一次拒答。同一 (vin, kind) 再拒时**次数累加、时刻刷新**——
   * 连着拒三次与第一次拒是不同的信号，虽然本期还不据此分叉。
   */
  decline(input: {
    vin: string;
    ownerId: string;
    kind: ElicitationKind;
    at: number;
  }): Promise<ElicitationCooldown>;
  /**
   * 记一次**"刚问过、也拿到过答复"**——不是拒答，所以 `declineCount` 不加。
   *
   * 它补的是一条会让助手**永远问下去**的路：车主报的里程若不大于档案里的值，
   * 仓储层的「只前进」规则会把它丢掉（`advanceOdometerWithin`），`odometerAt` 于是
   * 一直是 null、体检一直判 `unknown`、`suggested` 一直含 odometer——
   * 而车主明明已经答过了。冷却只按拒答记的话，这一类永远出不来。
   *
   * 与 `decline` 共用同一行：冷却期的判定（`listActive`）只看 `declinedAt`，
   * 两者对"暂时别再问"的作用相同，区别只在"连着拒三次"那个信号要不要被污染。
   */
  touch(input: {
    vin: string;
    ownerId: string;
    kind: ElicitationKind;
    at: number;
  }): Promise<ElicitationCooldown>;
  /**
   * 该车**仍在冷却期内**的项。`since` 由调用方按配置的冷却时长算出——
   * 时长是策略值，不该硬编码进仓储。
   */
  listActive(vin: string, since: number): Promise<ElicitationCooldown[]>;
}

export function createElicitationCooldownRepository(
  prisma: PrismaClient,
): ElicitationCooldownRepository {
  return {
    async decline({ vin, ownerId, kind, at }) {
      const declinedAt = new Date(at);
      const row = await prisma.elicitationCooldown.upsert({
        where: { vin_kind: { vin, kind } },
        create: { vin, ownerId, kind, declinedAt, declineCount: 1 },
        update: { declinedAt, declineCount: { increment: 1 }, ownerId },
      });
      return {
        vin: row.vin,
        kind: row.kind as ElicitationKind,
        declinedAt: row.declinedAt.getTime(),
        declineCount: row.declineCount,
      };
    },

    async touch({ vin, ownerId, kind, at }) {
      const declinedAt = new Date(at);
      const row = await prisma.elicitationCooldown.upsert({
        where: { vin_kind: { vin, kind } },
        // 新建时 `declineCount: 0`——这一行不是拒答，别让运营侧看到一次并不存在的拒绝。
        create: { vin, ownerId, kind, declinedAt, declineCount: 0 },
        update: { declinedAt, ownerId },
      });
      return {
        vin: row.vin,
        kind: row.kind as ElicitationKind,
        declinedAt: row.declinedAt.getTime(),
        declineCount: row.declineCount,
      };
    },

    async listActive(vin, since) {
      const rows = await prisma.elicitationCooldown.findMany({
        where: { vin, declinedAt: { gte: new Date(since) } },
      });
      return rows.map((r) => ({
        vin: r.vin,
        kind: r.kind as ElicitationKind,
        declinedAt: r.declinedAt.getTime(),
        declineCount: r.declineCount,
      }));
    },
  };
}
