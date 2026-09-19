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
import { join, resolve } from "node:path";

import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

import type { AcpApp } from "./app";
import type { ChatStreamer, ChatStreamHooks, ChatTurnMessage } from "./stream";
import { messageText } from "./stream";
import {
  isPiAcpUpdateNotice,
  projectUpdate,
  type UpdateSink,
} from "./update-bridge";

import { canonicalAgent } from "./naming";
import type { ThinkingLevel } from "./thinking";
import { splitThinkBursts, type ThoughtTick } from "./think";

/*
 * **这里没有 `import.meta.url`，而且不许有**（`check:arch` 的 `acp-substrate-pure`）。
 *
 * 以前这个文件用 `resolve(HERE, "../../../pi-agents")` 自己推 pi 目录。
 * 搬家前后目录层数恰好一样，所以那行照搬进来**仍然算得对**——回归全绿、
 * smoke:acp 也过。缺陷要等第二个应用（用研面）接上来才发作，形态是
 * 「用研面加载了车主面的 .pi/extensions 与 prompts」：工具表和提示词都是别人的，
 * 零报错。所以目录只从 `AcpApp.piDir` 来，见 `app.ts` 的文件头。
 */

const CONNECT_TIMEOUT_MS = 30_000;
/**
 * 单次 session/prompt 的兜底超时。**必须比任何一层编排超时都长**——
 * 行程 fan-out 的 `ITINERARY_BRANCH_TIMEOUT_MS` 是 300s，本层留 30s 余量，
 * 保证到点时永远是编排层先判超时并下发 cancel（否则两层同时到点，僵尸调用会回来）。
 */
const PROMPT_TIMEOUT_MS = 330_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;



export interface AcpClientOptions {
  /**
   * 这个连接服务哪个应用。**必填，没有默认值。**
   *
   * 给默认值（比如"没传就按车主面算"）是这一整张单要拦的那类错：
   * 用研面哪天漏传，它会拿到车主面的 pi 目录、prompts 与工具表，
   * 一切照常跑、零报错，只是模型手里全是别人的东西。
   * 必填的话，漏传在 `tsc` 那一步就红。
   */
  app: AcpApp;
  /**
   * 覆盖 pi 的项目级配置目录（测试用）。
   *
   * **它同时覆盖项目目录与二进制目录**（`resolvePiCommands`）——语义与
   * `binDir` 引入之前逐字一致：给了它就是"全都在这一个目录下"，
   * 拿一个夹具目录顶替整份 pi 安装的用法照旧。
   */
  piAgentsDir?: string;
  /** 注入给子进程的环境变量（模型凭证等由父进程注入，pi 子进程不自己读配置 DB）。 */
  env?: Record<string, string | undefined>;
  /** 本连接服务哪个 Agent——决定 pi 扩展加载哪张工具表（§4.3 能力映射裁剪）。 */
  agent?: string;
  /** Mock 三态（FL-39 F-39-02）；由装配层决定，pi 侧不自己选。 */
  toolMode?: "real" | "mock" | "off";
  /**
   * 思考档位。**按进程固定**——pi 的 `--model <id>:<level>` 在启动时就定死了，
   * 改不了单次调用。所以池按 (Agent, 档位) 分进程，见 `pool.ts` 的 `processKey`。
   * 省略时用 `.pi/settings.json` 里的 `defaultThinkingLevel`。
   */
  thinkingLevel?: ThinkingLevel;
}

interface SessionEntry {
  acpSessionId: string;
  agent: string;
}

/** `resolvePiCommands` 的产物：一次算清"在哪儿启动、以谁的身份启动"。 */
export interface PiCommands {
  /** pi 的项目目录：`session/new` 的 cwd、`.pi/settings.json`、`--approve` 作用域。 */
  piDir: string;
  /** pi 的二进制目录：`node_modules/.bin` 与 `bin/` 的父目录。 */
  binDir: string;
  localBin: string;
  adapterBin: string;
  piAcpCommand: string;
  piCommand: string;
}

