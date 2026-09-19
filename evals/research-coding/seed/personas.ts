/**
 * 造数素材：把 `内部文档` 的角色映射成"能生成数据的车主原型"（施工单 M82-03）。
 *
 * # 为什么不是 11 个角色各造一批
 *
 * `内部文档` 里只有一部分是车主：P-06 苏未是运营管理员、P-08 罗启明是使用者、
 * P-09 是后台任务、P-10 是系统管理员——**给他们造用车数据等于凭空发明车主**，
 * 而研究面的每一个数字都会把这些虚构的人算进分母。
 *
 * 所以这里按"行为分群"组织，每个群指明它取材自哪个角色（`personaId`）。
 * 分群本身才是研究面的分析单位（镜头四），角色只是让口吻不至于千篇一律。
 *
 * # 角色文件是只读素材
 *
 * 本模块**只读** `内部文档` 的 `profile.profile_card` 与 `summary`，
 * 取不到就用这里写死的缺省——角色文件的字段随建模演进，
 * 造数不该因为某个角色改了一行说明就跑不起来。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 仓库根。本文件在 `evals/research-coding/seed/` 下，往上三层。 */
const ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const PERSONA_DIR = join(ROOT, "docs", "personas");

/** 行为分群 id。**镜头四（分群图谱）按它聚**，改名要同步快照口径。 */
export type SegmentId =
  | "commute-city"
  | "family-shared"
  | "cold-sensitive"
  | "long-haul"
  | "new-owner"
  | "maintenance-outsourced";

/** 造数用的车主原型。一个原型生成 `owners` 个车主，各一台车。 */
export interface SeedSegment {
  id: SegmentId;
  label: string;
  /** 取材自哪个角色（只影响口吻与车型，不影响行为分布）。 */
  personaId: string;
  /** 生成多少个车主。**maintenance-outsourced 刻意是 9**，见下。 */
  owners: number;
  vehicleModel: string;
  energyType: "bev" | "phev" | "fuel";
  /** 语音消息占比。开车时说话多的群更高。 */
  voiceRatio: number;
  /** 每人多少轮对话（闭区间，按种子在区间内取）。 */
  turnsPerOwner: [number, number];
  /** 每车多少趟行程。 */
  tripsPerVehicle: [number, number];
  /** 这个群最常出现的场景，按权重抽。 */
  scenes: Array<{ scene: SceneId; weight: number }>;
  /** 口头禅，掺进话语让不同群的语料不至于一个味道。 */
  phrases: string[];
}

export type SceneId = "commute" | "long-trip" | "charging" | "cabin" | "maintenance";

export const SCENES: readonly SceneId[] = ["commute", "long-trip", "charging", "cabin", "maintenance"];

/**
 * 六个分群，合计 64 车主 / 64 台车。
 *
 * ⚠️ `maintenance-outsourced` **只有 9 台车是刻意的**（工单要求）：
 * 小单元抑制阈值是 10，留一个 9 台的群，抑制态才有真实数据可验——
 * 否则"抑制"这条路径永远只在单测里跑过，而它是权利边界不是显示偏好。
 */
