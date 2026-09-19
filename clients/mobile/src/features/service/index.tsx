/**
 * features/service — 售后服务界面（FL-20 `F-20-15` 指定的落点）。
 *
 * 2026-09-18 起有了第一条链：拍照问诊（`capture.tsx` 拍照页，M104-03；引导卡 / 报告页 / 追问在 M104-04）。
 * 报告数据经 `api.ts` 只读（M104-02），端上不解析回答文本。
 */
export { MobileCapture, CAPTURE_PARTS, type CapturePart, type MobileCaptureProps } from "./capture";
export { loadDiagnosis } from "./api";
export { DiagnosisCards, ObservationCard } from "./guided";
export { PromptCards, AskGroup, GuidanceCard, CaptureCard, type PromptCardsProps } from "./prompts";
export { composeAnswers, composeOutcome } from "./prompt-answers";
export { MobileDiagnosisReport, riskTitle } from "./report";
export { ReportPin, QuickReplies, QUICK_REPLIES, bookingPrompt } from "./followup";
export { diagnosisDemoView, DEMO_DIAGNOSIS_REPORT, DEMO_DIAGNOSIS_MESSAGES_GUIDED, DEMO_DIAGNOSIS_MESSAGES_FOLLOWUP } from "./demo";
export type { DiagnosisState, DiagnosisReport } from "./types";
