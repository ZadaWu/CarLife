/**
 * llm/thinking-policy —— **每一处 LLM 调用的思考档都在这里显式声明**（施工单 M70-01）。
 *
 * # 为什么要有这张表
 *
 * 2026-08-28 直连路径统一到 `deepseek-v4-flash` 之后，narrator / 标题 / 填充语 / 对照探针
 * 四处在代码注释里都写着「钉死非推理模型」，实际却**全在思考**：这个模型不带参数请求时
 * 默认 `thinking: enabled`，而 `@ai-sdk/deepseek` 0.1.17 没有任何关思考的参数。
 * 后果是 narrator 的首 token 从 0.7 s 跳到 5 s 以上、忽长忽短、与 prompt 大小无关
 * （首 token = 推理时长），一周后在一轮复合意图上推理超过 120 s 撞了应答封顶（INC-0126）。
 * 同一份 prompt 重放：默认档 400 token 预算全烧在推理上、正文 0 字；`thinking: disabled` 0.3 s 出正文。
 *
 * 问题的本质不是某一处漏了参数，是「没声明 = 跟模型默认走」。所以：
 *  - 直连侧每个调用点必须从 `DIRECT_CALL_SITES` 取档，`createConfiguredChatStreamer` 的 `thinking` 是**必填**；
 *  - `createDeepSeek` 一律经 `withDeepSeekThinking(level)` 包一层 `fetch`，把档位写进请求体——不依赖 SDK 版本；
 *  - pi 侧沿用 `piThinkingLevelFor`（`-task` / `-intent` 后缀 off，应答会话 high）；
 *  - `test/thinking-policy.test.ts` 扫源码：每处 `createConfiguredChatStreamer(` / `createDeepSeek(` 都带声明。
 *
 * # 判据（架构文档 §5.1）
 *
 * 走思考：输出直接给人、且模型要在多步工具之间做取舍（pi 应答会话 `trip` / `buying`）；评测裁判。
 * 不走：输出被代码解析（`-task` / `-intent` / 标题 / 事实抽取 / 联网搜索）、纯表述已求解的内容
 * （narrator / 填充语 / 对照探针）、探针。中间档 `low`：接口收、pi 目录要 `models.json` 覆盖，
 * 在 `tour-task` 上实测比 off 更糟（推演从正文挪进思考块、token 三倍），只给应答会话做对照实验用。
 */

export type ThinkingLevel = "off" | "low" | "high";

/**
 * 直连侧（AI SDK / 裸 HTTP）调用点的档位。**加调用点先加这里**，测试会按源码扫描核对。
 *
 * | 调用点 | 档 | 理由 |
 * |---|---|---|
 * | `main-direct` | high | 没有 ACP 时直连主链路：有工具、给车主，与 pi 应答会话同档 |
 * | `narrator` | off | 求解已经做完，它只把结果说成人话；存在的全部理由是快 |
 * | `title` | off | 代码取一行当标题 |
 * | `filler` | off | 旁路填充语，几秒一句 |
 * | `dual-probe` | off | 控制台双路对照，与 narrator 同人设 |
 * | `probe` | off | 连通性探针，`maxTokens` 8，思考纯白烧 |
 * | `web-search` | off | DeepSeek Anthropic 兼容端点的联网搜索，输出被代码解析（实测关掉后 `server_tool_use` 照常） |
 * | `judge` | high | 评测裁判要推理；显式写出来，不靠隐式默认 |
 */
export const DIRECT_CALL_SITES = {
  "main-direct": "high",
  narrator: "off",
  title: "off",
  filler: "off",
  "dual-probe": "off",
  probe: "off",
  "web-search": "off",
  judge: "high",
} as const satisfies Record<string, ThinkingLevel>;

export type DirectCallSite = keyof typeof DIRECT_CALL_SITES;

export function thinkingForSite(site: DirectCallSite): ThinkingLevel {
  return DIRECT_CALL_SITES[site];
}

