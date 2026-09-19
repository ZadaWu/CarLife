/**
 * 四道硬门（施工单 M82-01，判据照 analysis.md §3）。
 *
 * # 门是页面上的状态位，不是声明
 *
 * 任一失败则停止处理或降级用途。**商业分数不能抵消权利与安全缺陷**——
 * 所以门的结果不参与 ODS 的加权，它是加权之前的闸；ODS 里那个 `C`
 * 只表示证据强度，与门是两回事。
 *
 * # `degraded` 与 `fail` 的分工
 *
 *  - `degraded`：镜头照出，但**禁用某些表达**（象限底色、方向、置信数字）。
 *    观察总体只有 5 台车时，`n/N` 仍然是真的，"方向向好"不是。
 *  - `fail`：停止处理。整行/整群置灰或标"不可交付"，不显示明细。
 *
 * 最后一格（safety）是 CarLife 特有的：硬禁范畴的需求会持续出现在语料里
 * （"你帮我把胎压调一下"），它在图上**必须有位置且标成不可交付**——
 * 归到"待优化"会让 roadmap 反复捡起一件做不了的事。
 */

import { isSimulated, passportOf } from "./passport";
import type { GateName, GateVerdict, Gates, Population } from "./types";

/** 观察总体低于这个车辆数就降级——与小单元抑制阈值同源。 */
export const EVIDENCE_MIN_VEHICLES = 10;

/** 编码一致率的及格线（Sprint 完成判定 4）。 */
export const MEASUREMENT_MIN_AGREEMENT = 0.7;

/** 重要度的三种口径，必须声明其一（measurement 门）。 */
export type ImportanceBasis = "mention" | "behavior" | "direct-ask";

/**
 * 不做健康 / 阶层 / 性格推断——这三类轴一旦进 codebook，
 * 后面每一张图都在做这件事，而且没有任何一层会报错。
 */
export const FORBIDDEN_AXES: readonly string[] = ["health", "class", "personality"];

export interface GateInput {
  /** 这次分析用到的来源 id 集合。任一不可采或为模拟数据 → rights fail。 */
  sourceIds: readonly string[];
  /** 观察总体。分母为 0 → evidence fail；车辆数不足 → degraded。 */
  population: Population;
  /** 分母能不能显示。不能显示的分母等于没有分母。 */
  denominatorVisible: boolean;
  /** 反例是否检索过。没检索过只是降级——有证据但只找了支持的那一半。 */
  counterEvidenceSearched: boolean;
  /** codebook 锁没锁。没锁 = 口径还会变，任何数字都不能跨窗比较。 */
  codebookLocked: boolean;
  /** 复编码一致率（0–1）。`null` = 还没测过。 */
  agreement: number | null;
  /** 重要度口径。`null` = 没声明。 */
  importanceBasis: ImportanceBasis | null;
  /** codebook 的全部轴名。命中禁用轴 → safety fail。 */
  axes: readonly string[];
  /** 主题是否落在硬禁范畴（自动驾驶决策 / 车辆安全控制 / 替代专业维修的确定性结论）。 */
  undeliverable: boolean;
}

const pass = (reason: string): GateVerdict => ({ status: "pass", reason });
const degraded = (reason: string): GateVerdict => ({ status: "degraded", reason });
const fail = (reason: string): GateVerdict => ({ status: "fail", reason });

function rightsGate(sourceIds: readonly string[]): GateVerdict {
  const simulated = sourceIds.filter(isSimulated);
  if (simulated.length > 0) {
    return fail(`来源含模拟数据（${simulated.join(" / ")}），不构成市场证据`);
  }
  const unregistered = sourceIds.filter((id) => passportOf(id) === null);
  if (unregistered.length > 0) {
    return fail(`来源未登记护照（${unregistered.join(" / ")}），默认不可采`);
  }
  const notCollectable = sourceIds.filter((id) => passportOf(id)?.collect !== "yes");
  if (notCollectable.length > 0) {
    return fail(`来源护照 collect ≠ yes（${notCollectable.join(" / ")}）`);
  }
  return pass("全部来源在护照内且 collect = yes");
}

function evidenceGate(input: GateInput): GateVerdict {
  const { population, denominatorVisible, counterEvidenceSearched } = input;
  if (population.turns === 0 && population.vehicles === 0) {
    return fail("观察总体为空，这个窗里没有任何证据");
  }
  if (!denominatorVisible) {
    return fail("分母不可显示——没有分母的 n 是一个无法解读的数");
  }
  if (population.vehicles < EVIDENCE_MIN_VEHICLES) {
    return degraded(
      `观察总体只有 ${population.vehicles} 台车（阈值 ${EVIDENCE_MIN_VEHICLES}）：` +
        "只显示 n/N，方向与置信留空",
    );
  }
  if (!counterEvidenceSearched) {
    return degraded("反例未检索：只找了支持的那一半，方向不可读");
  }
  return pass(`观察总体 ${population.owners} 车主 / ${population.vehicles} 车 / ${population.turns} 轮`);
}

function measurementGate(input: GateInput): GateVerdict {
  if (!input.codebookLocked) {
    return fail("codebook 版本未锁：口径还会变，跨窗比较没有意义");
  }
  if (input.agreement === null) {
    return fail("复编码一致率未测");
  }
  if (input.agreement < MEASUREMENT_MIN_AGREEMENT) {
    return fail(
      `复编码一致率 ${input.agreement.toFixed(2)} < ${MEASUREMENT_MIN_AGREEMENT}：编码本身不可靠`,
    );
  }
  if (input.importanceBasis === null) {
    return degraded("重要度口径未声明：象限图退化为散点，不显示象限底色");
  }
  return pass(`codebook 已锁，一致率 ${input.agreement.toFixed(2)}，重要度口径 ${input.importanceBasis}`);
}

function safetyGate(input: GateInput): GateVerdict {
  const hit = input.axes.filter((a) => FORBIDDEN_AXES.includes(a.toLowerCase()));
  if (hit.length > 0) {
    return fail(`codebook 含禁用推断轴（${hit.join(" / ")}）：不做健康 / 阶层 / 性格推断`);
  }
  if (input.undeliverable) {
    /*
     * 注意这里是 `degraded` 不是 `fail`：**需求是真的，只是永远不能满足**。
     * 判 fail 会让它从图上消失，而消失的表现就是半年后有人再提一次。
     */
    return degraded("落在硬禁范畴：标「不可交付」，仍显示证据量");
  }
  return pass("不落硬禁范畴，无推断轴");
}

export function evaluateGates(input: GateInput): Gates {
  return {
    rights: rightsGate(input.sourceIds),
    evidence: evidenceGate(input),
    measurement: measurementGate(input),
    safety: safetyGate(input),
  };
}

/** 任一 fail 即停止处理。调用方据此决定"出不出这张图"。 */
export function anyGateFailed(gates: Gates): boolean {
  return (Object.keys(gates) as GateName[]).some((k) => gates[k].status === "fail");
}

/** 最高等级的上限：门决定天花板，证据强度决定能不能顶到天花板。 */
export function levelCeilingOf(gates: Gates): "signal" | "candidate" | "validated" {
  if (anyGateFailed(gates)) return "signal";
  const allPass = (Object.keys(gates) as GateName[]).every((k) => gates[k].status === "pass");
  return allPass ? "validated" : "candidate";
}
