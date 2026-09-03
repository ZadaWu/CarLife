/**
 * cabin_apply_preferences —— 按「今天谁坐哪」把各人的偏好一次调好（M24 收口）。
 *
 * # 它是座舱的 `merge.ts`，只是入口变成了工具
 *
 * 翻译（谁的偏好落到哪个分区、冲突怎么仲裁、这车做不到什么）是**确定性求解**，
 * 必须留在代码里——"妈妈上限 24 + 组合覆盖 25 该落几度"不该由模型算，
 * 那和行程的硬约束求解在 `merge.ts` 是同一条纪律（§4.5）。
 *
 * 变的只是**谁触发它**：此前编排层用正则识别"副驾是妈妈"再直调；现在模型
 * 理解人话、调这个工具，求解仍在 `translateCabinPlan` 里一行未改。
 *
 * # 入参收 memberId，不收称呼
 *
 * 称呼的歧义（"我妈"/"妈妈"/"母亲"）由模型消解——它可以先 `vehicle_member`
 * 查名单。工具这一侧只认 id：编一个会被拒，与 `test_drive_book` 只收 slotId 同源。
 */

import type { CabinSettingPlan, MemberCabinPreference, MemberCombination } from "@carlife/shared";
import type { CombinationStore, MemberStore, VehicleMember } from "@carlife/memory";

import { requireCabinClient, type CabinApplyOp, type CabinCapabilities, type CabinOpResult } from "./cabin-backend";
import { resolveCabinVin, type CabinVinArgs } from "./cabin-status";
import { defineExternalTool, ToolError, type ExternalTool, type ToolCallContext } from "./external";
import { deriveRequestId } from "./cabin-control";

/** 翻译器由装配层注入——`enterprise/backend/shared/tools` 不 import `agent-runtime`（依赖方向）。 */
export interface CabinTranslator {
  (input: {
    seated: Array<{ memberId: string; zone: string; ageBand?: string; preference: MemberCabinPreference }>;
    combination: MemberCombination | null;
    roundOverride?: MemberCabinPreference | null;
    capabilities: CabinCapabilities;
  }): CabinSettingPlan;
}

let translate: CabinTranslator | undefined;
let members: MemberStore | undefined;
let combinations: CombinationStore | undefined;

export function setCabinApplyDeps(deps: {
  translate?: CabinTranslator;
  members?: MemberStore;
  combinations?: CombinationStore;
}): void {
  translate = deps.translate;
  members = deps.members;
  combinations = deps.combinations;
}

export interface CabinApplyPreferencesArgs extends CabinVinArgs {
  /** zone → memberId。zone：driver/passenger/rearLeft/rearRight。 */
  seating: Record<string, string>;
}

export interface CabinApplyPreferencesData {
  vin: string;
  /** 每一项设置因为谁——播报要按人分组说。 */
  attributions: CabinSettingPlan["attributions"];
  /** 这车做不到的，带原因与是谁的偏好。 */
  undone: CabinSettingPlan["undone"];
  /** 共享资源的仲裁记录（谁赢了、按什么规则、谁让了）。 */
  arbitrations: CabinSettingPlan["arbitrations"];
  /** 车机的逐字段裁决。 */
  results: CabinOpResult[];
  /** 命中的组合（无则 null）——"回退叠加"是正常路径，不必声张。 */
  combinationLabel: string | null;
  /** zone → 称呼，供播报用。 */
  seatedNames: Record<string, string>;
}

const TOOL = "cabin_apply_preferences";

export const cabinApplyPreferencesTool: ExternalTool<CabinApplyPreferencesArgs, CabinApplyPreferencesData> =
  defineExternalTool({
    name: TOOL,
    provider: "mock-cabin",
    timeoutMs: 8_000,
    retries: 0,
    async real(args, ctx: ToolCallContext) {
      if (!translate || !members) throw new ToolError(TOOL, "unconfigured", "座舱偏好应用未接入", false);
      const seating = args.seating ?? {};
      const ids = Object.values(seating).filter(Boolean);
      if (ids.length === 0) {
        throw new ToolError(TOOL, "invalid", "seating 不能为空：至少要知道一个座位坐了谁（zone → memberId）", false);
      }

      const vin = await resolveCabinVin(TOOL, args);
      const roster = await members.listByOwner(args.userId);
      const byId = new Map<string, VehicleMember>(roster.map((m) => [m.id, m]));
      const unknown = ids.filter((id) => !byId.has(id));
      if (unknown.length > 0) {
        // 编 id 死在这里——与 test_drive_book 的 slotId 同一条防编纪律
        throw new ToolError(TOOL, "invalid", `名单里没有这些人：${unknown.join("、")}——先用 vehicle_member 查名单拿 id`, false);
      }

      const client = requireCabinClient();
      const status = await client.status(vin);

      // 组合精确匹配；无命中 = 正常回退叠加，不是错误
      const combination =
        combinations && ids.length >= 2
          ? await combinations.findByMembers(args.userId, vin, ids).catch(() => null)
          : null;

      const seated = Object.entries(seating)
        .filter(([, id]) => byId.has(id))
        .map(([zone, id]) => {
          const m = byId.get(id)!;
          return { memberId: id, zone, ageBand: m.ageBand, preference: m.cabinPreference ?? {} };
        });

      const plan = translate({ seated, combination, capabilities: status.capabilities });

      let results: CabinOpResult[] = [];
      if (plan.ops.length > 0) {
        const r = await client.apply(vin, {
          requestId: deriveRequestId(ctx, plan.ops as CabinApplyOp[]),
          ops: plan.ops as CabinApplyOp[],
        });
        results = r.results;
      }

      const seatedNames: Record<string, string> = {};
      for (const [zone, id] of Object.entries(seating)) {
        const m = byId.get(id);
        if (m) seatedNames[zone] = m.displayName;
      }

      return {
        vin,
        attributions: plan.attributions,
        undone: plan.undone,
        arbitrations: plan.arbitrations,
        results,
        combinationLabel: combination?.label ?? null,
        seatedNames,
      };
    },
  });