/**
 * pi 侧按会话名单独钉档位的例外表。**只放实测证明"改了会更快且不退化"的会话**——目前为空。
 *
 * 试过一次 `tour-task: "low"`（turn-c0ea193e → turn-8ddc78e7，2026-09-03）：DeepSeek 上 low 没有把推演压短，
 * 只是把它从正文挪进思考块，token 烧了三倍，撤回。正文过长的真因是 tour.md 让模型在正文里做取舍，要修的是提示词。
 */
const PI_OVERRIDES: Readonly<Record<string, ThinkingLevel>> = {};

/** 只表述、不规划的五个应答会话——M70-03 的 low 对照实验只对它们生效（`trip` / `buying` 要做规划，不参与）。 */
export const PI_NARRATING_ANSWER_SESSIONS = ["supervisor", "ownership", "service", "cabin", "test-drive"] as const;

/**
 * pi 会话的档位。
 *
 * `-task` / `-intent` 后缀（产出给代码解析）→ off；其余（应答，车主直接读）→ high。
 * README「思考档位」实测：off 让应答把规划漏进正文、丢台风预警，所以刀只落在后缀会话上。
 * `CARLIFE_PI_ANSWER_THINKING`（off / low / high）只覆盖 `PI_NARRATING_ANSWER_SESSIONS` 五个会话，
 * 缺省不设 = high；这是 M70-03 对照实验的开关，实验没结论前不要在 .env 里钉它。
 */
export function piThinkingLevelFor(agent: string, env: NodeJS.ProcessEnv = process.env): ThinkingLevel {
  const pinned = PI_OVERRIDES[agent];
  if (pinned) return pinned;
  if (/-(task|intent)$/.test(agent)) return "off";
  const experiment = env.CARLIFE_PI_ANSWER_THINKING;
  if (
    (experiment === "off" || experiment === "low" || experiment === "high") &&
    (PI_NARRATING_ANSWER_SESSIONS as readonly string[]).includes(agent)
  ) {
    return experiment;
  }
  return "high";
}

/**
 * DeepSeek `chat/completions` 请求体里表达档位的字段。
 *
 * 2026-09-04 实测：`thinking.type` 是开关；`reasoning_effort: "low"` 接口接受（README「中间档」），
 * high 不传 `reasoning_effort`——与 pi 侧 `high` 档的请求形状一致。
 */
export function deepseekThinkingFields(level: ThinkingLevel): Record<string, unknown> {
  if (level === "off") return { thinking: { type: "disabled" } };
  if (level === "low") return { thinking: { type: "enabled" }, reasoning_effort: "low" };
  return { thinking: { type: "enabled" } };
}

/** Anthropic 兼容端点（`/anthropic/v1/messages`）的同一件事：不带字段时它默认思考，实测关掉后联网搜索照常。 */
export function anthropicThinkingFields(level: ThinkingLevel): Record<string, unknown> {
  return level === "off" ? { thinking: { type: "disabled" } } : { thinking: { type: "enabled" } };
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * 给 AI SDK 的 provider 包一层 `fetch`：凡是发往 `chat/completions` 的 JSON 请求，都把档位字段合进去。
 *
 * 放在 `fetch` 这一层而不是 `providerOptions`，是因为 `@ai-sdk/deepseek` 0.1.17 不透传思考参数，
 * 而升级 SDK 是另一件事（ACR-022 正在动 vendor 层，不在这里叠）。请求体已带同名字段时**以显式声明为准**，
 * 不覆盖——这样将来 SDK 自己会传时不会打架。
 */
export function withDeepSeekThinking(level: ThinkingLevel, base: FetchLike = fetch): FetchLike {
  const fields = deepseekThinkingFields(level);
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (init?.method?.toUpperCase() === "POST" && /\/chat\/completions(\?|$)/.test(url) && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        return base(input, { ...init, body: JSON.stringify({ ...fields, ...body }) });
      } catch {
        /* 不是 JSON 就原样放过——这里只管我们自己拼的请求 */
      }
    }
    return base(input, init);
  };
}
