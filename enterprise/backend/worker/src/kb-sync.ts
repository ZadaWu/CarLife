/**
 * 知识库增量同步任务（施工单 M7-05，FL-32 F-32-03，
 * 语义见 FL-24 F-24-09）。
 *
 * # 这个任务同步的是**状态**，不是文件
 *
 * 上传由后台知识库界面发起（`console/knowledge.ts` → `RagClient.uploadDocument`，
 * 上传与触发解析already 合成一步）。本任务负责另一半：**把解析状态取回来**。
 *
 * 解析是异步的——上传返回成功时文档往往还在 `queued`。真正的失败发生在几分钟后，
 * 那时没人还盯着页面。**"上传成功"是苏未最不信的四个字**：文件传上去了但没解析成功，
 * 检索时什么都查不到，而页面上写着"成功"。
 *
 * # 失败要告警到运营，不能静默（F-32-03 边界）
 *
 * 她以为传上去了，两周后用户投诉才发现。所以本任务的产出**主要是告警**，
 * `changed` 记的是状态发生迁移的文档数，`failures` 里逐条写清是哪个文件、什么原因。
 *
 * # 卡住也算失败
 *
 * `queued`/`parsing` 停留超过阈值与 `failed` 同等对待——一个永远排队的文档
 * 和一个解析失败的文档，对检索的影响完全一样：查不到。
 */

import { DATASETS, createRagClient, type DatasetKey, type DocumentStatus } from "@carlife/rag";

import type { JobContext, JobDefinition, JobResult } from "./job-runner";

const HOUR_MS = 3_600_000;

/** 解析停留在 queued/parsing 超过此时长即视为卡住。 */
export const STUCK_AFTER_MS = 2 * HOUR_MS;

/** 三个数据集各自的巡检身份——`datasetsForAgent` 在调用层强制隔离，这里按数据集取对应 agent。 */
const DATASET_AGENTS: Record<DatasetKey, string> = {
  "vehicle-manuals": "ownership",
  "repair-kb": "service",
  "car-catalog": "buying",
};

export interface KbSyncDeps {
  list(dataset: DatasetKey, agent: string): Promise<DocumentStatus[]>;
  /** 上一轮记录的状态，用于判断"有没有变化"与"卡了多久"。 */
  previous(dataset: DatasetKey): Promise<Map<string, { status: string; since: number }>>;
  remember(dataset: DatasetKey, snapshot: Map<string, { status: string; since: number }>): Promise<void>;
  now?: () => number;
}

export async function runKbSync(_ctx: JobContext, deps: KbSyncDeps): Promise<JobResult> {
  const now = (deps.now ?? Date.now)();
  const result: JobResult = { processed: 0, changed: 0, deleted: 0, failures: [] };

  for (const dataset of Object.keys(DATASET_AGENTS) as DatasetKey[]) {
    const agent = DATASET_AGENTS[dataset];
    let docs: DocumentStatus[];
    try {
      docs = await deps.list(dataset, agent);
    } catch (err) {
      // 整个数据集取不到，是连通性/额度问题，值得单独一条告警——
      // 它和"某个文档解析失败"是两类故障，混在一起会误导排查方向。
      result.failures.push(
        `数据集 ${dataset} 状态拉取失败：${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const prev = await deps.previous(dataset);
    const next = new Map<string, { status: string; since: number }>();

    for (const doc of docs) {
      result.processed += 1;
      const before = prev.get(doc.documentId);
      const changed = before?.status !== doc.status;
      if (changed) result.changed += 1;
      // 状态没变就沿用旧的 since，变了就从现在重新计时——这是"卡了多久"的依据
      next.set(doc.documentId, { status: doc.status, since: changed ? now : (before?.since ?? now) });

      if (doc.status === "failed") {
        result.failures.push(
          `${dataset}/${doc.name} 解析失败：${doc.error ?? "RAGFlow 未给出原因"}`,
        );
        continue;
      }
      if (doc.status === "succeeded" && (doc.chunkCount ?? 0) === 0) {
        // 解析"成功"但零切片，检索时同样查不到。这正是 内部开发指引 记的那个坑
        // （切分方法选错 / embedding 账号欠费）的表现形态。
        result.failures.push(
          `${dataset}/${doc.name} 解析成功但切片数为 0——检查数据集切分方法与 embedding 账号余额`,
        );
        continue;
      }
      if (doc.status === "queued" || doc.status === "parsing") {
        const since = next.get(doc.documentId)!.since;
        if (now - since > STUCK_AFTER_MS) {
          result.failures.push(
            `${dataset}/${doc.name} 已在 ${doc.status} 停留 ${((now - since) / HOUR_MS).toFixed(1)} 小时`,
          );
        }
      }
    }

    await deps.remember(dataset, next);
  }
  return result;
}

/**
 * 生产依赖装配。
 *
 * 状态快照存在进程内存里：它只用于"卡了多久"的判断，丢了最坏结果是重新计时，
 * 下一轮照样能发现卡住。为此建一张表不值得。
 */
const snapshots = new Map<DatasetKey, Map<string, { status: string; since: number }>>();

export function createKbSyncDeps(): KbSyncDeps {
  const baseUrl = process.env.RAGFLOW_BASE_URL?.trim();
  const apiKey = process.env.RAGFLOW_API_KEY?.trim();
  // 没配就直接拒绝装配，而不是造一个连不上的客户端——后者会把"没配置"
  // 伪装成"每轮都连接失败"，在告警里刷屏且指错方向。
  if (!baseUrl || !apiKey) {
    throw new Error("kb-sync 未配置：缺少 RAGFLOW_BASE_URL / RAGFLOW_API_KEY");
  }
  const rag = createRagClient({
    baseUrl,
    apiKey,
    datasetIds: {
      "vehicle-manuals": process.env.RAGFLOW_DATASET_VEHICLE_MANUALS ?? "",
      "repair-kb": process.env.RAGFLOW_DATASET_REPAIR_KB ?? "",
      "car-catalog": process.env.RAGFLOW_DATASET_CAR_CATALOG ?? "",
    },
  });
  return {
    list: (dataset, agent) => rag.listDocuments(dataset, agent),
    async previous(dataset) {
      return snapshots.get(dataset) ?? new Map();
    },
    async remember(dataset, snapshot) {
      snapshots.set(dataset, snapshot);
    },
  };
}

export const kbSyncJob: JobDefinition = {
  name: "kb-sync",
  intervalMs: HOUR_MS,
  // 补偿对本任务没有意义：它读的是**当前**状态，不是某个历史窗口的事件。
  // 上限设 1 = 只跑最近一个窗口，漏跑的窗口直接放弃。
  maxCatchUpWindows: 1,
  run: (ctx) => runKbSync(ctx, createKbSyncDeps()),
};

/** 数据集列表导出给自检脚本用，避免那边再抄一份。 */
export const SYNCED_DATASETS = Object.keys(DATASET_AGENTS) as DatasetKey[];
export { DATASETS };
