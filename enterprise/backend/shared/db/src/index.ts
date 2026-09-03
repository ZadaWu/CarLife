// @carlife/db — 数据访问层入口
import { PrismaClient } from "@prisma/client";

export { PrismaClient };
export {
  resolveTestDatabaseUrl,
  TestDatabaseUrlError,
  DEFAULT_TEST_DATABASE_URL,
} from "./test-db";
export { createChatRepository, type ChatRepository } from "./repositories/chat";
export {
  createConfigStore,
  type ConfigStore,
  type ConfigDisplayItem,
  type ConfigWrite,
  type ConfigSource,
} from "./config/store";
export {
  CONFIG_REGISTRY,
  DEV_JWT_SECRET,
  findConfigDef,
  isWritable,
  registryHasNoPolicyOrRedline,
  type ConfigDef,
  type ConfigClass,
  type ConfigScope,
  type ConfigStorage,
} from "./config/registry";
export {
  resolveTts,
  isTtsEngine,
  DOUBAO_TTS_URL,
  TTS_GATEWAY_PATH,
  LEGACY_ALIYUN_TTS_GATEWAY_PATH,
  type ResolvedTts,
  type TtsEngine,
} from "./config/tts";
export { maskSecret, maskDeep } from "./config/mask";
export { encryptSecret, decryptSecret, assertMasterKeyUsable, MasterKeyMissingError } from "./config/crypto";
export { encryptPii, decryptPii, isPiiCiphertext, assertPiiMasterKeyUsable, PiiMasterKeyMissingError } from "./pii/crypto";
export {
  assertStartupConfig,
  collectStartupIssues,
  collectStartupReport,
  isProductionEnv,
  type StartupIssue,
  type StartupWarning,
  type StartupReport,
} from "./config/startup";
export {
  createUsageRepository,
  type UsageRepository,
  type UsageEntry,
  type UsageBucket,
} from "./repositories/usage";
// 用户体系（M48-01）：账号、车辆授权、设备。角色判定的唯一入口是 `roleFor`。
export {
  createUserRepository,
  UsernameTakenError,
  type UserRepository,
  type UserAccount,
  type PublicUser,
  type CreateUserInput,
} from "./repositories/user";
export {
  createVehicleGrantRepository,
  OwnerCannotBeGrantedError,
  GrantAlreadyActiveError,
  type VehicleGrantRepository,
  type ResolvedRole,
  type GrantInput,
} from "./repositories/vehicle-grant";
export {
  createDeviceRepository,
  type DeviceRepository,
  type RegisterDeviceInput,
} from "./repositories/device";
// 用户体系的后台只读面（M68-01）：只给 `/console/*` 用，全仓唯一允许无键跨实体读的仓储。
export {
  createIdentityConsoleRepository,
  encodeCursor as encodeIdentityCursor,
  decodeCursor as decodeIdentityCursor,
  type IdentityConsoleRepository,
  type IdentityOverview,
  type IdentityPage,
  type UserListRow,
  type UserDetail,
  type UserGrantRow,
  type OwnedVehicleRow,
  type VehicleListRow,
  type VehicleDetail,
  type VehicleGrantRow,
  type DeviceListRow,
  type DevicePageQuery,
  type DeviceStatusFilter,
  type RecordState,
} from "./repositories/identity-console";
export {
  createAuditRepository,
  type AuditRepository,
  type AuditEntry,
  type AuditRecord,
  type AuditPage,
  type AuditQuery,
  type AuditRole,
  type AuditResult,
} from "./repositories/audit";

let client: PrismaClient | undefined;

/** 进程内单例 PrismaClient（DATABASE_URL 由环境提供）。 */
export function getPrisma(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

export { createTripRepository, type TripRepository } from "./repositories/trip";
// ⑥ 补能流水（M26-06）：油侧能耗唯一的数据源。与 energy_gap 同 Sprint 落地，
// 不留「字段与消费者先于数据源」的口子（ADR-002 第 3 类）。
export {
  createRefuelRepository,
  validateRefuel,
  RefuelValidationError,
  type RefuelRepository,
  type RefuelInput,
  type StoredRefuel,
} from "./repositories/refuel";
export {
  createTripRouteAuditRepository,
  TRIP_ROUTE_AUDIT_LIST_MAX,
  type TripRouteAuditRepository,
  type TripRouteAuditContext,
  type StoredTripRouteAudit,
} from "./repositories/trip-route-audit";
export {
  assignLatestByPrefix,
  createTripPlanRepository,
  TRIP_PLAN_LIST_DEFAULT,
  TRIP_PLAN_LIST_MAX,
  type TripPlanRepository,
  type CommittedTripPlan,
  type TripPlanStatus,
  type TripPlanQuery,
} from "./repositories/trip-plan";
export {
  createOwnerProfileRepository,
  DEFAULT_HOME,
  type OwnerProfileRepository,
  type OwnerProfile,
  type HomePlace,
} from "./repositories/owner-profile";
export {
  createAttachmentRepository,
  type AttachmentRepository,
  type AttachmentMeta,
} from "./repositories/attachment";
export {
  createMessageAudioRepository,
  type MessageAudioRepository,
  type MessageAudioMeta,
  type MessageAudioKind,
  type MessageAudioOrigin,
} from "./repositories/message-audio";
export {
  createTraceRepository,
  type TraceRepository,
  type TraceEventRecord,
} from "./repositories/trace";
export {
  createVehicleRepository,
  VehicleNotFoundError,
  type VehicleRepository,
} from "./repositories/vehicle";
export {
  createVehicleMemberRepository,
  type VehicleMemberRepository,
} from "./repositories/vehicle-member";
export {
  createMemberCombinationRepository,
  type MemberCombinationRepository,
} from "./repositories/member-combination";
export { createUserFlagRepository } from "./repositories/user-flag";
// 补录询问的拒答冷却（M26-03，§4.6 约束 2/4）：独立成表，**不挂在 Vehicle 上**。
export {
  createElicitationCooldownRepository,
  type ElicitationCooldownRepository,
} from "./repositories/elicitation";
export { createWorkingThreadStore, type WorkingThreadRecord, type WorkingThreadStore } from "./working-thread";
export { createJobRepository, type JobRepository, type JobRunRecord } from "./repositories/job";
// Guardrails 运行时裁决审计（M37-04）：追加式，无更新/删除接口。
export {
  createGuardAuditRepository,
  type GuardAuditRepository,
  type GuardAuditRow,
} from "./repositories/guard-audit";
export {
  createGuardSettingRepository,
  type GuardSettingRepository,
  type GuardSettingKey,
  type GuardSettingRecord,
  type GuardSettingRevisionRecord,
  type KillSwitch,
} from "./repositories/guard-setting";
export { createGuideBriefRepository, type GuideBriefStore } from "./repositories/guide-brief";
