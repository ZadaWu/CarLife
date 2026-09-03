/**
 * ragflow_retrieve —— RAGFlow Cloud 检索（带出处），双路检索的**通用原理**那一路（§6）。
 *
 * # 为什么用注入而不是在这里读配置
 *
 * `enterprise/backend/shared/tools` 不读环境变量、不连数据库——它要能脱离 Agent 与 LLM 直接单测
 * （注册表文件头第 3 条）。RAGFlow 的 baseUrl / apiKey / dataset id 由装配层
 * （`agent-runtime` 启动时）经 `setRagClient` 注入。
 *
 * 未注入时**明确返回"未接入"**，不是返回空结果——空结果会被上层当成
 * "说明书里没写这件事"，那是错误信息；"未接入"才是事实。
 *
 * # 跨数据集隔离不在这里做
 *
 * 它在 `enterprise/backend/shared/rag` 的 `createRagClient` 里（调用层强制，AC-24-8）。
 * 本文件只把 `agent` 如实传下去——**不允许调用方自己指定 agent 之外的数据集**，
 * 因为 dataset 与 agent 的映射是 `datasetsForAgent` 说了算，不是入参说了算。
 */

import { datasetsForAgent, type DatasetKey, type RagClient, type RetrievedChunk } from "@carlife/rag";

import { defineExternalTool, ToolError, type ExternalTool } from "./external";

export interface RagflowArgs {
  query: string;
  /** 省略时取该 Agent 的默认数据集（多数 Agent 只有一个）。 */
  dataset?: DatasetKey;
  topK?: number;
  /**
   * 车型限定（F-23-07）。**多车型同库时必须传**——
   * 否则特斯拉车主会拿到迈锐宝手册的片段，而且带着出处。
   */
  vehicleModel?: string;
}

export interface RagflowData {
  dataset: DatasetKey;
  chunks: RetrievedChunk[];
  /** 数据来源标注（F-24-11）：`repair-kb` 是模拟数据，**不冒充真实厂商资料**。 */
  provenance: "public" | "simulated";
}

let client: RagClient | undefined;

/** 装配层注入。传 undefined 表示未接入（离线/未配置）。 */
export function setRagClient(c: RagClient | undefined): void {
  client = c;
}

export function getRagClient(): RagClient | undefined {
  return client;
}

export const ragflowTool: ExternalTool<RagflowArgs, RagflowData> = defineExternalTool<
  RagflowArgs,
  RagflowData
>({
  name: "ragflow_retrieve",
  provider: "ragflow-cloud",
  timeoutMs: 8_000,
  async real(args, ctx) {
    const agent = ctx.agent ?? "ownership";
    const allowed = datasetsForAgent(agent);
    if (allowed.length === 0) {
      throw new ToolError("ragflow_retrieve", "invalid", `Agent ${agent} 没有可检索的数据集`, false);
    }
    // 入参给了 dataset 也要落在该 Agent 的白名单内——否则忽略并用默认，
    // 而不是报错后让模型换个说法再试一次（那等于给它一次绕过的机会）。
    const def = allowed.find((d) => d.key === args.dataset) ?? allowed[0];

    if (!client) {
      throw new ToolError(
        "ragflow_retrieve",
        "unconfigured",
        "RAGFlow 未接入（RAGFLOW_BASE_URL / API_KEY / dataset id 未配置）",
        false,
      );
    }

    const chunks = await client.retrieve({
      dataset: def.key,
      query: args.query,
      // **不在这里给默认值**。返回条数是检索侧的调参结论（`pnpm rag:eval` 定的
      // `DEFAULT_PAGE_SIZE`），写死在工具层等于让它悄悄失效——
      // 我把 client.ts 的默认改成 8 之后，这里的 `?? 5` 让那次调参完全没落地。
      topK: args.topK,
      agent,
      vehicleModel: args.vehicleModel,
    });
    return { dataset: def.key, chunks, provenance: def.provenance };
  },
  /**
   * mock 模式的固定数据。内容取自公开的电动车低温衰减常识，
   * **不编具体车型的参数**——四件套会把 `source.kind` 标成 mock，
   * 但内容本身也不该看起来像真实厂商数据。
   */
  mock(args) {
    return {
      dataset: (args.dataset ?? "vehicle-manuals") as DatasetKey,
      // mock 模式下的内容当然是模拟的——这里与数据集自身的 provenance 无关，
      // 标的是「这一次调用返回的是假数据」。
      provenance: "simulated",
      chunks: [
        {
          content:
            "锂离子动力电池在低温环境下内阻升高、可用容量下降，续航表现通常低于常温工况；" +
            "此外座舱制热会额外消耗电量。",
          source: { document: "（模拟）车辆使用说明书", location: "电池与充电" },
          score: 0.9,
        },
      ],
    };
  },
});
