/**
 * acp-client/connection —— ACP Client：连接 pi-acp 子进程，管理会话与 session/prompt（施工单 M4-01）。
 *
 * 【形态】`agent-runtime` 是 **ACP Client**（`@agentclientprotocol/sdk` 的 `ClientSideConnection`），
 * 由开源 `pi-acp` 扮演 **ACP Agent**（它自己再 spawn `pi`）。两者是**两个物理进程**，
 * 只通过 ACP 消息通信（§4.1、§0 已澄清 2）——本目录之外不得 import pi/ACP SDK（F-12-10，CI 守）。
 *
 * 【§13-1 已关闭，实测结论（M4-01 spike）】
 *  - 包名：`@agentclientprotocol/sdk`（Client）/ `pi-acp`（Agent，svkozak）/ `@earendil-works/pi-coding-agent`（pi 本体）。
 *  - **工具注入机制 = `.pi/extensions/` 目录发现**，由 `session/new` 的 `cwd` 决定加载哪个项目的配置。
 *    MCP 路径不可行：pi 不支持 mcpServers，pi-acp 只是"接受并存储"（其源码原话）。
 *  - 版本偏斜：pi-acp 依赖 SDK `^0.26.0`，而 SDK 已到 1.3.0。**Client 侧对齐 `~0.26.0`**，
 *    协商结果 protocolVersion=1。升级 SDK 必须与 pi-acp 同步，否则协商可能失败。
 *
 * 【一个会话 = 一个 (carlifeSessionId, agent) 对】——Supervisor 与 5 个子 Agent 各自独立会话
 * （F-12-05 / AC-12-7：不是同一次 LLM 调用里扮演六个角色）。
 *
 * 【上下文归属】①Working = "LangGraph 图状态 + pi session"（§7①）。pi 会话**自己保存历史**，
 * 因此每轮只发**本轮的用户输入**（末尾那串连续 user 消息，见 `currentUserText`），
 * 不回灌全量历史——回灌会让上下文翻倍。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

import type { ChatStreamer, ChatStreamHooks, ChatTurnMessage } from "../llm";
import { CancelledError } from "../trace";
import { recordPrompt, recordSpan, span } from "../trace/span";
import {
  isPiAcpUpdateNotice,
  projectUpdate,
  type UpdateSink,
} from "./update-bridge";
import { listForAgent, type AgentName as ToolAgentName } from "@carlife/tools";

import { loadAgentPrompt, canonicalAgent } from "./agent-prompt";
import { splitThinkBursts, type ThoughtTick } from "./think";

const HERE = dirname(fileURLToPath(import.meta.url));
/** pi 的项目级配置目录；session/new 的 cwd 指向它，pi 据此发现 .pi/（§13-1 结论）。 */
const PI_AGENTS_DIR = resolve(HERE, "../../../pi-agents");

const CONNECT_TIMEOUT_MS = 30_000;
const PROMPT_TIMEOUT_MS = 120_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;

export type AgentName =
  | "supervisor"
  | "buying"
  | "ownership"
  | "trip"
  | "cabin"
  | "service"
  // 试驾预约（M19-03，第六个业务 Agent）。**名字不能以 `-task`/`-intent`/`-voice` 结尾**——
  // `canonicalAgent` 会剥掉那些后缀，`loadAgentPrompt` 就去找错文件了，
  // 而外部症状只是"分支失败"（`trip-task.md` 那次踩过）。`test-drive` 安全。
  | "test-drive"
  // 多天行程 fan-out 的四个专家（M12-02）：只以 `-task` 会话被编排层驱动（思考档
  // 随后缀落 off），**没有直达路由**——route.ts 的目标里没有它们，answer 也不发给它们。
  | "drive"
  | "hotel"
  | "tour"
  | "transit"
  // 景区导游采集三分支（M36-01）：同上，仅以 `-task` 会话被 runGuideFanout 驱动，
  // 触发方式是点击景点（HTTP），不经聊天路由。与 registry.ts 的第二份必须同步。
  | "guide-access"
  | "guide-spots"
  | "guide-comfort"
  // 出发导航规划（M66-01）：仅以 `nav-task` 会话被 runNavPlanFanout 驱动，触发方式是点「开始行程」（HTTP），
  // 不经聊天路由。与 registry.ts 的第二份必须同步。
  | "nav";

