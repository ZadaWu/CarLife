// HUD 数据契约由 contracts 提供（端云契约唯一真相源），此处仅做转出，
// 避免车机端各处直接深引用 shared 的内部路径。
export type {
  AssistantState,
  DestinationHighlights,
  EnergySummary,
  Freshness,
  HighlightEntry,
  HudSnapshot,
  PhotoTipRef,
  TipItemRef,
  TipPage,
  TipsBlock,
  TripNode,
  TripPlan,
  WeatherContext,
  WeatherKind,
} from "@carlife/shared";

export {
  MAX_ITEMS_PER_PAGE,
  highlightsPage,
  isHighlightsPage,
  WEATHER_KINDS,
  WEATHER_LABELS,
  MAX_TRIP_NODES,
  MIN_TRIP_NODES,
  paginateTipItems,
  tripDayIndex,
  tripPlanHasCoords,
  tripPlanNavDay,
  tripPlanStops,
  tripPlanToHud,
  validateHudSnapshot,
} from "@carlife/shared";
