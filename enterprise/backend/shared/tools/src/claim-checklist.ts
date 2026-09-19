/**
 * 出险材料与时限清单（施工单 M96-02，ACR-041 第 1 步）。
 *
 * # 材料与时限由代码给，不由模型给
 *
 * 车主出险时最怕的不是流程长，是**事后无法补救**的两条时限：48 小时内报案、未经定损不修。
 * 这类硬约束交给模型"记得说"，迟早有一轮它忘了——所以做成结构化词条，事故类型是封闭枚举，
 * 由模型选（ADR-012：值来自工具 schema，不从原话正则），内容由这里给。
 *
 * 它没有"真实系统"：mock 与 real 同一份数据，不连任何后端，不外发任何信息。
 * 词条内容来自设计定稿附录在线核实的公开资料（provenance: public），
 * 条款原文与出处由 insurance-kb 检索面承担（M96-04），这里只给"要带什么、什么时候之前"。
 */

import { ToolError, defineExternalTool, type ExternalTool } from "./external";

/**
 * 事故类型封闭枚举。后两类是新能源特有——对应中保协新能源专属条款新增的
 * 附加外部电网故障损失险 / 附加自用充电桩损失保险 / 附加自用充电桩责任保险。
 */
export const ACCIDENT_TYPES = ["single_vehicle", "two_party", "injury", "battery_or_fire", "charging_pile"] as const;
export type AccidentType = (typeof ACCIDENT_TYPES)[number];

export const ACCIDENT_TYPE_LABELS: Record<AccidentType, string> = {
  single_vehicle: "单方事故（剐蹭、撞墙撞柱、自己撞的）",
  two_party: "双方或多方事故（有对方车辆）",
  injury: "有人受伤",
  battery_or_fire: "三电（电池 / 电机 / 电控）损坏或自燃",
  charging_pile: "充电桩相关事故（自用桩损坏、充电时损伤）",
};

export interface ClaimChecklist {
  accidentType: AccidentType;
  label: string;
  /** 要准备的材料。 */
  materials: string[];
  /**
   * **先备齐的那 1~3 样**，是 `materials` 的子集（M101-04）。
   *
   * 整份材料清单有 5~8 条，一口气念完会把答复撑到六七百字，车主记不住、
   * 也听不出哪几样是"现在就得去拿"的。所以这里把"现在去拿"和"后面自然会有"
   * 分开：定损单、维修发票都要等保险公司先动作，不属于车主此刻要办的事。
   *
   * 取值必须与 `materials` 里对应项**同一个字符串常量**，不另写一份——
   * 两处各写一遍的后果是改了一处、另一处悄悄说着旧话。
   */
  essentials: string[];
  /** 事后无法补救的时限——每一型都含 48 小时报案与未经定损不修两条。 */
  deadlines: string[];
  /** 会导致拒赔或减赔的动作。 */
  dontDo: string[];
  notes: string[];
  provenance: "public";
}

/** 所有事故类型共有的两条时限——它们事后无法补救，所以每一型都原样带上。 */
const COMMON_DEADLINES: readonly string[] = [
  "48 小时内向保险公司报案：超时且无法提供有效损失证明的，保险公司有权拒赔",
  "未经保险公司定损不要先修车：先修再报，损失金额与事故的关联就说不清了",
];

// 逐项命名是为了 `essentials` 能引用同一个常量而不是照抄一遍字符串。
const M_IDS = "驾驶证、行驶证、身份证（三证原件或清晰照片）";
const M_POLICY = "保单号或电子保单（品牌 App 或保险公司 App 里能找到）";
const M_SCENE_PHOTOS = "事故现场照片：全景（看得出路况与位置）、车辆受损部位特写、车牌与受损部位同框、对方车牌（如有）";
const M_LOSS_SHEET = "定损单（保险公司查勘定损后出具）";
const M_INVOICE = "维修发票与结算清单（修完后向保险公司提交）";

// 后三类事故各自多出来的那几样，同样命名——它们才是各型 essentials 的主角。
const M_ACCIDENT_REPORT = "交警出具的《道路交通事故认定书》";
const M_ACCIDENT_REPORT_OR_QUICK = "交警出具的《道路交通事故认定书》或双方签字的快处协议";
const M_OTHER_PARTY = "对方的驾驶证、行驶证、保单信息与联系方式";
const M_INJURY_RECORDS = "伤者的病历、诊断证明、医疗费发票、用药清单";
const M_EV_REPORT = "品牌授权服务中心出具的三电检测报告（电池 / 电机 / 电控）";
const M_FIRE_REPORT = "自燃事故：消防部门出具的火灾事故认定书";
const M_PILE_OWNERSHIP = "充电桩的购买凭证、安装记录与产权证明（自用桩）";
const M_PILE_PHOTOS = "充电桩损坏部位照片与安装位置全景";

const COMMON_MATERIALS: readonly string[] = [M_IDS, M_POLICY, M_SCENE_PHOTOS, M_LOSS_SHEET, M_INVOICE];

const COMMON_DONT_DO: readonly string[] = [
  "不要先修再报案",
  "不要自行与对方私了后再想走保险——私了协议会让保险公司认为损失已经处理",
  "不要在报案时夸大或改动事故经过：全国车险信息共享，前后不一致会被追溯",
];