export interface AcpClientOptions {
  /** 覆盖 pi 的项目级配置目录（测试用）。 */
  piAgentsDir?: string;
  /** 注入给子进程的环境变量（模型凭证等由父进程注入，pi 子进程不自己读配置 DB）。 */
  env?: Record<string, string | undefined>;
  /** 本连接服务哪个 Agent——决定 pi 扩展加载哪张工具表（§4.3 能力映射裁剪）。 */
  agent?: AgentName;
  /** Mock 三态（FL-39 F-39-02）；由装配层决定，pi 侧不自己选。 */
  toolMode?: "real" | "mock" | "off";
  /**
   * 思考档位。**按进程固定**——pi 的 `--model <id>:<level>` 在启动时就定死了，
   * 改不了单次调用。所以池按 (Agent, 档位) 分进程，见 `pool.ts` 的 `processKey`。
   * 省略时用 `.pi/settings.json` 里的 `defaultThinkingLevel`。
   */
  thinkingLevel?: "off" | "high";
}

interface SessionEntry {
  acpSessionId: string;
  agent: AgentName;
}

/** 未映射的 update 类型计数——不抛错、只计数上报（与 FL-01 F-01-08 适配器同一原则）。 */
export interface AcpHealth {
  connected: boolean;
  restarts: number;
  unmappedUpdates: Record<string, number>;
  lastError?: string;
}

export class AcpClient {
  private child?: ChildProcessWithoutNullStreams;
  private conn?: ClientSideConnection;
  private connecting?: Promise<void>;
  private sessions = new Map<string, SessionEntry>();
  /** ACP 会话 id → CarLife 会话与 Agent（`sessions` 的反向索引，见 `resolveSession`）。 */
  private byAcpSession = new Map<string, { carlifeSessionId: string; agent: AgentName }>();
  /** 当前活跃的 update 消费者，按 ACP sessionId 索引。 */
  private sinks = new Map<string, UpdateSink>();
  private health: AcpHealth = { connected: false, restarts: 0, unmappedUpdates: {} };
  private disposed = false;

  constructor(private opts: AcpClientOptions = {}) {}

  getHealth(): AcpHealth {
    return { ...this.health, unmappedUpdates: { ...this.health.unmappedUpdates } };
  }

  private get agentsDir(): string {
    return this.opts.piAgentsDir ?? PI_AGENTS_DIR;
  }

