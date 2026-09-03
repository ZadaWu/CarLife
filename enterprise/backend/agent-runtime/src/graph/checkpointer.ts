/**
 * graph/checkpointer —— ①Working 的持久化（施工单 M4-06，FL-40 F-40-06 / FL-14 F-14-01）。
 *
 * 【§13-3 的实测结论】LangGraph.js 的 PG Checkpointer **可用**，但要选对版本线：
 *  - `@langchain/langgraph-checkpoint-postgres@1.x` 的 peer 是 `@langchain/core@^1.1.44`，
 *    与本仓的 `0.3.x`（跟随 `@langchain/langgraph@0.2.44`）不兼容；
 *  - `0.0.5` 的 peer 是 `@langchain/core >=0.2.31 <0.4.0`，**与我们兼容**，故采用它。
 *
 * 顺带记一笔：整个 LangChain 生态已到 v1，本仓卡在 0.3.x。同一根源也是 `mem0ai`
 * 冲突的来源（FL-21 已知坑）。**升 v1 是一次性解决两处的动作**，
 * 但那是独立的技术债工单，不该塞进本 Sprint。
 *
 * 【为什么这件事要在 M4 做，而不是等 US-40】
 * M5 的 HITL 要求"挂起等多久都不丢"（FL-04 F-04-05 / §8.4）。
 * 那条承诺整个建立在检查点持久化上——等到 M5 才发现它不成熟就来不及了。
 */

import { MemorySaver } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

export type CheckpointerKind = "pg" | "memory";

export function resolveCheckpointerKind(env: NodeJS.ProcessEnv = process.env): CheckpointerKind {
  const raw = (env.CARLIFE_CHECKPOINTER ?? "pg").toLowerCase();
  return raw === "memory" ? "memory" : "pg";
}

export interface CheckpointerHandle {
  kind: CheckpointerKind;
  saver: BaseCheckpointSaver;
  /** 建表等一次性准备；memory 实现为 no-op。 */
  setup(): Promise<void>;
  /** 记录降级原因（PG 不可用时）。**降级必须可见，不能静默变回内存。** */
  degradedReason?: string;
}

/**
 * 建检查点存储。
 *
 * PG 不可用时的取向：**明确降级到内存并大声记录**，不让服务起不来——
 * 对话能力不该因为检查点存储挂了而整体不可用（与 §8.2 input fail-open 同源）。
 * 但降级意味着"重启即丢上下文、挂起的 HITL 会丢"，所以它必须出现在日志与运维面上，
 * 而不是悄悄退回去。
 */
export async function createCheckpointer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CheckpointerHandle> {
  const kind = resolveCheckpointerKind(env);

  if (kind === "memory") {
    return { kind: "memory", saver: new MemorySaver(), setup: async () => {} };
  }

  const url = env.DATABASE_URL;
  if (!url) {
    return {
      kind: "memory",
      saver: new MemorySaver(),
      setup: async () => {},
      degradedReason: "DATABASE_URL 未配置，检查点降级为内存（重启即丢上下文与挂起的 HITL）",
    };
  }

  try {
    const saver = PostgresSaver.fromConnString(url);
    return {
      kind: "pg",
      saver,
      setup: async () => {
        // 幂等建表；重复执行不破坏既有数据（M4-06 约束：迁移可重复执行）。
        await saver.setup();
      },
    };
  } catch (err) {
    return {
      kind: "memory",
      saver: new MemorySaver(),
      setup: async () => {},
      degradedReason: `PG 检查点不可用，降级为内存：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
