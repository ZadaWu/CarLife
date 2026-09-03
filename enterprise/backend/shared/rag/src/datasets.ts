/**
 * RAGFlow 数据集定义（施工单 M8-01，§6 知识库划分）。
 *
 * 三个数据集**严格隔离**（AC-24-8）：用车助手检索不到维修知识库的内容。
 * 隔离靠 `dataset_id` 在调用层强制，不靠 prompt 提醒——后者迟早被绕过。
 *
 * # 归属规则：按**消费方**分，不按文档类型分
 *
 * 放错的后果不是"检索质量差一点"，而是**该看到它的 Agent 看不到、
 * 不该看到的反而能看到**——隔离是硬的，放错就等于对某个 Agent 隐藏了资料。
 *
 * 判据是"什么场景下的人会去翻它"：
 *
 *   vehicle-manuals  "这个功能怎么用"          —— 日常用车会翻的那本
 *   repair-kb        "出问题了怎么办 / 该保养了吗" —— 带着症状或周期去查的
 *   car-catalog      "买哪款"                  —— 还没有这辆车时看的
 *
 * 两个容易犹豫的边界，已经定了：
 *  - **保养手册进 repair-kb 不进 vehicle-manuals**。保养是售后的业务面
 *    （周期推算、预约、工单），不是"功能怎么用"。
 *  - **配置参数进 car-catalog 不进 vehicle-manuals**。已经买了车的人
 *    不会去查"这一款有哪些配置可选"。
 */

export type DatasetKey = "vehicle-manuals" | "repair-kb" | "car-catalog";

export interface DatasetDef {
  key: DatasetKey;
  /** RAGFlow 侧的 dataset id，由配置注入（不同环境不同）。 */
  envKey: string;
  name: string;
  /** 消费方——按 §4.3 能力映射，不是谁都能查。 */
  consumers: readonly string[];
  /**
   * 数据来源标注（F-24-11）：真实公开资料还是模拟数据。
   * **`repair-kb` 是模拟的，不冒充真实厂商数据**——罗启明会追问真假。
   */
  provenance: "public" | "simulated";
}

export const DATASETS: readonly DatasetDef[] = [
  {
    key: "vehicle-manuals",
    envKey: "RAGFLOW_DATASET_VEHICLE_MANUALS",
    name: "车辆说明书",
    consumers: ["ownership"],
    provenance: "public",
  },
  {
    key: "repair-kb",
    envKey: "RAGFLOW_DATASET_REPAIR_KB",
    name: "维修与保养手册",
    consumers: ["service"],
    // 装的是厂商的保修及保养手册（真实公开资料），不是编造的维修案例。
    provenance: "public",
  },
  {
    key: "car-catalog",
    envKey: "RAGFLOW_DATASET_CAR_CATALOG",
    name: "车型参数库",
    consumers: ["buying"],
    provenance: "public",
  },
];

export function datasetFor(key: DatasetKey): DatasetDef {
  const d = DATASETS.find((x) => x.key === key);
  if (!d) throw new Error(`未定义的数据集：${key}`);
  return d;
}

/** 某 Agent 能查哪些数据集——**跨集检索在这里就被挡住**，不靠 prompt。 */
export function datasetsForAgent(agent: string): readonly DatasetDef[] {
  return DATASETS.filter((d) => d.consumers.includes(agent));
}
