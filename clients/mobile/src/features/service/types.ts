/**
 * 拍照问诊在端上的读形状（施工单 M104-02）。契约真相源是 `@carlife/shared` 的 `DiagnosisReport`——
 * 这里只转出并加一个三态壳，与 `features/buying/types.ts` 同一形态。
 */
import type { DiagnosisReport } from "@carlife/shared";

export type { DiagnosisReport, DiagnosisQuestion, DiagnosisObservedItem, DiagnosisRiskLevel } from "@carlife/shared";

export type DiagnosisState =
  | { kind: "ready"; report: DiagnosisReport }
  /** 这个会话还没问过诊。常态，不是错误。 */
  | { kind: "empty" }
  | { kind: "offline"; reason: string };
