/**
 * 演示前检查单（施工单 M38-04 / FL-43 F-43-11）。
 *
 * 回答一个 `dev:status` 回答不了的问题：**现在能不能开始演示。**
 *
 * # 只读，绝不代跑修复
 *
 * 每一项只检查、只给修复命令，**不自己动手**。代跑就会变成第二个 `dev:bootstrap`，
 * 而两个 bootstrap 的漂移是从"顺手修一下"开始的。演示前你要知道的是"哪里不对"，
 * 不是"它替我修过了但我不知道修了什么"。
 *
 * # 它盯的是几次真实的演示事故
 *
 * 全部来自内部开发指引 的「已知坑」，每一条都真的发生过：
 *
 * | 事故 | 现场表现 | 本脚本怎么抓 |
 * |---|---|---|
 * | `mock-dealer` 没起 | 助手一本正经地说「门店系统没连上」，**看起来像产品故障** | 单独一项探它的 `/health` |
 * | 只起了 `cockpit` 没起 `cockpit-app` | 端口有人应答、状态表也显示"正常"，**屏幕上什么都不会出现** | 两个目标分别检查，缺一即 ✗ |
 * | 监护层已死 | 端口照常应答，改代码却再也不生效 | 复用 `dev.sh status` 的判定（它按 cwd 认进程，`pgrep` 找不到最里层那个） |
 * | `.env` 没 source / 缺 master key | 服务起不来，或起来了但配置层是空的 | 直接读 `.env` 查必填键 |
 *
 * # 与 `dev:bootstrap` / `dev:status` 的分工
 *
 * `dev:bootstrap` 是"把它弄好"，`dev:status` 是"进程在不在"，本脚本是"能不能演示"——
 * 后者要看的东西前两者都不看：种子数据在不在、当前是哪一档（fake 还是真实 LLM）、
 * 迁移落没落全。
 *
 * 用法：
 *   corepack pnpm demo:verify
 *   corepack pnpm demo:verify -- --json   # 机器可读
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";


const ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** 一句修复提示——**给命令，不给"请检查配置"**。 */
  fix?: string;
  /** 只报事实、不参与判定（如"当前是 fake 档"）。 */
  info?: boolean;
}

export interface DevStatusRow {
  target: string;
  port: string;
  pid: string;
  state: string;
}

export interface ComposeRow {
  service: string;
  state: string;
  health: string;
}

/** 全部外部观察都从这里进来——单测把它换成桩，就能不起任何服务地验判定。 */
export interface Probes {
  envFile(): Record<string, string> | undefined;
  composePs(): ComposeRow[] | undefined;
  devStatus(): DevStatusRow[] | undefined;
  http(url: string): Promise<{ status: number; body: string } | undefined>;
  migrationsApplied(): Promise<number | undefined>;
  migrationsOnDisk(): number;
  /** 新 clone 上 Prisma 客户端不会自动生成——先查它，否则后面每一项碰库的都会以"连不上库"收场。 */
  prismaClientGenerated(): boolean;
  seedStatus(): Promise<Array<{ name: string; ok: boolean; detail: string }> | undefined>;
}

/** 演示必须在跑的宿主服务。`cockpit` 与 `cockpit-app` **两个都要**——单起前者是白屏。 */
export const REQUIRED_TARGETS = [
  "gateway",
  "runtime",
  "mock-dealer",
  "mock-cabin",
  "mock-repair",
  "web",
  "cockpit",
  "cockpit-app",
] as const;

/** compose 里演示要用到的三个（`local-asr` 只在 `ASR_ENGINE=mock` 时才要，不强制）。 */
export const REQUIRED_CONTAINERS = ["postgres", "redis", "minio"] as const;