  /**
   * 建立（或复用）到 pi-acp 的连接。并发调用合并为一次。
   *
   * 冷启动那一次会 spawn 两级子进程（pi-acp → pi），是**整条链路上最容易被漏掉的一跳**：
   * 它只在第一次（或重连后）出现，稳态跑十次都量不到它（TD-08 任务 3）。
   */
  private async ensureConnected(): Promise<void> {
    if (this.conn && this.health.connected) return;
    if (this.connecting) return this.connecting;

    // threadId 传 undefined：连接建立发生在任何一轮之外，本来就不属于某一轮。
    // 落库时会带 keyFallback，页面按"会话外事件"呈现。
    this.connecting = span(undefined, "acp.connect", () => this.connect(), {
      agent: this.opts.agent ?? "supervisor",
    }).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const agentsDir = this.agentsDir;
    const localBin = resolve(agentsDir, "node_modules/.bin");
    const adapterBin = resolve(agentsDir, "bin");
    const piAcpCommand = resolve(
      localBin,
      process.platform === "win32" ? "pi-acp.cmd" : "pi-acp",
    );
    const piCommand = resolve(agentsDir, "bin/pi-approved.sh");
    if (!existsSync(piAcpCommand)) {
      throw new Error(
        `仓库内 pi-acp 不存在：${piAcpCommand}；请先运行 corepack pnpm install`,
      );
    }
    if (!existsSync(piCommand)) {
      throw new Error(
        `仓库内 pi 启动包装不存在：${piCommand}；请先运行 corepack pnpm install`,
      );
    }

    const child = spawn(piAcpCommand, [], {
      cwd: agentsDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...this.opts.env,
        // pi-acp 与 pi 的 bin 在 enterprise/backend/pi-agents 的本地 node_modules；
        // pi-acp 0.0.33 会绕过 PI_ACP_PI_COMMAND 执行裸 `pi --version` + `npm view`。
        // 把项目 shim 放在最前面，让该旁路拿不到版本；真正会话仍走下面的绝对
        // PI_ACP_PI_COMMAND。localBin 仍保留给其它本地工具。
        PATH: `${adapterBin}:${localBin}:${process.env.PATH ?? ""}`,
        // 两层启动都固定为离线：Pi 本体尊重这两个变量，适配器的裸版本探针由
        // adapterBin/pi 截断。模型 API 请求不属于启动检查，不受此项影响。
        PI_SKIP_VERSION_CHECK: "1",
        PI_OFFLINE: "1",
        // 给 .pi/extensions/carlife-tools.ts 的三个入参（M4-02）：
        // 工具表回调地址、本进程服务哪个 Agent、Mock 三态。
        // **子进程不自己读配置 DB**——否则系统里会出现第三份配置缓存，
        // M3-02 的热生效语义当场失效（M4-00 决策 5）。
        AGENT_RUNTIME_URL: process.env.AGENT_RUNTIME_URL ?? `http://localhost:${process.env.AGENT_RUNTIME_PORT ?? 8788}`,
        CARLIFE_PI_AGENT: this.opts.agent ?? "supervisor",
        CARLIFE_TOOLS: this.opts.toolMode ?? process.env.CARLIFE_TOOLS ?? "real",
        // pi 在 `--mode rpc` 下不弹项目信任提示，默认**静默忽略** .pi/extensions/
        // ——工具一个都不会注册，且没有任何报错（M4-02 实测踩到）。
        // 包装脚本给 pi 加 --approve，作用域仅限本仓库的 pi-agents 目录。
        // 固定到仓库内 wrapper，不读取宿主机同名环境变量；个人全局 pi 不在业务链路内。
        PI_ACP_PI_COMMAND: piCommand,
        // 思考档位按进程定（pi 的 `--model <id>:<level>` 是启动参数，不是每次调用的参数）。
        // 走自定义变量而不是往 PI_ACP_PI_COMMAND 里拼参数——后者的解析规则是
        // pi-acp 的内部约定，拼错了只会在运行时静默变成另一种行为。
        // 包装脚本 bin/pi-approved.sh 认这个变量；拼不出来时为空，行为与加这特性前一致。
        CARLIFE_PI_MODEL: modelSpecFor(agentsDir, this.opts.thinkingLevel) ?? "",
        // 工具允许清单（M23-01）：pi 侧自己兜一道 §4.3 的 ACL，与 describe/invoke 同源。
        // 包装脚本据此加 `--tools`；空串时它只加 `--no-builtin-tools`——
        // `--tools ""` 的语义是"允许零个工具"，一旦清单意外为空，症状是整个 Agent 哑掉。
        CARLIFE_PI_TOOLS: toolListFor(this.opts.agent ?? "supervisor"),
        // 业务 prompt 走真正的系统提示词（M23-02）。此前它前置在新会话第一条 user 消息里
        // ——那是 pi 早期没有 system prompt 入口时的权宜；0.84.1 有 `--append-system-prompt`
        // （2026-08-25 实测：一次性与 rpc 模式都生效，特殊字符逐字透传）。
        // 为什么是 CLI 参数而不是 `.pi/APPEND_SYSTEM.md`：十个 Agent 共用同一个 cwd，
        // 按文件注入区分不了 Agent，参数是唯一能按进程差异化的通道。
        // `loadAgentPrompt` 读不到就抛——比原来（首轮 prompt 时才炸）更早，绝不静默降级。
        CARLIFE_PI_APPEND_PROMPT: loadAgentPrompt(this.opts.agent ?? "supervisor"),
      },
    });

    child.on("error", (err) => this.onChildDown(`spawn 失败: ${err.message}`));
    child.on("exit", (code, signal) => {
      if (!this.disposed) this.onChildDown(`子进程退出 code=${code} signal=${signal}`);
    });
    // pi-acp 的诊断走 stderr；保留可见是排查"pi 未安装/未登录"的唯一线索。
    child.stderr.on("data", (b: Buffer) => process.stderr.write(`[pi-acp] ${b}`));

