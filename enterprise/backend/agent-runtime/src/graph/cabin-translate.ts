/**
 * 偏好 → 设置单的翻译器（施工单 M24-07，F-50-07/08/11）。
 *
 * # 零 LLM 零 IO 是结构保证，不是自律
 *
 * 本模块只 import 类型与常量：输入由调用方备齐（偏好、组合、乘坐上下文、能力表），
 * 输出是 `CabinSettingPlan`。给定同样输入永远同一张单——演示可复现、单测可穷举。
 * check:arch 的 env-timing 与 boundary 检查守着它不长出 IO。
 *
 * # 查找顺序（每个字段独立走一遍）
 *
 *   本轮覆盖（"今天冷副驾调 26"）＞ 组合覆盖 ＞ 成员个人偏好 ＞ 车主默认（不出 op）
 *
 * # 冲突是本模块的本质困难，不是边角
 *
 * 能分区的分区解决（主驾 22 副驾 24——双区空调本来就是干这个的）；
 * 分不了区的共享资源按固定规则仲裁：**儿童在车儿童优先，否则驾驶员优先**，
 * 仲裁结果是结构化字段（谁赢、什么规则、谁让了），播报层照着念，驾驶员可否决
 * （否决走本轮覆盖，不改偏好）。情境例外（儿童睡着该静音）归 §13-19，本期不做。
 */

import type {
  CabinArbitration,
  CabinAttribution,
  CabinPlanOp,
  CabinSettingPlan,
  CabinUndone,
  MemberCabinPreference,
  MemberCombination,
} from "@carlife/shared";
import type { CabinCapabilities } from "@carlife/tools";

export interface SeatedMember {
  memberId: string;
  /** zone：driver / passenger / rearLeft / rearRight。 */
  zone: string;
  ageBand?: string;
  preference: MemberCabinPreference;
}

export interface TranslateInput {
  /** 本次在车的人（来自乘坐上下文 × 人员档案）。 */
  seated: SeatedMember[];
  /** 精确命中的组合（无命中传 null——回退叠加是正常路径，F-50-11）。 */
  combination: MemberCombination | null;
  /** 本轮覆盖（字段级，形状同偏好）。 */
  roundOverride?: MemberCabinPreference | null;
  capabilities: CabinCapabilities;
}

/** 座位 zone → 空调 zone 的映射（能力表分区不足时逐级落靠）。 */
function climateZoneFor(seatZone: string, zones: string[]): string | null {
  const want =
    seatZone === "rearLeft" || seatZone === "rearRight"
      ? ["rear", "cabin"]
      : [seatZone, "cabin"];
  for (const z of want) if (zones.includes(z)) return z;
  return zones.length > 0 ? null : null;
}

interface FieldClaim {
  memberId: string | null;
  via: CabinAttribution["via"];
  value: unknown;
}