export async function runChecks(p: Probes): Promise<CheckResult[]> {
  const out: CheckResult[] = [];

  // ── ① .env 与必填键 ────────────────────────────────────
  const env = p.envFile();
  if (!env) {
    out.push({
      name: ".env 存在",
      ok: false,
      detail: "仓库根没有 .env",
      fix: "cp .env.example .env，再按 DEMO.md 填两个必填键",
    });
  } else {
    out.push({ name: ".env 存在", ok: true, detail: "已读到" });
    const db = env.DATABASE_URL ?? "";
    out.push({
      name: "DATABASE_URL",
      ok: db.startsWith("postgresql://"),
      detail: db ? "已配置" : "缺失",
      fix: "DATABASE_URL=postgresql://carlife:carlife@localhost:55433/carlife",
    });
    /*
     * **两把钥匙，不是一把**（M42-01 刻意分的：轮换周期与泄露影响面不同）。
     * 两者都是「缺失或过短即启动失败」，而失败信息离原因很远——干净环境实跑时
     * 正是漏了 `CARLIFE_PII_MASTER_KEY` 让 gateway 与 runtime 起不来，
     * 表现却是 `dev:bootstrap` 卡在 readiness、`/healthz` 无响应。
     */
    for (const [key, hint] of [
      ["CARLIFE_CONFIG_MASTER_KEY", "openssl rand -hex 16 生成后写进 .env（只加密本地配置，不是产品密钥）"],
      ["CARLIFE_PII_MASTER_KEY", "openssl rand -hex 32 生成后写进 .env（加密成员联系人等个人信息，与上一把独立）"],
    ] as const) {
      const value = env[key] ?? "";
      out.push({
        name: key,
        // 长度是硬要求：不足 16 字符服务直接起不来。
        ok: value.length >= 16,
        detail: value ? `${value.length} 字符` : "缺失",
        fix: hint,
      });
    }
  }

  // ── ② 容器 ────────────────────────────────────────────
  const ps = p.composePs();
  if (!ps) {
    out.push({
      name: "Docker 容器",
      ok: false,
      detail: "拿不到 compose 状态（Docker 没起？）",
      fix: "开 Docker Desktop 后 corepack pnpm dev:infra-up",
    });
  } else {
    for (const svc of REQUIRED_CONTAINERS) {
      const row = ps.find((r) => r.service === svc);
      const healthy = row?.state === "running" && (row.health === "healthy" || row.health === "");
      out.push({
        name: `容器 ${svc}`,
        ok: healthy,
        detail: row ? `${row.state}${row.health ? `/${row.health}` : ""}` : "未运行",
        fix: "corepack pnpm dev:infra-up",
      });
    }
  }

  // ── ③ 迁移 ────────────────────────────────────────────
  const prismaReady = p.prismaClientGenerated();
  out.push({
    name: "Prisma 客户端已生成",
    ok: prismaReady,
    detail: prismaReady ? "node_modules/.prisma/client 在" : "没生成——新 clone 上它不会自动生成",
    // 这一条不在 dev:bootstrap 里（它只 migrate deploy），所以新 clone 必须显式跑一次。
    fix: "corepack pnpm --filter @carlife/db db:generate",
  });
  const applied = prismaReady ? await p.migrationsApplied() : undefined;
  const onDisk = p.migrationsOnDisk();
  out.push({
    name: "数据库迁移",
    ok: applied !== undefined && applied >= onDisk,
    detail: applied === undefined ? (prismaReady ? "连不上库" : "跳过（Prisma 客户端未生成）") : `已落 ${applied} / 目录里 ${onDisk}`,
    fix: "corepack pnpm dev:bootstrap（它会 migrate deploy 并复查）",
  });

  // ── ④ 宿主进程（复用 dev.sh 的判定）─────────────────────
  const rows = p.devStatus();
  if (!rows) {
    out.push({ name: "宿主服务", ok: false, detail: "拿不到 dev:status 输出", fix: "corepack pnpm dev:status 手动看一眼" });
  } else {
    for (const target of REQUIRED_TARGETS) {
      const row = rows.find((r) => r.target === target);
      const state = row?.state ?? "未运行";
      // 「监护层已死」是最难发现的那种：端口照常应答，改代码却不生效。它算 ✗。
      const dead = state.includes("监护层已死");
      const running = row !== undefined && state !== "未运行" && !state.startsWith("❌") && !dead;
      out.push({
        name: `服务 ${target}`,
        ok: running,
        detail: state,
        fix: dead ? `corepack pnpm dev:restart ${target}（监护层死了，重启才会重新生效）` : `corepack pnpm dev:restart ${target}`,
      });
    }
  }

  // ── ⑤ 端口真的应答（进程在 ≠ 服务可用）──────────────────
  /*
   * **后端端口从 `.env` 读，不写死。**
   *
   * `.env.example` 里 `GATEWAY_PORT` / `AGENT_RUNTIME_PORT` / `MOCK_DEALER_PORT`
   * 都是可改的：8790 被别的东西占着的机器上，使用者改完 `.env`，一张写死端口的检查单
   * 会去探**别人的服务**——探到了就报绿，探不到就报错，两种都不是真相。
   *
   * 前端三个（cockpit 1430 / mobile 1420 / web 5173）**是写死的**：它们在各自的
   * `vite.config.ts` 里且 `strictPort: true`，环境变量改不动。这里照抄常量，
   * 并不是偷懒——改端口要改 vite 配置，那时这里也得跟着改。
   */
  const port = (key: string, fallback: number): number => Number(env?.[key] ?? process.env[key] ?? fallback) || fallback;
  const gatewayPort = port("GATEWAY_PORT", 8790);
  const runtimePort = port("AGENT_RUNTIME_PORT", 8791);
  const dealerPort = port("MOCK_DEALER_PORT", 8792);
  const runtimeHealthUrl = `http://localhost:${runtimePort}/internal/health/runtime`;
  for (const [name, url, fix] of [
    [`网关 /healthz :${gatewayPort}`, `http://localhost:${gatewayPort}/healthz`, "corepack pnpm dev:restart gateway"],
    [`runtime 健康 :${runtimePort}`, runtimeHealthUrl, "corepack pnpm dev:restart runtime"],
    [`门店系统 /health :${dealerPort}`, `http://localhost:${dealerPort}/health`, "corepack pnpm dev:restart mock-dealer（它不起时助手会说「门店系统没连上」，看着像产品故障）"],
    ["车机 vite :1430", "http://localhost:1430/", "corepack pnpm dev:restart cockpit（vite 没起，客户端窗口就是白屏）"],
    ["运营台 :5173", "http://localhost:5173/", "corepack pnpm dev:restart web"],
  ] as const) {
    const r = await p.http(url);
    out.push({ name, ok: r !== undefined && r.status < 400, detail: r ? `HTTP ${r.status}` : "无响应", fix });
  }

  // ── ⑥ 演示数据 ────────────────────────────────────────
  const seed = await p.seedStatus();
  if (!seed) {
    out.push({ name: "演示数据", ok: false, detail: "查不到（库连不上？）", fix: "corepack pnpm demo:seed" });
  } else {
    for (const s of seed) {
      out.push({ name: `演示数据 ${s.name}`, ok: s.ok, detail: s.detail, fix: "corepack pnpm demo:seed（幂等，可重复跑）" });
    }
  }

  /*
   * ── ⑥.5 档位配置自洽吗 ────────────────────────────────
   *
   * **既没有真实 LLM 密钥、又没开离线档 → 对话会一直挂着不出字。**
   * 干净环境实跑撞到过：`.env.example` 里 `CARLIFE_LLM=fake` 是注释掉的，
   * 照五步走而没手动打开它的人，得到的是一个没有报错、也永远不回话的助手
   * （SSE 里有 tool_call、有 branch，就是没有 delta 和 turn_end）。
   * 这一项要 ✗ 得响——沉默的错配比报错难查十倍。
   */
  if (env) {
    const llmMode = (env.CARLIFE_LLM ?? "").trim();
    const deepseek = (env.DEEPSEEK_API_KEY ?? "").trim();
    const usable = llmMode === "fake" || deepseek.length > 0;
    out.push({
      name: "LLM 档位配置",
      ok: usable,
      detail: usable ? (llmMode === "fake" ? "离线档（CARLIFE_LLM=fake）" : "真实档（有 DEEPSEEK_API_KEY）") : "既没有 DEEPSEEK_API_KEY，也没开 CARLIFE_LLM=fake",
      fix: "离线演示：在 .env 里加一行 CARLIFE_LLM=fake（.env.example 里它是注释掉的）；真实档：填 DEEPSEEK_API_KEY",
    });
  }

  // ── ⑦ 当前是哪一档（只报事实，不判对错）──────────────────
  const health = await p.http(runtimeHealthUrl);
  if (health) {
    try {
      const h = (JSON.parse(health.body) as { health?: { llm?: string; guardrails?: { moderation?: boolean } } }).health;
      out.push({
        name: "当前档位",
        ok: true,
        info: true,
        // runtime 的 `llm` 只看 CARLIFE_LLM 这一个开关：没配密钥、也没标 fake 时
        // 它照样报 real，而实际行为不是。所以这里补一句以 .env 为准的说明。
        detail:
          `runtime 自报 LLM=${h?.llm ?? "?"}；内容审核层=${h?.guardrails?.moderation ? "已接入" : "未接入"}` +
          (env && (env.CARLIFE_LLM ?? "").trim() !== "fake" && !(env.DEEPSEEK_API_KEY ?? "").trim()
            ? "（⚠️ 但 .env 里既无密钥也未开 fake——自报的 real 不作数）"
            : ""),
      });
    } catch {
      /* 拿不到就不报这一项——它是信息，不是判定 */
    }
  }

  return out;
}

