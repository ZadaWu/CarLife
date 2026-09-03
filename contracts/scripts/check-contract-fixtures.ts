/**
 * 跨语言契约一致性校验（施工单 M2-01）。
 *
 * 断言 `src/protocol/samples.ts`（类型化样例，编译期贴合 TS 契约）与
 * `fixtures/contract-events.json`（Rust 测试消费的同一份数据）逐值相等。
 * 加上 Rust 侧的 serde 往返测试，构成三方一致：
 *   TS 类型 ⇄ samples.ts ⇄ fixtures.json ⇄ Rust 契约类型。
 *
 * 运行：`corepack pnpm test:contract`（根目录，经 tsx 执行）。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deepStrictEqual } from "node:assert";

import {
  SAMPLE_AUDIO_META,
  SAMPLE_CAPTURE_STATUSES,
  SAMPLE_ENVELOPES,
  SAMPLE_HISTORY_PAGE,
  SAMPLE_MESSAGES,
} from "../src/protocol/samples";
import {
  DEFAULT_AUDIO_CHANNELS,
  DEFAULT_AUDIO_FORMAT,
  DEFAULT_AUDIO_SAMPLE_RATE_HZ,
  MAX_CAPTURE_DURATION_MS,
} from "../src/constants";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(join(here, "../fixtures/contract-events.json"), "utf8"),
) as Record<string, unknown>;

/** JSON 往返，消除 undefined 与原型差异后做结构比较。 */
const norm = (v: unknown) => JSON.parse(JSON.stringify(v));

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  try {
    deepStrictEqual(norm(actual), norm(expected));
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`✗ ${name}`);
    console.error(err instanceof Error ? err.message : err);
  }
}

check("envelopes：samples.ts ↔ fixtures.json", SAMPLE_ENVELOPES, fixtures.envelopes);
check("messages：samples.ts ↔ fixtures.json", SAMPLE_MESSAGES, fixtures.messages);
check("historyPage：samples.ts ↔ fixtures.json", SAMPLE_HISTORY_PAGE, fixtures.historyPage);
check(
  "captureStatuses：samples.ts ↔ fixtures.json",
  SAMPLE_CAPTURE_STATUSES,
  fixtures.captureStatuses,
);
check("audioMeta：samples.ts ↔ fixtures.json", SAMPLE_AUDIO_META, fixtures.audioMeta);

// 常量镜像核对（TS constants ↔ fixtures.audioMeta ↔ Rust consts 由 Rust 测试核对）
check("audio 常量镜像：format", SAMPLE_AUDIO_META.format, DEFAULT_AUDIO_FORMAT);
check("audio 常量镜像：sampleRateHz", SAMPLE_AUDIO_META.sampleRateHz, DEFAULT_AUDIO_SAMPLE_RATE_HZ);
check("audio 常量镜像：channels", SAMPLE_AUDIO_META.channels, DEFAULT_AUDIO_CHANNELS);
if (SAMPLE_AUDIO_META.durationMs > MAX_CAPTURE_DURATION_MS) {
  failed += 1;
  console.error("✗ audioMeta.durationMs 超过 MAX_CAPTURE_DURATION_MS");
}

// 五类事件覆盖断言（与 Rust 测试同一约束）
const kinds = new Set(
  (fixtures.envelopes as Array<{ event: { type: string } }>).map((e) => e.event.type),
);
for (const k of ["session", "prompt", "update", "permission", "tool_call"]) {
  if (!kinds.has(k)) {
    failed += 1;
    console.error(`✗ fixtures 未覆盖事件类型 ${k}`);
  }
}
console.log(`✓ 事件类型覆盖：${[...kinds].join(", ")}`);

if (failed > 0) {
  console.error(`\n契约一致性校验失败：${failed} 项`);
  process.exit(1);
}
console.log("\n契约一致性校验通过。");