/**
 * 解析"这个连接要启动哪儿的 pi、以哪个目录为项目"。
 *
 * **纯函数、不碰文件系统**（存在性检查留在 `connect()`），所以能直测——
 * 这一处的两种错法都不报错：cwd 用了 binDir 就是"加载了别人的扩展与提示词"，
 * 二进制用了 piDir 则是"借用方根本起不来"，前者尤其安静（ACR-038 关键决策）。
 *
 * 三条语义，缺一条都会在第二个应用接上时才发作：
 *  - `opts.piAgentsDir`（旧的测试覆盖入口）给了就**两者都用它**，语义与从前逐字一致；
 *  - 否则项目目录是 `app.piDir`；
 *  - 二进制目录是 `app.binDir ?? app.piDir`——车主面不传 `binDir`，于是回落到
 *    `piDir`，与加这个字段之前完全相同。
 */
export function resolvePiCommands(
  app: Pick<AcpApp, "piDir" | "binDir">,
  opts?: Pick<AcpClientOptions, "piAgentsDir">,
): PiCommands {
  const override = opts?.piAgentsDir;
  const piDir = override ?? app.piDir;
  const binDir = override ?? app.binDir ?? app.piDir;

  const localBin = resolve(binDir, "node_modules/.bin");
  const adapterBin = resolve(binDir, "bin");
  return {
    piDir,
    binDir,
    localBin,
    adapterBin,
    piAcpCommand: resolve(localBin, process.platform === "win32" ? "pi-acp.cmd" : "pi-acp"),
    piCommand: resolve(binDir, "bin/pi-approved.sh"),
  };
}

/**
 * 拼 pi-acp 子进程的环境变量。
 *
 * 抽成纯函数只为一件事：注入项能被直测。这里每一项漏了都不报错——
 * `CARLIFE_PI_TOOLS` 空串是"整个 Agent 哑掉"，`CARLIFE_TOOLS_ENDPOINT` 指错进程
 * 是"模型手里零工具却照样编答案"。
 */
