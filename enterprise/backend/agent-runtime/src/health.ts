/**
 * 运行时健康视图（施工单 M9-05，FL-42）。
 *
 * # 它要回答的是"现在到底跑在什么形态上"
 *
 * 这套系统有大量**可降级路径**，每一条降级都让能力悄悄变少而系统表现正常：
 *  - 检查点降级为内存 → 重启即丢上下文与挂起的 HITL
 *  - 审核层未接入 → 内容安全实际只有两层
 *  - 工具 mock 模式 → 数据是假的
 *  - ACP 未连接 → 退回直连，多 Agent 编排不存在
 *
 * **把它们集中暴露成一个视图**，是因为分散在日志里没人会去逐条确认。
 * 演示前扫一眼这个接口，比读十屏启动日志可靠。
 */

import { classifyUnmapped } from "./acp-client/update-bridge";

/** 一类记忆的接线状态。`wired` 分读写两端——只有一端通是常态（③曾经就是）。 */
export interface MemoryWiring {
  /** 1~6，与 §7 的编号一致。 */
  id: number;
  key: "working" | "episodic" | "preference" | "vehicle" | "cache" | "usage";
  /** 落点：PG / Mem0 / Redis / 图状态。 */
  store: string;
  /** 写路径是否接线。 */
  write: boolean;
  /** 读路径是否接线。 */
  read: boolean;
}

export interface RuntimeHealth {
  /** 运行形态：acp（目标架构）或 direct（直连，多 Agent 编排不存在）。 */
  agentRuntime: "acp" | "direct";
  /**
   * LLM 是真模型还是离线 Fake。
   *
   * **必须由运行时自己报**：网关进程里也有 `CARLIFE_LLM` 这个变量，
   * 但 LLM 根本不在网关跑——读它得到的是一个看起来合理却与事实无关的值。
   * 演示大屏第一眼看的就是这个字段，读错等于把"这是真实调用"讲错。
   */
  llm: "real" | "fake";
  acp?: {
    connected: boolean;
    restarts: number;
    lastError?: string;
    /**
     * 未映射的 ACP update 类型计数。
     *
     * **原始计数照旧全给**，分类在 `classifyUnmapped`（与映射表同一个文件）：
     * 三桶语义完全不同——明写忽略的、已知欠着的、真正没见过的。
     * 只有第三桶进风险行，见 `riskSummary`。
     */
    unmappedUpdates: Record<string, number>;
    /** 两侧 SDK 版本。**版本偏斜是 M4-01 记录的遗留风险**，需要有人盯。 */
    clientSdkVersion?: string;
    agentVersion?: string;
  };
  checkpointer: {
    kind: "pg" | "memory";
    /** 有值表示**降级中**：重启即丢上下文与挂起的 HITL。 */
    degradedReason?: string;
  };
  guardrails: {
    prefilter: true;
    /** 审核层是否接入。false = 内容安全实际只有两层。 */
    moderation: boolean;
    pii: true;
  };
  /**
   * 六类记忆的接线状态（M11-05）。
   *
   * **每一项都必须由代码事实推导**（对应的 store / client 是否注入），
   * 不是常量。硬编码的"未接入"会随代码演进变成谎话，而没有任何机制会发现它——
   * 走查时 `/memory` 页就写着"Mem0 尚未部署（§13-11 未定案 + LangChain v1 版本冲突）"，
   * 那时 Mem0 早已部署、版本冲突早已解决。**我据此在能力矩阵里写下过错误的判断。**
   */
  memory: MemoryWiring[];
  tools: {
    mode: "real" | "mock" | "off";
    registered: number;
    invocations: number;
    failures: number;
    /** pi 扩展是否确实被加载——M4-02 踩过的无症状故障。 */
    extensionLoaded: boolean;
  };
}

/**
 * 把健康视图压成一行**风险摘要**。
 *
 * 演示前只看这一行：**空字符串才是可以上台的状态**。
 */
