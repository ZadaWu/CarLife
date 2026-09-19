/**
 * 车型 ↔ 知识库的关联关系（施工单 M14-08）。
 *
 * # 为什么必须从知识库实时求，而不是在代码里标
 *
 * M14-07 一度在车型目录上写 `manual: true`。那是个手写布尔值，靠人记得
 * "加语料后回来改"。它漂了没有任何信号——表现要么是"明明有手册却说暂无"，
 * 要么是更糟的"说有却检索不到"。关联关系的唯一真相在知识库里的文件名，
 * 所以这里拿 `listDocuments` 的结果按 `documentMatchesModel` 现算。
 *
 * **判据与检索侧完全同一个函数**：如果这里说"有"，检索侧就一定限定得到；
 * 如果这里说"没有"，检索侧就一定抛 `NoDocumentsForModelError`。
 * 用另一套判据（比如按品牌关键字）会让两边给出不同答案，
 * 而不一致的那一半正是用户会撞上的那一半。
 */

import { documentMatchesModel, type RagClient } from "./client";
import { DATASETS, type DatasetKey } from "./datasets";

/** 数据集 → 该集里的文档名。`fetchModelCoverage` 的中间形态，也便于单测。 */
export type DocumentsByDataset = Partial<Record<DatasetKey, string[]>>;

export interface CoverageLink {
  dataset: DatasetKey;
  datasetName: string;
  documents: string[];
}

/** 车型名 → 它关联到的资料。**没有关联的车型不出现在这个 Map 里**。 */
export type CoverageIndex = Map<string, CoverageLink[]>;

/**
 * 算出每个车型关联到哪些文档。
 *
 * 复杂度是 models × documents 的朴素两重循环——量级是几十 × 几十，
 * 建索引反而更容易写错（车型名不是文档名的前缀，没有可利用的结构）。
 */
export function coverageOf(models: readonly string[], docs: DocumentsByDataset): CoverageIndex {
  const index: CoverageIndex = new Map();
  for (const model of models) {
    const links: CoverageLink[] = [];
    for (const def of DATASETS) {
      const names = docs[def.key];
      if (!names) continue; // 这个数据集没读到——**不等于空**，跳过而不是记成 0 篇
      const mine = names.filter((n) => documentMatchesModel(n, model));
      if (mine.length > 0) links.push({ dataset: def.key, datasetName: def.name, documents: mine });
    }
    if (links.length > 0) index.set(model, links);
  }
  return index;
}

/**
 * 限定车型检索时**谁也看不见**的文档。
 *
 * 传了却检索不到是最贵的一种失败：花了解析额度、占了库位，
 * 而唯一的症状是"这款车问什么都说没资料"。返回 `数据集/文件名`。
 *
 * 判据按作用域分叉（ACR-042）——**两种集的"隐形"是两回事**：
 *
 *   per-model  文件名不含任何目录车型 = 隐形。按车型分区的集里，不属于任何一款车的
 *              文档永远落不进任何一次限定检索。
 *   shared     文件名**含**车型、而那款车不在目录里 = 隐形。它既不是行业级（所以不对
 *              所有车可见），指向的车又不存在（所以也没有人能看到它）——通常是车名写错了。
 *              不含车型的行业文档在这类集里对所有车可见，**不是隐形**：M96 把三篇行业级
 *              条款报成隐形就是拿 per-model 的判据去量 shared 的集。
 */
export function invisibleDocuments(
  models: readonly string[],
  docs: DocumentsByDataset,
): string[] {
  const out: string[] = [];
  for (const def of DATASETS) {
    for (const name of docs[def.key] ?? []) {
      const matched = models.some((m) => documentMatchesModel(name, m));
      if (def.scope === "per-model") {
        if (!matched) out.push(`${def.key}/${name}`);
      } else if (!matched && mentionsSomeModel(name)) {
        out.push(`${def.key}/${name}`);
      }
    }
  }
  return out;
}

/**
 * 文件名里像是点了某款车，但那款车不在目录里（多半是车名写错了）。
 *
 * 只能是启发式：真判据（`documentMatchesModel`）要有一个候选车型名，而这里恰恰是
 * "候选之外"的情况。所以只认一条**窄**信号——`Model?` / `Cybertruck` 这类车系写法。
 * **宁可漏报不误报**：这条检查的全部价值是"它一红就一定有事"，
 * 误报会让自检变成需要人去分辨真假的噪音，那还不如不检。
 * 代价是中文车名写错（如"迈瑞宝"）漏报——由语料工单的文件名规范（D15）兜。
 */
function mentionsSomeModel(name: string): boolean {
  return /model\s*[a-z0-9]|cybertruck/i.test(name);
}

export interface FetchedCoverage {
  index: CoverageIndex;
  invisible: string[];
  /** 读成功的数据集；某个集读失败时它不在这里，对应车型不会被记成"没资料"。 */
  datasets: DatasetKey[];
  /** 读失败的数据集及原因，如实带出去。 */
  failures: Array<{ dataset: DatasetKey; reason: string }>;
}

/**
 * 从 RAGFlow 拉取全部文档名并算出关联关系。
 *
 * 每个数据集用**它自己声明的 consumer** 调用 `listDocuments`——
 * `datasetsForAgent` 的隔离规则一步不绕。这里拿到的只有文件名与解析状态，
 * 不含任何 chunk 内容，所以跨集列举不构成"某个 Agent 读到了别的集的内容"。
 */
export async function fetchModelCoverage(
  client: RagClient,
  models: readonly string[],
): Promise<FetchedCoverage> {
  const docs: DocumentsByDataset = {};
  const failures: FetchedCoverage["failures"] = [];
  const datasets: DatasetKey[] = [];

  await Promise.all(
    DATASETS.map(async (def) => {
      const agent = def.consumers[0];
      if (!agent) return;
      try {
        const list = await client.listDocuments(def.key, agent);
        // 只认解析完成的：还在解析的文档检索不到，说"有资料"是提前庆祝。
        docs[def.key] = list.filter((d) => d.status === "succeeded").map((d) => d.name);
        datasets.push(def.key);
      } catch (e) {
        failures.push({ dataset: def.key, reason: firstLine(String(e)) });
      }
    }),
  );

  return { index: coverageOf(models, docs), invisible: invisibleDocuments(models, docs), datasets, failures };
}

function firstLine(s: string): string {
  return s.split("\n")[0]!.slice(0, 200);
}