    const input = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((res) => {
          if (child.stdin.destroyed) return res();
          child.stdin.write(chunk, () => res());
        });
      },
    });
    const output = new ReadableStream<Uint8Array>({
      start(controller) {
        child.stdout.on("data", (c: Buffer) => controller.enqueue(new Uint8Array(c)));
        child.stdout.on("end", () => {
          try {
            controller.close();
          } catch {
            /* 已关闭 */
          }
        });
        child.stdout.on("error", (e) => controller.error(e));
      },
    });

    const conn = new ClientSideConnection(
      () => ({
        // pi-acp 不实现 session/request_permission（§0 已澄清 3）。真正的权限门是敏感工具
        // execute() 内的一次内部 HTTP（§8.4，M5-02）——与 ACP 协议无关。
        requestPermission: async () => {
          throw new Error("pi-acp 不应发起 session/request_permission；权限门走内部 HTTP（§8.4）");
        },
        sessionUpdate: async (params: unknown) => {
          this.dispatchUpdate(params);
        },
        writeTextFile: async () => {
          throw new Error("ACP writeTextFile 未启用");
        },
        readTextFile: async () => {
          throw new Error("ACP readTextFile 未启用");
        },
      }),
      ndJsonStream(input, output),
    );

    await withTimeout(
      conn.initialize({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      } as never),
      CONNECT_TIMEOUT_MS,
      "ACP initialize",
    );

    this.child = child;
    this.conn = conn;
    this.health.connected = true;
    this.health.lastError = undefined;
  }

  /** 子进程掉线：清空会话映射，等待下次请求时重建（不主动重启，避免崩溃风暴）。 */
  private onChildDown(reason: string) {
    this.health.connected = false;
    this.health.lastError = reason;
    this.health.restarts += 1;
    this.conn = undefined;
    this.child = undefined;
    // 会话属于已死的进程，全部作废——重连后按需重建。
    this.sessions.clear();
    this.byAcpSession.clear();
    for (const sink of this.sinks.values()) sink.fail(new Error(`ACP 连接中断：${reason}`));
    this.sinks.clear();
  }

  private dispatchUpdate(params: unknown) {
    const p = params as { sessionId?: string; update?: Record<string, unknown> };
    const sink = p.sessionId ? this.sinks.get(p.sessionId) : undefined;
    const projected = projectUpdate(p.update);

    // pi-acp 0.0.33 即使 quietStartup=true 也会把版本提示作为普通 delta
    // 发出来。它不是模型回答，不能进入车主会话；shim 负责阻止检查，
    // 这里再做协议边界兜底，兼容旧进程或未来适配器改变探针路径的情况。
    if (projected.kind === "delta" && isPiAcpUpdateNotice(projected.text)) return;

    if (projected.kind === "unmapped") {
      const key = projected.rawKind;
      this.health.unmappedUpdates[key] = (this.health.unmappedUpdates[key] ?? 0) + 1;
      return;
    }
    sink?.push(projected);
  }

  /**
   * 取（或建）某个 CarLife 会话下某个 Agent 的独立 ACP 会话。
   *
   * 返回 `fresh=true` 表示这是新建的会话——调用方必须补一次历史回灌，
   * 否则子进程重建后 pi 侧上下文为空（见 `prompt` 的说明）。
   */
  private async sessionFor(
    carlifeSessionId: string,
    agent: AgentName,
  ): Promise<{ acpSessionId: string; fresh: boolean }> {
    const key = `${carlifeSessionId}::${agent}`;
    const existing = this.sessions.get(key);
    if (existing) return { acpSessionId: existing.acpSessionId, fresh: false };

    // 每个 (会话 × Agent) 首次用到时各建一次；六个 Agent 就是六次，
    // 都串在用户等待里，所以必须能分开看见（TD-08 任务 3）。
    const res = (await span(
      carlifeSessionId,
      "acp.session_new",
      () =>
        withTimeout(
          this.conn!.newSession({ cwd: this.agentsDir, mcpServers: [] } as never),
          CONNECT_TIMEOUT_MS,
          "ACP session/new",
        ),
      { agent },
    )) as { sessionId: string };

    this.sessions.set(key, { acpSessionId: res.sessionId, agent });
    // 反解索引：工具调用从 pi 侧回传时只带得到 ACP 会话 id，
    // 而 F-07-07 要求工具日志与权限门都带 CarLife 的 session_id。
    // 没有这张表，权限门的 interrupt 就找不到该挂起哪一路 SSE——HITL 结构上不可能工作。
    this.byAcpSession.set(res.sessionId, { carlifeSessionId, agent });
    return { acpSessionId: res.sessionId, fresh: true };
  }

  /** pi 会话 id → CarLife 会话与 Agent。解析不出返回 undefined，由调用方决定怎么说。 */
  resolveSession(acpSessionId: string): { carlifeSessionId: string; agent: AgentName } | undefined {
    return this.byAcpSession.get(acpSessionId);
  }

  /**
   * 发一轮 prompt，产出文本增量流。
   *
   * 【上下文的两半，以及为什么要回灌】§7① 把 ①Working 定义为"LangGraph 图状态 + pi session"。
   * 稳态下两者并存，每轮只发**本轮用户输入**即可（pi 会话自己保存历史，回灌会让上下文翻倍）。
   * 但 pi-acp 子进程崩溃/重启后，**pi session 那一半随进程消失，图状态那一半还在**——
   * 此时若仍只发最新一句，用户会看到"我没有之前对话的上下文"（M4-01 冒烟实测到过）。
   * 因此：**新建会话时用图状态回灌一次历史**。图状态是权威源，pi session 是它的副本。
   */
  async *prompt(args: {
    carlifeSessionId: string;
    agent: AgentName;
    /** 图状态里的完整消息序列（权威源）。 */
    messages: ChatTurnMessage[];
    /** 调用方放弃时的取消信号（TD-08 / F-14-04）；见下面 abort 处的说明。 */
    signal?: AbortSignal;
  }): AsyncGenerator<string> {
    await this.ensureConnectedWithBackoff();
    const { acpSessionId, fresh } = await this.sessionFor(args.carlifeSessionId, args.agent);
    // 业务 prompt 不再前置到第一条消息——它已经在系统提示词里（M23-02，`connect()` 的
    // `CARLIFE_PI_APPEND_PROMPT`）。这里只剩回灌语义：新会话用图状态回灌一次历史。
    const primed = fresh ? primeWithHistory(args.messages) : currentUserText(args.messages);
    const text = primed;
    if (!text) return;

    // 记的是**这一行真正发出去的 text**，不是入参 messages（TD-08）：
    // 新会话回灌历史、前置业务 prompt、稳态只取最后一条——三种形态差别很大，
    // 而"模型为什么说这句"只能从实际发出的那段里看出来。
    recordPrompt(args.carlifeSessionId, args.agent, text);

    const sink = createSink();
    this.sinks.set(acpSessionId, sink);

    const done = withTimeout(
      this.conn!.prompt({
        sessionId: acpSessionId,
        prompt: [{ type: "text", text }],
      } as never),
      PROMPT_TIMEOUT_MS,
      "ACP session/prompt",
    )
      .then(() => sink.end())
      .catch((e) => sink.fail(e instanceof Error ? e : new Error(String(e))));

    /*
     * 思考片：**内容仍然不下发**（FL-03 F-03-04 归后续），但**时长必须记**（TD-08）。
     *
     * pi 跑的是推理模型，一次应答里两段思考合计 22 秒、占全轮 80%，
     * 而此前这里一行 `只丢弃` 让它在轨迹上成了两段没人认领的空白。
     * 展示思考内容是产品决策，记录它花了多久不是。
     */
    const ticks: ThoughtTick[] = [];

    /*
     * 取消下传（TD-08 / F-14-04）。**两件事都要做，缺一不可**：
     *
     *  1. 发 `session/cancel` —— 让 pi 那边真的停下来。不发的话，
     *     编排层不等了，pi 还在烧 token，直到 `PROMPT_TIMEOUT_MS` 才收。
     *     实测过一次 60 秒的僵尸调用（分支 60s 判超时 → 底层跑到 120s）。
     *  2. `sink.fail` 立刻结束本地这条流 —— **流静默时这条才是关键**：
     *     光发 cancel、等 pi 的最后一条更新，遇上 pi 已经不说话的情况就还是干等。
     *
     * 协议允许 Agent 在 cancel 后再发几条收尾更新（见 SDK acp.d.ts 的说明），
     * 我们不等它们：调用方已经放弃这次结果了，收尾内容没有消费者。
     */
    const onAbort = (): void => {
      void this.conn?.cancel({ sessionId: acpSessionId } as never).catch(() => {
        // 取消发不出去不该再抛一次错——调用方本来就在放弃这条路径。
      });
      sink.fail(new CancelledError(`本轮已取消（${args.agent}）`));
    };
    if (args.signal?.aborted) onAbort();
    else args.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      for await (const chunk of sink.stream()) {
        if (chunk.kind === "delta") {
          yield chunk.text;
        } else {
          // 只留到达时刻与字数，**一个字都不留**（AC-44-10）。
          ticks.push({ at: Date.now(), chars: chunk.text.length });
        }
      }
      await done;
    } finally {
      this.sinks.delete(acpSessionId);
      args.signal?.removeEventListener("abort", onAbort);
      // 放在 finally：超时、取消与失败的那几段思考同样烧了时间，也同样要能看见。
      for (const b of splitThinkBursts(ticks)) {
        recordSpan(args.carlifeSessionId, `think.${args.agent}`, b.startedAt, b.endedAt, "ok", {
          agent: args.agent,
          detail: `${b.chunks} 片 · ${b.chars} 字`,
        });
      }
    }
  }

  private async ensureConnectedWithBackoff(): Promise<void> {
    let delay = BACKOFF_BASE_MS;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await this.ensureConnected();
        return;
      } catch (e) {
        lastErr = e;
        this.health.lastError = e instanceof Error ? e.message : String(e);
        await sleep(delay);
        delay = Math.min(delay * 2, BACKOFF_MAX_MS);
      }
    }
    throw new Error(
      `ACP 连接不可用（已重试 4 次）：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }

  /**
   * 启动自检（F-42-12）：pi 子进程能起来 **且扩展确实被加载**。
   *
   * 后半句是重点——pi 对未信任项目会**静默忽略** `.pi/extensions/`：
   * 不报错、不告警，只是模型手里一个工具都没有，转而编造答案。
   * 这种故障没有任何症状，只能靠"预期没兑现"来发现（M4-02 实测踩过）。
   *
   * 判据：建一个探针会话后，pi 扩展应当已回调过 `/internal/tools/describe`。
   */
  async selfCheck(expectDescribeCalls: () => number): Promise<{ ok: boolean; detail: string }> {
    const before = expectDescribeCalls();
    try {
      await this.ensureConnectedWithBackoff();
      await this.sessionFor("__selfcheck__", this.opts.agent ?? "supervisor");
    } catch (e) {
      return { ok: false, detail: `ACP 连接或会话创建失败：${e instanceof Error ? e.message : String(e)}` };
    }
    const after = expectDescribeCalls();
    if (after <= before) {
      return {
        ok: false,
        detail:
          "pi 扩展未加载：工具表回调未发生。最常见原因是 pi 未信任项目目录——" +
          "确认仓库内 pi 已安装，并检查 enterprise/backend/pi-agents/.pi/ 是否可读（启动入口已固定为本地 wrapper）",
      };
    }
    return { ok: true, detail: `扩展已加载（describe 回调 ${before}→${after}）` };
  }

  dispose() {
    this.disposed = true;
    this.child?.kill();
    this.child = undefined;
    this.conn = undefined;
    this.health.connected = false;
  }
}

/**
 * 把 ACP 会话包装成既有的 `ChatStreamer` 形状，使 `graph/supervisor.ts` 的替换只动一行。
 *
 * 入参虽是全量 `messages`（图状态），但**只取本轮的用户输入**发给 pi——
 * 其余历史由 pi 会话自己持有（§7① 的"LangGraph 图状态 + pi session"两者并存）。
 */
/**
 * `createAcpStreamer` 只需要"能发一轮 prompt"这一件事。
 * 收窄成接口，单个客户端与按 Agent 分进程的池（`pool.ts`）都能接。
 */
export interface AcpPrompter {
  prompt(args: {
    carlifeSessionId: string;
    agent: AgentName;
    messages: ChatTurnMessage[];
    signal?: AbortSignal;
  }): AsyncGenerator<string>;
}

/**
 * pi 实际跑的模型名（`.pi/settings.json` 的 defaultModel，唯一真相源）。
 * 读不到返回 undefined——调用方回落到会话名，与旧行为一致。
 */
let piModelCache: string | null | undefined;
function piDefaultModel(): string | undefined {
  if (piModelCache !== undefined) return piModelCache ?? undefined;
  try {
    const s = JSON.parse(readFileSync(join(PI_AGENTS_DIR, ".pi", "settings.json"), "utf8")) as {
      defaultModel?: unknown;
    };
    piModelCache = typeof s.defaultModel === "string" ? s.defaultModel : null;
  } catch {
    piModelCache = null;
  }
  return piModelCache ?? undefined;
}

/**
 * 字符 → token 的估算系数。**pi 侧拿不到真实 token 计数**（不经我们的 AI SDK 出口，
 * 真值要等 pi 的 get_session_stats 接入，M9-03），此前一律记 0——于是经 ACP 的
 * 子 Agent 调用在成本上等于免费，大屏的"LLM 费用"整块偏低。
 * 0 和估算都不是真值，但 0 是**系统性低估且不可见**，估算至少方向对、口径可写明。
 * 系数取 DeepSeek 官方口径的中文侧（1 汉字 ≈ 0.6 token；英文 ≈ 0.3/字符），
 * 按偏高的一侧取——与单价取"高峰未命中"同一取向：宁可略高，不可假低。
 */
const EST_TOKENS_PER_CHAR = 0.6;

export function createAcpStreamer(
  client: AcpPrompter,
  resolve: (hooks?: ChatStreamHooks) => { carlifeSessionId: string; agent: AgentName },
): ChatStreamer {
  return async function* (messages: ChatTurnMessage[], hooks?: ChatStreamHooks) {
    const { carlifeSessionId, agent } = resolve(hooks);
    const startedAt = Date.now();
    const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
    let completionChars = 0;
    let ok = true;
    try {
      // signal 必须透传：断在这里的话，上层取消了而底层还在烧（TD-08）。
      for await (const chunk of client.prompt({ carlifeSessionId, agent, messages, signal: hooks?.signal })) {
        completionChars += chunk.length;
        yield chunk;
      }
    } catch (e) {
      ok = false;
      throw e;
    } finally {
      hooks?.onUsage?.({
        provider: "pi-acp",
        // 子 Agent 身份：用量页按 Agent 维度全靠它，写死 supervisor 会让
        // 十几个分支的花费全算到主链路头上（见 LlmUsageSample.agent）。
        agent,
        // 模型记真名（settings 的 defaultModel）——此前记的是会话名（supervisor-intent 等），
        // 按模型聚合成本时那些行既对不上任何单价、也没人认得出它们是 deepseek。
        model: piDefaultModel() ?? agent,
        promptTokens: Math.ceil(promptChars * EST_TOKENS_PER_CHAR),
        completionTokens: Math.ceil(completionChars * EST_TOKENS_PER_CHAR),
        durationMs: Date.now() - startedAt,
        status: ok ? "ok" : "failed",
      });
    }
  };
}

// ── 内部工具 ───────────────────────────────────────────────

/** `.pi/settings.json` 只读一次——它随仓库走，进程生命周期内不会变。 */
const modelSpecCache = new Map<string, string | undefined>();

/**
 * 拼出 pi 的 `--model` 值：`<provider>/<model>:<thinking>`。
 *
 * **模型 id 的唯一真相源是 `.pi/settings.json`**，这里只是给它加个档位后缀。
 * 在别处再写一遍 `deepseek-v4-flash` 的话，改了 settings 而忘了改那处时，
 * 两边会静默跑不同的模型——而这正是当初钉模型要解决的问题（见 pi-agents/README）。
 *
 * 读不到、缺字段、或没指定档位时返回 undefined：不加 `--model`，
 * pi 用 settings 的默认值，与加这个特性之前完全一致。**降级到原行为，不是降级到未知行为。**
 */
/**
 * 该 Agent 的工具允许清单（施工单 M23-01），拼给 `--tools`。
 *
 * # 为什么从 `listForAgent` 派生而不是另写一份
 *
 * ACL 的单一真相源是 registry 的 `agents` 数组（M23-00 红线）。describe 端裁剪、
 * invoke 端 403、本清单三处**必须同源**——第四份手写清单出现之日，就是它们漂移之始。
 * 名字与扩展注册的完全一致也由同源保证：pi 对 `--tools` 里的未知名**静默忽略**
 * （2026-08-25 实测 T4），拼错不会报错，只会让那个工具无声消失。
 *
 * # 为什么在 spawn 时算而不是缓存
 *
 * 注册表是静态模块，`listForAgent` 是一次数组 filter；连接重建本来就是罕见路径，
 * 缓存只会引入"注册表变了但清单没变"的第三种状态。
 */
export function toolListFor(agent: AgentName | string): string {
  return listForAgent(canonicalAgent(agent) as ToolAgentName)
    .map((t) => t.name)
    .join(",");
}

export function modelSpecFor(
  agentsDir: string,
  thinkingLevel: "off" | "high" | undefined,
): string | undefined {
  if (!thinkingLevel) return undefined;
  const key = `${agentsDir}::${thinkingLevel}`;
  if (modelSpecCache.has(key)) return modelSpecCache.get(key);

  let spec: string | undefined;
  try {
    const raw = readFileSync(join(agentsDir, ".pi", "settings.json"), "utf8");
    const s = JSON.parse(raw) as { defaultProvider?: unknown; defaultModel?: unknown };
    if (typeof s.defaultProvider === "string" && typeof s.defaultModel === "string") {
      spec = `${s.defaultProvider}/${s.defaultModel}:${thinkingLevel}`;
    }
  } catch {
    /* 读不到就不加参数——见上 */
  }
  modelSpecCache.set(key, spec);
  return spec;
}

/**
 * 末尾那一串**连续 user 消息**的起点下标；没有 user 消息时返回 -1。
 *
 * 编排层会在用户原话后面追加自己的指令，而它们同样是 `role: "user"`——
 * 意图节点追加 `INTENT_INSTRUCTION`，应答节点追加【编排层已完成的求解结果】。
 * 中间没有 assistant 隔开，说明它们和用户原话同属**本轮输入**，边界就在这里。
 */
export function trailingUserRunStart(messages: readonly ChatTurnMessage[]): number {
  let i = messages.length - 1;
  // 正常情况下末条就是 user；容错：尾部若挂着 assistant，退回最近一条 user。
  while (i >= 0 && messages[i].role !== "user") i -= 1;
  if (i < 0) return -1;
  while (i - 1 >= 0 && messages[i - 1].role === "user") i -= 1;
  return i;
}

/**
 * 本轮真正要发给 pi 的用户输入。
 *
 * **不能只取最后一条**——这曾是一个很难看出来的失明：稳态（会话复用）下只发末条时，
 * 编排层追加的指令把用户原话挤掉了，pi 那一侧从头到尾没收到过本轮说了什么。
 * 实测（turn-0377dd6a）：车主说"我是今天下午三点出发"，发给意图会话的 194 字里
 * 只有那段"请先做意图理解"的指令，于是模型据历史推断并写下"本轮未说明具体出发日期"，
 * 应答也照抄了上一轮的收尾。**首轮不会暴露**——首轮走 `primeWithHistory`，
 * 原话混在回灌的历史里进去了，所以症状只在第二轮起出现。
 */
function currentUserText(messages: ChatTurnMessage[]): string | undefined {
  const start = trailingUserRunStart(messages);
  if (start < 0) return undefined;
  const parts = messages
    .slice(start)
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .filter((c) => c && c.trim().length > 0);
  return parts.length ? parts.join("\n\n") : undefined;
}

/**
 * 新建 pi 会话时的历史回灌：把图状态里的既往轮次压成一段上下文 + 本轮问题。
 *
 * 只在 `fresh` 时用一次。首轮（无既往历史）等价于直接发本轮输入，不产生额外开销。
 *
 * 切分点与 `currentUserText` 用**同一个**边界函数。各算各的会让末尾那串 user 消息里
 * 靠前的几条既进"历史"又进"现在问"，同一句话发两遍。
 */
function primeWithHistory(messages: ChatTurnMessage[]): string | undefined {
  const current = currentUserText(messages);
  if (!current) return undefined;

  const prior = messages.slice(0, trailingUserRunStart(messages));
  if (prior.length === 0) return current;

  const transcript = prior
    .map((m) => `${m.role === "user" ? "车主" : "助手"}：${m.content}`)
    .join("\n");
  return [
    "以下是本次会话此前的对话记录（供你接上下文，不要复述）：",
    transcript,
    "",
    `车主现在问：${current}`,
  ].join("\n");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} 超时 ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

interface Sink extends UpdateSink {
  stream(): AsyncGenerator<{ kind: "delta"; text: string } | { kind: "thought"; text: string }>;
  end(): void;
}

/** 把回调式的 session/update 转成可 for-await 的流。 */
function createSink(): Sink {
  const queue: Array<{ kind: "delta" | "thought"; text: string }> = [];
  let notify: (() => void) | undefined;
  let finished = false;
  let error: Error | undefined;

  const wake = () => {
    notify?.();
    notify = undefined;
  };

  return {
    push(item) {
      queue.push(item);
      wake();
    },
    fail(e) {
      error = e;
      finished = true;
      wake();
    },
    end() {
      finished = true;
      wake();
    },
    async *stream() {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (error) throw error;
        if (finished) return;
        await new Promise<void>((r) => {
          notify = r;
        });
      }
    },
  };
}
