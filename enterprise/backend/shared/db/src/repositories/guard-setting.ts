/**
 * Guard 策略值仓储（施工单 TD-03，FL-30 F-30-01/02/03）。
 *
 * # 只承载 C 策略值，红线没有落点
 *
 * §8.2 三分边界：策略值归运营（本表）、接入面归管理员（`config_items`）、
 * **红线永远只在代码里**。红线类字段在本仓储的类型里根本不存在——
 * 不是"写入会被拒绝"，是压根没有那个 key。做成"可写但校验拒绝"的话，
 * 迟早有人为了某个急事把校验放宽。
 *
 * # 写入必留痕，且保留旧值
 *
 * 与 `ConfigItemRevision` 对密钥类的处理相反：那边不留旧值是因为多留一份
 * 明文/密文等于多开一个泄露面；策略值不是密钥，留旧值才能回答
 * "上周三那次误伤是在哪套策略下发生的"。
 */

import { PrismaClient, Prisma } from "@prisma/client";

/**
 * 本表承载的五项。红线不在其中——见文件头。
 *
 * `freshness_thresholds`（M26-02）是 ④⑥ 数据新鲜度的三项阈值。它进这张表而不是环境变量，
 * 因为按 FL-35 的四分类它是 **C 策略值**：运营可热改、要留痕、且改错了只是打扰多寡，
 * 不涉及安全红线。放 env 会让"改一次阈值要重启"，也绕过了留痕。
 *
 * 话术拆成"开关"与"文案"两个 key，不压成一份：
 * 留痕要能分别回答两个问题——「谁关掉了金融免责」是合规决定，
 * 「上周那版话术是谁改的」是文案决定，审阅人与风险都不同。
 * 压成一份 JSON 时两个问题都只能靠 diff 猜。
 * 两者的校验红线也不同：开关那边是"售后免责不可关"，文案那边是"不能太长"。
 */
export type GuardSettingKey =
  | "policy"
  | "kill_switch"
  | "disclaimer_policy"
  | "disclaimer_text"
  | "freshness_thresholds";

/** 止血开关（F-30-03）。Agent 级关闭在编排层生效，不是去停 pi-acp 进程。 */
export interface KillSwitch {
  /** 被关停的 Agent 名（supervisor/buying/ownership/trip/cabin/service）。 */
  agents: string[];
  /** 被关停的能力（工具名）。 */
  capabilities: string[];
}

export interface GuardSettingRecord<T = unknown> {
  key: GuardSettingKey;
  value: T;
  updatedBy?: string;
  updatedAt: number;
}

export interface GuardSettingRevisionRecord {
  id: string;
  key: string;
  prevValue: unknown;
  nextValue: unknown;
  actor: string;
  actorRole: string;
  at: number;
}

export interface GuardSettingRepository {
  /** 读一项；从未写过返回 null（调用方回落到代码里的默认值）。 */
  get<T>(key: GuardSettingKey): Promise<GuardSettingRecord<T> | null>;
  /**
   * 写一项并留痕。**同一事务**——留痕失败就不该改成功，
   * 否则会出现"策略变了但没人知道是谁改的"。
   */
  put<T>(
    key: GuardSettingKey,
    value: T,
    actor: { subject: string; role: string },
  ): Promise<GuardSettingRecord<T>>;
  /** 变更历史，最近在前。 */
  history(key: GuardSettingKey, limit?: number): Promise<GuardSettingRevisionRecord[]>;
}

export function createGuardSettingRepository(prisma: PrismaClient): GuardSettingRepository {
  return {
    async get<T>(key: GuardSettingKey) {
      const row = await prisma.guardSetting.findUnique({ where: { key } });
      if (!row) return null;
      return {
        key: row.key as GuardSettingKey,
        value: row.value as T,
        updatedBy: row.updatedBy ?? undefined,
        updatedAt: row.updatedAt.getTime(),
      };
    },

    async put<T>(key: GuardSettingKey, value: T, actor: { subject: string; role: string }) {
      return prisma.$transaction(async (tx) => {
        const before = await tx.guardSetting.findUnique({ where: { key } });
        const row = await tx.guardSetting.upsert({
          where: { key },
          create: { key, value: value as Prisma.InputJsonValue, updatedBy: actor.subject },
          update: { value: value as Prisma.InputJsonValue, updatedBy: actor.subject },
        });
        await tx.guardSettingRevision.create({
          data: {
            key,
            prevValue: (before?.value ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            nextValue: value as Prisma.InputJsonValue,
            actor: actor.subject,
            actorRole: actor.role,
          },
        });
        return {
          key: row.key as GuardSettingKey,
          value: row.value as T,
          updatedBy: row.updatedBy ?? undefined,
          updatedAt: row.updatedAt.getTime(),
        };
      });
    },

    async history(key, limit = 50) {
      const rows = await prisma.guardSettingRevision.findMany({
        where: { key },
        orderBy: { at: "desc" },
        take: limit,
      });
      return rows.map((r) => ({
        id: r.id,
        key: r.key,
        prevValue: r.prevValue,
        nextValue: r.nextValue,
        actor: r.actor,
        actorRole: r.actorRole,
        at: r.at.getTime(),
      }));
    },
  };
}
