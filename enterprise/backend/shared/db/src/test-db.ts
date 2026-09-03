/**
 * 测试库地址的唯一解析入口（施工单 M45-01）。
 *
 * # 为什么不是直接读 `DATABASE_URL`
 *
 * 之前测试与开发共用一个库，而 `e2e:dualpath` 的准备阶段会
 * `deleteMany({ ownerId: "demo-user" })` ——`demo:seed` 播的正是同一个 userId。
 * 跑一次端到端，演示数据就没了，要演示得重新播种。
 *
 * # 为什么绝不回落到 `DATABASE_URL`
 *
 * 写成 `TEST_DATABASE_URL ?? DATABASE_URL` 是这个文件最容易犯的错，
 * 且它**不会以失败的形式暴露**：平时两个变量都配着，测试照常全绿，
 * 直到某天演示前发现数据没了才知道隔离一直没生效。
 * 所以缺配置时用下面这个测试库的字面默认值，一眼都不看 `DATABASE_URL`。
 *
 * # `_test` 后缀是运行期强制的不变量，不是命名约定
 *
 * 约定会被下一个人绕过去（复制个脚本、图省事把变量指回开发库），
 * 而绕过去的表现是"什么都没发生"，直到数据没了。所以这里直接拒绝执行。
 * 与本仓在别处的做法一致：RAG 的数据集隔离也是调用层强制，不靠 prompt 约束。
 */

/** 没配 `TEST_DATABASE_URL` 时用它。**刻意与开发库同实例不同库**——隔离在库这一层就够了。 */
const DEFAULT_TEST_DATABASE_URL = "postgresql://carlife:carlife@localhost:55433/carlife_test";

/** 库名必须以它结尾。改这个后缀等于改一条不变量，先想清楚。 */
const REQUIRED_SUFFIX = "_test";

export class TestDatabaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestDatabaseUrlError";
  }
}

/** 从连接串里取库名：path 去掉前导 `/`，查询串由 URL 解析天然剥离。 */
function databaseNameOf(url: URL): string {
  return url.pathname.replace(/^\//, "");
}

/**
 * 解析并校验测试库地址。返回值是**已经过 `_test` 校验**的 URL——
 * 调用方拿到就可以直接连，不需要也不应该再自己检查一遍。
 *
 * @throws {TestDatabaseUrlError} URL 解析不了，或库名不以 `_test` 结尾
 */
export function resolveTestDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  // 只看 TEST_DATABASE_URL。不看 DATABASE_URL——理由见文件头。
  const raw = env.TEST_DATABASE_URL?.trim() || DEFAULT_TEST_DATABASE_URL;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // 解析不了就抛，**不静默退回默认值**：退回的话，一个拼错的连接串会表现成
    // "测试莫名其妙地过了"，而人以为自己正在测另一个库。
    throw new TestDatabaseUrlError(
      `TEST_DATABASE_URL 不是合法的连接串：${raw}\n` +
        `期望形如 ${DEFAULT_TEST_DATABASE_URL}`,
    );
  }

  const name = databaseNameOf(parsed);
  if (!name.endsWith(REQUIRED_SUFFIX)) {
    throw new TestDatabaseUrlError(
      `拒绝在库「${name}」上跑测试：库名必须以 ${REQUIRED_SUFFIX} 结尾。\n` +
        `这道闸挡的是"测试连上开发库"——测试会删数据（如 e2e 会清掉 demo-user 的车辆与行程）。\n` +
        `把 TEST_DATABASE_URL 指向测试库（默认 ${DEFAULT_TEST_DATABASE_URL}），` +
        `并先跑一次 corepack pnpm db:test:setup 建好它。`,
    );
  }

  return raw;
}

export { DEFAULT_TEST_DATABASE_URL };
