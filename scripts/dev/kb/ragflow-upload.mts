/**
 * 往 RAGFlow 数据集传文档并等它解析完（施工单 M8-01）。
 *
 * 用法：
 *   corepack pnpm kb:upload <数据集> <文件路径...>
 *   数据集 ∈ vehicle-manuals | repair-kb | car-catalog
 *
 * 例：
 *   corepack pnpm kb:upload vehicle-manuals "data/manuals/某某车主手册.pdf"
 *
 * # 为什么要等解析完
 *
 * 上传返回 200 只说明文件到了。**解析没跑完之前检索什么都查不到**，
 * 而界面上它看起来是"已上传"。所以这个脚本会一直轮询到 succeeded 或 failed，
 * 并在失败时把原因打出来——"解析失败"四个字等于没说。
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { createRagClient, type DatasetKey } from "../../../enterprise/backend/shared/rag/src/index";

const DATASETS: Record<DatasetKey, string> = {
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
  } catch {
    /* 无 .env */
  }
  return "";
}

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  md: "text/markdown",
  txt: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  html: "text/html",
};

async function main(): Promise<void> {
  const [dataset, ...files] = process.argv.slice(2);
  if (!dataset || !(dataset in DATASETS) || files.length === 0) {
    console.error(`用法：pnpm kb:upload <${Object.keys(DATASETS).join("|")}> <文件...>`);
    process.exit(2);
  }
  const key = dataset as DatasetKey;
  const agent = DATASETS[key];

  const client = createRagClient({
    baseUrl: env("RAGFLOW_BASE_URL"),
    apiKey: env("RAGFLOW_API_KEY"),
    datasetIds: {
      "vehicle-manuals": env("RAGFLOW_DATASET_VEHICLE_MANUALS"),
      "repair-kb": env("RAGFLOW_DATASET_REPAIR_KB"),
      "car-catalog": env("RAGFLOW_DATASET_CAR_CATALOG"),
    },
    // 上传大 PDF 比检索慢得多，单独放宽。
    timeoutMs: 120_000,
  });

  const pending: string[] = [];
  for (const path of files) {
    const bytes = readFileSync(path);
    const name = basename(path);
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const { documentId } = await client.uploadDocument(key, agent, {
      name,
      bytes,
      contentType: CONTENT_TYPES[ext],
    });
    pending.push(documentId);
    console.log(`↑ ${name}（${(bytes.length / 1024).toFixed(0)} KB）已上传并触发解析`);
  }

  console.log("\n等待解析…（大文档可能几分钟）");
  const deadline = Date.now() + 15 * 60_000;
  let failed = 0;
  while (pending.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    const docs = await client.listDocuments(key, agent);
    for (const d of docs.filter((x) => pending.includes(x.documentId))) {
      if (d.status === "succeeded") {
        console.log(`✓ ${d.name}：解析完成，${d.chunkCount ?? "?"} 个切片`);
        pending.splice(pending.indexOf(d.documentId), 1);
      } else if (d.status === "failed") {
        // 失败原因必须可读——"解析失败"等于没说。
        console.error(`✗ ${d.name}：${d.error ?? "解析失败，原因未提供"}`);
        pending.splice(pending.indexOf(d.documentId), 1);
        failed += 1;
      }
    }
  }

  if (pending.length > 0) {
    console.error(`\n⚠ 还有 ${pending.length} 篇 15 分钟内没解析完。到 RAGFlow 界面看状态，`);
    console.error("  **不要当成已完成**——没解析完的文档检索时查不到。");
    process.exitCode = 1;
    return;
  }

  console.log("\n下一步：");
  console.log("  corepack pnpm probe:ragflow    # 看检索能不能命中");
  console.log("  corepack pnpm e2e:dualpath     # 双路端到端（会用真实 RAGFlow）");
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();
