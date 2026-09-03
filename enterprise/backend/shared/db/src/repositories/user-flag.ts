/**
 * 用户级一次性标记仓储（施工单 M14-03，F-23-12）。
 *
 * 实现 `@carlife/memory` 的 `UserFlagStore`。语义刻意窄：
 * 只有 `has` 与幂等 `set`，**没有 unset**——"引导过"是发生过的事实，
 * 想再引导应当换一个新 flag 名，而不是抹掉旧事实。
 */

import type { PrismaClient } from "@prisma/client";
import type { UserFlagStore } from "@carlife/memory";

export function createUserFlagRepository(prisma: PrismaClient): UserFlagStore {
  return {
    async has(userId, flag) {
      const row = await prisma.userFlag.findUnique({
        where: { userId_flag: { userId, flag } },
        select: { userId: true },
      });
      return row !== null;
    },
    async set(userId, flag) {
      // 幂等：重复 set 不报错也不更新时间——`at` 记录的是**首次**发生。
      await prisma.userFlag.upsert({
        where: { userId_flag: { userId, flag } },
        create: { userId, flag },
        update: {},
      });
    },
  };
}
