/**
 * 车主档案仓储（施工单 M13-10）。
 *
 * 目前只有一项：常住地。它的消费方是座舱 HUD——**没有行程时地图落在哪里**。
 *
 * # 为什么是「读时初始化」而不是建档时写入
 *
 * 车主档案这张表是随这一项一起加的，存量用户一行都没有。等建档流程补上
 * 再回填，中间这段时间 HUD 就没有落点，只能退回写死的坐标——而写死的那个
 * 是深圳，对一个杭州车主来说是「地图停在一个他没去过的城市」。
 *
 * 所以第一次读就落一行默认值。**默认值是明确的、可覆盖的**，不是猜的：
 * 它只表示"还没设置过"，用户改了就以用户的为准（`setHome`）。
 */

import { PrismaClient } from "@prisma/client";

export interface HomePlace {
  /** 展示名，如「浙江杭州」。 */
  city: string;
  lat: number;
  lon: number;
}

export interface OwnerProfile {
  userId: string;
  home: HomePlace;
  updatedAt: Date;
}

/**
 * 未设置常住地时的默认落点：浙江杭州（西湖文化广场一带）。
 *
 * 坐标是真实的杭州市中心坐标，不是占位数字——HUD 拿它当地图中心，
 * 随手填的坐标会把地图落在钱塘江里，而那看起来只是"地图有点怪"。
 */
export const DEFAULT_HOME: HomePlace = { city: "浙江杭州", lat: 30.2741, lon: 120.1551 };

export interface OwnerProfileRepository {
  /** 读；没有就按默认值落一行再返回（见文件头）。 */
  currentForUser(userId: string): Promise<OwnerProfile>;
  /** 覆盖常住地。 */
  setHome(userId: string, home: HomePlace): Promise<OwnerProfile>;
}

type Row = {
  userId: string;
  homeCity: string;
  homeLat: number;
  homeLon: number;
  updatedAt: Date;
};

function toDomain(r: Row): OwnerProfile {
  return {
    userId: r.userId,
    home: { city: r.homeCity, lat: r.homeLat, lon: r.homeLon },
    updatedAt: r.updatedAt,
  };
}

export function createOwnerProfileRepository(prisma: PrismaClient): OwnerProfileRepository {
  return {
    async currentForUser(userId) {
      const existing = await prisma.ownerProfile.findUnique({ where: { userId } });
      if (existing) return toDomain(existing as Row);
      /*
       * upsert 而不是 create：两路轮询同时首次读会撞主键，
       * 而"HUD 拉取偶发 500"这种现象没人会往这一行看。
       */
      const row = await prisma.ownerProfile.upsert({
        where: { userId },
        update: {},
        create: {
          userId,
          homeCity: DEFAULT_HOME.city,
          homeLat: DEFAULT_HOME.lat,
          homeLon: DEFAULT_HOME.lon,
        },
      });
      return toDomain(row as Row);
    },

    async setHome(userId, home) {
      const row = await prisma.ownerProfile.upsert({
        where: { userId },
        update: { homeCity: home.city, homeLat: home.lat, homeLon: home.lon },
        create: { userId, homeCity: home.city, homeLat: home.lat, homeLon: home.lon },
      });
      return toDomain(row as Row);
    },
  };
}
