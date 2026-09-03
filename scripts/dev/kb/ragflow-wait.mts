/**
 * 等 RAGFlow 把文档解析完（施工单 M8-01 运维辅助）。
 *
 * # 为什么不用一行 shell
 *
 * 第一版是 shell + curl + grep：curl 偶发失败时拿到空串，
 * `grep -q RUNNING` 找不到东西就判定"跑完了"——**把「没拿到数据」读成了「成功」**。
 * 我据此报了一次"全部解析完成"，实际还在 15%。
 *
 * 所以这一版要求**正面证据**：必须真的拿到每一篇的状态，且全部为 succeeded
 * 才算完成。查询失败就明说查询失败，不做任何推断。
 *
 * 用法：corepack pnpm kb:wait
 */

import { readFileSync } from "node:fs";

import { createRagClient, type DatasetKey } from "../../../enterprise/backend/shared/rag/src/index";

const AGENTS: Record<DatasetKey, string> = {
  "vehicle-manuals": "ownership",
  "repair-kb": "service",
  "car-catalog": "buying",
};

function env(k: string): string {
  if (process.env[k]) return process.env[k] as string;
  try {
    for (const l of readFileSync(".env", "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)="?([^"]*)"?$/.exec(l.trim());
      if (m && m[1] === k) return m[2];
    }
  } catch { /* 无 .env */ }
  return "";
}

const POLL_MS = 30_000;
const DEADLINE_MS = 60 * 60_000;

async function main(): Promise<void> {
  const client = createRagClient({
    baseUrl: env("RAGFLOW_BASE_URL"),
    apiKey: env("RAGFLOW_API_KEY"),
    datasetIds: {
      "vehicle-manuals": env("RAGFLOW_DATASET_VEHICLE_MANUALS"),
      "repair-kb": env("RAGFLOW_DATASET_REPAIR_KB"),
      "car-catalog": env("RAGFLOW_DATASET_CAR_CATALOG"),
    },
  });

  const until = Date.now() + DEADLINE_MS;
  let lastLine = "";

  while (Date.now() < until) {
    let all: Array<{ ds: string; name: string; status: string; error?: string; chunks?: number }> = [];
    let queryFailed = false;

    for (const [ds, agent] of Object.entries(AGENTS) as Array<[DatasetKey, string]>) {
      try {
        const docs = await client.listDocuments(ds, agent);
        all = all.concat(docs.map((d) => ({
          ds, name: d.name, status: d.status, error: d.error, chunks: d.chunkCount,
        })));
      } catch (e) {
        // **查询失败不推断任何结论**——这正是上一版栽的地方。
        console.log(`⏳ ${ds} 查询失败（${String(e).slice(0, 80)}），本轮不判定`);
        queryFailed = true;
      }
    }
    if (queryFailed) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }

    const done = all.filter((d) => d.status === "succeeded");
    const failed = all.filter((d) => d.status === "failed");
    const running = all.filter((d) => d.status === "parsing" || d.status === "queued");

    const line = `${done.length} 完成 / ${running.length} 解析中 / ${failed.length} 失败（共 ${all.length}）`;
    if (line !== lastLine) {
      console.log(`  ${line}`);
      lastLine = line;
    }

    if (running.length === 0 && all.length > 0) {
      for (const d of done) console.log(`✓ ${d.ds}  ${d.chunks ?? "?"} 个切片  ${d.name}`);
      for (const d of failed) console.log(`✗ ${d.ds}  ${d.name}：${(d.error ?? "").split("\n").find((l) => /ERROR/i.test(l))?.slice(0, 160) ?? "原因未提供"}`);
      process.exitCode = failed.length === 0 ? 0 : 1;
      return;
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  console.error("⚠ 超过 1 小时仍未全部完成。**不要当成已完成**——没解析完的文档检索不到。");
  process.exitCode = 1;
}

void main();
