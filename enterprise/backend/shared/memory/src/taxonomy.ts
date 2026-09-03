/**
 * 六类记忆 taxonomy 与 metadata 约定（架构文档 §7）。
 *
 * 这里只放**恒真的性质**：这一类是什么、按 §7 该存在哪、该怎么衰减。
 *
 * # 这里**没有** `connected`，这是故意的（M11-05）
 *
 * 它曾经有，写着"②③未接入：Mem0 尚未部署（§13-11 未定案 + LangChain v1 版本冲突）"。
 * 后来 Mem0 部署了、版本冲突解决了、④的表和工具都在了，而这行字一个字没变——
 * 运营记忆页照着它渲染，于是这一页整整一段时间在**明确地说假话**。
 * 更糟的是它可信：走查时我据此在能力矩阵里写下了错误的结论。
 *
 * 一份写错的状态说明比没有说明更糟——它让人停止查证。
 *
 * 所以接线状态**只能来自运行时自报**（`/console/memory/overview`），
 * 条数**只能从库里数**。静态文件里不许再存第二份副本：
 * 两份状态必然分叉，而分叉时先被人看见的总是旧的那份。
 */
export type MemoryCategoryId = 1 | 2 | 3 | 4 | 5 | 6;

export interface MemoryCategory {
  id: MemoryCategoryId;
  /** metadata 约定中的 category 值（②③⑥ 写入 Mem0 时使用） */
  key: string;
  name: string;
  /** 存放位置——§7 的分治结论，写错就是架构错误 */
  storage: string;
  decay: string;
  /** 实现位置或负责它的清单编号。**不表示接没接**——那由运行时自报。 */
  owner: string;
  /** 这一类**是什么**、为什么这么存。不含接入状态。 */
  note: string;
}

export const MEMORY_TAXONOMY: readonly MemoryCategory[] = [
  {
    id: 1,
    key: "working",
    name: "Working 短期任务状态",
    storage: "LangGraph 图状态 + pi session",
    decay: "硬过期（会话结束 / 24h）",
    owner: "M2-02 / M3-05 / M4-06",
    note: "跨轮上下文的唯一承载。**M4-06 起已落 PG 检查点**（§13-3 已关闭），跨重启不丢；thread 映射也一并持久化——只落检查点不落映射会出现'状态在库里却读不到'的假成功。",
  },
  {
    id: 2,
    key: "episodic",
    name: "Episodic 情景记忆",
    storage: "Mem0 category=episodic（pgvector 同库）",
    decay: "指数衰减，半衰期 ~30d，硬删 ~180d",
    owner: "FL-21 F-21-01 / M7-03",
    note: "「上次这辆车出过什么事」——带时间的具体事件。**不能用对话历史冒充它**：§7 里两者是两样东西，历史是逐字记录，情景是被抽出来的事件。",
  },
  {
    id: 3,
    key: "preference",
    name: "Preference 偏好记忆",
    storage: "Mem0 category=preference（pgvector 同库）",
    decay: "慢衰减 + 访问强化，半衰期 ~365d，不硬删",
    owner: "FL-21 F-21-01",
    note: "越常用越不容易忘的那一类，所以它慢衰减且访问强化、不硬删。**只收长期倾向**——一次性指令（「这次走高速」）不是偏好。",
  },
  {
    id: 4,
    key: "vehicle",
    name: "Vehicle 车辆档案",
    storage: "PostgreSQL（非 Mem0）",
    decay: "不衰减，仅事件驱动更新",
    owner: "FL-21 F-21-04 / FL-23 / M7-04",
    note: "**刻意不入向量库**：VIN 与保养记录要的是精确匹配，语义近似会检索到别的车——那不是召回差，是答错车。",
  },
  {
    id: 5,
    key: "context_cache",
    name: "Context cache 环境缓存",
    storage: "Redis",
    decay: "TTL 分钟~小时；目的地推荐与景区导览简报按周（2 周）",
    owner: "FL-21 F-21-07",
    note: "严格说非记忆，**不参与 re-rank**——放进 Mem0 的话天气预报会跟着记忆被访问强化，越查越不容易过期。",
  },
  {
    id: 6,
    key: "usage_pattern",
    name: "Usage telemetry 用车数据",
    storage: "流水 → PG/TimescaleDB；聚合摘要 → Mem0 category=usage_pattern",
    decay: "流水永久保留；摘要半衰期 ~180d + 访问强化",
    owner: "FL-21 F-21-05 / FL-22 / M7-02",
    note: "双路检索（§6）里「这辆车的真实数据」那一路，缺它个性化就塌成通用答案。**两段式**：流水入 PG，聚合成画像才进 Mem0。",
  },
];

export function findMemoryCategory(id: MemoryCategoryId): MemoryCategory | undefined {
  return MEMORY_TAXONOMY.find((c) => c.id === id);
}

/**
 * 曾经这里有个 `taxonomyProgress()`，按 `connected` 统计"六类接了几类"。
 * 它随 `connected` 一起删了（M11-05）——**进度不能由静态文件回答**。
 * 要看接了几类，问 `/console/memory/overview`：它数的是运行时真实装配。
 */