const CHECKLISTS: Record<AccidentType, Omit<ClaimChecklist, "accidentType" | "label" | "provenance">> = {
  single_vehicle: {
    materials: [...COMMON_MATERIALS],
    // 单方事故没有第三方要对，现场照片就是定损唯一的依据——车挪走了就再也补不到。
    essentials: [M_SCENE_PHOTOS, M_IDS, M_POLICY],
    deadlines: [...COMMON_DEADLINES],
    dontDo: [...COMMON_DONT_DO, "小额单方剐蹭先看 claim_advisor 的净收益再决定报不报——出险次数会影响次年保费"],
    notes: [
      "单方事故一般不需要交警事故认定书，但停车场、小区内的事故建议保留物业或监控记录",
      "如果现场无法确认损失金额，拍完照片可以把车挪到安全位置再报案",
    ],
  },
  two_party: {
    materials: [...COMMON_MATERIALS, M_ACCIDENT_REPORT_OR_QUICK, M_OTHER_PARTY],
    // 认定书与对方信息都只能在现场或当场拿，人一散就得靠交警补——排在照片前面。
    essentials: [M_ACCIDENT_REPORT_OR_QUICK, M_OTHER_PARTY, M_SCENE_PHOTOS],
    deadlines: [...COMMON_DEADLINES, "双方事故先报警（或走交管快处），事故认定书是理赔的必要材料，越晚越难补"],
    dontDo: [...COMMON_DONT_DO, "不要放弃向全责第三方追偿——放弃追偿权保险公司可以拒赔相应部分", "不要在没有认定书的情况下同意对方口头责任划分"],
    notes: ["自己无责时由对方保险赔，自己的保单不记出险；有责时才动自己的车损险与三者险"],
  },
  injury: {
    materials: [...COMMON_MATERIALS, M_ACCIDENT_REPORT, M_INJURY_RECORDS, "误工、护理、交通等费用的证明（如需赔付）"],
    // 人伤案先立"责任"和"伤情"两件事，其余费用证明都是后面按治疗进度补的。
    essentials: [M_ACCIDENT_REPORT, M_INJURY_RECORDS, M_IDS],
    deadlines: [...COMMON_DEADLINES, "有人受伤立即报警并叫救护车，报案时明确告知有人伤——交强险与三者险的处理流程不同"],
    dontDo: [...COMMON_DONT_DO, "不要自行垫付大额医疗费而不留发票与用途说明", "不要与伤者私下签订赔偿协议后再向保险公司主张"],
    notes: ["人伤案件由交强险先赔、超出部分走第三者责任险；次年保费的交强险因子按有人伤浮动"],
  },
  battery_or_fire: {
    materials: [...COMMON_MATERIALS, M_EV_REPORT, M_FIRE_REPORT, "充电记录或车机上的故障提示截图（如有）"],
    // 三电定责只认授权检测报告；自燃还多一道消防认定书，两样都不是事后能补的。
    essentials: [M_EV_REPORT, M_FIRE_REPORT, M_SCENE_PHOTOS],
    deadlines: [...COMMON_DEADLINES, "自燃或电池异常先撤离到安全距离再报案，等消防与保险查勘人员到场再动车"],
    dontDo: [...COMMON_DONT_DO, "不要在非授权门店拆检三电——拆检记录不被认可会影响定损", "不要自行给起火车辆通电或再次充电"],
    notes: [
      "新能源专属条款下，三电与自燃属车损险承保范围，但要确认保单是新能源专属条款而不是旧版燃油车条款",
      "外部电网故障造成的损失对应附加外部电网故障损失险，保单没有这项附加险时不在赔付范围",
    ],
  },
  charging_pile: {
    materials: [...COMMON_MATERIALS, M_PILE_OWNERSHIP, M_PILE_PHOTOS, "造成第三方损失的，对方的损失证明与联系方式"],
    // 自用桩的附加险是按"这桩是你的"赔的，产权凭证拿不出来后面全卡在这里。
    essentials: [M_PILE_OWNERSHIP, M_PILE_PHOTOS, M_POLICY],
    deadlines: [...COMMON_DEADLINES, "涉及第三方财产或人身损失时同步报警，保留现场"],
    dontDo: [...COMMON_DONT_DO, "不要在报案前自行拆除或更换充电桩"],
    notes: [
      "自用桩本身的损坏对应附加自用充电桩损失保险，桩造成他人损失对应附加自用充电桩责任保险——两项是分开投保的附加险，保单没有就不赔",
      "公共充电桩造成的车辆损伤先找运营方，同时向自己的保险公司报案",
    ],
  },
};

export function claimChecklistFor(accidentType: AccidentType): ClaimChecklist {
  const entry = CHECKLISTS[accidentType];
  return {
    accidentType,
    label: ACCIDENT_TYPE_LABELS[accidentType],
    materials: [...entry.materials],
    essentials: [...entry.essentials],
    deadlines: [...entry.deadlines],
    dontDo: [...entry.dontDo],
    notes: [...entry.notes],
    provenance: "public",
  };
}

export interface ClaimChecklistArgs {
  accidentType: AccidentType;
}

function isAccidentType(v: unknown): v is AccidentType {
  return typeof v === "string" && (ACCIDENT_TYPES as readonly string[]).includes(v);
}

export const claimChecklistTool: ExternalTool<ClaimChecklistArgs, ClaimChecklist> = defineExternalTool({
  name: "claim_checklist",
  provider: "carlife-kb",
  sensitive: false,
  timeoutMs: 1_000,
  retries: 0,
  real: async (args) => {
    if (!isAccidentType(args.accidentType)) {
      throw new ToolError(
        "claim_checklist",
        "invalid",
        `accidentType 必须是 ${ACCIDENT_TYPES.join(" / ")} 之一——不确定就问车主"是自己撞的、有对方车、有人受伤、还是电池充电桩的事"`,
        false,
      );
    }
    return claimChecklistFor(args.accidentType);
  },
  // 没有"真实系统"：mock 与 real 同一份词条。
  mock: (args) => claimChecklistFor(isAccidentType(args.accidentType) ? args.accidentType : "single_vehicle"),
});
