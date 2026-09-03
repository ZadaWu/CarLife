/**
 * RAGFlow 连通性自检（施工单 M8-01）。
 *
 * 配完 RAGFLOW_* 之后跑这一条，确认三件事：接得上、隔离生效、超时够用。
 *
 * # 为什么单独有这个脚本
 *
 * RAGFlow 是**外部托管服务**，它的可用性不在我们的测试范围内，但它挂了的表现是
 * "双路静默退化成单路"——回答看起来仍然像样。所以需要一条能主动问一句
 * "现在到底通不通"的命令，而不是等用户问出一个答不上来的问题。
 *
 * 运行（根目录）：corepack pnpm probe:ragflow
 */

import { readFileSync } from "node:fs";

import {
  createRagClient,
  DatasetAccessError,
  fetchModelCoverage,
} from "../../../enterprise/backend/shared/rag/src/index";
import { catalogModels } from "../../../contracts/src/index";

const env: Record<string, string> = {};
try {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)="?([^"]*)"?$/.exec(l.trim());
    if (m) env[m[1]] = m[2];
  }
} catch {
  /* 没有 .env 就只看 process.env */
}
const get = (k: string): string => process.env[k] ?? env[k] ?? "";

const checks: Array<[boolean, string]> = [];
const ok = (b: boolean, s: string): void => {
  checks.push([b, s]);
  console.log(`${b ? "✓" : "✗"} ${s}`);
};

/**
 * 从 RAGFlow 的多页错误日志里挑出一行。
 *
 * 它的 `progress_msg` 是逐页追加的，同一个根因会重复几十遍。
 * 取第一条含 ERROR 的、去掉时间戳与页码前缀——**要的是"为什么"，不是"哪几页"**。
 */
function firstErrorLine(raw?: string): string {
  if (!raw) return "原因未提供";
  const line = raw
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /ERROR|Exception/i.test(l));
  if (!line) return raw.slice(0, 160);
  return line.replace(/^\d{2}:\d{2}:\d{2}\s*/, "").replace(/^Page\([^)]*\):\s*/, "").slice(0, 200);
}

