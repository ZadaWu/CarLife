/**
 * 售后服务：风险分级与替代方案（施工单 M8-05，§4.3⑤ / §8.3 末条）。
 *
 * # 本模块要解的是一个真实矛盾
 *
 * 高鹏要的是"能不能开、修多少钱"；§8.4 硬禁"替代专业维修的确定性结论"。
 * 如果每次都回"建议到店检测"，他用两次就不用了。
 *
 * **唯一可行解 = 拒绝的是"结论"，不是"帮助"**（FL-20 的核心设计矛盾）。
 * 用三样东西替代确定性结论：
 *  1. 风险分级 + 对应行动建议；
 *  2. 可执行的下一步（自查清单、补拍指引）；
 *  3. 谈判依据（常见处理方式 + 可向修理厂追问的关键问题）。
 *
 * # 分级不是模型自由发挥
 *
 * 症状到风险等级的映射写成规则。让模型"感觉一下"不可接受——
 * 罗启明会追问依据，且**答错方向（把异常说成正常）是安全问题**。
 */

export type RiskLevel = "low" | "medium" | "high";

export interface SymptomSignal {
  /** 是否涉及制动/转向/轮胎等安全件。 */
  safetyCritical: boolean;
  /** 是否随速度或制动加剧。 */
  worsensWithSpeedOrBraking: boolean;
  /** 是否伴随警告灯。 */
  warningLight: boolean;
  /** 是否持续存在（相对偶发）。 */
  persistent: boolean;
}

export interface RiskAssessment {
  level: RiskLevel;
  /** 判定依据——**每条都可被追问**。 */
  basis: string[];
  /** 需要立即停车的迹象（F-20-07）。 */
  stopNowSigns: string[];
  /** 可执行的下一步（F-20-08）。 */
  selfChecks: string[];
  /** 向修理厂追问的关键问题（F-20-10 的谈判依据部分）。 */
  questionsForShop: string[];
}

const STOP_NOW_SIGNS = [
  "刹车踏板变软、行程明显变长",
  "方向盘出现明显抖动或跑偏",
  "仪表出现红色警告灯（制动、机油压力、水温）",
  "车下出现持续滴漏",
  "异响随制动明显加剧",
];

/**
 * 症状 → 风险等级。
 *
 * 取向是**宁可偏高**：把中风险报成高风险的代价是用户多跑一趟，
 * 把高风险报成低风险的代价可能是一次事故。这条不对称决定了规则的写法。
 */
export function assessRisk(s: SymptomSignal): RiskAssessment {
  const basis: string[] = [];
  let level: RiskLevel = "low";

  if (s.safetyCritical) {
    level = "high";
    basis.push("涉及制动/转向/轮胎等安全件");
  }
  if (s.warningLight) {
    level = "high";
    basis.push("伴随仪表警告灯");
  }
  if (s.worsensWithSpeedOrBraking) {
    level = level === "high" ? "high" : "medium";
    basis.push("症状随速度或制动加剧");
  }
  if (s.persistent && level === "low") {
    level = "medium";
    basis.push("症状持续存在而非偶发");
  }
  if (basis.length === 0) basis.push("无安全件牵涉、无警告灯、非持续症状");

  return {
    level,
    basis,
    stopNowSigns: STOP_NOW_SIGNS,
    selfChecks: buildSelfChecks(s),
    questionsForShop: buildQuestions(s),
  };
}

function buildSelfChecks(s: SymptomSignal): string[] {
  const out = ["记录异响出现的时机：冷车/热车、直行/转向、什么路面"];
  if (s.worsensWithSpeedOrBraking) out.push("在安全路段以不同车速复现，记下起始车速");
  if (!s.warningLight) out.push("确认仪表无警告灯（有的话优先级立刻提高）");
  out.push("拍一段带声音的视频，或对准部位补拍清晰照片");
  return out;
}

function buildQuestions(s: SymptomSignal): string[] {
  const out = [
    "这个症状你们判断是哪个部件？依据是什么？",
    "更换与维修两种方案的价格与寿命差别？",
    "如果不修，最坏会发展成什么？多久？",
  ];
  if (s.safetyCritical) out.push("在修好之前，这车还能不能开？限速多少？");
  return out;
}

/**
 * 问诊留档（施工单 M14-03，F-20-13）。
 *
 * # 留档是敏感写，必须走权限门
 *
 * 问诊结论写进④档案（`RepairRecord`）后可能被用户拿去和修理厂争议，
 * 所以：经 `vehicle_profile_write`（sensitive）落库、留档前用户确认、
 * 编排层**不得**绕过工具直写仓储——那会同时绕过权限门与审计。
 *
 * # 多模态分析（F-20-03/F-20-06）未落地时的形态
 *
 * 留档输入取对话摘要：症状 = 用户问诊原话，处置摘要 = 助手回答的截断。
 * 风险分级有则标注、无则不编——接口先行，分析补齐后接同一入口。
 */

