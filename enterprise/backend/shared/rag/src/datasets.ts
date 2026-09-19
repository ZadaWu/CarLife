/**
 * RAGFlow 数据集定义（施工单 M8-01，§6 知识库划分）。
 *
 * 四个数据集**严格隔离**（AC-24-8）：用车助手检索不到维修知识库的内容。
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
 *   insurance-kb     "出险了该怎么办 / 这单该不该走保险 / 保单里写了什么"
 *                                             —— 售后与购车两边都会翻（ACR-040）
 *
 * 三个容易犹豫的边界，已经定了：
 *  - **保养手册进 repair-kb 不进 vehicle-manuals**。保养是售后的业务面
 *    （周期推算、预约、工单），不是"功能怎么用"。
 *  - **配置参数进 car-catalog 不进 vehicle-manuals**。已经买了车的人
 *    不会去查"这一款有哪些配置可选"。
 *  - **理赔材料清单进 insurance-kb 不进 repair-kb**。它回答的是
 *    "保险公司要什么"，不是"车怎么修"。insurance-kb 能独立成集不是因为
 *    "保险是另一类文档"，而是消费方与 repair-kb 不同——买车时也要看条款。
 *
 * ⚠️ **`consumers` 是权限清单，不是检索范围**（ACR-042）。它回答"谁**可以**查"，
 * 缺省查哪些由工具层决定——`ragflow_retrieve` 不指定 dataset 时查该 Agent 允许的**全部**集。
 * 数组顺序因此不再有语义：此前"第一项是默认集"的约定让 M96 接进来的 insurance-kb
 * 在线上一条都查不到（`service` 永远落在 repair-kb），那不是配置问题，是"能查"被当成了"会查"。
 *
 * # 作用域：这个集按什么键分区
 *
 * 车型过滤（F-23-07）对四个集一视同仁曾是隐含假设，而它只对按车型分区的集成立。
 * 行业级的示范条款不属于任何一款车，按车型筛必然零匹配——那不是"没资料"，是问错了问题。
 *
 *   per-model  文档按车型分区。带车型检索必须落到这辆车的文档上，零匹配是错误
 *              （抛 NoDocumentsForModelError，**不退回全库**）。
 *   shared     文档对所有车型有效。文件名不含任何目录车型的对所有车可见；
 *              含车型的只对那款车可见（如特斯拉专属的出险注意事项）。零可见不是错误。
 */

export type DatasetKey = "vehicle-manuals" | "repair-kb" | "car-catalog" | "insurance-kb";

export interface DatasetDef {
  key: DatasetKey;
  /** RAGFlow 侧的 dataset id，由配置注入（不同环境不同）。 */
  envKey: string;
  name: string;
  /** 消费方——按 §4.3 能力映射，不是谁都能查。**是权限清单，见文件头**。 */
  consumers: readonly string[];
  /**
   * 这个集按什么键分区（ACR-042）。取值含义见文件头；
   * **新集必须显式声明**——漏了的后果是车型过滤要么该生效不生效、要么不该生效却生效。
   */
  scope: "per-model" | "shared";
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
    scope: "per-model",
    provenance: "public",
  },
  {
    key: "repair-kb",
    envKey: "RAGFLOW_DATASET_REPAIR_KB",
    name: "维修与保养手册",
    consumers: ["service"],
    scope: "per-model",
    // 装的是厂商的保修及保养手册（真实公开资料），不是编造的维修案例。
    provenance: "public",
  },
  {
    key: "car-catalog",
    envKey: "RAGFLOW_DATASET_CAR_CATALOG",
    name: "车型参数库",
    consumers: ["buying"],
    scope: "per-model",
    provenance: "public",
  },
  {
    key: "insurance-kb",
    envKey: "RAGFLOW_DATASET_INSURANCE_KB",
    name: "车险条款与理赔指引",
    // 售后（出险了怎么办）与购车（投保前看条款）两边都翻；两边缺省都会查它（ACR-042）。
    consumers: ["service", "buying"],
    // 中保协示范条款是行业级的，不属于任何一款车——按车型筛必然零匹配，那是范畴错误不是"没资料"。
    scope: "shared",
    // 主干是中保协示范条款与险企公开的理赔指引（真实公开资料）。
    // 若语料工单混入自写的流程整理稿，按"跟着实际内容走"回来复核这一栏。
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

/** `datasetsForAgent` 的 key 投影——工具层与自检脚本要的是 key 列表，不是整份定义。 */
export function datasetKeysForAgent(agent: string): DatasetKey[] {
  return datasetsForAgent(agent).map((d) => d.key);
}

/**
 * 从环境变量取全部数据集 id —— `createRagClient({ datasetIds })` 的唯一正确来源。
 *
 * # 为什么非得有这个函数
 *
 * 在它之前，这张表在仓库里被**手抄了 12 份**（网关、worker、runtime、六个 kb 脚本、
 * 探针、自检、评测各一份），每份都是三到四行 `"key": process.env.RAGFLOW_DATASET_X ?? ""`。
 * 加第四个集 `insurance-kb` 时漏了其中 4 份，而 `envKey` 明明就写在上面那张
 * `DATASETS` 表里——真相源一直在，只是没人从它派生。
 *
 * **漏抄不报错，只让那一个集消失**：网关那份漏了，后台知识库页点开「车险条款与理赔指引」
 * 就是 `加载失败：ragflow_error`（2026-09-16 用户实报）；评测脚本那份漏了，6 道保险题
 * 每题打一行失败就滑过去、命中率照算（TD-56）。两处症状完全不同，根因是同一个。
 *
 * 取不到的键留空串——由 `createRagClient` 在真正用到那个集时报
 * 「未配置 id（<envKey>）」，而不是在启动时把整个客户端拒掉：
 * 少配一个集不该让另外三个也用不了。
 */
export function datasetIdsFromEnv(
  read: (key: string) => string | undefined = (k) => process.env[k],
): Record<DatasetKey, string> {
  const out = {} as Record<DatasetKey, string>;
  for (const d of DATASETS) out[d.key] = read(d.envKey)?.trim() ?? "";
  return out;
}
