/**
 * 把后面那条命令跑在**测试库**上（施工单 M45-01）。
 *
 *   tsx scripts/dev/check/with-test-db.ts corepack pnpm -r --if-present test
 *
 * # 为什么要这么一层
 *
 * `enterprise/backend/shared/db` 的 10 个测试文件读的是 `process.env.DATABASE_URL`，而本机 shell 里
 * `.env` 通常是 source 过的——于是 `pnpm test` 实际连的是**开发库**。
 * 与其改那 10 个文件（还得指望以后新增的测试记得照做），不如在这里把子进程的
 * `DATABASE_URL` 换成测试库：测试代码一行不用动，新增的测试也自动落在正确的库上。
 *
 * 解析与 `_test` 校验都在 `@carlife/db` 的 `resolveTestDatabaseUrl()` 里，只有一份。
 *
 * # 为什么是 .ts 而不是 .mjs
 *
 * `@carlife/db` 在仓库根解析不到（根 package.json 没有它这个依赖，pnpm 也就没在根
 * node_modules 里放链接）——`node infra/scripts/with-test-db.mjs` 实测直接
 * ERR_MODULE_NOT_FOUND。经 tsx 跑就能解析，`check-env-example.ts` 一直是这么干的。
 */

import { spawn } from "node:child_process";

import { resolveTestDatabaseUrl } from "@carlife/db";

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error("用法：tsx scripts/dev/check/with-test-db.ts <命令> [参数…]");
  process.exit(2);
}

let testUrl: string;
try {
  testUrl = resolveTestDatabaseUrl();
} catch (err) {
  // 安全闸拒绝时把原因原样打出来——它已经写清了怎么改。
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
}

const child = spawn(argv[0], argv.slice(1), {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: testUrl },
});

// 透传退出码与信号，否则 CI 会把被信号杀死的进程当成通过。
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal as NodeJS.Signals);
  else process.exit(code ?? 0);
});
child.on("error", (err) => {
  console.error(`起不来：${argv[0]}——${err.message}`);
  process.exit(1);
});