/** 上一轮问诊的会话内记录（图状态 `consultation` 通道的形状，跨轮存活）。 */
export interface ConsultationState {
  /** 用户描述的症状（问诊原话）。 */
  symptom: string;
  /** 问诊发生的会话（原图经会话附件回看，F-20-13 的引用句柄）。 */
  sessionId: string;
  at: number;
  /** 风险分级；F-20-06 落地前通常为空——**空就不标，不编**。 */
  riskLevel?: RiskLevel;
  /** 助手当轮回答的截断摘要，落库时作为处置参考。 */
  resolutionSummary?: string;
  /** 已留档标记：防止"记一下"连说两次写两条。 */
  archived?: boolean;
}

/** 留档意图门：用户明确要求记录时才走留档路径。 */
const ARCHIVE_RE = /(记录|留档|记下|存档|写进|记到).{0,6}(档案|问诊|维修|历史|记录)|把.{0,10}(问诊|维修|这次).{0,4}(记|存|留)/;

export function archiveIntent(text: string): boolean {
  return ARCHIVE_RE.test(text);
}

export type ConsultationArchivePlan =
  | { kind: "no-profile"; note: string }
  | { kind: "no-consultation"; note: string }
  | {
      kind: "ready";
      /** `vehicle_profile_write` 的入参（op=repair）。 */
      writeArgs: {
        vin: string;
        op: "repair";
        at: number;
        odometerKm: number;
        symptom: string;
        resolution?: string;
        source: string;
        sessionId: string;
      };
      /** 权限门弹窗摘要。 */
      summary: string;
      /** 弹窗逐项披露：批的是什么（与落库的是同一份数据）。 */
      disclosures: string[];
    };

const RISK_LABEL: Record<RiskLevel, string> = { low: "低风险", medium: "中风险", high: "高风险" };

export function buildConsultationArchive(args: {
  profile?: { vin: string; odometerKm: number };
  consultation?: ConsultationState;
}): ConsultationArchivePlan {
  const { profile, consultation } = args;
  if (!consultation || consultation.archived) {
    return {
      kind: "no-consultation",
      note: consultation?.archived
        ? "这次问诊已经留档过了，没有重复写入。"
        : "本会话还没有可留档的问诊内容。先描述一下车辆的症状，我们聊完再记录。",
    };
  }
  if (!profile) {
    // 与 F-23-12 的引导共用"去建档"这一个动作，不另起一段催促。
    return {
      kind: "no-profile",
      note: "还没有车辆档案，问诊记录暂时没有落点。在「档案」页建档后，问诊结论就可以留档并关联到这辆车。",
    };
  }
  const risk = consultation.riskLevel ? `【${RISK_LABEL[consultation.riskLevel]}】` : "";
  const resolution = [risk, consultation.resolutionSummary].filter(Boolean).join(" ") || undefined;
  return {
    kind: "ready",
    writeArgs: {
      vin: profile.vin,
      op: "repair",
      at: consultation.at,
      odometerKm: profile.odometerKm,
      symptom: consultation.symptom,
      resolution,
      source: "问诊",
      sessionId: consultation.sessionId,
    },
    summary: `把本次问诊写入车辆档案：${consultation.symptom.slice(0, 40)}`,
    disclosures: [
      `症状：${consultation.symptom.slice(0, 80)}`,
      ...(consultation.riskLevel ? [`风险分级：${RISK_LABEL[consultation.riskLevel]}`] : []),
      `关联会话：${consultation.sessionId}`,
      `写入目标：车辆 ${profile.vin} 的维修/问诊历史（只追加，不可修改）`,
    ],
  };
}

/**
 * 输出前的自检：**不得出现确定性结论或否定性保证**。
 *
 * 与 `guard/hard-block-rules.ts` 的硬禁是两道：那道拦动作，这道拦措辞。
 * 两道都在，是因为措辞问题不会触发动作层——模型可以一边不调工具、
 * 一边说出"你的刹车没问题"。
 */
export function violatesVerdictBoundary(text: string): string | null {
  if (/(确诊|一定是|肯定是|就是).{0,10}(故障|坏了|损坏)/.test(text)) {
    return "包含确定性维修结论";
  }
  if (/(没问题|没事|安全的?).{0,6}(放心|开吧|上路)|(保证|敢说|绝对).{0,8}(没问题|安全)/.test(text)) {
    return "包含否定性安全保证——它比确诊更危险";
  }
  return null;
}
