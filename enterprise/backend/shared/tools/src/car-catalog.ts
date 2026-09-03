/**
 * `car_catalog` —— 车型查询与比较（§5 工具表 / FL-15 F-15-03）。
 *
 * # 它读 `car-catalog` 数据集，不是另建一份车型库
 *
 * 车型手册、配置参数、选装表、价格表已经在 RAGFlow 的 `car-catalog` 数据集里
 * 。
 * 本工具是那份资料的**结构化查询面**，不复制一份数据出来——两份必然漂移，
 * 而漂移的表现是"顾问报的价和手册上的不一样"。
 *
 * # 隔离由调用层强制，不靠 prompt
 *
 * `datasetsForAgent("buying")` 在 `enterprise/backend/shared/rag` 里判定，本工具只声明它要
 * `car-catalog`。购车顾问之外的 Agent 拿不到这个工具（registry 的 `agents` 字段），
 * 拿到了也会被数据集访问检查挡住。
 *
 * # 比较要给出**出处**，不给结论
 *
 * "哪款更好"是价值判断，取决于用户的取舍。工具的职责是把两款车的同名参数并排放好
 * 并带上出处；下结论是 Agent 结合用户约束做的事，且要能被追问"这个数哪来的"。
 */

import { defineExternalTool, ToolError, type ExternalTool } from "./external";
import { getRagClient } from "./ragflow";

export interface CarCatalogArgs {
  /** 自然语言检索词，如「20 万以内的纯电 SUV 续航」。 */
  query: string;
  /** 限定车型，给了就只在这些车型的资料里查（比较场景传多个）。 */
  models?: string[];
  /** 返回条数上限。 */
  limit?: number;
}

export interface CatalogChunk {
  /** 命中的原文片段。 */
  text: string;
  /** 出处文档名——**必须有**，否则"这个数哪来的"答不上（F-39-12 同源要求）。 */
  document: string;
  /** 相似度，供调用方判断可信度。 */
  score: number;
  /** 该片段归属的车型，从文档名解析不出时为 undefined，不猜。 */
  model?: string;
}

export interface CarCatalogResult {
  chunks: CatalogChunk[];
  /**
   * 请求了但一条都没命中的车型。
   *
   * **这个字段不能省**：比较两款车时若其中一款零命中，只返回另一款的参数会让
   * Agent 输出一个看起来完整、实则单边的对比。空命中要显式说出来。
   */
  missingModels: string[];
}

export interface CatalogBackend {
  retrieve(args: {
    query: string;
    models?: string[];
    limit: number;
    signal?: AbortSignal;
  }): Promise<CatalogChunk[]>;
}

/**
 * RAGFlow 后端。
 *
 * 由装配层注入 `RagClient`——`enterprise/backend/shared/tools` 不直接 import `enterprise/backend/shared/rag` 的
 * 具体客户端构造，避免工具层拿到跨数据集的能力（隔离在调用层强制，见文件头）。
 */
export interface RagRetrieveLike {
  retrieve(args: {
    dataset: "car-catalog";
    agent: string;
    query: string;
    topK?: number;
    signal?: AbortSignal;
  }): Promise<{ content: string; documentName: string; score: number }[]>;
}

export function createRagCatalogBackend(rag: RagRetrieveLike | undefined): CatalogBackend {
  return {
    async retrieve({ query, models, limit, signal }) {
      if (!rag) {
        throw new ToolError(
          "car_catalog",
          "unconfigured",
          "未配置 RAGFlow（RAGFLOW_BASE_URL / RAGFLOW_API_KEY），车型资料不可用",
          false,
        );
      }
      // 车型限定拼进检索词而不是做后置过滤：后者在 topK 内可能一条都不剩，
      // 表现成"这款车没有资料"，而其实只是没排进前 K。
      const q = models?.length ? `${models.join(" ")} ${query}` : query;
      const hits = await rag.retrieve({
        dataset: "car-catalog",
        agent: "buying",
        query: q,
        topK: limit,
        signal,
      });
      return hits.map((h) => ({
        text: h.content,
        document: h.documentName,
        score: h.score,
        model: models?.find((m) => h.documentName.includes(m) || h.content.includes(m)),
      }));
    },
  };
}

