/**
 * 把一篇文档从一个数据集挪到另一个（施工单 M8-01 运维辅助）。
 *
 * RAGFlow 没有"移动"这个操作——只能重传再删。所以这个脚本的顺序很要紧：
 * **先传到新位置、确认拿到 id，再删旧的**。反过来一旦上传失败，文档就没了。
 *
 * 用法：
 *   corepack pnpm kb:move <源数据集> <目标数据集> <文件名关键字> <本地文件路径>
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

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

async function main(): Promise<void> {
  const [from, to, keyword, path] = process.argv.slice(2);
  if (!from || !to || !keyword || !path || !(from in AGENTS) || !(to in AGENTS)) {
    console.error("用法：pnpm kb:move <源> <目标> <文件名关键字> <本地文件路径>");
    process.exit(2);
  }
  const src = from as DatasetKey;
  const dst = to as DatasetKey;

  const client = createRagClient({
    baseUrl: env("RAGFLOW_BASE_URL"),
    apiKey: env("RAGFLOW_API_KEY"),
    datasetIds: {
      "vehicle-manuals": env("RAGFLOW_DATASET_VEHICLE_MANUALS"),
      "repair-kb": env("RAGFLOW_DATASET_REPAIR_KB"),
      "car-catalog": env("RAGFLOW_DATASET_CAR_CATALOG"),
    },
    timeoutMs: 120_000,
  });

  const bytes = readFileSync(path);
  const name = basename(path);

  // 1) 先传到新位置
  const { documentId } = await client.uploadDocument(dst, AGENTS[dst], {
    name,
    bytes,
    contentType: "application/pdf",
  });
  console.log(`↑ ${name} 已传入 ${dst}（id=${documentId}）并触发解析`);

  // 2) 确认新的确实在了，再动旧的
  const dstDocs = await client.listDocuments(dst, AGENTS[dst]);
  if (!dstDocs.some((d) => d.documentId === documentId)) {
    console.error("✗ 新位置查不到刚上传的文档，**不删旧的**");
    process.exitCode = 1;
    return;
  }

  const srcDocs = await client.listDocuments(src, AGENTS[src]);
  const doomed = srcDocs.filter((d) => d.name.includes(keyword));
  if (doomed.length === 0) {
    console.log(`  ${src} 里没有匹配「${keyword}」的文档，无需删除`);
    return;
  }
  await client.deleteDocuments(src, AGENTS[src], doomed.map((d) => d.documentId));
  for (const d of doomed) console.log(`✗ 已从 ${src} 删除：${d.name}`);
}

void main();
