/**
 * 用 MinerU 转出的 markdown **替换**知识库里的原 PDF（施工单 M8-01 运维辅助）。
 *
 * 为什么要替换而不是并存：RAGFlow 对 PDF 的解析在多列版面上会逐行串读
 * （见 `kb:qa` 的告警）。串坏的块**照样能被检索命中**——每行本身通顺、关键词也在，
 * 只是拼起来讲的不是一件事。留着它就是留一份"看着像样但错的"证据源，
 * 双路检索的出处会时好时坏，且**坏的那次没有任何外部信号**。
 *
 * 与 `kb:move` 顺序相反：**先删同名旧版再传**。RAGFlow 遇到重名不会拒绝，
 * 而是把新传的改名成 `xxx(1).md`，让旧的继续占着正名——库里两份都能被检索命中，
 * 而正名指向的是旧内容，从外面看不出来。先删安全的前提是真相源在本地
 * （`data/kb-md/`），删完上传失败重跑一次即可；kb:move 搬的文档只存在于 RAGFlow 里，
 * 那里才必须先传后删。上传后会校验名字有没有被改，改了就报错退出。
 *
 * 上传前先过 `prepareMarkdownForChunking`：加面包屑、并短节、切长段留 overlap、
 * 表格不切。**RAGFlow 的 HTTP API 只给 chunk_token_num 与 delimiter 两个旋钮**，
 * 给不了 overlap，更不知道"这一块属于哪一节"。
 *
 * 用法：
 *   corepack pnpm kb:replace <数据集> <转换后的 md 路径> [原 PDF 文件名]
 *
 * 省略第三个参数时按 md 的文件名推断原 PDF —— `kb:convert` 的产物命名是
 * `<原名去扩展名>.<sha8>.md`，去掉 `.<sha8>.md` 再补 `.pdf` 即可。
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import {
  createRagClient,
  estimateTokens,
  prepareMarkdownForChunking,
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

/** 正则转义——文档名里有 `(`、`)`、`.` 这些元字符。 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `kb:convert` 的产物命名：`<原名去扩展名>.<sha8>.md`。没有哈希段的手写 md 也要认。 */
const HASHED_MD = /\.[0-9a-f]{8}\.md$/;

/** `迈锐宝用户手册_OM000G542.3a19ede3.md` → `迈锐宝用户手册_OM000G542.pdf` */
export function originalPdfName(mdPath: string): string {
  return `${basename(mdPath).replace(HASHED_MD, "").replace(/\.md$/, "")}.pdf`;
}

/**
 * 上传时去掉哈希段：知识库里露出的名字应该是人认得的那个。
 *
 * ⚠️ **不是所有 md 都来自 `kb:convert`**。手写的资料（如购车费用与金融规则）没有
 * `.<sha8>` 段，正则不匹配、`replace` 原样返回，再补一个 `.md` 就成了 `xxx.md.md`——
 * 实测传上去就是这个名字，而它**不报错**：文档解析正常、检索也正常，
 * 只有知识库列表里那一行看着别扭，以及"重传同名先删"会因为名字对不上而删不掉旧的。
 */
export function uploadNameFor(mdPath: string): string {
  const stripped = basename(mdPath).replace(HASHED_MD, "");
  return stripped.endsWith(".md") ? stripped : `${stripped}.md`;
}

