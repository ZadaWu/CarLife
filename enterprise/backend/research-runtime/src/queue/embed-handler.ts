/**
 * `research.embed` 的消费者（施工单 M82-05）。
 *
 * 把编码完的话语单元的 `text_redacted` 嵌成 1024 维向量写 `research_embeddings`。
 * 主题聚类吃的是这些向量——**不是原文**：原文这一层根本拿不到。
 */

import type { ResearchRepository } from "@carlife/db";

import { embedTexts, type EmbedConfig } from "../ontology/embed";

export interface EmbedJobPayload {
  unitIds: string[];
}

export interface EmbedHandlerDeps {
  repo: ResearchRepository;
  config: EmbedConfig;
  recordUsage?: (u: { agent: string; model: string; promptTokens: number; completionTokens: number; reasoningTokens: number }) => Promise<void>;
}

export interface EmbedJobResult {
  embedded: number;
  skipped: boolean;
}

export async function handleEmbedJob(payload: EmbedJobPayload, deps: EmbedHandlerDeps): Promise<EmbedJobResult> {
  const ids = payload.unitIds ?? [];
  // 空批不调 API——空任务也调一次是白花钱。
  if (ids.length === 0) return { embedded: 0, skipped: true };

  const rows: Array<{ id: string; text: string }> = [];
  for (const id of ids) {
    const row = (await deps.repo.units.byId(id)) as { id: string; textRedacted: string | null } | null;
    if (row?.textRedacted && row.textRedacted.trim() !== "") rows.push({ id: row.id, text: row.textRedacted });
  }
  if (rows.length === 0) return { embedded: 0, skipped: true };

  const { vectors, promptTokens } = await embedTexts(rows.map((r) => r.text), deps.config);
  await deps.repo.embeddings.upsertMany(
    rows.map((r, i) => ({ unitId: r.id, model: deps.config.model, embedding: vectors[i] })),
  );

  await deps.recordUsage?.({
    agent: "research-embed",
    model: deps.config.model,
    promptTokens,
    // 嵌入没有输出 token，也没有推理——后者恒 0 是这一档的定义，不是巧合。
    completionTokens: 0,
    reasoningTokens: 0,
  });

  return { embedded: rows.length, skipped: false };
}