export function riskSummary(h: RuntimeHealth): string[] {
  const risks: string[] = [];

  if (h.agentRuntime === "direct") {
    risks.push("运行在 direct 形态——**多 Agent 编排与 ACP 链路不存在**，不能作为架构证据演示");
  }
  if (h.acp && !h.acp.connected) {
    risks.push(`ACP 未连接${h.acp.lastError ? `：${h.acp.lastError}` : ""}`);
  }
  if (h.checkpointer.degradedReason) {
    risks.push(`检查点降级：${h.checkpointer.degradedReason}`);
  }
  if (!h.guardrails.moderation) {
    risks.push("内容审核层未接入——四道防线目前只有三道半（规则筛 + 脱敏 + 权限门）");
  }
  if (h.tools.mode !== "real") {
    risks.push(`工具处于 ${h.tools.mode} 模式——**数据不是真的**，演示前须确认这是有意的`);
  }
  // 只报"两端都没接"的类：只有一端的（如③曾经只能读）不是故障，是进行中的状态，
  // 混进 risks 会让真正的空洞被淹没。
  const dead = (h.memory ?? []).filter((m) => !m.read && !m.write);
  if (dead.length > 0) {
    risks.push(
      `记忆类别未接线：${dead.map((m) => `${m.id}${m.key}`).join("、")}——` +
        `存储在但没有任何读写路径，页面上会显示为空且看不出原因`,
    );
  }
  if (!h.tools.extensionLoaded) {
    risks.push("pi 扩展未加载——模型手里零工具，会转而编造答案且无任何报错");
  }
  /*
   * 未映射的 update **只报"真的没见过"那一桶**。
   *
   * 从前三桶合成一句，于是这一行每次都在喊：
   * 「available_commands_update×10, session_info_update×36, tool_call×25, tool_call_update×50」——
   * 前两类是 `update-bridge.ts` 明写忽略的，后两类是已知欠着的（端上工具进度没有生产方）。
   * 读的人看两次就学会跳过整行，而这一行原本要报的东西——**协议真的演进了**——
   * 就此再也没人看见。风险行的契约是「空数组才是可以上台的状态」，
   * 一条永远清不掉的常驻项会把这个契约作废。
   *
   * 欠着的那桶不丢，走 `knownGaps`：它该被看见，但不该拦着人上台。
   */
  const unmapped = classifyUnmapped(h.acp?.unmappedUpdates ?? {});
  const unexpected = Object.entries(unmapped.unexpected);
  if (unexpected.length > 0) {
    risks.push(
      `出现了没见过的 ACP update 类型：${unexpected.map(([k, v]) => `${k}×${v}`).join("、")}` +
        "——协议可能演进了，acp-client/update-bridge.ts 的映射表该跟",
    );
  }
  return risks;
}

/**
 * 已知的空洞：**看得见，但不拦着上台**。
 *
 * 与 `riskSummary` 分开返回，是因为两者的语义不同：风险要"空了才能上台"，
 * 而这些是排期上欠着的账，永远清不掉。混进风险行的后果不是多一条信息，
 * 是让整行失去"空 = 可以上台"的意义。
 */
export function knownGaps(h: RuntimeHealth): string[] {
  return mergeGaps(classifyUnmapped(h.acp?.unmappedUpdates ?? {}).deferred);
}

/**
 * 按"欠的是什么"合并。
 *
 * 一笔欠账常对应多个 update 类型（`tool_call` 与 `tool_call_update` 是一件事），
 * 分两行列出来会读成两个空洞，而看的人据此判断"还差多少"。
 *
 * **单独导出是为了能被断言**：`DEFERRED_UPDATES` 当前为空（那笔已还清），
 * 不拆出来的话这段合并逻辑就随之失去覆盖，下一笔欠账出现时没人知道它还灵不灵。
 */
export function mergeGaps(
  deferred: Readonly<Record<string, { count: number; owes: string }>>,
): string[] {
  const byOwes = new Map<string, number>();
  for (const v of Object.values(deferred)) byOwes.set(v.owes, (byOwes.get(v.owes) ?? 0) + v.count);
  return [...byOwes.entries()].map(([owes, count]) => `${owes}：本进程已丢弃 ${count} 条 ACP update`);
}
