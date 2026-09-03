/**
 * 外部依赖工具的四件套包装器（施工单 M4-03，FL-39 F-39-01~03/12）。
 *
 * 四件 = **超时 / 重试与退避 / Mock 三态 / 数据来源标注**。它们做成包装器而不是约定，
 * 是因为**约定会被绕过**：半年后总会有一半工具忘了加超时。工具作者拿不到"不加超时"的写法。
 *
 * 【Mock 三态不是布尔】（F-39-02）
 *   real  走真实依赖
 *   mock  走内置固定数据，**且结果被标注为模拟**
 *   off   该能力不可用，返回明确的"未接入"——**不是假装成功**
 * 与既有 `CARLIFE_LLM=fake` / `ASR_ENGINE=fake` 同源，不发明第二套开关风格。
 *
 * 【来源标注要能一路带到用户可见处】（F-39-12）
 * 每个返回值都挂 `source: { kind, provider, fetchedAt }`。这是"罗启明会问这个数是真的还是编的"
 * 的唯一答案来源——模型不可能凭空补出这个字段。
 */

export type ToolMode = "real" | "mock" | "off";

export interface ToolSource {
  kind: "real" | "mock";
  provider: string;
  fetchedAt: string;
}

export interface ToolResult<T> {
  data: T;
  source: ToolSource;
}

/** 工具失败的结构化形态：由**调用方**决定降级，底层不自动降级（与 FL-33 F-33-07 同一原则）。 */
export class ToolError extends Error {
  constructor(
    readonly tool: string,
    readonly category: "timeout" | "upstream" | "unconfigured" | "invalid",
    message: string,
    readonly retryable = false,
  ) {
    super(`[${tool}] ${message}`);
    this.name = "ToolError";
  }
}

export interface ExternalToolSpec<TArgs, TData> {
  name: string;
  /**
   * 供应商标识，进 `source.provider`。
   *
   * 允许给函数：**同一个工具可能有多个供应商**（`weather` 配了高德走高德、
   * 没配走 Open-Meteo）。写死成 `"amap|open-meteo"` 这种并列串等于没标注——
   * 罗启明问"这个数哪来的"时，答案必须是确定的一个名字。
   */
  provider: string | (() => string);
  /** 是否敏感动作：`true` 的工具在 execute() 内先过权限门（M5-02 接线；本 Sprint 只是标记）。 */
  sensitive?: boolean;
  timeoutMs?: number;
  /** 仅对幂等只读调用启用；**有副作用的工具默认 0**（M5 的工具会用到，现在就把默认值定对）。 */
  retries?: number;
  /** 真实实现。抛错即失败，包装器负责重试与分类。 */
  real: (args: TArgs, ctx: ToolCallContext) => Promise<TData>;
  /**
   * 固定的模拟数据；`mock` 模式下使用。没有 mock 的工具不能声明支持 mock 模式。
   * `ctx` 是 M66-01 加的第二个参数（既有 mock 一律忽略它）：`map_route` 的 mock 要把候选记进按轮白名单，
   * 而白名单按 (sessionId, turnId) 归轮——没有 ctx 就归不了轮。
   */
  mock?: (args: TArgs, ctx: ToolCallContext) => TData;
}

/** 工具执行上下文：`session_id` 必须一路带到这里（§3、F-07-07）。 */
export interface ToolCallContext {
  sessionId: string;
  turnId?: string;
  agent?: string;
  /** 由装配层注入；缺省 `real`。 */
  mode?: ToolMode;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const RETRY_BASE_MS = 200;
const RETRY_MAX_MS = 2_000;

export interface ExternalTool<TArgs, TData> {
  readonly name: string;
  /** 当前生效的供应商（多供应商工具按调用时的装配状态解析）。 */
  readonly provider: string;
  readonly sensitive: boolean;
  readonly supportsMock: boolean;
  call(args: TArgs, ctx: ToolCallContext): Promise<ToolResult<TData>>;
}

export function defineExternalTool<TArgs, TData>(
  spec: ExternalToolSpec<TArgs, TData>,
): ExternalTool<TArgs, TData> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // 有副作用的工具默认不重试——重试一次预约就是下两次单。
  const retries = spec.retries ?? (spec.sensitive ? 0 : 2);

  const providerNow = (): string =>
    typeof spec.provider === "function" ? spec.provider() : spec.provider;

  return {
    name: spec.name,
    get provider() {
      return providerNow();
    },
    sensitive: spec.sensitive ?? false,
    supportsMock: spec.mock !== undefined,

    async call(args, ctx) {
      const mode: ToolMode = ctx.mode ?? "real";

      if (mode === "off") {
        throw new ToolError(spec.name, "unconfigured", "该能力未接入（mode=off）", false);
      }

      if (mode === "mock") {
        if (!spec.mock) {
          throw new ToolError(spec.name, "unconfigured", "该工具未提供模拟数据，不能以 mock 模式运行", false);
        }
        return {
          data: spec.mock(args, ctx),
          source: { kind: "mock", provider: providerNow(), fetchedAt: new Date().toISOString() },
        };
      }

      let lastErr: unknown;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const data = await withTimeout(spec.real(args, ctx), timeoutMs, spec.name);
          return {
            data,
            source: { kind: "real", provider: providerNow(), fetchedAt: new Date().toISOString() },
          };
        } catch (e) {
          lastErr = e;
          const retryable = e instanceof ToolError ? e.retryable : true;
          if (!retryable || attempt === retries) break;
          await sleep(Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS));
        }
      }

      if (lastErr instanceof ToolError) throw lastErr;
      throw new ToolError(
        spec.name,
        "upstream",
        lastErr instanceof Error ? lastErr.message : String(lastErr),
        true,
      );
    },
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout<T>(p: Promise<T>, ms: number, tool: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new ToolError(tool, "timeout", `超时 ${ms}ms`, true)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
