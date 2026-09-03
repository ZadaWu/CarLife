/**
 * ACP 最小往返 spike（施工单 M4-01 任务 1）—— 关闭 §13-1 的验证脚本，长期保留为冒烟。
 *
 * 它只做一件事：起 pi-acp 子进程 → initialize → session/new → session/prompt → 打印 update 序列 → 干净退出。
 * **在它跑通之前不写任何业务代码**（M4-01 约束 1）。
 *
 * 运行（根目录）：
 *   corepack pnpm -w run spike:acp
 *
 * 分阶段退出码，便于在"哪一步断了"上不猜：
 *   0 = 完整往返成功
 *   10 = 子进程起不来（仓库内 pi-acp / pi 未安装或不可执行）
 *   20 = initialize 失败（协议协商问题，多半是 SDK 版本偏斜）
 *   30 = session/new 失败（cwd 或 pi 配置问题）
 *   40 = session/prompt 失败（多半是 pi 侧的模型凭证未配置——协议本身已通）
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

const HERE = dirname(fileURLToPath(import.meta.url));
/** pi 的项目级配置目录：session/new 的 cwd 决定 pi 从哪里发现 .pi/（§13-1 结论）。 */
const PI_AGENTS_DIR = resolve(HERE, "../../pi-agents");
const LOCAL_BIN = resolve(PI_AGENTS_DIR, "node_modules/.bin");
const ADAPTER_BIN = resolve(PI_AGENTS_DIR, "bin");
const PI_ACP_COMMAND = resolve(LOCAL_BIN, "pi-acp");
const PI_COMMAND = resolve(PI_AGENTS_DIR, "bin/pi-approved.sh");
const PROMPT_TIMEOUT_MS = 60_000;

function loadDotEnv(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(resolve(HERE, "../../../../.env"), "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)="?([^"]*)"?$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

function fail(code: number, stage: string, err: unknown): never {
  console.error(`\n✗ [${stage}] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(code);
}

// pi-acp 与 pi 都是 enterprise/backend/pi-agents 的本地 devDependency，其 bin 在该包的
// node_modules/.bin 下；这里同时使用绝对入口与本地 PATH，避免 spike 误测用户全局 pi。
// pi-acp 内部还要再 spawn `pi`，所以 wrapper 与 PATH 对两级子进程都必要。
if (!existsSync(PI_ACP_COMMAND) || !existsSync(PI_COMMAND)) {
  fail(10, "local-dependencies", "仓库内 pi/pi-acp 不完整，请先运行 corepack pnpm install");
}

const expectedNode = readFileSync(
  resolve(HERE, "../../../../.nvmrc"),
  "utf8",
).trim();
if (process.version !== `v${expectedNode}`) {
  fail(10, "node-version", `当前 Node ${process.version}，项目要求精确 Node ${expectedNode}`);
}

const child = spawn(PI_ACP_COMMAND, [], {
  cwd: PI_AGENTS_DIR,
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    ...loadDotEnv(),
    PATH: `${ADAPTER_BIN}:${LOCAL_BIN}:${process.env.PATH ?? ""}`,
    PI_SKIP_VERSION_CHECK: "1",
    PI_OFFLINE: "1",
    PI_ACP_PI_COMMAND: PI_COMMAND,
  },
});

child.on("error", (err) => {
  const hint =
    (err as NodeJS.ErrnoException).code === "ENOENT"
      ? "仓库内 pi-acp 本地入口不存在。先运行 corepack pnpm install"
      : String(err);
  fail(10, "spawn", hint);
});

// pi-acp 的诊断信息走 stderr，保留可见——它是排查 pi 未安装/未登录的唯一线索。
child.stderr.on("data", (b: Buffer) => process.stderr.write(`  [pi-acp] ${b}`));

// ndJsonStream(input, output)：input 是我们写出去的一侧，output 是我们读进来的一侧。
const input = new WritableStream<Uint8Array>({
  write(chunk) {
    return new Promise<void>((res) => child.stdin.write(chunk, () => res()));
  },
});
const output = new ReadableStream<Uint8Array>({
  start(controller) {
    child.stdout.on("data", (c: Buffer) => controller.enqueue(new Uint8Array(c)));
    child.stdout.on("end", () => controller.close());
    child.stdout.on("error", (e) => controller.error(e));
  },
});

const updates: string[] = [];
let deltaChars = 0;

const conn = new ClientSideConnection(
  () => ({
    // pi-acp 不发起权限请求（§0 已澄清 3）——这里实现只为满足接口，
    // 真正的权限门是工具 execute() 内的一次内部 HTTP（§8.4，M5-02）。
    async requestPermission() {
      throw new Error("unexpected: pi-acp 不应发起 session/request_permission");
    },
    async sessionUpdate(params: { update?: { sessionUpdate?: string; content?: { text?: string } } }) {
      const kind = params.update?.sessionUpdate ?? "unknown";
      updates.push(kind);
      const text = params.update?.content?.text;
      if (typeof text === "string") deltaChars += text.length;
    },
    async writeTextFile() {
      throw new Error("unsupported in spike");
    },
    async readTextFile() {
      throw new Error("unsupported in spike");
    },
  }),
  ndJsonStream(input, output),
);

async function main() {
  console.log(`▸ cwd = ${PI_AGENTS_DIR}`);

  const t0 = Date.now();
  let init: unknown;
  try {
    init = await conn.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } } as never);
  } catch (e) {
    fail(20, "initialize", e);
  }
  console.log(`✓ initialize (${Date.now() - t0}ms)`, JSON.stringify(init));

  let session: { sessionId?: string } = {};
  try {
    session = (await conn.newSession({ cwd: PI_AGENTS_DIR, mcpServers: [] } as never)) as { sessionId?: string };
  } catch (e) {
    fail(30, "session/new", e);
  }
  console.log(`✓ session/new → ${session.sessionId}`);

  const t1 = Date.now();
  try {
    const res = await Promise.race([
      conn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "回复一个字：好" }],
      } as never),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`prompt 超时 ${PROMPT_TIMEOUT_MS}ms`)), PROMPT_TIMEOUT_MS)),
    ]);
    console.log(`✓ session/prompt (${Date.now() - t1}ms)`, JSON.stringify(res));
  } catch (e) {
    console.error(`\n✗ [session/prompt] ${e instanceof Error ? e.message : String(e)}`);
    console.error(`  已收到的 update 类型：${updates.join(", ") || "(无)"}`);
    console.error("  注意：协议层若已走到这一步，说明 initialize/session/new 均正常，");
    console.error("  失败多半在 pi 侧的模型凭证或 provider 配置，不是 ACP 通道问题。");
    child.kill();
    process.exit(40);
  }

  console.log(`\n▸ update 序列（${updates.length} 条）：${[...new Set(updates)].join(", ")}`);
  console.log(`▸ 文本增量累计 ${deltaChars} 字符`);
  child.kill();
  process.exit(0);
}

main().catch((e) => fail(1, "unexpected", e));
