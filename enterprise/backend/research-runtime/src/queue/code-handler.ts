/**
 * `research.code` 的消费者（施工单 M82-04）。
 *
 * 取单元 → 编码 → 落库。失败让它抛，pg-boss 记失败态（`pgboss.job` 可查）——
 * **不要吞**：吞掉的表现是这批单元永远没有编码，而镜头上只是少了一点分子。
 */

import type { ResearchRepository } from "@carlife/db";

import { codeBatch, type CodableUnit, type CodeBatchDeps } from "../coding/coder";

export interface CodeJobPayload {
  unitIds: string[];
  codebookVersion: string;
}

export interface CodeHandlerDeps extends CodeBatchDeps {
  repo: ResearchRepository;
  /** 记一条 `llm_usage`。留成回调，测试里不必碰库。 */
  recordUsage?: (u: { agent: string; model: string; promptTokens: number; completionTokens: number; reasoningTokens: number }) => Promise<void>;
}

export interface CodeJobResult {
  units: number;
  codings: number;
  skipped: boolean;
}

/** 从库里的单元行拼出送模型的形状。**只取脱敏文本与上下文**。 */
function toCodable(row: Record<string, unknown>): CodableUnit | null {
  const text = row.textRedacted;
  if (typeof text !== "string" || text.trim() === "") return null;
  const ctx = (row.context ?? {}) as CodableUnit["context"];
  return { id: String(row.id), textRedacted: text, context: ctx };
}

export async function handleCodeJob(payload: CodeJobPayload, deps: CodeHandlerDeps): Promise<CodeJobResult> {
  const ids = payload.unitIds ?? [];
  // 空批直接完成，**不调模型**——空任务也调一次是白花钱且会污染合法 JSON 率。
  if (ids.length === 0) return { units: 0, codings: 0, skipped: true };

  const rows: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    const row = (await deps.repo.units.byId(id)) as Record<string, unknown> | null;
    if (row) rows.push(row);
  }
  const units = rows.map(toCodable).filter((u): u is CodableUnit => u !== null);
  if (units.length === 0) return { units: 0, codings: 0, skipped: true };

  const result = await codeBatch(units, deps);

  await deps.repo.codings.insertMany(
    result.codings.map((c) => ({
      unitId: c.unitId,
      codebookVersion: deps.book.version,
      axis: c.axis,
      code: c.code,
      confidence: c.confidence,
      rationale: c.rationale,
      competingCode: c.competingCode,
      uncertain: c.uncertain,
      coder: result.coder,
      promptHash: result.promptHash,
    })),
  );

  await deps.recordUsage?.(result.usage);
  return { units: units.length, codings: result.codings.length, skipped: false };
}
