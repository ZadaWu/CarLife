/**
 * domain/vehicle-catalog — 车型清单与**车型 ↔ 知识库的关联关系**（施工单 M14-08）。
 *
 * # 为什么这份数据在 shared 而不在 UI 包
 *
 * 它原来在 `@carlife/ui`，于是服务端不知道有哪些车型，
 * `ragflow-probe.mts` 只好自己再写一份 `KNOWN_MODELS`——**三份手写清单**
 * （目录 / 探针 / `MODEL_ALIASES`）各自漂各自的。清单是端云共用的契约，
 * 归位到这里之后：向导、网关、探针读同一份。
 *
 * # provenance：清单是手工整理的，关联关系不是
 *
 * brand/model 两列按国内保有量手工整理，用途只有一个——让用户点选而不是
 * 自由录入（"比亚迪宋plus"与"宋 PLUS EV"在检索侧是两个车型）。
 * 它**不代表知识库有这些车的资料**。
 *
 * "有没有资料"由 `@carlife/rag` 的 `coverageOf` 拿**知识库里真实的文档名**
 * 实时算出来（M14-08 之前是代码里一个手写的 `manual: true`，会漂且漂了没信号）。
 * 所以本文件里没有任何覆盖标记——有没有资料不是车型的属性，是**关系**。
 *
 * # `model` 同时是落库值与检索键
 *
 * `Vehicle` 表没有 brand 列，`Vehicle.model` 既是展示名也是
 * `documentMatchesModel` 的输入。所以这里的写法必须与知识库文件名对得上：
 * 存 "特斯拉 Model Y" 会让匹配一篇都命中不了（M14-07 实测过）。
 */

export interface VehicleCatalogEntry {
  brand: string;
  model: string;
}

/** 品牌 → 车型。加车型时只加这里；有没有资料由知识库说了算。 */
export const VEHICLE_CATALOG: readonly VehicleCatalogEntry[] = [
  { brand: "特斯拉", model: "Model 3" },
  { brand: "特斯拉", model: "Model Y" },
  { brand: "特斯拉", model: "Model S" },
  { brand: "特斯拉", model: "Model X" },
  { brand: "特斯拉", model: "Cybertruck" },
  { brand: "雪佛兰", model: "迈锐宝" },
  { brand: "雪佛兰", model: "迈锐宝 XL" },
  { brand: "比亚迪", model: "秦 PLUS DM-i" },
  { brand: "比亚迪", model: "宋 PLUS EV" },
  { brand: "比亚迪", model: "宋 PLUS DM-i" },
  { brand: "比亚迪", model: "汉 EV" },
  { brand: "比亚迪", model: "海豚" },
  { brand: "比亚迪", model: "海豹" },
  { brand: "蔚来", model: "ES6" },
  { brand: "蔚来", model: "ET5" },
  { brand: "小鹏", model: "P7" },
  { brand: "小鹏", model: "G6" },
  { brand: "理想", model: "L7" },
  { brand: "理想", model: "L9" },
  { brand: "五菱", model: "宏光 MINIEV" },
  { brand: "吉利", model: "星越 L" },
  { brand: "吉利", model: "帝豪" },
  { brand: "长安", model: "CS75 PLUS" },
  { brand: "大众", model: "朗逸" },
  { brand: "大众", model: "迈腾" },
  { brand: "丰田", model: "卡罗拉" },
  { brand: "丰田", model: "凯美瑞" },
  { brand: "本田", model: "CR-V" },
  { brand: "本田", model: "雅阁" },
  { brand: "日产", model: "轩逸" },
];

/** 目录里所有车型名——探针与覆盖计算的输入。 */
export function catalogModels(): string[] {
  return VEHICLE_CATALOG.map((e) => e.model);
}

/**
 * 一款车在一个数据集里关联到的文档。
 *
 * 只有**文档名**，没有 chunk 内容——这是"有没有资料"的索引，不是检索结果。
 * 跨数据集列举在这里是安全的：暴露给用户的是"你这辆车有哪些资料"，
 * 而 `datasetsForAgent` 管的是"哪个 Agent 能读到哪些内容"，两回事。
 */
export interface ModelKnowledgeLink {
  /** DatasetKey（`vehicle-manuals` / `repair-kb` / `car-catalog`）。 */
  dataset: string;
  /** 数据集的中文名，直接给用户看。 */
  datasetName: string;
  /** 匹配到的文档名。空数组不会出现——没关联就不生成这条。 */
  documents: string[];
}

/**
 * 覆盖数据的新鲜度。**三态，不是两态**。
 *
 * `unavailable` 与"没有资料"是完全不同的两件事：前者是我们读不到知识库，
 * 后者是知识库里确实没有这一款。端上把前者显示成后者，就是在替知识库
 * 断言一件我们此刻并不知道的事。
 */
export type KnowledgeCoverageState = "live" | "stale" | "unavailable";

export interface VehicleKnowledge {
  /** 按此车型名算出的关联（即 `Vehicle.model`）。 */
  model: string;
  links: ModelKnowledgeLink[];
  state: KnowledgeCoverageState;
  /** 覆盖数据的取得时间；`unavailable` 时缺席。 */
  fetchedAt?: number;
  /** `stale` / `unavailable` 时给出原因，直接可展示。 */
  reason?: string;
}
