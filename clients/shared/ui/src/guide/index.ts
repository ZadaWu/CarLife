export { GuideScreen, type GuideScreenProps, type GuideScreenState } from "./GuideScreen";
export { GuideMiniMap, type GuideMiniMapProps } from "./GuideMiniMap";
export { GuideJobsPanel, type GuideJobsPanelProps } from "./GuideJobsPanel";
export {
  GUIDE_JOBS_POLL_MS,
  applyGuideFetchOptimistic,
  outstandingGuideJobs,
  readyGuideSpots,
  shouldPollGuideJobs,
} from "./jobs-logic";
// 版式截图入口用的演示数据（`?guide=demo`）：两端共用一份。
export { DEMO_GUIDE_BRIEF, isGuideDemo } from "./demo-guide-brief";
