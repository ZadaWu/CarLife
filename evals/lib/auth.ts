/**
 * 评测 runner 的鉴权令牌（施工单 M51-01）。
 *
 * # 它补的是一处**静默断裂**
 *
 * `scenarios/run.ts` 与 `risk/run.ts` 建于 M38，当时网关认一把硬编码的
 * `Bearer demo-token`。M48-02 把那把万能钥匙删了（`enterprise/backend/gateway/src/auth/index.ts`
 * 的文件头写着「留着它等于留一个人人可用的万能钥匙」——删得对），
 * 但两个 runner 没跟着改。
 *
 * 于是三套评测从那天起**一条 case 都跑不了**，而失败的样子离根因很远：
 * SSE 那一路抛 `stream 401`，主流程先卡在 60s 超时上，看起来像"评测很慢"。
 * 更糟的是它不在任何 CI 里——`eval:*` 不进 `check:all`，所以没有任何一条测试会红。
 * 本文件是修复；防复发的那一条在 `auth.test.ts`（签出来的 token 必须过
 * 网关自己的 `verifyToken`，两边用同一个密钥来源）。
 *
 * # 为什么在这里重签而不是 import 网关的 `issueToken`
 *
 * 与 `eval-risk-lib.ts` 抄 `CONFIRM_REQUIRED_TOOLS` 同一条：infra 脚本不 import
 * 服务内部模块。代价是这里要跟着 `auth/jwt.ts` 的 claims 形状走——所以
 * `auth.test.ts` 拿网关的 `verifyToken` 反过来验本文件签的 token，
 * 漂了就红在那条测试上，而不是红在一次花了钱的 real 档全量跑到一半时。
 *
 * # 有效期为什么给 8 小时
 *
 * 网关的 access token 是 15 分钟（撤销靠"下一次请求查库"，短是对的）。
 * 但一次 real 档全量要跑一个多小时，中途过期的表现是**后半段全部 401**——
 * 那会变成一张"通过率断崖下跌"的表，而原因与被测系统无关。
 * 这把 token 只发给本机隔离栈（18797/18798）里的评测进程，不落盘、不出网。
 */

import { createHmac } from "node:crypto";

/** 评测统一用演示账号——`demo:seed` 的两辆车（`DEM00SEED0*`）归它，⑥用车数据也挂在它名下。 */
export const EVAL_USER_ID = "demo-user";

/**
 * 开发默认签名密钥——**逐字复制自 `enterprise/backend/shared/db/src/config/registry.ts` 的 `DEV_JWT_SECRET`**。
 *
 * 为什么抄而不是 import：本文件被 `node --import tsx --test` 加载时走 CJS 解析路径，
 * 而根 `package.json` 没有 `@carlife/db` 依赖——那条 import 会让整个 `test:infra` 红在
 * 「Cannot find module」上。抄一份的代价是可能漂移，所以 `auth.test.ts` 里有一条
 * 断言直接读那个文件来对，漂了就红在那儿（同 `eval-risk-lib.ts` 抄 `CONFIRM_REQUIRED_TOOLS` 的做法）。
 */
export const DEV_JWT_SECRET = "carlife-dev-insecure-jwt-secret-changeme";

const TTL_SEC = 8 * 60 * 60;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * 签一把 access token。
 *
 * 密钥来源与网关的 `auth/jwt.ts` 一致：`CARLIFE_JWT_SECRET` 够长就用它，
 * 否则落回上面那份开发默认值。**两处必须同源**——各读各的环境变量时，
 * 「source 了 .env 就全 401、没 source 就正常」这种现象没人能一眼看穿。
 */
export function issueEvalToken(userId: string = EVAL_USER_ID): string {
  const raw = process.env.CARLIFE_JWT_SECRET?.trim();
  const secret = raw && raw.length >= 16 ? raw : DEV_JWT_SECRET;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      sub: userId,
      kind: "user",
      use: "access",
      iat: now,
      exp: now + TTL_SEC,
      jti: `eval-${now}-${Math.random().toString(36).slice(2, 10)}`,
    }),
  );
  const data = `${header}.${payload}`;
  return `${data}.${createHmac("sha256", Buffer.from(secret, "utf8")).update(data).digest("base64url")}`;
}

/** `assertEvalUser` 需要的最小 Prisma 形状——由调用方注入，本文件不 import `@carlife/db`。 */
export interface EvalUserLookup {
  user: { findUnique(q: unknown): Promise<{ id: string } | null> };
}

/**
 * 起跑前确认账号真的在库里。
 *
 * 网关对「token 坏」「用户不存在」一律回 401（防账号存在性探测，这是对的），
 * 所以这两件事在 runner 侧分不开。分不开就得**在起跑前分**：
 * 没有这个账号时直接告诉人去跑 `demo:seed`，而不是让 86 条 case 各自 401 一遍。
 *
 * Prisma 由调用方传进来：本文件一旦 import `@carlife/db`，
 * `test:infra` 的 CJS 解析路径就会红在「Cannot find module」上（根 package.json 没有这个依赖）。
 */
export async function assertEvalUser(prisma: EvalUserLookup, userId: string = EVAL_USER_ID): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error(
      `评测账号 \`${userId}\` 不在库里——网关会把它和「token 坏了」一样回 401，逐条跑只会得到一张全红的表。\n` +
        `先跑：corepack pnpm demo:seed`,
    );
  }
}
