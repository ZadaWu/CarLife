/**
 * CarLife 工具注入扩展（施工单 M4-02）。
 *
 * 【这是 §13-1 的落地形态】pi 从**本目录**发现扩展——由 ACP `session/new` 的 `cwd`
 * 指向 `enterprise/backend/pi-agents/` 决定（实测结论见 architecture §13-1）。
 *
 * 【本文件是薄代理，不是工具实现】
 * 工具实现在 `enterprise/backend/shared/tools`（§10 要点 7：独立于 Agent、可单测、可另行包装为 MCP）。
 * 这里只做两件事：把工具**注册进 pi 的工具表**，以及把调用**转发回 agent-runtime**。
 *
 * 为什么转发而不是就地执行：pi 扩展的 `ctx.sessionManager.getSessionId()` 是 pi 自己的
 * 会话标识，拿不到 CarLife 的 `session_id`；而 F-07-07 要求工具调用日志与 §8.4 的权限门
 * 都必须带它。把 execute 放回 agent-runtime，`session_id` 天然在手，且 M5 的
 * `POST /internal/guard/check` 变成进程内调用。详见 `enterprise/backend/agent-runtime/src/tools-endpoint.ts`。
 *
 * 【本目录不含协议代码】（§10 要点 1 / AC-12-3）——这里没有一行 ACP 实现，
 * 只有 pi 的扩展 API 调用与一次 HTTP 转发。
 */

const RUNTIME_URL = process.env.AGENT_RUNTIME_URL ?? "http://localhost:8788";
/** 本进程服务哪个 Agent；由 agent-runtime 在 spawn pi-acp 时注入。 */
const AGENT = process.env.CARLIFE_PI_AGENT ?? "supervisor";
/** Mock 三态由装配层决定，pi 侧不自己选（FL-39 F-39-02）。 */
const TOOL_MODE = process.env.CARLIFE_TOOLS ?? "real";

interface PiToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  sensitive: boolean;
  /** 一行简介，进系统提示词 Available tools 节——pi 的规则是不传就不进（M23-03）。 */
  promptSnippet?: string;
  /** 工具纪律 bullets，进 Guidelines 节；每条以 `tool_name` 开头（registry 侧测试守格式）。 */
  promptGuidelines?: string[];
}

type ExtensionApi = {
  registerTool(def: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    promptSnippet?: string;
    promptGuidelines?: string[];
    execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal,
      onUpdate: unknown,
      ctx: { sessionManager?: { getSessionId?(): string | undefined } },
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
  }): void;
};

export default async function carlifeTools(pi: ExtensionApi): Promise<void> {
  // 工具表按 Agent 裁剪（§4.3 能力映射）——不是所有 Agent 都拿到全部工具。
  const res = await fetch(`${RUNTIME_URL}/internal/tools/describe?agent=${encodeURIComponent(AGENT)}`);
  if (!res.ok) {
    // 起不来就明说：静默零工具会让"模型为什么不调工具"变成一桩悬案。
    throw new Error(`[carlife-tools] 无法从 agent-runtime 取工具表：HTTP ${res.status}`);
  }
  const { tools } = (await res.json()) as { tools: PiToolDescriptor[] };

  // 一行注册回执（M23-01）：`--tools` 允许清单与本表同源（listForAgent），理论上不会错配；
  // 但 pi 对未知名是静默忽略，万一错配的症状是"某工具无声消失"——这行日志是对数的依据。
  console.error(`[carlife-tools] agent=${AGENT} 注册 ${tools.length} 个工具: ${tools.map((t) => t.name).join(",")}`);

  for (const t of tools) {
    pi.registerTool({
      name: t.name,
      label: t.name,
      description: t.description,
      parameters: t.parameters,
      // 提示词元数据原样透传（M23-03）：纪律跟着工具走，不再散在各 Agent 的 prompt 里。
      ...(t.promptSnippet ? { promptSnippet: t.promptSnippet } : {}),
      ...(t.promptGuidelines?.length ? { promptGuidelines: t.promptGuidelines } : {}),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const piSessionId = ctx?.sessionManager?.getSessionId?.() ?? "unknown";
        const r = await fetch(`${RUNTIME_URL}/internal/tools/invoke`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: t.name, args: params, agent: AGENT, piSessionId, mode: TOOL_MODE }),
          signal,
        });
        const body = (await r.json()) as { ok: boolean; result?: unknown; error?: string };
        if (!body.ok) {
          // 失败要让模型看得见，它才能选择改参数重试或换路——不是静默返回空。
          return { content: [{ type: "text", text: `工具执行失败：${body.error ?? "unknown"}` }] };
        }
        // 结果里含 source 标注（真实/模拟），模型据此决定是否声明数据来源（F-39-12）。
        return { content: [{ type: "text", text: JSON.stringify(body.result) }], details: body.result };
      },
    });
  }
}
