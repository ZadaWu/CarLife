/**
 * features/guide — 手机端景区导览页（施工单 M36-04，todo 1.b「手机端打开」两条）。
 *
 * 复用 `@carlife/ui` 的 GuideScreen（竖屏变体）：上小地图（单向路线）、
 * 下时间轴、休憩栏目紧随（下车逛景区的高频问题）、自驾到达段折叠。
 * 数据链：useGuideBrief → invoke → Rust → 网关 `POST /v1/guide/brief`。
 */

import { GuideScreen, type GuideScreenState } from "@carlife/ui";

export interface MobileGuideProps {
  spotName: string;
  state: GuideScreenState;
  onBack: () => void;
  onRetry?: () => void;
  /** 「重新采集」（2026-08-29：简报持久化后只采一次，刷新只走这里）。 */
  onRegenerate?: () => void;
}

export function MobileGuide({ spotName, state, onBack, onRetry, onRegenerate }: MobileGuideProps) {
  return (
    <GuideScreen
      spotName={spotName}
      state={state}
      onBack={onBack}
      onRetry={onRetry}
      onRegenerate={onRegenerate}
      layout="portrait"
    />
  );
}

export { useGuideBrief, requestGuideBrief } from "./api";
export { useGuideJobs } from "./jobs";
