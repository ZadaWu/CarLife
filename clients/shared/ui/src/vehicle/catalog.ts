/**
 * 车型目录的端上辅助（施工单 M14-05；M14-07 更正来源；M14-08 改吃实时关联关系）。
 *
 * # 数据不在这里
 *
 * 车型清单已归位到 `@carlife/shared` 的 `VEHICLE_CATALOG`（端云共用的契约），
 * **有没有对应知识库**由网关 `GET /v1/vehicle-catalog` 从 RAGFlow 实时算出。
 * 这里只剩把两者拼给 UI 用的纯函数。
 *
 * M14-07 曾在目录上写死 `manual: true`。那是个手写布尔值，加语料后要靠人记得
 * 回来改，漂了没有任何信号。现在"有没有资料"是**关系**不是属性，
 * 判据与检索侧同一个函数（`documentMatchesModel`），两边不可能给出不同答案。
 */

import {
  VEHICLE_CATALOG,
  type ModelKnowledgeLink,
  type VehicleCatalogEntry,
  type KnowledgeCoverageState,
} from "@carlife/shared";

export type { VehicleCatalogEntry, ModelKnowledgeLink, KnowledgeCoverageState };

/** `GET /v1/vehicle-catalog` 的响应形状。 */
export interface CatalogResponse {
  entries: Array<VehicleCatalogEntry & { links: ModelKnowledgeLink[] }>;
  coverage: {
    state: KnowledgeCoverageState;
    fetchedAt?: number;
    reason?: string;
    partialFailures?: Array<{ dataset: string; reason: string }>;
  };
}

/** 端上手里的目录：拿到网关数据前用静态清单，`links` 为空且 state=unavailable。 */
export interface CatalogView {
  entries: Array<VehicleCatalogEntry & { links: ModelKnowledgeLink[] }>;
  state: KnowledgeCoverageState;
  reason?: string;
}

/**
 * 没有网关数据时的目录。**state 是 `unavailable` 而不是"没有资料"**——
 * 车型照样能选（建档不依赖知识库），但绝不声称这些车没有资料。
 */
export function offlineCatalog(reason = "还没读到知识库覆盖情况"): CatalogView {
  return {
    entries: VEHICLE_CATALOG.map((e) => ({ ...e, links: [] })),
    state: "unavailable",
    reason,
  };
}

export function catalogFromResponse(r: CatalogResponse): CatalogView {
  return { entries: r.entries, state: r.coverage.state, reason: r.coverage.reason };
}

/** 品牌列表；**有资料的品牌排在前面**（覆盖读不到时保持清单原序）。 */
export function catalogBrands(view: CatalogView): string[] {
  const all = [...new Set(view.entries.map((e) => e.brand))];
  if (view.state === "unavailable") return all;
  const covered = new Set(view.entries.filter((e) => e.links.length > 0).map((e) => e.brand));
  return [...all.filter((b) => covered.has(b)), ...all.filter((b) => !covered.has(b))];
}

export function modelsOfBrand(view: CatalogView, brand: string) {
  return view.entries.filter((e) => e.brand === brand);
}

export function entryOf(view: CatalogView, model: string | undefined) {
  return model ? view.entries.find((e) => e.model === model) : undefined;
}

/** 年款选择器的候选：通用近 20 年，**不按车型编上市年表**（M14-07）。 */
export function catalogYears(now = new Date()): number[] {
  const cur = now.getFullYear();
  return Array.from({ length: 20 }, (_, i) => cur - i);
}

/**
 * 建档/档案页要展示的那一句话。**三态**：
 *
 *  - 有资料 → 列出关联到哪些资料（用户由此知道"能问什么"）
 *  - 没有资料 → 明说没有，并说清哪些功能不受影响
 *  - 读不到 → 说读不到，**不冒充"没有资料"**
 *
 * 这三句话的区别不是措辞问题：把第三种说成第二种，是在替知识库断言
 * 一件我们此刻并不知道的事。
 */
export function knowledgeNote(view: CatalogView, model: string | undefined): string {
  if (view.state === "unavailable") {
    return `暂时读不到知识库覆盖情况${view.reason ? `（${view.reason}）` : ""}，无法判断这一款有没有资料。建档不受影响。`;
  }
  const links = entryOf(view, model)?.links ?? [];
  const stale = view.state === "stale" ? "（覆盖数据可能不是最新的）" : "";
  if (links.length === 0) {
    return `知识库暂时没有这一款的资料${stale}：问到「说明书里怎么说」时会如实告诉你没有，不会拿别的车型的手册作答。保养推算、提醒与用车记录不受影响。`;
  }
  const parts = links.map((l) => `${l.datasetName} ${l.documents.length} 篇`);
  return `已关联知识库${stale}：${parts.join("、")}。问这辆车的用法、保养与参数会引用这些资料并给出出处。`;
}

/**
 * 目录检索：品牌或车型包含关键词（大小写/空格不敏感）。
 * 无结果就是无结果——调用方展示检索词与明确结论（Brief §4），不做模糊兜底。
 */
export function searchCatalog(view: CatalogView, query: string) {
  const q = query.trim().toLowerCase().replace(/\s+/g, "");
  if (!q) return [];
  return view.entries.filter((e) =>
    `${e.brand}${e.model}`.toLowerCase().replace(/\s+/g, "").includes(q),
  );
}
