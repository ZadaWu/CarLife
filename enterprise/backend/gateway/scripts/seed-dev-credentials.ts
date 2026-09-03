/**
 * 开发账号口令播种（施工单 M48-02）。
 *
 * # 为什么需要它
 *
 * M48-01 的迁移把 `demo-user` 种成**锁定**账号（口令散列 `!`，scrypt 永不匹配）——
 * 迁移里不写死任何口令的散列，因为那等于把一个人人可读的凭证提交进仓库，
 * 而且它会出现在每一个部署环境里。
 *
 * 代价是：M48-02 删掉 demo-token 万能钥匙之后，**本机没有任何账号能登录**。
 * 这个脚本补上那一步。
 *
 * # 它放在 gateway 而不是 enterprise/backend/shared/db
 *
 * 口令散列是鉴权层的事（`src/auth/password.ts`）。把脚本放进 `enterprise/backend/shared/db`
 * 会让数据层反向依赖服务层——data 层现在被 worker、agent-runtime 都引着，
 * 那条依赖会把 gateway 拖进它们的构建里。
 *
 * # 它不是生产工具
 *
 * 只在本机 / CI 用；生产账号走 `POST /console/users`（admin token）。
 * 刻意不随机生成口令再打印——那会把口令写进终端历史与 CI 日志。
 *
 * 用法：
 *   corepack pnpm --filter @carlife/gateway seed:dev-credentials
 *   CARLIFE_DEV_PASSWORD=... 覆盖缺省口令（缺省 `carlife-dev`，仅本机）
 */

import { getPrisma } from "@carlife/db";

import { hashPassword } from "../src/auth/password";

const DEV_USER_ID = "demo-user";
const DEFAULT_PASSWORD = "carlife-dev";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("缺少 DATABASE_URL");
    process.exit(2);
  }
  const password = process.env.CARLIFE_DEV_PASSWORD?.trim() || DEFAULT_PASSWORD;
  const prisma = getPrisma();
  try {
    const user = await prisma.user.findUnique({ where: { id: DEV_USER_ID } });
    if (!user) {
      console.error(
        `账号 ${DEV_USER_ID} 不存在——先跑迁移（db:migrate:safe / migrate deploy），它会种下这一行`,
      );
      process.exitCode = 1;
      return;
    }
    await prisma.user.update({
      where: { id: DEV_USER_ID },
      data: { passwordHash: await hashPassword(password) },
    });
    console.log(
      `✓ 已为 ${DEV_USER_ID}（用户名 ${user.username}）设置口令` +
        (process.env.CARLIFE_DEV_PASSWORD ? "（来自 CARLIFE_DEV_PASSWORD）" : "（缺省开发口令）"),
    );
  } finally {
    await prisma.$disconnect();
  }
}

await main();