export const SEED_SEGMENTS: readonly SeedSegment[] = [
  {
    id: "commute-city",
    label: "城市通勤型",
    personaId: "P-02",
    owners: 13,
    vehicleModel: "紧凑纯电轿车",
    energyType: "bev",
    // 开车时说话最多的一群：陈书雅的场景就是"在路上，手不能离方向盘"。
    voiceRatio: 0.85,
    turnsPerOwner: [16, 24],
    tripsPerVehicle: [16, 22],
    scenes: [
      { scene: "commute", weight: 6 },
      { scene: "charging", weight: 2 },
      { scene: "cabin", weight: 2 },
      { scene: "maintenance", weight: 1 },
    ],
    phrases: ["我在开车", "你直接说结论", "别念长句子"],
  },
  {
    id: "family-shared",
    label: "家庭共用型",
    personaId: "P-01",
    owners: 12,
    vehicleModel: "纯电中型 SUV",
    energyType: "bev",
    voiceRatio: 0.6,
    turnsPerOwner: [18, 26],
    tripsPerVehicle: [15, 20],
    scenes: [
      { scene: "commute", weight: 3 },
      { scene: "long-trip", weight: 3 },
      { scene: "cabin", weight: 2 },
      { scene: "charging", weight: 2 },
      { scene: "maintenance", weight: 1 },
    ],
    phrases: ["家里人也开", "带着老人小孩", "周末要用车"],
  },
  {
    id: "cold-sensitive",
    label: "低温敏感型",
    personaId: "P-01",
    owners: 11,
    vehicleModel: "纯电中型 SUV",
    energyType: "bev",
    voiceRatio: 0.7,
    turnsPerOwner: [17, 25],
    tripsPerVehicle: [14, 20],
    scenes: [
      { scene: "charging", weight: 4 },
      { scene: "commute", weight: 3 },
      { scene: "long-trip", weight: 2 },
      { scene: "cabin", weight: 1 },
    ],
    phrases: ["天一冷就", "东北这边", "暖风一开"],
  },
  {
    id: "long-haul",
    label: "长途高里程型",
    personaId: "P-04",
    owners: 10,
    vehicleModel: "增程 SUV",
    energyType: "phev",
    voiceRatio: 0.8,
    turnsPerOwner: [18, 26],
    tripsPerVehicle: [14, 19],
    scenes: [
      { scene: "long-trip", weight: 5 },
      { scene: "maintenance", weight: 3 },
      { scene: "charging", weight: 2 },
    ],
    phrases: ["一年跑六万", "跑长途", "别耽误我出车"],
  },
  {
    id: "new-owner",
    label: "首购新手型",
    personaId: "P-03",
    // 10 而不是 9：**只允许 maintenance-outsourced 一个群低于抑制阈值**，
    // 否则"哪一格该被抑制"这条断言就不再能指认到唯一一个群。
    owners: 10,
    vehicleModel: "紧凑纯电 SUV",
    energyType: "bev",
    voiceRatio: 0.5,
    turnsPerOwner: [16, 24],
    tripsPerVehicle: [13, 18],
    scenes: [
      { scene: "cabin", weight: 4 },
      { scene: "commute", weight: 3 },
      { scene: "charging", weight: 2 },
      { scene: "maintenance", weight: 1 },
    ],
    phrases: ["第一次开电车", "这个按钮是干嘛的", "我不太懂"],
  },
  {
    id: "maintenance-outsourced",
    label: "保养托管型",
    personaId: "P-04",
    // 9 < 10：留给小单元抑制的真实样本。**不要"顺手凑够 10"**。
    owners: 9,
    vehicleModel: "燃油中型轿车",
    energyType: "fuel",
    voiceRatio: 0.4,
    turnsPerOwner: [16, 22],
    tripsPerVehicle: [13, 17],
    scenes: [
      { scene: "maintenance", weight: 6 },
      { scene: "commute", weight: 3 },
      { scene: "long-trip", weight: 1 },
    ],
    phrases: ["都交给店里", "到点提醒我就行", "我不想操心"],
  },
];

/** 角色文件里读到的一点点补充信息（读不到就没有，不影响生成）。 */
export interface PersonaBrief {
  id: string;
  name: string;
  summary: string;
  city: string;
}

/**
 * 读 `内部文档`。**失败不抛**——造数不该因为角色文件的字段变动而跑不起来，
 * 那会让"补一条角色说明"变成一次造数事故。
 */
export function loadPersonaBriefs(): Map<string, PersonaBrief> {
  const out = new Map<string, PersonaBrief>();
  let files: string[];
  try {
    files = readdirSync(PERSONA_DIR).filter((n) => /^P-\d{2}.*\.json$/.test(n));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(PERSONA_DIR, f), "utf8")) as {
        id?: string;
        title?: string;
        profile?: { summary?: string; profile_card?: Record<string, string> };
      };
      if (!j.id) continue;
      const card = j.profile?.profile_card ?? {};
      out.set(j.id, {
        id: j.id,
        name: (j.title ?? j.id).split("——")[0].trim(),
        summary: j.profile?.summary ?? "",
        city: (card["城市"] ?? "").split("，")[0] ?? "",
      });
    } catch {
      // 单个角色文件坏了就跳过它，不连累整批。
    }
  }
  return out;
}

/** 六个群合计多少车主——测试与 CLI 都要用，只算一处。 */
export const TOTAL_OWNERS = SEED_SEGMENTS.reduce((n, s) => n + s.owners, 0);