async function main(): Promise<void> {
  const [ds, mdPath, explicitPdf] = process.argv.slice(2);
  if (!ds || !mdPath || !(ds in AGENTS)) {
    console.error("用法：pnpm kb:replace <数据集> <md 路径> [原 PDF 文件名]");
    process.exit(2);
  }
  const dataset = ds as DatasetKey;
  const agent = AGENTS[dataset];
  const pdfName = explicitPdf ?? originalPdfName(mdPath);
  const uploadName = uploadNameFor(mdPath);

  const client = createRagClient({
    baseUrl: env("RAGFLOW_BASE_URL"),
    apiKey: env("RAGFLOW_API_KEY"),
    datasetIds: {
      "vehicle-manuals": env("RAGFLOW_DATASET_VEHICLE_MANUALS"),
      "repair-kb": env("RAGFLOW_DATASET_REPAIR_KB"),
      "car-catalog": env("RAGFLOW_DATASET_CAR_CATALOG"),
    },
    timeoutMs: 180_000,
  });

  // 0) 切片预处理：加面包屑、并短节、切长段留 overlap、表格不切。
  //    **在这里做而不是让 RAGFlow 做**，因为它的 HTTP API 只给
  //    chunk_token_num 与 delimiter 两个旋钮，给不了 overlap，
  //    更不会知道"这一块属于哪一节"。
  const raw = readFileSync(mdPath, "utf8");
  const title = uploadName.replace(/\.md$/, "");
  const prepared = prepareMarkdownForChunking(raw, { title });
  const units = prepared.split(/\n\n(?=> )/).length;
  console.log(
    `  预处理：${estimateTokens(raw)} tok → ${units} 个单元` +
    `（均长 ${Math.round(estimateTokens(prepared) / units)} tok，含面包屑与重叠）`,
  );

  // 0.5) **先删同名旧版，再传**。
  //
  //   这一步违反 kb:move 的"先传后删"，是有意为之：RAGFlow 遇到重名不会拒绝，
  //   而是把**新传的**改名成 `xxx(1).md`，让旧的继续占着正名。结果是库里两份、
  //   都能被检索命中、出处几乎一样，而正名指向的是那份旧的——
  //   从外面完全看不出来。
  //
  //   先删安全的前提是**真相源在本地**（`data/kb-md/`），删完上传失败重跑一次即可；
  //   kb:move 搬的文档只存在于 RAGFlow 里，那里才必须先传后删。
  const before = await client.listDocuments(dataset, agent);
  const stale = before.filter((d) => d.name === uploadName || d.name === pdfName);
  if (stale.length > 0) {
    await client.deleteDocuments(dataset, agent, stale.map((d) => d.documentId));
    for (const d of stale) console.log(`✗ 先删旧版：${d.name}`);
  }

  // 1) 传 markdown
  const { documentId } = await client.uploadDocument(dataset, agent, {
    name: uploadName,
    bytes: Buffer.from(prepared, "utf8"),
    contentType: "text/markdown",
  });
  console.log(`↑ ${uploadName} → ${dataset}（id=${documentId}）已触发解析`);

  // 2) 确认它真的在，再动旧的
  const docs = await client.listDocuments(dataset, agent);
  if (!docs.some((d) => d.documentId === documentId)) {
    console.error("✗ 数据集里查不到刚上传的文档，**不删原 PDF**");
    process.exitCode = 1;
    return;
  }

  // 3) 上传后校验名字没被 RAGFlow 改掉。
  //    改名意味着还有同名文档没删干净——**这时"成功"是假的**：
  //    正名指向旧内容，新内容躲在 `(1)` 后面。
  const mine = docs.find((d) => d.documentId === documentId)!;
  if (mine.name !== uploadName) {
    console.error(`✗ 名字被改成 ${mine.name}——说明还有同名旧版未删，检索会命中旧内容`);
    process.exitCode = 1;
    return;
  }

  // 4) 顺带清掉可能残留的 `xxx(n).md`（早先版本的脚本造出来的）。
  //    精确匹配前缀 + `(数字)`：用 includes 会把「迈锐宝用户手册」和
  //    「迈锐宝保修及保养手册」一起带走。
  const stem = uploadName.replace(/\.md$/, "");
  const orphans = docs.filter(
    (d) => d.documentId !== documentId && new RegExp(`^${escapeRe(stem)}\\(\\d+\\)\\.md$`).test(d.name),
  );
  if (orphans.length > 0) {
    await client.deleteDocuments(dataset, agent, orphans.map((d) => d.documentId));
    for (const d of orphans) console.log(`✗ 清理重名残留：${d.name}`);
  }
}

if (process.argv[1]?.includes("ragflow-replace")) void main();
