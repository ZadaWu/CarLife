/**
 * 车型清单 + **车型 ↔ 知识库关联关系**端点（施工单 M14-08）。
 *
 * GET /v1/vehicle-catalog → 目录全量 + 每款关联到的资料 + 数据新鲜度
 *
 * # 为什么带缓存
 *
 * 算一次要向 RAGFlow 发三次 `listDocuments`（实测整轮 1–2s）。
 * 建档向导每选一次车型都等一次是不能接受的，而这份索引变化极慢
 * （只有传/删语料时变）。所以进程内缓存 10 分钟。
 *
 * # 三态，不是两态
 *
 * 拉失败时**返回上一次的结果并标 `stale`**；从来没成功过则标 `unavailable`。
 * 绝不把"读不到"折叠成"没有资料"——那是在替知识库断言一件我们此刻不知道的事，
 * 而用户看到的两句话（"这款没有说明书" vs "暂时读不到知识库"）含义完全不同。
 */

import { Router } from "express";
import type { Response } from "express";

import {
  VEHICLE_CATALOG,
  catalogModels,
  type KnowledgeCoverageState,
  type ModelKnowledgeLink,
  type VehicleKnowledge,
} from "@carlife/shared";
import { fetchModelCoverage, type CoverageIndex, type RagClient } from "@carlife/rag";

import type { AuthedRequest } from "../auth";

/** 索引变化只发生在传/删语料时，10 分钟足够新鲜。 */
export const COVERAGE_TTL_MS = 10 * 60 * 1000;

export interface CoverageSnapshot {
  index: CoverageIndex;
  fetchedAt: number;
  /** 读失败的数据集——**它们对应的车型不会被记成"没资料"**，见 coverageOf。 */
  failures: Array<{ dataset: string; reason: string }>;
  /** 不被任何已知车型匹配到的文档：传了却检索不到，运维要看见。 */
  invisible: string[];
}

export interface CoverageProvider {
  /** 当前快照；`undefined` = 从来没成功拉到过。 */
  get(): Promise<{ snapshot?: CoverageSnapshot; state: KnowledgeCoverageState; reason?: string }>;
}

/**
 * 带 TTL 与"过期用旧值"的覆盖提供者。
 *
 * 并发去重（`inflight`）不是优化而是正确性：建档页一进来可能同时打两三次，
 * 没有它就会并发向 RAGFlow 发六到九次 `listDocuments`。
 */
export function createCoverageProvider(
  ragClient: () => RagClient | undefined,
  ttlMs = COVERAGE_TTL_MS,
  now = () => Date.now(),
): CoverageProvider {
  let snapshot: CoverageSnapshot | undefined;
  let lastError: string | undefined;
  let inflight: Promise<void> | undefined;

  async function refresh(): Promise<void> {
    const client = ragClient();
    if (!client) {
      lastError = "知识库未接入（RAGFLOW_BASE_URL / RAGFLOW_API_KEY 未配置）";
      return;
    }
    try {
      const r = await fetchModelCoverage(client, catalogModels());
      // 三个数据集**一个都没读到**不算成功：那时 index 必然全空，
      // 存下来就等于把"读不到"固化成了"没有资料"。
      if (r.datasets.length === 0) {
        // reason 会被端上直接显示，所以带上"这是知识库连不上"这层意思——
        // 光一句 `TypeError: fetch failed` 用户看不懂是什么坏了。
        const detail = r.failures[0]?.reason;
        lastError = detail ? `知识库不可达（${detail}）` : "知识库三个数据集都读不到";
        return;
      }
      snapshot = {
        index: r.index,
        fetchedAt: now(),
        failures: r.failures.map((f) => ({ dataset: f.dataset, reason: f.reason })),
        invisible: r.invisible,
      };
      lastError = undefined;
      if (r.invisible.length > 0) {
        console.warn(
          `[vehicle-catalog] ${r.invisible.length} 篇文档不含任何已知车型，限定车型时检索不到：${r.invisible.join("、")}`,
        );
      }
    } catch (e) {
      lastError = `知识库不可达（${String(e).split("\n")[0]!.slice(0, 160)}）`;
    }
  }

  return {
    async get() {
      const fresh = snapshot && now() - snapshot.fetchedAt < ttlMs;
      if (!fresh) {
        inflight ??= refresh().finally(() => {
          inflight = undefined;
        });
        await inflight;
      }
      if (!snapshot) return { state: "unavailable", reason: lastError ?? "知识库覆盖尚未取得" };
      if (lastError) return { snapshot, state: "stale", reason: lastError };
      return { snapshot, state: "live" };
    },
  };
}

function linksOf(snapshot: CoverageSnapshot | undefined, model: string): ModelKnowledgeLink[] {
  return (snapshot?.index.get(model) ?? []).map((l) => ({
    dataset: l.dataset,
    datasetName: l.datasetName,
    documents: l.documents,
  }));
}

/** 一辆车（或一个车型）的关联关系。`GET /v1/vehicles` 也用它。 */
export async function knowledgeFor(
  provider: CoverageProvider,
  model: string,
): Promise<VehicleKnowledge> {
  const { snapshot, state, reason } = await provider.get();
  return {
    model,
    links: state === "unavailable" ? [] : linksOf(snapshot, model),
    state,
    fetchedAt: snapshot?.fetchedAt,
    reason,
  };
}

export function createVehicleCatalogRouter(provider: CoverageProvider): Router {
  const router = Router();

  router.get("/v1/vehicle-catalog", async (_req: AuthedRequest, res: Response) => {
    const { snapshot, state, reason } = await provider.get();
    res.json({
      entries: VEHICLE_CATALOG.map((e) => ({
        brand: e.brand,
        model: e.model,
        links: state === "unavailable" ? [] : linksOf(snapshot, e.model),
      })),
      coverage: {
        state,
        fetchedAt: snapshot?.fetchedAt,
        reason,
        // 部分数据集读失败时如实说是哪几个——"有一半资料没查到"与"全查到了"不同。
        partialFailures: snapshot?.failures ?? [],
      },
    });
  });

  return router;
}
