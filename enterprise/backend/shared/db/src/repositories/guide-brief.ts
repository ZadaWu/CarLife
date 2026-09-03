/**
 * 景区导览简报的持久仓储（2026-08-29 走查追修：只采一次）。
 *
 * 读写维度只有 (city, spotName)，与⑤缓存键同构：city 为空统一写 "-"——
 * 两套键必须同源，否则同一景点两条路各存一份（M40-02 已为缓存键踩过这坑）。
 * brief 是 @carlife/shared `GuideBrief` 的 JSON 快照，结构由契约管，这里不校验
 * 不拆列；**只存三支齐全的简报**由调用方把关（半成品占位会让景点永远不再补全）。
 */

import type { Prisma, PrismaClient } from "@prisma/client";

export interface GuideBriefStore {
  /** 命中返回 brief JSON（unknown，调用方按 shared 契约用）；没有返回 null。 */
  get(city: string | undefined, spotName: string): Promise<unknown | null>;
  /** upsert：重新采集（force）覆盖旧份。 */
  put(city: string | undefined, spotName: string, brief: unknown): Promise<void>;
}

const cityKey = (city: string | undefined): string => city?.trim() || "-";

export function createGuideBriefRepository(prisma: PrismaClient): GuideBriefStore {
  return {
    async get(city, spotName) {
      const row = await prisma.guideBriefRecord.findUnique({
        where: { city_spotName: { city: cityKey(city), spotName } },
      });
      return row?.brief ?? null;
    },

    async put(city, spotName, brief) {
      const value = brief as Prisma.InputJsonValue;
      await prisma.guideBriefRecord.upsert({
        where: { city_spotName: { city: cityKey(city), spotName } },
        create: { city: cityKey(city), spotName, brief: value },
        update: { brief: value },
      });
    },
  };
}
