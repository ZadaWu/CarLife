/**
 * `.env.example` 与配置注册表的**双向一致性检查**（施工单 M3-02，AC-35-10）。
 *
 * 运行：`corepack pnpm check:env-example`
 *
 * 为什么值得一条独立检查：沈立平那句"`.env.example` 里少了三个变量，
 * 新人照着填是起不来的"——模板缺一行就是缺陷。后续接进 US-43 的 L1 自检层。
 */

import { readFileSync } from "node:fs";

import { CONFIG_REGISTRY } from "@carlife/db";

const ROOT = new URL("../../../", import.meta.url);
const template = readFileSync(new URL(".env.example", ROOT), "utf8");

/*
 * 匹配 `KEY=` 与被注释掉的 `# KEY=`（可选项同样算"模板里有"）。
 *
 * 键名允许**混合大小写**：仓里绝大多数是 ALL_CAPS，但第三方约定的名字不由我们定——
 * 阿里云给的就是 `Aliyun_AccessKey_ID`（见 内部文档）。
 * 原来只认 `[A-Z][A-Z0-9_]*`，于是这类项写进 .env.example 也被判成"缺失"，
 * 而这个检查本身是拦"注册表加了项却忘了写进模板"的——不该顺带管命名风格。
 */
const declared = new Set(
  [...template.matchAll(/^#?\s*([A-Za-z][A-Za-z0-9_]*)=/gm)].map((m) => m[1]),
);

const missing = CONFIG_REGISTRY.filter((d) => !declared.has(d.envFallback));

let failed = false;

if (missing.length > 0) {
  failed = true;
  console.error("✗ .env.example 缺少以下注册表项（缺一行即缺陷）：");
  for (const d of missing) {
    console.error(`  - ${d.envFallback}  # ${d.description}`);
  }
} else {
  console.log(`✓ 注册表 ${CONFIG_REGISTRY.length} 项均在 .env.example 中声明`);
}

// 反向：模板里有、注册表里没有的项 —— 只警告不失败
// （端口、DATABASE_URL 之类的引导项允许存在于模板但不进注册表）
const known = new Set(CONFIG_REGISTRY.map((d) => d.envFallback));
const extra = [...declared].filter(
  (k) => !known.has(k) && !/^(GATEWAY_PORT|AGENT_RUNTIME_PORT|AGENT_RUNTIME_URL|CARLIFE_GATEWAY_URL|CARLIFE_DEMO_TOKEN|CARLIFE_ASR_FAKE_TEXT|CARLIFE_TTS_SAY_VOICE|CARLIFE_CONFIG_TTL_MS|CARLIFE_AGENT_RUNTIME|CARLIFE_ANSWER_RUNTIME|CARLIFE_ANSWER_MODEL|CARLIFE_TITLE_MODEL|CARLIFE_PROBE_RATE_LIMIT|TAURI_APPLE_DEVELOPMENT_TEAM|TEST_DATABASE_URL)$/.test(k),
);
if (extra.length > 0) {
  console.warn(`⚠ 模板中有、注册表中无：${extra.join(", ")}（如属配置项请补进注册表）`);
}

process.exit(failed ? 1 : 0);