export function translateCabinPlan(input: TranslateInput): CabinSettingPlan {
  const { seated, combination, capabilities } = input;
  const round = input.roundOverride ?? undefined;
  const combo = combination && !combination.invalidatedAt ? combination : null;

  const ops: CabinPlanOp[] = [];
  const attributions: CabinAttribution[] = [];
  const undone: CabinUndone[] = [];
  const arbitrations: CabinArbitration[] = [];

  const pushOp = (domain: string, zone: string | undefined, field: string, claim: FieldClaim) => {
    let op = ops.find((o) => o.domain === domain && o.zone === zone);
    if (!op) {
      op = zone ? { domain, zone, set: {} } : { domain, set: {} };
      ops.push(op);
    }
    op.set[field] = claim.value;
    attributions.push({
      opIndex: ops.indexOf(op),
      field,
      memberId: claim.memberId,
      via: claim.via,
    });
  };

  /** 单个字段的取值：本轮覆盖 > 组合 > 个人。返回 null = 谁都没表态。 */
  const claimFor = (member: SeatedMember | null, field: keyof MemberCabinPreference): FieldClaim | null => {
    if (round?.[field] !== undefined) return { memberId: null, via: "round-override", value: round[field] };
    if (combo?.override[field] !== undefined) return { memberId: null, via: "combination", value: combo.override[field] };
    if (member && member.preference[field] !== undefined) return { memberId: member.memberId, via: "member", value: member.preference[field] };
    return null;
  };

  const childrenPresent = seated.some((m) => m.ageBand === "child");
  const driver = seated.find((m) => m.zone === "driver") ?? null;

  // ── 温度：按人给、按分区落 ──────────────────────────────
  // 一个空调 zone 可能坐多个人（单温区/后排两座）：同 zone 内也要仲裁。
  const tempClaims = new Map<string, Array<{ member: SeatedMember; value: number }>>();
  for (const m of seated) {
    const c = claimFor(m, "tempC");
    const cap = claimFor(m, "tempMaxC");
    // tempC 与 tempMaxC 并存取更低（上限语义：晕车的人"别太高"压过"喜欢 26"）
    let value: number | undefined;
    if (c && typeof c.value === "number") value = c.value;
    if (cap && typeof cap.value === "number") value = value === undefined ? cap.value : Math.min(value, cap.value);
    if (value === undefined) continue;
    const zone = climateZoneFor(m.zone, capabilities.climate.zones);
    if (!zone) continue;
    const list = tempClaims.get(zone) ?? [];
    list.push({ member: m, value });
    tempClaims.set(zone, list);
  }
  for (const [zone, claims] of tempClaims) {
    let winner = claims[0]!;
    if (claims.length > 1) {
      // 同一分区多人：儿童在车儿童优先，否则驾驶员优先；都不在取更低值（保守侧）。
      const child = childrenPresent ? claims.find((c) => c.member.ageBand === "child") : undefined;
      const drv = claims.find((c) => c.member.zone === "driver");
      winner = child ?? drv ?? claims.reduce((a, b) => (b.value < a.value ? b : a));
      arbitrations.push({
        resource: "climate",
        rule: child ? "child-first" : "driver-first",
        winnerMemberId: winner.member.memberId,
        loserMemberIds: claims.filter((c) => c !== winner).map((c) => c.member.memberId),
      });
      for (const loser of claims.filter((c) => c !== winner)) {
        undone.push({
          memberId: loser.member.memberId,
          field: "tempC",
          reason: "lost-arbitration",
          note: `与同分区的偏好冲突，按${child ? "儿童优先" : "驾驶员优先"}执行`,
        });
      }
    }
    // 本轮覆盖/组合对温度是全车语义：有就直接压过个人仲裁结果。
    const global = claimFor(null, "tempC");
    if (global) {
      pushOp("climate", zone, "tempC", global);
    } else {
      pushOp("climate", zone, "tempC", { memberId: winner.member.memberId, via: "member", value: winner.value });
    }
  }
  // 没人坐（或没人对温度表态）但组合/本轮有温度 → 落全车
  if (tempClaims.size === 0) {
    const global = claimFor(null, "tempC");
    if (global && capabilities.climate.zones.length > 0) {
      pushOp("climate", capabilities.climate.zones.includes("cabin") ? "cabin" : undefined, "tempC", global);
    }
  }

  // ── 座椅（加热/通风）：天然分区，无冲突 ──────────────────
  for (const m of seated) {
    const seatCap = capabilities.seats[m.zone];
    for (const [field, capLevels] of [
      ["seatHeating", seatCap?.heatingLevels ?? 0],
      ["seatVentilation", seatCap?.ventilationLevels ?? 0],
    ] as const) {
      const c = claimFor(m, field);
      if (!c) continue;
      if (!seatCap || capLevels === 0) {
        undone.push({
          memberId: c.memberId ?? m.memberId,
          field,
          reason: "unsupported-on-vehicle",
          note: `${m.zone} 没有${field === "seatHeating" ? "座椅加热" : "座椅通风"}`,
        });
        continue;
      }
      pushOp("seat", m.zone, field === "seatHeating" ? "heating" : "ventilation", { ...c, memberId: c.memberId ?? m.memberId });
    }
  }

  // ── 氛围灯：分区有限，取全车一档（组合/本轮 > 驾驶员 > 其他人最低亮度）──
  {
    const global = claimFor(null, "ambientBrightness");
    const personal = seated
      .map((m) => ({ m, c: claimFor(m, "ambientBrightness") }))
      .filter((x): x is { m: SeatedMember; c: FieldClaim } => x.c !== null && x.c.via === "member");
    const chosen = global ?? (personal.find((p) => p.m.zone === "driver")?.c ?? personal[0]?.c ?? null);
    if (chosen && capabilities.ambientLight.zones.length > 0) {
      pushOp("ambientLight", undefined, "brightness", chosen);
    }
  }

  // ── 媒体：全车一路，共享资源仲裁的主场 ──────────────────
  {
    const globalTag = claimFor(null, "mediaContentTag");
    const claims = seated
      .map((m) => ({ m, c: claimFor(m, "mediaContentTag") }))
      .filter((x): x is { m: SeatedMember; c: FieldClaim } => x.c !== null && x.c.via === "member");
    let chosen: { memberId: string | null; via: CabinAttribution["via"]; value: unknown } | null = globalTag;
    if (!chosen && claims.length > 0) {
      const child = childrenPresent ? claims.find((c) => c.m.ageBand === "child") : undefined;
      const drv = claims.find((c) => c.m.zone === "driver");
      const winner = child ?? drv ?? claims[0]!;
      chosen = { ...winner.c, memberId: winner.m.memberId };
      if (claims.length > 1) {
        arbitrations.push({
          resource: "media",
          rule: child ? "child-first" : "driver-first",
          winnerMemberId: winner.m.memberId,
          loserMemberIds: claims.filter((c) => c !== winner).map((c) => c.m.memberId),
        });
        for (const loser of claims.filter((c) => c !== winner)) {
          undone.push({
            memberId: loser.m.memberId,
            field: "mediaContentTag",
            reason: "lost-arbitration",
            note: `媒体全车一路，按${child ? "儿童优先" : "驾驶员优先"}播放`,
          });
        }
      }
    }
    if (chosen) {
      const tag = String(chosen.value);
      const source = tag.includes("儿歌") ? "kids" : tag.includes("播客") ? "podcast" : tag.includes("电台") ? "radio" : "music";
      pushOp("media", undefined, "source", { ...chosen, value: source });
      pushOp("media", undefined, "contentTag", chosen);
    }
    // 音量上限：取在车成员里最严的一档（上限语义没有冲突——都满足）。
    const limits: Array<{ memberId: string | null; via: CabinAttribution["via"]; value: number }> = [];
    const g = claimFor(null, "mediaVolumeLimit");
    if (g && typeof g.value === "number") limits.push({ ...g, value: g.value });
    for (const m of seated) {
      const c = claimFor(m, "mediaVolumeLimit");
      if (c && c.via === "member" && typeof c.value === "number") limits.push({ memberId: m.memberId, via: "member", value: c.value });
    }
    if (limits.length > 0) {
      const strictest = limits.reduce((a, b) => (b.value < a.value ? b : a));
      pushOp("media", undefined, "volumeLimit", strictest);
    }
  }

  return { ops, attributions, undone, arbitrations };
}