async function main(): Promise<void> {
  const baseUrl = get("RAGFLOW_BASE_URL");
  const apiKey = get("RAGFLOW_API_KEY");
  if (!baseUrl || !apiKey) {
    console.log("RAGFlow 未接入（RAGFLOW_BASE_URL / API_KEY 未配置）。");
    console.log("这不是错误：此时双路检索只剩⑥那一路，回答会显式标注未引用出处。");
    return;
  }

  const client = createRagClient({
    baseUrl,
    apiKey,
    datasetIds: {
      "vehicle-manuals": get("RAGFLOW_DATASET_VEHICLE_MANUALS"),
      "repair-kb": get("RAGFLOW_DATASET_REPAIR_KB"),
      "car-catalog": get("RAGFLOW_DATASET_CAR_CATALOG"),
    },
  });

  for (const [ds, agent] of [
    ["vehicle-manuals", "ownership"],
    ["repair-kb", "service"],
    ["car-catalog", "buying"],
  ] as const) {
    // 查询本身失败要与"这个集是空的"分开——**没拿到 ≠ 没有**。
    // 写监视脚本时正好在这上面栽过：curl 出错拿到空串，
    // grep 找不到 RUNNING 就判定"跑完了"，把「没数据」读成了「成功」。
    let docs;
    try {
      docs = await client.listDocuments(ds, agent);
    } catch (e) {
      ok(false, `${ds}：查询文档列表失败 —— ${firstErrorLine(String(e))}`);
      continue;
    }
    const parsed = docs.filter((d) => d.status === "succeeded").length;
    const parsing = docs.filter((d) => d.status === "parsing" || d.status === "queued").length;
    const failed = docs.filter((d) => d.status === "failed");
    ok(
      true,
      `${ds}：${docs.length} 篇文档，${parsed} 篇解析完成` +
        (parsing > 0 ? `，${parsing} 篇仍在解析中（此时检索不到它们）` : ""),
    );
    for (const f of failed) {
      // 解析失败要点名——**文件传上去了但解析失败，检索时什么都查不到**。
      // 但 RAGFlow 会把每一页的错误日志全贴出来（一篇 192 页的手册就是几十屏），
      // 而**几十屏里说的是同一件事**。只留最有信息量的那一行。
      ok(false, `  ${f.name} 解析失败：${firstErrorLine(f.error)}`);
    }
  }

  // **检索失败不能让自检崩掉**——自检的职责是把问题报出来，不是跟着一起挂。
  // 第一版直接 await，SiliconFlow 余额不足时整个脚本抛栈退出，
  // 后面的跨集隔离检查根本没跑到。
  const t0 = Date.now();
  try {
    const hits = await client.retrieve({
      dataset: "vehicle-manuals",
      query: "低温下续航为什么会下降",
      agent: "ownership",
      topK: 5,
    });
    const ms = Date.now() - t0;
    ok(true, `检索往返 ${ms}ms，命中 ${hits.length} 条`);
    // 实测空库就要 2.3~2.7s（要先把 query 送去 embedding），默认超时 15s 是据此定的。
    ok(ms < 15_000, "在默认超时（15s）之内——超时的后果是双路静默退化为单路");
    if (hits.length === 0) {
      console.log("  零命中不是错误，是信息：说明这个问题当前知识库答不了。");
    }
  } catch (e) {
    ok(false, `检索失败：${firstErrorLine(String(e))}`);
    console.log("  **这与「零命中」是两回事**：零命中说明知识库没这内容，");
    console.log("  失败说明我们取不到——知识库里可能是有的。");
  }

  try {
    await client.retrieve({ dataset: "repair-kb", query: "x", agent: "ownership" });
    ok(false, "跨集访问竟然通过了——隔离失效");
  } catch (e) {
    ok(e instanceof DatasetAccessError, "跨集隔离在调用层生效：ownership 查不到 repair-kb");
  }

  // 车型限定（F-23-07）。跨集隔离挡的是"用车助手翻到维修知识库"，
  // 挡不住**同一个数据集里的另一款车**——vehicle-manuals 里同时躺着迈锐宝与
  // 三款特斯拉。不限定时 Model 3 车主会拿到迈锐宝手册的片段**并带着出处**，
  // 而有引用只会让这个错误更可信。
  //
  // 这条此前是临时跑的。文件名从 `.pdf` 换成 `.md` 之后匹配还认不认得出车型，
  // 正是"临时跑过一次"回答不了的问题——所以固化在这里。
  try {
    const [loose, scoped] = await Promise.all([
      client.retrieve({ dataset: "vehicle-manuals", query: "轮胎胎压", agent: "ownership", topK: 10 }),
      client.retrieve({
        dataset: "vehicle-manuals", query: "轮胎胎压", agent: "ownership", topK: 10,
        vehicleModel: "Model 3",
      }),
    ]);
    const docsOf = (hits: readonly { source: { document: string } }[]): string[] =>
      [...new Set(hits.map((h) => h.source.document))].sort();

    const scopedDocs = docsOf(scoped);
    const strays = scopedDocs.filter((d) => !/model\s*-?3|model3/i.test(d));
    ok(
      scoped.length > 0 && strays.length === 0,
      `限定 Model 3 后出处只剩 ${scopedDocs.join("、") || "（零命中）"}`,
    );
    if (strays.length > 0) console.log(`  混进来的：${strays.join("、")}`);

    // 对照组：不限定时确实会混进别的车——**没有这一半，上面那条可能只是
    // 因为知识库里本来就只有一款车而"通过"**。
    const looseDocs = docsOf(loose);
    ok(
      looseDocs.length > scopedDocs.length,
      `不限定时出处有 ${looseDocs.length} 篇（含其他车型），限定后 ${scopedDocs.length} 篇`,
    );
    // 迈锐宝那几份是**被 MinerU 换成 markdown 的**，文件名从 `.pdf` 变成 `.md`。
    // 上面只查了 Model 3（仍是 pdf），验不到改名这件事——而改名正是这轮的改动。
    const malibu = await client.retrieve({
      dataset: "vehicle-manuals", query: "轮胎胎压", agent: "ownership", topK: 10,
      vehicleModel: "迈锐宝",
    });
    const malibuDocs = docsOf(malibu);
    ok(
      malibu.length > 0 && malibuDocs.every((d) => d.includes("迈锐宝")),
      `换成 markdown 后仍能按车型限定：${malibuDocs.join("、") || "（零命中）"}`,
    );
  } catch (e) {
    ok(false, `车型限定检查失败：${firstErrorLine(String(e))}`);
  }

  // 文件名不含任何已知车型的文档，**对所有限定车型的检索都是隐形的**。
  //
  // 车型限定按文件名匹配（documentMatchesModel）。一份叫
  // `2017_车型手册与配置参数.md` 的迈锐宝手册，在"迈锐宝"限定下匹配不到，
  // 于是抛 NoDocumentsForModelError——而它的措辞是"数据集里没有迈锐宝的资料"，
  // **那是假的**。评测里 Q10 就是这么全军覆没的，而在此之前没有任何信号。
  //
  // 车型清单**引 shared 的目录**（M14-08）：这里曾经自己写一份 KNOWN_MODELS，
  // 于是全仓有三份手写车型清单各自漂。目录里没有的车型，
  // 用户根本选不到，所以"目录之外的车型有资料"对用户等价于没有。
  const cov = await fetchModelCoverage(client, catalogModels());
  ok(
    cov.invisible.length === 0,
    cov.invisible.length === 0
      ? "每篇文档的文件名都能被目录里的某个车型匹配到"
      : `${cov.invisible.length} 篇文档的文件名不含任何目录车型，限定车型时检索不到`,
  );
  for (const n of cov.invisible) console.log(`  隐形：${n}`);
  for (const f of cov.failures) console.log(`  数据集读失败：${f.dataset} —— ${f.reason}`);

  // 关联关系直接打出来：这是"车型 ↔ 知识库"这件事的可复跑证据。
  console.log("\n车型 ↔ 知识库关联（由文件名实时算出）：");
  for (const [model, links] of [...cov.index].sort()) {
    console.log(`  ${model}：${links.map((l) => `${l.datasetName} ${l.documents.length} 篇`).join("、")}`);
  }
  const uncovered = catalogModels().filter((m) => !cov.index.has(m));
  console.log(`  无资料车型 ${uncovered.length} 款：${uncovered.join("、") || "（无）"}`);

  const failed = checks.filter(([b]) => !b).length;
  console.log(`\nRAGFlow 自检：${checks.length - failed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();