export function render(results: CheckResult[]): string {
  const out: string[] = ["演示前检查单（只读；不代跑任何修复）", ""];
  for (const r of results) {
    const mark = r.info ? "ℹ" : r.ok ? "✓" : "✗";
    out.push(`  ${mark} ${r.name.padEnd(26)} ${r.detail}`);
    if (!r.ok && !r.info && r.fix) out.push(`      ↳ ${r.fix}`);
  }
  const bad = results.filter((r) => !r.ok && !r.info);
  out.push("");
  out.push(bad.length === 0 ? "全部通过——可以开始演示。" : `${bad.length} 项未通过——**先修完再演示**，上面每项都给了命令。`);
  return out.join("\n");
}

// ── 真实探测 ──────────────────────────────────────────────

/**
 * 生成后的 Prisma 客户端可能落在两处，**两处都要看**。
 *
 * npm/yarn 的经典布局是 `node_modules/.prisma/client`；而 pnpm 下它落在
 * `node_modules/.pnpm/@prisma+client@<版本>/node_modules/.prisma/client`。
 * 只查前者的话，本仓（pnpm）永远报"没生成"——一个**把好环境报成坏的检查项**，
 * 比没有这一项更糟：它会让人去跑一条不需要的命令，然后开始怀疑整张检查单。
 * （ADR-003 同一条：校验器识别不到时必须报"我可能瞎了"，不许把它当成缺失。）
 */
