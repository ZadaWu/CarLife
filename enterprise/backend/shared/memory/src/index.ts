// @carlife/memory — Mem0 封装 + 按类衰减层入口
export {
  MEMORY_TAXONOMY,
  findMemoryCategory,
  type MemoryCategory,
  type MemoryCategoryId,
} from "./taxonomy";

export {
  CarLifeMemoryClient,
  getMemoryClient,
  resetMemoryClient,
  type CarLifeMemoryMeta,
  type EpisodicMemoryMeta,
  type PreferenceMemoryMeta,
  type UsagePatternMeta,
  type EpisodicMemoryInput,
  type PreferenceMemoryInput,
  type UsagePatternInput,
  type MemoryReadResult,
} from "./client";

export {
  extractEpisodes,
  episodeFingerprint,
  parseOccurredAt,
  type EpisodicCandidate,
  type EpisodicSubType,
} from "./episodic-extract";

export {
  extractPreferences,
  PREFERENCE_DOMAINS,
  MIN_CONFIDENCE,
  type PreferenceCandidate,
  type PreferenceDomain,
} from "./preference-extract";

export {
  aggregate,
  aggregateCompanion,
  assessUsability,
  assessCompanionUsability,
  MIN_SAMPLE,
  MAX_STALE_DAYS,
  type CompanionSummary,
  type TripRecord,
  type UsageSummary,
  type UsabilityVerdict,
} from "./usage-telemetry/summary";

// ⑥ 的实测能耗口径（M26-06）。油侧靠补能流水、电侧靠实测续航折算成百分比——
// **两侧单位不同是刻意的**：车主看仪表盘报的就是"升"和"百分之几"。
export {
  measuredEnergyPer100km,
  fuelConsumptionPer100km,
  electricConsumptionPer100km,
  DEFAULT_MIN_FUEL_INTERVALS,
  type RefuelRecord,
  type EnergyConsumption,
  type EnergyConsumptionResult,
  type EnergyInput,
} from "./usage-telemetry/energy";

export {
  ingestTrip,
  validateTrip,
  TripValidationError,
  type TripInput,
  type StoredTrip,
  type TripStore,
  type TripMemberFilter,
} from "./usage-telemetry/ingest";

export {
  loadUsageProfile,
  listTrips,
  loadMemberUsageProfile,
  loadCompanionProfile,
  memberProfileFallback,
  type UsageProfile,
  type MemberUsageProfile,
  type CompanionProfile,
  type ProfileScope,
} from "./usage-telemetry/query";

export {
  removeMemberCascade,
  type MemberProfilePurger,
  type MemberRemovalResult,
  type CombinationInvalidator,
} from "./member-cascade";

// 衰减层：re-rank 供检索期使用，decayFactor 另被 worker 的 memory-decay 任务复用——
// 两处共用同一条衰减曲线，避免"排序上已沉底却永远删不掉"的撕裂（见 decay.ts 注释）
export {
  rerank,
  reinforce,
  decayFactor,
  DECAY_PROFILES,
  NON_DECAYING,
  type DecayProfile,
  type MemoryItem as DecayMemoryItem,
  type RerankOptions,
} from "./decay";

export {
  VEHICLE_ONBOARDING_FLAG,
  COMPANION_ONBOARDING_FLAG,
  type UserFlagStore,
} from "./user-flags";

export {
  validateMember,
  sameRoles,
  MemberValidationError,
  type MemberStore,
  type VehicleMember,
  type VehicleMemberInput,
  type MemberRole,
  type MemberNeed,
  type MemberAgeBand,
} from "./member-store";
export {
  COMBINATION_LABEL_MAX,
  CombinationValidationError,
  validateCombination,
  type CombinationStore,
  type MemberCombination,
  type MemberCombinationInput,
} from "./member-combinations";

export {
  createCachedVehicleStore,
  getVehicleCacheStats,
  resetVehicleCacheStats,
  vehicleVinKey,
  vehicleOwnerKey,
  VEHICLE_CACHE_TTL_SECONDS,
  type VehicleCacheBackend,
  type VehicleCacheStats,
} from "./vehicle-cache";

// ④⑥ 数据新鲜度判定（M26-01）。**与 usage-telemetry 的 usable 语义不同**：
// 那套问"能不能下个性化结论"，这套问"该不该问车主一句"，取值不可互相复用。
export {
  assessFreshness,
  resolveFreshnessThresholds,
  DEFAULT_FRESHNESS_THRESHOLDS,
  type FreshnessItem,
  type FreshnessVerdict,
  type FreshnessThresholds,
  type FreshnessInput,
  type FreshnessFinding,
  type FreshnessReport,
} from "./freshness/index";

export {
  isValidVin,
  isEnergyType,
  forecastMaintenance,
  usableRate,
  MAINTENANCE_DEGRADE_LABEL,
  DEFAULT_INTERVAL_KM,
  ENERGY_LABEL,
  type VehicleProfile,
  type VehicleStore,
  type VehicleEnergyType,
  type MaintenanceRecord,
  type RepairRecord,
  type MaintenanceForecast,
  type MaintenanceDegradeReason,
  type MaintenanceRate,
  type ForecastContext,
} from "./vehicle-store";
