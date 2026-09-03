/**
 * 切分质量抽检（施工单 M8-01，FL-24 F-24-05）。
 *
 * # 为什么需要一条命令而不是靠肉眼看界面
 *
 * 切坏的表现**不是报错**：检索照样命中、照样给出处，只是内容读不通。
 * 这次就是用户在 RAGFlow 界面上翻切片才发现三栏手册被横着串读了——
 * 而那时它已经进了知识库、已经被检索命中过。
 *
 * 这条命令把"最可能出问题的地方"批量挑出来，用的是与知识库页同一套判据
 * （`suspiciousChunks`），所以命令行和页面不会给出两种结论。
 *
 * 用法：corepack pnpm kb:qa
 */

import { readFileSync } from "node:fs";

import {
  createRagClient,
  suspiciousChunks,
  estimateTokens,
  CHUNK_TOKEN_NUM,
  type DatasetKey,
} from "../../../enterprise/backend/shared/rag/src/index";

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

/** 超过这个比例的切片被标记，才认为整篇文档有问题——单块异常是常态。 */
const DOC_BAD_RATIO = 0.2;

/**
 * 客服/文档问答的通行块长区间。
 *
 * 太碎：手册是过程性内容，一个步骤序列被拆散后每块单看都通顺、合起来答不了问题。
 * 太长：一次检索塞进太多无关内容，把真正相关的那几句稀释掉。
 */
const GOOD_MIN = 256;
const GOOD_MAX = 512;
/** 短于此的块**检索命中了也撑不起回答**——它们是纯噪声，比长块有害得多。 */
const USELESS_MAX = 50;

function pct(n: number, total: number): string {
  return `${Math.round((n / total) * 100)}%`;
}

/** 块长分布。**这是"切得好不好"的主指标**，可疑块只是次要的形状检查。 */
function sizeReport(tokens: readonly number[]): string {
  const t = [...tokens].sort((a, b) => a - b);
  const q = (r: number): number => t[Math.min(t.length - 1, Math.floor(t.length * r))];
  const good = t.filter((x) => x >= GOOD_MIN && x <= GOOD_MAX).length;
  const useless = t.filter((x) => x < USELESS_MAX).length;
  return (
    `中位 ${String(q(0.5)).padStart(4)}  p10 ${String(q(0.1)).padStart(3)}  p90 ${String(q(0.9)).padStart(4)}` +
    `  ${GOOD_MIN}~${GOOD_MAX} ${pct(good, t.length).padStart(4)}  <${USELESS_MAX}tok ${pct(useless, t.length).padStart(4)}`
  );
}

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

  let flagged = 0;
  let checked = 0;
  const allTokens: number[] = [];

  for (const [ds, agent] of Object.entries(AGENTS) as Array<[DatasetKey, string]>) {
    const docs = await client.listDocuments(ds, agent);
    for (const d of docs) {
      if (d.status !== "succeeded") {
        // **解析没完成的不下结论**——它此刻检索不到，也谈不上切得好不好。
        console.log(`⏳ ${ds}/${d.name.slice(0, 34)}（${d.status}）`);
        continue;
      }
      const chunks = await client.listChunks(ds, d.documentId, agent);
      if (chunks.length === 0) {
        console.log(`⚠️  ${ds}/${d.name.slice(0, 34)}：解析完成但一个切片都没有`);
        flagged += 1;
        continue;
      }
      checked += 1;
      const tokens = chunks.map((c) => estimateTokens(c.content));
      allTokens.push(...tokens);
      const problems = suspiciousChunks(chunks);
      const ratio = problems.length / chunks.length;

      // **只报真正触发了的原因**。原先无条件附一句"最长未收尾 N 行"，
      // 而那条规则可能根本没触发（表格块、目录块都会被跳过）——
      // 于是告警指向一个不存在的原因，人照着去查只会白查一轮。
      const tally = new Map<string, number>();
      for (const p of problems) {
        const kind = p.why.includes("逐行串读") ? "逐行串读"
          : p.why.includes("拦腰截断") ? "表格碎片"
          : "内容过短";
        tally.set(kind, (tally.get(kind) ?? 0) + 1);
      }
      const why = [...tally].map(([k, v]) => `${k} ${v}`).join("／");

      if (ratio > DOC_BAD_RATIO) {
        flagged += 1;
        console.log(`⚠️  ${ds}/${d.name.slice(0, 34)}：${chunks.length} 块，${problems.length} 块可疑（${why}）`);
        console.log(`      ${sizeReport(tokens)}`);
        // 只列前两条：几十屏同一个原因没有意义。
        for (const p of problems.slice(0, 2)) console.log(`      #${p.index} ${p.why.slice(0, 120)}`);
      } else {
        console.log(
          `✓  ${String(chunks.length).padStart(3)} 块  ${sizeReport(tokens)}  ${d.name.slice(0, 34)}`,
        );
      }
    }
  }

  if (allTokens.length > 0) {
    console.log(`\n全库 ${allTokens.length} 块  ${sizeReport(allTokens)}`);
    console.log(
      `目标：中位落在 ${GOOD_MIN}~${GOOD_MAX}、<${USELESS_MAX}tok 接近 0`,
      `（当前 chunk_token_num=${CHUNK_TOKEN_NUM}）`,
    );
  }
  console.log(`\n切分抽检：${checked} 篇已解析，${flagged} 篇需要人看一眼`);
  // **不因为发现问题就返回非零**：这是抽检不是门禁，切得好不好最终要人判断。
  // 返回非零会诱使人把它塞进 CI 然后为了绿灯去调阈值。
}

void main();