function prismaClientPaths(): string[] {
  const out = [join(ROOT, "node_modules/.prisma/client")];
  const pnpmDir = join(ROOT, "node_modules/.pnpm");
  try {
    for (const entry of readdirSync(pnpmDir)) {
      if (entry.startsWith("@prisma+client@")) out.push(join(pnpmDir, entry, "node_modules/.prisma/client"));
    }
  } catch {
    /* 没有 .pnpm 目录就只看经典布局 */
  }
  return out;
}
function parseEnvFile(): Record<string, string> | undefined {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return undefined;
  const env: Record<string, string> = {};
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const raw = m[2];
    env[m[1]] = raw.replace(/^["'](.*)["']$/, "$1");
  }
  return env;
}

/** 解析 `dev.sh status` 的表格。**复用它而不是重写进程探测**：它按 cwd 认进程，是唯一抓得到最里层那个 node 的办法。 */
export function parseDevStatus(text: string): DevStatusRow[] {
  const rows: DevStatusRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s{2}(\S+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m || m[1] === "目标") continue;
    rows.push({ target: m[1], port: m[2], pid: m[3], state: m[4] });
  }
  return rows;
}

function realProbes(): Probes {
  return {
    envFile: parseEnvFile,
    composePs: () => {
      try {
        const raw = execFileSync("docker", ["compose", "-f", join(ROOT, "infra/docker-compose.yml"), "ps", "--format", "json"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        return raw
          .split("\n")
          .filter((l) => l.trim().startsWith("{"))
          .map((l) => JSON.parse(l) as { Service?: string; State?: string; Health?: string })
          .map((r) => ({ service: r.Service ?? "", state: r.State ?? "", health: r.Health ?? "" }));
      } catch {
        return undefined;
      }
    },
    devStatus: () => {
      try {
        return parseDevStatus(
          execFileSync("bash", [join(ROOT, "infra/scripts/dev.sh"), "status"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
        );
      } catch {
        return undefined;
      }
    },
    http: async (url) => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
        return { status: r.status, body: await r.text() };
      } catch {
        return undefined;
      }
    },
    migrationsApplied: async () => {
      try {
        /*
         * **按相对路径动态 import，而且必须包在 try 里**——三个坑叠在一起：
         *  ① `import("@carlife/db")` 在 tsx 的 CJS 转译路径下解析不到 workspace 包；
         *  ② 顶层静态 import 会让 `test:infra` 直接起不来（`infra/` 不是 workspace 成员，
         *    仓库根 node_modules 里没有 `@carlife/*` 的链接）；
         *  ③ **新 clone 上 Prisma 客户端还没生成**，顶层 import 会让整个检查单
         *    带着一屏 `Cannot find module '.prisma/client/default'` 崩掉——
         *    一个本该报告问题的工具，自己变成了那个问题。实测于干净 clone。
         */
        const { getPrisma } = (await import("../../../enterprise/backend/shared/db/src/index")) as {
          getPrisma: () => { $queryRawUnsafe: (q: string) => Promise<Array<{ n: bigint }>> };
        };
        const rows = await getPrisma().$queryRawUnsafe(
          `select count(*)::bigint as n from "_prisma_migrations" where finished_at is not null and rolled_back_at is null`,
        );
        return Number(rows[0]?.n ?? 0);
      } catch {
        return undefined;
      }
    },
    migrationsOnDisk: () =>
      readdirSync(join(ROOT, "enterprise/backend/shared/db/prisma/migrations"), { withFileTypes: true }).filter((d) => d.isDirectory()).length,
    prismaClientGenerated: () => prismaClientPaths().some((d) => existsSync(d)),
    seedStatus: async () => {
      try {
        const { status } = (await import("./demo-seed")) as { status: () => Promise<Array<{ name: string; ok: boolean; detail: string }>> };
        return await status();
      } catch {
        return undefined;
      }
    },
  };
}

async function main(): Promise<void> {
  /*
   * **自己把 `.env` 灌进 process.env**（不覆盖已有值），与 `dev-readiness.mjs`
   * 的 `loadRootEnv` 同一做法。
   *
   * 不这么做的话，使用者照 DEMO.md 走到这一步会看到「数据库迁移：连不上库」——
   * 而库好好的，只是这个进程不知道 `DATABASE_URL`。**一个检查单不该要求使用者
   * 先做一件文档里没写的事**（实测于干净 clone：`.env` 建好了、容器 healthy，
   * 唯独这一项红）。
   */
  const fileEnv = parseEnvFile();
  for (const [k, v] of Object.entries(fileEnv ?? {})) if (process.env[k] === undefined) process.env[k] = v;

  const results = await runChecks(realProbes());
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  } else {
    console.log(render(results));
  }
  process.exit(results.some((r) => !r.ok && !r.info) ? 1 : 0);
}

// 直接执行时才跑 main。**必须锚定结尾**：`includes("x")` 会把 `x.test.ts` 也算上，
// 于是单测一 import 就真的去探活、真的打印检查单（实测踩到）。
if (/\/demo-verify\.ts$/.test(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