export function createCarCatalogTool(
  backend: CatalogBackend,
): ExternalTool<CarCatalogArgs, CarCatalogResult> {
  return defineExternalTool<CarCatalogArgs, CarCatalogResult>({
    name: "car_catalog",
    provider: "ragflow",
    // 只读检索 → §8.4 第三行自动放行。
    sensitive: false,
    // 与 ragflow 工具同档：RAGFlow Cloud 的检索要先过 embedding，实测空集也要 2.3~2.7s。
    timeoutMs: 15_000,
    retries: 2,

    real: async (args, ctx) => {
      if (!args.query?.trim()) {
        throw new ToolError("car_catalog", "invalid", "检索词不能为空", false);
      }
      const limit = Math.min(Math.max(args.limit ?? 6, 1), 20);
      const chunks = await backend.retrieve({
        query: args.query.trim(),
        models: args.models,
        limit,
        signal: ctx.signal,
      });
      const hitModels = new Set(chunks.map((c) => c.model).filter(Boolean) as string[]);
      return {
        chunks,
        missingModels: (args.models ?? []).filter((m) => !hitModels.has(m)),
      };
    },

    mock: (args) => ({
      chunks: [
        {
          text: "【模拟】该车型 CLTC 续航 605km，快充 30%→80% 约 28 分钟。",
          document: "模拟车型手册.pdf",
          score: 0.9,
          model: args.models?.[0],
        },
      ],
      missingModels: (args.models ?? []).slice(1),
    }),
  });
}

/**
 * 默认后端：**惰性**取 `setRagClient` 注入的那一个（施工单 M15-01）。
 *
 * 此前这里是 `createRagCatalogBackend(undefined)`——模块加载时就把"没有 RAG"
 * 固化进了默认实例，而装配层从来没有替换过它。后果是 `car_catalog` 无论何时被调用
 * 都抛 `unconfigured`；因为它在生产代码里**一个调用点都没有**，这件事一直没被发现。
 *
 * 惰性取的另一个好处：与 `ragflow_retrieve` 共用同一个客户端实例，
 * 数据集隔离仍由 `enterprise/backend/shared/rag` 的调用层强制（我们只把 `agent: "buying"` 如实传下去），
 * 工具层不因此拿到跨数据集的能力。
 */
export function createInjectedCatalogBackend(): CatalogBackend {
  return {
    // `signal` 不透传：`RagClient.retrieve` 没有这个参数（`ragflow_retrieve` 同样没有）。
    // 取消由 `defineExternalTool` 的 `withTimeout` 兜底——上游请求会跑完，但结果被丢弃。
    async retrieve({ query, limit }) {
      const rag = getRagClient();
      if (!rag) {
        throw new ToolError(
          "car_catalog",
          "unconfigured",
          "未配置 RAGFlow（RAGFLOW_BASE_URL / RAGFLOW_API_KEY），车型资料不可用",
          false,
        );
      }
      const hits = await rag.retrieve({
        dataset: "car-catalog",
        agent: "buying",
        query,
        topK: limit,
      });
      // 车型归属**不在这里判**：本层只有文档名与原文，判据（车型索引）在购车子图，
      // 那里才知道当前语料里有哪几款车。这里猜一个出来，错的时候带着正确的出处。
      //
      // ⚠️ 由此本后端不填 `model`，于是本工具算出的 `missingModels` 会把**每个**
      // 请求的车型都当成零命中——`Model3_参数规格.md` 匹配不上 `"Model 3"` 这个写法。
      // 所以用本后端时 **`missingModels` 不可信，调用方必须自己算**。
      // 实测教训：第一次接上真库时，回答里稳定出现"你提到的 Model 3、Model Y 车型库里
      // 没有资料"，而同一次的候选里正拿着这两款的指导价与参数。
      return hits.map((h) => ({
        text: h.content,
        document: h.source.document,
        score: h.score,
      }));
    },
  };
}

export const carCatalogTool = createCarCatalogTool(createInjectedCatalogBackend());