export function spawnEnvFor(
  app: AcpApp,
  opts?: Pick<
    AcpClientOptions,
    "piAgentsDir" | "env" | "agent" | "toolMode" | "thinkingLevel"
  >,
  appendPrompt = "",
): NodeJS.ProcessEnv {
  const { piDir, localBin, adapterBin, piCommand } = resolvePiCommands(app, opts);
  const agent = opts?.agent ?? "supervisor";
  return {
    ...process.env,
    ...opts?.env,
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
    // 扩展回调地址的**通用通道**（M88-01）：车主面扩展仍读上面那行
    // `AGENT_RUNTIME_URL`（一字不动），用研面扩展只读这一行。
    // 不做回落：`toolsEndpoint` 为空串时也照传空串，让扩展在启动时明确报错，
    // 而不是悄悄回落到另一个进程的工具端点——回错进程那边 `listForAgent` 对未知
    // Agent 回空表，模型手里零工具却照样编出像样的答案（ACR-038 实施陷阱 1）。
    CARLIFE_TOOLS_ENDPOINT: app.toolsEndpoint,
    CARLIFE_PI_AGENT: agent,
    CARLIFE_TOOLS: opts?.toolMode ?? process.env.CARLIFE_TOOLS ?? "real",
    // pi 在 `--mode rpc` 下不弹项目信任提示，默认**静默忽略** .pi/extensions/
    // ——工具一个都不会注册，且没有任何报错（M4-02 实测踩到）。
    // 包装脚本给 pi 加 --approve，作用域仅限本仓库的 pi-agents 目录。
    // 固定到仓库内 wrapper，不读取宿主机同名环境变量；个人全局 pi 不在业务链路内。
    PI_ACP_PI_COMMAND: piCommand,
    // 思考档位按进程定（pi 的 `--model <id>:<level>` 是启动参数，不是每次调用的参数）。
    // 走自定义变量而不是往 PI_ACP_PI_COMMAND 里拼参数——后者的解析规则是
    // pi-acp 的内部约定，拼错了只会在运行时静默变成另一种行为。
    // 包装脚本 bin/pi-approved.sh 认这个变量；拼不出来时为空，行为与加这特性前一致。
    // 读的是 **piDir** 的 settings：模型钉在哪个项目里，就该由那个项目说了算。
    CARLIFE_PI_MODEL: modelSpecFor(piDir, opts?.thinkingLevel) ?? "",
    // 工具允许清单（M23-01）：pi 侧自己兜一道 §4.3 的 ACL，与 describe/invoke 同源。
    // 包装脚本据此加 `--tools`；空串时它只加 `--no-builtin-tools`——
    // `--tools ""` 的语义是"允许零个工具"，一旦清单意外为空，症状是整个 Agent 哑掉。
    CARLIFE_PI_TOOLS: app.toolNamesFor(agent).join(","),
    // 业务 prompt 走真正的系统提示词（M23-02）。此前它前置在新会话第一条 user 消息里
    // ——那是 pi 早期没有 system prompt 入口时的权宜；0.84.1 有 `--append-system-prompt`
    // （2026-08-25 实测：一次性与 rpc 模式都生效，特殊字符逐字透传）。
    // 为什么是 CLI 参数而不是 `.pi/APPEND_SYSTEM.md`：十个 Agent 共用同一个 cwd，
    // 按文件注入区分不了 Agent，参数是唯一能按进程差异化的通道。
    // `loadAgentPrompt` 读不到就抛——比原来（首轮 prompt 时才炸）更早，绝不静默降级。
    CARLIFE_PI_APPEND_PROMPT: appendPrompt,
  };
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
  private byAcpSession = new Map<string, { carlifeSessionId: string; agent: string }>();
  /** 当前活跃的 update 消费者，按 ACP sessionId 索引。 */
  private sinks = new Map<string, UpdateSink>();
  private health: AcpHealth = { connected: false, restarts: 0, unmappedUpdates: {} };
  private disposed = false;

  constructor(private opts: AcpClientOptions) {}

  getHealth(): AcpHealth {
    return { ...this.health, unmappedUpdates: { ...this.health.unmappedUpdates } };
  }

  /**
   * pi 的**项目**目录：`session/new` 的 `cwd`、`.pi/settings.json`、`--approve` 的作用域。
   * 决定"加载谁的扩展与设置"，所以它一定是本应用自己的（ACR-038）。
   */
  private get piDir(): string {
    return resolvePiCommands(this.opts.app, this.opts).piDir;
  }

  /**
   * pi 的**二进制**目录：`node_modules/.bin`、`bin/`、`bin/pi-approved.sh`。
   * 缺省等于 `piDir`；用研面把它指向 `pi-agents/` 借那一份安装。
   */
  private get binDir(): string {
    return resolvePiCommands(this.opts.app, this.opts).binDir;
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
    this.connecting = this.opts.app.tracer.span(undefined, "acp.connect", () => this.connect(), {
      agent: this.opts.agent ?? "supervisor",
    }).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const app = this.opts.app;
    /*
     * 业务 prompt 在 spawn **之前**取。
     *
     * 取不到就抛——比原来（首轮 prompt 时才炸）更早，绝不静默降级：
     * 静默降级到"没有业务 prompt"正是此前那半年的状态，而它的症状
     * （啰嗦、跑题、超时）看起来完全像是模型能力问题。
     */
    const appendPrompt = await app.promptFor(this.opts.agent ?? "supervisor");
    const { piAcpCommand, piCommand } = resolvePiCommands(app, this.opts);
    // 两条错误文案都点名**查的是哪个目录**：借用安装之后，"pi-acp 不存在"可能是
    // binDir 指错了（借的那份没装），也可能是本应用的 piDir 下本来就不该有它。
    if (!existsSync(piAcpCommand)) {
      throw new Error(
        `仓库内 pi-acp 不存在：${piAcpCommand}（在 binDir=${this.binDir} 下查找）；` +
          "请先运行 corepack pnpm install",
      );
    }
    if (!existsSync(piCommand)) {
      throw new Error(
        `仓库内 pi 启动包装不存在：${piCommand}（在 binDir=${this.binDir} 下查找）；` +
          "请先运行 corepack pnpm install",
      );
    }

    const child = spawn(piAcpCommand, [], {
      // cwd 用 **piDir** 不是 binDir：它决定 pi 加载谁的 `.pi/extensions` 与
      // `settings.json`，而借用二进制的那一方要的正是"自己的项目配置"（ACR-038）。
      cwd: this.piDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnvFor(app, this.opts, appendPrompt),
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
    agent: string,
  ): Promise<{ acpSessionId: string; fresh: boolean }> {
    const key = `${carlifeSessionId}::${agent}`;
    const existing = this.sessions.get(key);
    if (existing) return { acpSessionId: existing.acpSessionId, fresh: false };

    // 每个 (会话 × Agent) 首次用到时各建一次；六个 Agent 就是六次，
    // 都串在用户等待里，所以必须能分开看见（TD-08 任务 3）。
    const res = (await this.opts.app.tracer.span(
      carlifeSessionId,
      "acp.session_new",
      () =>
        withTimeout(
          // cwd 是 piDir——pi 按它发现 `.pi/extensions` 与 `settings.json`。
          this.conn!.newSession({ cwd: this.piDir, mcpServers: [] } as never),
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
  resolveSession(acpSessionId: string): { carlifeSessionId: string; agent: string } | undefined {
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
    agent: string;
    /** 图状态里的完整消息序列（权威源）。 */
    messages: ChatTurnMessage[];
    /** 调用方放弃时的取消信号（TD-08 / F-14-04）；见下面 abort 处的说明。 */
    signal?: AbortSignal;
    /**
     * 本线程的锚定块（M84-03，ACR-036 §4.9）。**只在新建会话的那一次发**。
     *
     * pi 的系统提示词在进程启动时就拼死了（`--append-system-prompt`），一个进程服务很多人，
     * 所以车主档案只能走会话的第一条 prompt——它进了 pi 的历史最前面，之后每一轮都是
     * 命中的前缀。**重发等于每轮换前缀，比不发更糟**。
     */
    anchor?: string;
  }): AsyncGenerator<string> {
    const app = this.opts.app;
    await this.ensureConnectedWithBackoff();
    const { acpSessionId, fresh } = await this.sessionFor(args.carlifeSessionId, args.agent);
    // 业务 prompt 不再前置到第一条消息——它已经在系统提示词里（M23-02，`connect()` 的
    // `CARLIFE_PI_APPEND_PROMPT`）。这里只剩回灌语义：新会话用图状态回灌一次历史。
    const primed = fresh ? primeWithHistory(args.messages) : currentUserText(args.messages);
    if (!primed) return;
    /*
     * 日期行的归属（M84-03）：
     * - 装载层开着时，今天几号已经在本轮尾区里（它随最后一条 user 消息进来），这里不再前置一遍；
     * - 装载层关着（`CARLIFE_CONTEXT_LAYER=off`）时走老路径（车主面传的是 `withDateline`），**逐字等于从前**。
     * 判据用 `args.anchor === undefined` 而不是读环境变量：这一层不该知道开关长什么样。
     */
    const withContext = args.anchor !== undefined;
    const body = withContext ? primed : (app.decoratePrompt?.(primed, Date.now()) ?? primed);
    const text = fresh && args.anchor ? `${args.anchor}\n\n${body}` : body;

    // 记的是**这一行真正发出去的 text**，不是入参 messages（TD-08）：
    // 新会话回灌历史、前置业务 prompt、稳态只取最后一条——三种形态差别很大，
    // 而"模型为什么说这句"只能从实际发出的那段里看出来。
    app.tracer.recordPrompt(args.carlifeSessionId, args.agent, text);

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
     *     实测过一次 60 秒的僵尸调用（分支 60s 判超时 → 底层跑到当时的 120s）。
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
      sink.fail(app.tracer.cancelled(`本轮已取消（${args.agent}）`));
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
        app.tracer.recordSpan(args.carlifeSessionId, `think.${args.agent}`, b.startedAt, b.endedAt, "ok", {
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
    agent: string;
    messages: ChatTurnMessage[];
    signal?: AbortSignal;
    /** 本线程的锚定块（M84-03）；只在新建会话时用得上，见实现处的说明。 */
    anchor?: string;
  }): AsyncGenerator<string>;
}

/**
 * pi 实际跑的模型名（`.pi/settings.json` 的 defaultModel，唯一真相源）。
 * 读不到返回 undefined——调用方回落到会话名，与旧行为一致。
 *
 * **缓存按 `piDir` 分键**（M88-01 / ACR-038 实施陷阱 2）：从前是一个模块级变量，
 * 谁先调谁定——第二个应用接上来时，它的用量行会记成**第一个应用**的模型名，
 * 零报错，只在按模型聚合成本时表现为"这个模型怎么多出这么多调用"。
 * 同一个 `piDir` 仍只读一次盘（settings 随仓库走，进程内不会变）。
 */
const piModelCache = new Map<string, string | null>();
export function piDefaultModel(piDir: string): string | undefined {
  const cached = piModelCache.get(piDir);
  if (cached !== undefined) return cached ?? undefined;
  let model: string | null;
  try {
    const s = JSON.parse(readFileSync(join(piDir, ".pi", "settings.json"), "utf8")) as {
      defaultModel?: unknown;
    };
    model = typeof s.defaultModel === "string" ? s.defaultModel : null;
  } catch {
    model = null;
  }
  piModelCache.set(piDir, model);
  return model ?? undefined;
}

/**
 * 只给测试用：清空模型名缓存。
 *
 * 没有它，两条用例之间缓存串台——第二条读到的是第一条的目录，
 * 于是"按 piDir 分键"这件事在测试里永远是通过的，测的还是同一个问题。
 */
export function resetPiModelCacheForTests(): void {
  piModelCache.clear();
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
  resolve: (hooks?: ChatStreamHooks) => { carlifeSessionId: string; agent: string },
  /** 读 `.pi/settings.json` 拿模型真名用。由应用给——底座不推目录，见文件头。 */
  piDir: string,
): ChatStreamer {
  return async function* (messages: ChatTurnMessage[], hooks?: ChatStreamHooks) {
    const { carlifeSessionId, agent } = resolve(hooks);
    const startedAt = Date.now();
    const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
    let completionChars = 0;
    let ok = true;
    try {
      // signal 必须透传：断在这里的话，上层取消了而底层还在烧（TD-08）。
      for await (const chunk of client.prompt({
        carlifeSessionId,
        agent,
        messages,
        signal: hooks?.signal,
        // 直连那条把锚定块拼进 system；pi 这条没有按线程的 system，所以走会话首条 prompt。
        ...(hooks?.systemSuffix !== undefined ? { anchor: hooks.systemSuffix } : {}),
      })) {
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
        model: piDefaultModel(piDir) ?? agent,
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

export function modelSpecFor(
  /** pi 的**项目**目录（不是二进制目录）：settings 跟着项目走，见 `resolvePiCommands`。 */
  piDir: string,
  thinkingLevel: ThinkingLevel | undefined,
): string | undefined {
  if (!thinkingLevel) return undefined;
  const key = `${piDir}::${thinkingLevel}`;
  if (modelSpecCache.has(key)) return modelSpecCache.get(key);

  let spec: string | undefined;
  try {
    const raw = readFileSync(join(piDir, ".pi", "settings.json"), "utf8");
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
    // 附件备注一并带上（M80-02）：pi 那条路看不到图片，至少要知道车主附了东西。
    .map((m) => messageText(m))
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
    .map((m) => `${m.role === "user" ? "车主" : "助手"}：${messageText(m)}`)
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
