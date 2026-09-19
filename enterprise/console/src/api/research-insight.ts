/**
 * 洞察卡的读取面（施工单 M85-06）。
 *
 * # 卡片与「当前口径」必须一次取回
 *
 * G5 的比对是"这张卡的口径 vs 此刻的口径"。分两跳查的话，两个值来自两个时刻——
 * 中间恰好重算了一次快照，页面上就会出现一批被误判成过期的卡；
 * 反过来也一样，而两种误判都不报错。所以端点一次回两样，这里也一次收两样。
 */

import { api } from "./index";
import type { InsightCard } from "@carlife/research/types";

export type { InsightCard };

/** 置信五分量 + c + 最低项 + 建议。与 `@carlife/research` 的 `confidenceOf` 同形。 */
export interface ConfidenceBreakdown {
  coverage: number;
  quality: number;
  agreement: number;
  triangulation: number;
  freshness: number;
  c: number;
  lowest: string;
  suggestion: string;
}

export interface ResearchInsight {
  id: string;
  themeId: string;
  /**
   * 这张卡属于哪一格。**从主题连出来的**——主题 id 的形状切不出唯一解，
   * 前端不许拿它反推（M85-01 文件头记着那段历史）。
   */
  needPainCode: string | null;
  themeName: string;
  /** signal | candidate | validated。**没有任何自动路径把它变成后两者。** */
  level: string;
  card: InsightCard;
  confidence: ConfidenceBreakdown;
  upgradeNeeds: string[];
  /**
   * 这张卡基于哪份快照。
   *
   * **null 是「口径未知」，不是「口径一致」**——M85-06 之前写下的行拿不回当时的
   * 快照 hash，那些卡与哪份快照同源是真的不知道。
   */
  inputsHash: string | null;
  owner: string;
  reviewAt: string | null;
  createdAt: string;
}

export interface InsightsPayload {
  insights: ResearchInsight[];
  /** 此刻的口径。没有快照时 null。 */
  currentInputsHash: string | null;
}

/** 取这个合同下的全部卡（含六栏正文）。 */
export function fetchInsights(contractId: string): Promise<InsightsPayload> {
  return api.get<InsightsPayload>(
    `/console/research/insights?full=1&contract=${encodeURIComponent(contractId)}`,
  );
}
