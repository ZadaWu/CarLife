/**
 * 端到端脚本的登录助手（施工单 M48-02）。
 *
 * # 为什么每个脚本都要改
 *
 * M48-02 之前它们各自写着 `const TOKEN = "demo-token"` ——那把万能钥匙没了。
 * 现在脚本必须像真实客户端一样先登录换 token。这不是负担：
 * **它顺带让每条 e2e 都覆盖了一次登录路径**，而登录是新加的、最该被覆盖的一段。
 *
 * # 为什么带重试
 *
 * 脚本刚拉起 gateway 就调登录，进程可能还没 listen。
 * 各脚本原先都有自己的"等端口"逻辑，但登录失败的现象（401）与"还没起来"
 * （ECONNREFUSED）长得不一样，混在一起会让人往鉴权方向查。这里分开处理。
 */

/** 与 `seed-dev-credentials.ts` 的缺省值一致。 */
const DEV_USERNAME = "demo";
const DEV_PASSWORD = process.env.CARLIFE_DEV_PASSWORD?.trim() || "carlife-dev";

/**
 * 确保目标库里的开发账号可登录。
 *
 * 端到端脚本跑在**测试库**上，而迁移种下的 `demo-user` 是锁定的（散列 `!`）。
 * 让脚本自己把口令设好，比要求跑之前先手工执行一条命令可靠——
 * "忘了先播种"的现象是登录 401，而 401 会把人往鉴权实现上引。
 */
export async function ensureDevCredentials(databaseUrl: string): Promise<void> {
  /*
   * 从 `@carlife/db` 拿 PrismaClient，**不要直接 import `@prisma/client`**（M49-03 修）。
   *
   * `@prisma/client` 只是 `@carlife/db` 的依赖，不是 gateway 的。pnpm 的严格
   * node_modules 下，从 `enterprise/backend/gateway/scripts/` 解析它必然 ERR_MODULE_NOT_FOUND。
   * M48-02 写下这一行时没人跑到——**这几条 e2e 脚本不在 `check:all` 里**，
   * 于是 `e2e:m2-02` / `e2e:dualpath` / `smoke:*` 一起哑了一段时间而全仓照常绿。
   * 现象是脚本第一步就 ERR_MODULE_NOT_FOUND，与鉴权毫无关系，很容易被当成环境问题。
   */
  const { PrismaClient } = await import("@carlife/db");
  const { hashPassword } = await import("../../src/auth/password");
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    await prisma.user.update({
      where: { username: DEV_USERNAME },
      data: { passwordHash: await hashPassword(DEV_PASSWORD) },
    });
  } finally {
    await prisma.$disconnect();
  }
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  userId: string;
}

/** 登录换 token。连不上时重试（服务可能刚起），凭证不对则直接抛。 */
export async function login(
  gatewayUrl: string,
  opts: { username?: string; password?: string; deviceId?: string; retries?: number } = {},
): Promise<LoginResult> {
  const body = JSON.stringify({
    username: opts.username ?? DEV_USERNAME,
    password: opts.password ?? DEV_PASSWORD,
    ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
  });
  const retries = opts.retries ?? 30;

  for (let i = 0; i < retries; i += 1) {
    let res: Response;
    try {
      res = await fetch(`${gatewayUrl}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    } catch {
      // 还没 listen，等一下再试。
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }
    if (res.status === 401) {
      throw new Error(
        "登录被拒（401）。开发账号口令没设过？跑：" +
          "corepack pnpm --filter @carlife/gateway seed:dev-credentials",
      );
    }
    if (!res.ok) throw new Error(`登录失败 HTTP ${res.status}`);
    const json = (await res.json()) as {
      accessToken: string;
      refreshToken: string;
      user: { id: string };
    };
    return { accessToken: json.accessToken, refreshToken: json.refreshToken, userId: json.user.id };
  }
  throw new Error(`登录超时：${gatewayUrl} 一直连不上`);
}
