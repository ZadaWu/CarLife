/**
 * 测试账号播种（施工单 M48-01）。
 *
 * # 为什么每个连真库的测试都突然需要它
 *
 * M48-01 之前 `vehicles.owner_id` / `trips.user_id` 这些归属列是**裸字符串**，
 * 测试随手写个 `"test-owner-m7-03"` 就能建车。加上外键之后，
 * "拥有一辆车的人必须是一个账号"成了数据库级事实——这正是外键该有的效果，
 * 不是测试的负担：产品里也不存在没有账号的车主。
 *
 * # 为什么是 upsert 而不是 create
 *
 * 各测试文件并行跑（`node --test` 默认按文件并发），两个文件用同一个测试账号 id
 * 会撞主键。撞主键的表现是"另一个无关的测试偶发失败"，最难查的那一类。
 *
 * # 为什么不在 after 里删账号
 *
 * 删账号会因 `vehicles.owner_id` 的 `onDelete: Restrict` 失败（如果清理顺序错了），
 * 或者级联删掉别的并行测试正在用的行。测试账号留在测试库里没有代价——
 * 它们的 id 有 `test-` 前缀，与真实数据天然分开。
 */

import type { PrismaClient } from "@prisma/client";

/** 播种若干测试账号。id 即传入值，`username` 由 id 派生保证唯一。 */
export async function seedTestUsers(
  prisma: PrismaClient,
  ids: readonly string[],
): Promise<void> {
  for (const id of [...new Set(ids)]) {
    await prisma.user.upsert({
      where: { id },
      update: {},
      create: {
        id,
        username: `u_${id}`,
        // 锁定账号：bcrypt 永不与 '!' 匹配。测试不走登录路径。
        passwordHash: "!",
        displayName: id,
      },
    });
  }
}
