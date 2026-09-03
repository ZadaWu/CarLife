// agent-runtime — LangGraph.js（ACP Client）入口
//
// M4-01 形态：单节点 chat 图 + 内部 turn 接口（NDJSON 流），chat 节点经 **ACP** 驱动
// pi 侧 Agent（§13-1 已关闭，见 acp-client/connection.ts 的实测结论）。
//
// 运行时选择（`CARLIFE_AGENT_RUNTIME`）：
//   acp（默认）  经 pi-acp 子进程走 ACP —— 目标架构
//   direct       直连 LLM（AI SDK）——离线开发与测试用；`CARLIFE_LLM=fake` 时自动降到这条
//
// 表述路径（`CARLIFE_ANSWER_RUNTIME`，与上面那个是两回事）：
//   acp（默认）  应答与主链路同路
//   direct       **分支已交出求解结果时**，应答改由直连非推理模型讲出来（TD-08 第三步）
//                模型由 `CARLIFE_ANSWER_MODEL` 定，默认 deepseek-v4-flash

import { loadRootEnv } from "./env";
loadRootEnv();

import {
  getPrisma,
  createConfigStore,
  createUsageRepository,
  createWorkingThreadStore,
  assertStartupConfig,
  createElicitationCooldownRepository,
  createRefuelRepository,
  createAuditRepository,
  createVehicleGrantRepository,
} from "@carlife/db";

// 必填配置缺失即快速失败（M3-02 / AC-35-11）。
assertStartupConfig();

import { createConfiguredChatStreamer, NARRATOR_SYSTEM } from "./llm";
import { AcpClient, createAcpStreamer, type AgentName } from "./acp-client/connection";
import { AcpClientPool } from "./acp-client/pool";
import {
  setSessionResolver,
  setSessionUserResolver,
  setSessionAccessResolver,
} from "./tools-endpoint";
import { recordSubmission } from "./branch-submissions";
import { publishToTurn } from "./interrupt-bus";
import * as events from "./events";
import { toolDisplayName } from "./events/tool-display";
import type { SessionEvent } from "@carlife/shared";
import { buildChatGraph, setPreferenceWriter, setEpisodeWriter, setEpisodeReader } from "./graph/supervisor";
import { createCheckpointer } from "./graph/checkpointer";
import { TurnRunner } from "./turn-runner";
import { createRuntimeServer, setHealthProvider } from "./server";
import { getToolEndpointStats, setGuardGate } from "./tools-endpoint";
import { GuardGate } from "./guard/http-endpoint";
import { TraceCollector } from "./trace";
import { classifyError, hasSpanSink, recordSpan, recordToolCall, resolveTraceKey, setSpanSink } from "./trace/span";
import { liveTrace } from "./trace/live";
import { observeTrace } from "./sidecar/pair-session";
import { withLlmSpans } from "./llm/traced";
import { createFillerWriter } from "./sidecar-writer";
import { createTitleWriter } from "./title";
import { GuardPipeline } from "./guard/pipeline";
import { getFreshnessThresholds } from "./guard/settings";
import {
  DEFAULT_ELICITATION_COOLDOWN_DAYS,
  resolveDeepSeekModel,
} from "@carlife/shared";
import { createElicitationService } from "./elicitation/service";
import { extractProfileFacts } from "./elicitation/extract";
import { decisiveEnergyFor, parseDistanceKm } from "./graph/energy";
import { carryOverHighlights, createHighlightsBackfill } from "./graph/highlights";
import { looksLikeDeparting } from "./graph/elicitation";
import {
  TOOL_REGISTRY,
  createAmapClient,
  createCmaClient,
  setAmapClient,
  setDealerBackend,
  getDealerBackend,
  createHttpDealerBackend,
  createRepairAppointmentBackend,
  setAppointmentBackend,
  setRepairBackend,
  getRepairBackend,
  createHttpRepairBackend,
  setInsuranceBackend,
  getInsuranceBackend,
  createHttpInsuranceBackend,
  setCalendarBackend,
  createGoogleCalendarBackend,
  createCaldavBackend,
  createFanoutCalendarBackend,
  setCmaClient,
  setDestinationSearch,
  setEnvCache,
  envCacheKey,
  getEnvCacheStats,
  createRedisEnvCache,
  setPreferenceStore,
  setRagClient,
  setToolObserver,
  setToolStartObserver,
  setTripPlanStore,
  setRouteAuditStore,
  setBranchSubmissionSink,
  setSearchResultRecorder,
  setRestStopCandidateRecorder,
  setUsageStore,
  getTool,
  setFreshnessThresholds,
  dataFreshnessTool,
  invokeTool,
  setRefuelStore,
  setMemberStores,
  setVehicleStore,
  computeEnergyGap,
} from "@carlife/tools";
import {
  createCachedVehicleStore,
  getMemoryClient,
  loadUsageProfile,
  measuredEnergyPer100km,
} from "@carlife/memory";
import { assembleCabin } from "./cabin/assemble";
import { setCabinApplyDeps, setPreferenceMemberStore } from "@carlife/tools";
import { translateCabinPlan } from "./graph/cabin-translate";
import { createRedisVehicleCacheBackend } from "./vehicle-cache-backend";
import { setUserFlagStore } from "./graph/subgraphs/ownership";
import { runGuideBrief, type GuideBrief } from "./graph/subgraphs/guide";
import { guideBriefIsComplete } from "@carlife/shared";
import { createGuideBriefRepository } from "@carlife/db";
import { recordSearchResults } from "./search-results";
import { recordRestStopCandidates } from "./route-candidates";
import { setMemberStore as setGraphMemberStore } from "./graph/supervisor";
import { setCompanionFlagStore } from "./graph/companions";
import { createRagClient } from "@carlife/rag";
import {
  createTripPlanRepository,
  createTripRouteAuditRepository,
  createTripRepository,
  createVehicleMemberRepository,
  createMemberCombinationRepository,
  createVehicleRepository,
  createUserFlagRepository,
  createTraceRepository,
  createGuardAuditRepository,
} from "@carlife/db";
import { GuardAuditor, MemoryGuardAuditSink, PersistentGuardAuditSink } from "./guard/audit";
import {
  createContentGuard,
  createOpenAiCompatClient,
  createAliyunContentGuard,
  createAliyunGuardClient,
  type ContentGuard,
} from "@carlife/guardrails";

export { createChatStreamer, createConfiguredChatStreamer } from "./llm";
export { AcpClient, createAcpStreamer } from "./acp-client/connection";
export { buildChatGraph } from "./graph/supervisor";
export { TurnRunner } from "./turn-runner";
export { createRuntimeServer } from "./server";

const PORT = Number(process.env.AGENT_RUNTIME_PORT ?? 8788);
/**
 * 监听地址。默认 `0.0.0.0` **不能改**——容器部署里 gateway 经 docker 网络按
 * 服务名访问（`AGENT_RUNTIME_URL=http://agent-runtime:8791`），绑回环会让
 * 那条链当场断掉且没有回退。开发机在公共网络时设 `127.0.0.1` 收紧，
 * 理由见下面 listen 回调里的那段说明。
 */
const BIND = process.env.AGENT_RUNTIME_BIND?.trim() || "0.0.0.0";
/** 回环地址的几种写法。判"是不是只对本机可见"，不做地址解析。 */
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * `字段：值` 拆成协议里的 `PermissionDetail`。
 *
 * 端上靠 label 决定怎么渲染（「第1天 …」走天序时间线、「大交通」走独立卡），
 * 所以拆分规则必须只有这一处——两处各拆一份时，两端对不上的是版式而不是报错。
 */
function splitLabelled(line: string, fallbackLabel = "明细"): { label: string; value: string } {
  const i = line.indexOf("：");
  return i > 0
    ? { label: line.slice(0, i), value: line.slice(i + 1) }
    : { label: fallbackLabel, value: line };
}

// tsx watch src/index.ts 直接启动；被当作库 import 时（测试）不自启。
if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  const prisma = getPrisma();
  const config = createConfigStore(prisma);
  const usage = createUsageRepository(prisma);
  // 按配置版本缓存的工厂：换 key / 换模型不重启（M3-02 约束 2）。
  const directStreamer = createConfiguredChatStreamer(config);

  // 轨迹采集（M5-06 / §4.1 X2）。**回放页在 M9，但埋点必须从现在开始**——
  // 等做回放时才加，历史会话一条都放不出来（FL-29 排期警告）。
  // **落库而不是内存**（M9-01）：回放页读的是历史会话，进程一重启内存里的
  // 轨迹就全没了——"回放不是重跑"这条铁律要求数据活得比进程久。
  //
  // 仓储内部是缓冲 + 定时批量写：`TraceSink.write` 是同步接口，
  // 在里面 await 落库会把数据库延迟加到每一次 token 之间。
  //
  // **装在 ACP 之前**（TD-08）：ACP 冷启动是整条链路上最容易漏掉的一跳，
  // 它只在第一次出现。sink 装晚了，第一次冷启动——也就是最慢的那次——恰好量不到。
  const traceRepo = createTraceRepository(prisma);
  const trace = new TraceCollector(traceRepo);
  // 旁路观察者与落库**并列扇出**，不是包装替换（M18-02 约束 2）。
  // `observeTrace` 自己吞异常并计数——**不在这里包 try/catch**：
  // 包在外面会让"旁路挂了"被误算成"轨迹挂了"，而后者的排查方向完全不同。
  setSpanSink((e) => {
    traceRepo.write(e);
    observeTrace(e);
    // 第三条并列扇出（M25 之后的大屏实时视图）。同样不包 try/catch：
    // `publish` 自己吞异常，包在外面会让"实时通道挂了"被误算成"轨迹挂了"。
    liveTrace.publish(e);
  });
  // 未装 sink 时 span 静默丢弃（单测与离线路径需要这样），代价是**生产漏装也不报错**：
  // 现象是回放页的分跳耗时整块消失，与"这次真的没有那些跳"看起来一样。所以启动期喊一声。
  console.log(
    `[trace] 分跳耗时采集：${hasSpanSink() ? "已接（落 traceEvent 表）" : "⚠️ 未接——回放页不会有耗时"}`,
  );
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    // 退出前把队列刷出去：丢的是排障素材不是用户数据，但能少丢就少丢。
    process.once(sig, () => {
      traceRepo.stop();
      void traceRepo.flush();
    });
  }

  /*
   * Guardrails 裁决审计落库（M37-04，F-27-11 / F-10-07 / F-10-12 / F-10-13）。
   *
   * 与轨迹是两份、两个用途：trace_events 是**可 prune 的排障素材**（回放页），
   * guard_audit_logs 是**保留用**（高风险语境回查，追加式无删除接口）。
   * 高风险裁决（deny / needs_confirmation / 审核 block / PII 命中）全量落；
   * allow 默认也全量（F-27-11"含放行"），量大时用 GUARD_AUDIT_SAMPLE_ALLOW 采样，
   * 被采样掉的 allow 仍进内存 sink（误伤样本审查 F-30-04 不能采丢）。
   * GUARD_AUDIT_PERSIST=0 时整体退回内存（离线/演示不想写库的开关）。
   */
  const guardAuditMemory = new MemoryGuardAuditSink();
  const guardAuditRepo = createGuardAuditRepository(prisma);
  const guardAuditPersist = process.env.GUARD_AUDIT_PERSIST !== "0";
  const guardAuditor = new GuardAuditor(
    guardAuditPersist
      ? new PersistentGuardAuditSink(
          (r) =>
            guardAuditRepo.write({
              sessionId: r.sessionId,
              turnId: r.turnId,
              layer: r.layer,
              decision: r.decision,
              rule: r.rule,
              tool: r.tool,
              reason: r.reason,
              durationMs: r.durationMs,
              at: new Date(r.at),
            }),
          guardAuditMemory,
          { sampleAllow: Number(process.env.GUARD_AUDIT_SAMPLE_ALLOW ?? "1") },
        )
      : guardAuditMemory,
  );
  console.log(
    `[guard-audit] 裁决审计：${guardAuditPersist ? "落 guard_audit_logs 表（含放行）" : "⚠️ 仅内存（GUARD_AUDIT_PERSIST=0）——重启即丢"}`,
  );

  /*
   * 工具调用耗时（TD-08 任务 3，F-44-04）。
   *
   * 一处覆盖两条入口：图节点直调与 pi 经 HTTP 打进 tools-endpoint——
   * 两者最终都落到 `@carlife/tools` 的 `invokeTool`（见那边的说明）。
   *
   * `ctx.sessionId` 拿到的是 **threadId**（ACP 侧的历史命名），
   * 交给 `recordSpan` 换算成真会话 id；换算不到时仍写入并标 keyFallback。
   */
  setToolObserver((o) => {
    /*
     * detail 的构成（AC-44-10）：
     *   失败 → 归类后的原因（不含 message 原文，外部报错里带过入参回显）
     *   成功 → mock 三态 + **工具自己声明的那一行概括**（`traceSummary`）
     *
     * 概括是为了回答"同一轮里这五次 weather 差在哪"——没有它，
     * 五条一模一样的记录只能看出"调了五次"，看不出是五个点还是同一个点查了五遍。
     * 允许放什么由工具自己定，本处只负责拼上去（见 registry 的 `traceSummary`）。
     */
    const detail =
      o.status === "failed"
        ? classifyError(o.error)
        : [o.ctx.mode, o.summary].filter(Boolean).join(" · ");
    recordSpan(o.ctx.sessionId, `tool.${o.name}`, o.startedAt, o.endedAt, o.status, {
      agent: o.ctx.agent,
      detail,
    });
    /*
     * 与 span 并列再落一条 `tool_call`（内容记录）：四问之四"数据是真的吗"
     * 与大屏的工具三分类读的是它。这类事件曾被 span 改造静默弄丢——
     * 回放页的真/模拟计数为 0 跑了一路，没有任何报错（库里 0 条 tool_call）。
     * provider 取注册表声明（ragflow-cloud / mock-dealer / …），分类判据不落两处。
     */
    recordToolCall(o.ctx.sessionId, {
      name: o.name,
      agent: o.ctx.agent,
      mode: o.ctx.mode,
      provider: getTool(o.name)?.tool.provider,
      status: o.status,
    });
    // 工具进展下行（F-08-05）。与轨迹并列，不是包装：轨迹是给运维看的，
    // 这条是给车主看的，两者的失败互不牵连。
    publishToolProgress(o.callId, o.name, o.ctx.sessionId, o.status === "ok" ? "succeeded" : "failed");
  });

  /*
   * 工具进展下行（FL-08 F-08-05）。
   *
   * # 为什么产在这里，而不是把 ACP 的 `tool_call` update 转出去
   *
   * pi 的 `tool_call` update **只覆盖模型自己发起的调用**。而购车检索、
   * 双路检索、试驾下单这些是**图节点直调** `invokeTool` 的，那条路上根本
   * 没有 ACP update。接 ACP 那边的话，一半场景的车主仍然对着空白等十几秒，
   * 而这半边看起来"已经做了"——最难发现的那种半成品。
   *
   * `invokeTool` 是两条入口的共同下游（与工具耗时埋点同一个理由）。
   *
   * # 送不出去就算了，但不能出声
   *
   * `publishToTurn` 未命中说明这次调用不属于任何进行中的轮次
   * （轮次已收口后迟到的回调、或后台 cron 里的调用）。那时车主的屏幕上
   * 根本没有"这一轮"，补一条进度只会凭空冒出一句话。
   */
  const publishToolProgress = (
    callId: string,
    name: string,
    threadId: string,
    status: "started" | "succeeded" | "failed",
  ): void => {
    const display = toolDisplayName(name);
    // 表里没有就不发——见 `tool-display.ts`：宁可少一条进度，
    // 也不把函数名摆给车主，更不编一句"正在查询"。
    if (!display) return;
    try {
      publishToTurn(threadId, events.toolCall(callId, name, display, status));
    } catch {
      // 吞掉：进度提示坏了不该让工具调用坏。
    }
  };

  setToolStartObserver((o) => {
    publishToolProgress(o.callId, o.name, o.ctx.sessionId, "started");
  });

  // fake 是离线路径（无 pi、无网络也要能跑单测与 e2e），显式绕过 ACP。
  const useAcp =
    (process.env.CARLIFE_AGENT_RUNTIME ?? "acp") === "acp" && process.env.CARLIFE_LLM !== "fake";
  // **按 Agent 分进程**（见 pool.ts）：工具表是进程级的，共用一个进程就等于
  // 六个 Agent 共用 supervisor 的工具表——出行分支手上没有 calendar，
  // 主线后半段结构上不可能发生，而模型只会说"已写入日历"。
  const acpClient = useAcp ? new AcpClientPool() : undefined;
  // 包一层耗时埋点（TD-08）：**两条路径都包**——ACP 与直连实现的慢法不同，
  // 但"这次调用花了多久、多久才出第一个字"这个问题对两者是同一个。
  // 包装原样透传 hooks（threadId / agent），否则 pi 侧会落错 ACP 会话（见 traced.ts）。
  const streamer = withLlmSpans(
    acpClient === undefined
      ? directStreamer
      : createAcpStreamer(acpClient, (hooks) => ({
          // thread id 即会话维度（turn-runner 生成，形如 `${sessionId}#${ts}`）。
          carlifeSessionId: hooks?.threadId ?? "unknown-session",
          // 每个 (会话 × Agent) 一个独立 ACP 会话（F-12-05 / AC-12-7）：
          // 意图理解与应答因此不共享上下文，与 §11 时序一致。
          agent: (hooks?.agent as AgentName | undefined) ?? "supervisor",
        })),
  );
  if (acpClient) {
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.once(sig, () => acpClient.dispose());
    }
    // 工具调用从 pi 侧回来时只带 ACP 会话 id。装上反解，工具日志与权限门才拿得到
    // CarLife 的 session_id（F-07-07）——没有它，interrupt 找不到该挂起哪一路 SSE。
    setSessionResolver((acpSessionId) => acpClient.resolveSession(acpSessionId));
    // 启动自检（F-42-12）：pi 扩展没被加载是**无症状故障**——模型手里零工具、
    // 转而编造答案，不报错不告警。所以这条检查必须在启动期喊出来，
    // 而不是等第一次工具调用（那时只会看到"模型没调工具"这种无从下手的现象）。
    // 不因失败退出：pi 侧问题不该拖垮已能提供文本对话的服务，重连逻辑会持续尝试。
    void acpClient
      .selfCheck(() => getToolEndpointStats().describeCalls)
      .then((r) =>
        r.ok
          ? console.log(`[runtime] ACP 自检通过：${r.detail}`)
          : console.error(`[runtime] ⚠️ ACP 自检未通过：${r.detail}`),
      )
      .catch((e) => console.error("[runtime] ACP 自检异常", e));
  }

  /**
   * 权限门拿到的 `sessionId` 其实是 **threadId**（`carlifeSessionId: hooks?.threadId`，
   * 见上面 ACP streamer 的装配）。换算成真会话 id 再落轨迹（TD-08 任务 1）——
   *
   * 此前直接拿它当会话 id 写库，而图节点写的是真会话 id，于是回放页按真会话 id
   * 查不到任何 `guard` / `interrupt` / `resume`，且会话列表里一次对话裂成两条。
   * 症状是"这次没有安全裁决"，与"确实没裁决"长得一模一样。
   *
   * 换算不到时**保留原值并标 keyFallback**——丢掉的话就再也查不出为什么少。
   */
  const traceKeyFor = (threadIdOrSession: string, turnId?: string) => {
    const key = resolveTraceKey(threadIdOrSession);
    return { sessionId: key.sessionId, turnId: turnId ?? key.turnId, fallback: key.fallback };
  };

  // 动作权限门（M5-02 / §8.4）。裁决全量落审计——**含放行**（§8.5）：
  // 只记拦截的系统永远不知道自己漏了什么。
  const guardGate = new GuardGate({
    onInterrupt: ({ interruptId, request }) => {
      console.log(`[guard] 需确认 session=${request.sessionId} tool=${request.tool} interrupt=${interruptId}`);
      const key = traceKeyFor(request.sessionId, request.turnId);
      trace.record(
        key.sessionId,
        "interrupt",
        { interruptId, tool: request.tool, ...(key.fallback ? { keyFallback: true } : {}) },
        key.turnId,
      );

      // **publishToTurn 仍按 threadId**（本模块按 threadId 登记，见 interrupt-bus 文件头）——
      // 换算只用于落轨迹，路由不动。
      // 推进本轮事件流 → 网关原样转发到 SSE → 端上弹确认（§3，不新建通道）。
      // **送不出去要喊**：静默的话现象是"助手不说话了"，
      // 而工具调用会一直挂到超时收敛——排查方向完全不指向权限门。
      const delivered = publishToTurn(request.sessionId, {
        type: "permission",
        interruptId,
        action: request.tool,
        title: `需要你确认：${request.tool}`,
        // 明细必须是具体内容而不是动作名（F-04-02）——用户要看清楚批的是什么。
        // 首行是动作摘要，其后是调用方给的逐条明细（如行程的逐日安排）。
        details: [
          { label: "动作", value: request.summary ?? request.tool },
          ...(request.details ?? []).map((d) => splitLabelled(d)),
        ],
        /*
         * 外发的个人信息**单独一段**（M15-04，F-26-09 / AC-15-7）。
         *
         * 此前它是 `details` 里一堆 label 都写着"明细"的行——混在门店地址中间，
         * 用户不会意识到这几行的性质完全不同。协议加了独立字段之后，
         * 端上才有可能把它渲染成"将提供给门店的信息"那一块。
         *
         * 值在生成侧（`describeDisclosure`）已掩码，这里只做 `字段：值` 的拆分。
         */
        disclosure: (request.disclosures ?? []).map((d) => splitLabelled(d, "信息")),
        scope: request.agent ?? null,
      } as SessionEvent);
      if (!delivered) {
        console.error(
          `[guard] ⚠️ 中断 ${interruptId} 没有出口（会话 ${request.sessionId} 本轮的流已关闭）——` +
            `用户不会看到确认弹窗，这次调用会一直挂到超时`,
        );
      }
    },
    onAudit: ({ request, result, durationMs }) => {
      console.log(
        `[guard] ${result.decision} session=${request.sessionId} tool=${request.tool} ${durationMs}ms — ${result.reason}`,
      );
      // 含放行的全量裁决审计（§8.5）同时进轨迹——回放要能展示安全链路（F-29-07）。
      // **这条此前落错了会话键，回放页一条都读不到**（见 traceKeyFor 的说明）。
      const key = traceKeyFor(request.sessionId, request.turnId);
      trace.record(
        key.sessionId,
        "guard",
        {
          tool: request.tool,
          decision: result.decision,
          reason: result.reason,
          durationMs,
          ...(key.fallback ? { keyFallback: true } : {}),
        },
        key.turnId,
      );
      // 权限门本身也是一跳（敏感工具每次都过）。需确认时它包含**人在等**的那一段——
      // 那是全链路最长的一跳，但它慢不是系统的问题，必须能与"系统慢"分开看，
      // 所以 detail 带上裁决（allow / confirm / deny）。
      // 单取一次时钟：两次 Date.now() 会让起止各自漂移几毫秒。
      const endedAt = Date.now();
      recordSpan(request.sessionId, "guard.action", endedAt - durationMs, endedAt, "ok", {
        agent: request.agent ?? undefined,
        detail: result.decision,
      });
      // 保留用的那一份（M37-04）：轨迹会被 prune，这份进 guard_audit_logs 不删。
      guardAuditor.record({
        sessionId: request.sessionId,
        turnId: request.turnId,
        layer: "action_gate",
        decision: result.decision,
        tool: request.tool,
        reason: result.reason,
        durationMs,
      });
    },
  });
  setGuardGate(guardGate);

  // 内容管线（M6-01/02，§8 前三层）。审核模型（Qwen3Guard-Gen）归 M6-03，
  // 未注入时规则筛与脱敏照常生效，且结果里显式标注"审核层未跑"——不假装跑过。
  // 审核模型按配置接入（M6-03）：GUARD_BASE_URL 留空即未接入——
  // 此时规则筛与脱敏照常生效，结果显式标注未审核（不假装跑过）。
  const guardValues = await config.runtimeValues();
  const provider = (guardValues.get("GUARD_PROVIDER") ?? "aliyun").trim();

  /*
   * 审核层按供应商装配（TD-04）。
   *
   * 两套并存不是首鼠两端：审核层是安全边界，**不该被单一供应商的可用性绑死**。
   * 阿里云是托管服务（判得更全，含提示词攻击），openai-compat 那条留着，
   * 是为了在它出问题时能换回自建/本地模型而不必改代码。
   *
   * 装不上时一律回落到"未接入"并**出声**——规则筛与脱敏照常生效，
   * 且裁决里显式标注这一层没跑（`moderationSkipped`），不假装跑过。
   */
  let moderation: ContentGuard | undefined;
  let providerNote = "未接入（规则筛与脱敏仍生效）";

  if (provider === "aliyun") {
    const ak = guardValues.get("Aliyun_AccessKey_ID")?.trim();
    const sk = guardValues.get("Aliyun_AccessKey_Secret")?.trim();
    if (ak && sk) {
      moderation = createAliyunContentGuard(
        createAliyunGuardClient({
          accessKeyId: ak,
          accessKeySecret: sk,
          endpoint:
            guardValues.get("ALIYUN_GUARD_ENDPOINT")?.trim() ||
            "https://green-cip.cn-shanghai.aliyuncs.com",
          timeoutMs: Number(guardValues.get("ALIYUN_GUARD_TIMEOUT_MS") ?? 5_000),
        }),
        // 默认 pro：非 pro 版不返回 sensitiveData，控制台开了也白开
        { pro: (guardValues.get("ALIYUN_GUARD_PRO") ?? "true").trim() !== "false" },
      );
      providerNote = "阿里云 AI 安全护栏（green-cip）";
    } else {
      providerNote = "未接入——GUARD_PROVIDER=aliyun 但缺 Aliyun_AccessKey_ID/Secret";
    }
  } else if (provider === "openai-compat") {
    const guardBaseUrl = guardValues.get("GUARD_BASE_URL")?.trim();
    if (guardBaseUrl) {
      moderation = createContentGuard(
        guardValues.get("GUARD_MODEL") ?? "qwen3guard-gen",
        createOpenAiCompatClient({
          baseUrl: guardBaseUrl,
          apiKey: guardValues.get("GUARD_API_KEY"),
          model: guardValues.get("GUARD_MODEL") ?? "qwen3guard-gen",
          timeoutMs: Number(guardValues.get("GUARD_TIMEOUT_MS") ?? 10_000),
        }),
      );
      providerNote = `自建模型 ${guardValues.get("GUARD_MODEL") ?? "qwen3guard-gen"}`;
    } else {
      providerNote = "未接入——GUARD_PROVIDER=openai-compat 但 GUARD_BASE_URL 为空";
    }
  }

  console.log(`[guardrails] 内容审核层：${providerNote}`);
  if (!moderation) {
    // 未接入不是错误状态，但必须显眼：它意味着这条安全边界当前只剩规则筛与脱敏
    console.warn("[guardrails] ⚠ 审核层未接入——裁决会标注 moderationSkipped，不会假装审过");
  }

  const guards = new GuardPipeline({
    moderation,
    onAudit: ({ stage, allowed, reason, ruleId }) =>
      console.log(`[guardrails] ${stage} ${allowed ? "allow" : "deny"}${ruleId ? ` rule=${ruleId}` : ""}${reason ? ` — ${reason}` : ""}`),
  });

  // ── 双路检索的两个后端（M8-02 收口，§6）────────────────────────
  //
  // 两路都**显式装配**，且各自的"未接入"状态要能被看见：只查到一路时
  // 系统仍会作答（降级），但它必须知道自己缺了什么，才能如实告诉用户
  // ——"看起来个性化、实际是通用答案"是最坏形态（F-16-08）。

  // ⑥用车数据：Trip 表在同一个 PG，直接接。
  const tripRepo = createTripRepository(prisma);
  setUsageStore(tripRepo);
  /*
   * ⑥ 补能流水（M26-06）：**油侧能耗唯一的数据源**。
   *
   * 电侧的能耗能从 `Trip` 的实测续航折算，油侧一条都没有——不接它，
   * "这趟 500 公里要多少油"就只能取厂标，而厂标与真实油耗能差三成。
   * 与 `energy_gap` 同一个 Sprint 落地，不留「字段与消费者先于数据源」的口子
   * （ADR-002 第 3 类）。
   */
  setRefuelStore(createRefuelRepository(prisma));
  // 常用人员（M17-03，F-46-09）：名单与按人画像同库直接接。
  // **注入了才有数据源**——工具单测全绿不等于生产里读得到东西（M7-03/04 的教训）。
  setMemberStores(createVehicleMemberRepository(prisma), tripRepo);
  /*
   * 会话 → 用户（M19-06）。`contact_lookup` 这类用户维度的工具靠它拿到 userId——
   * 模型不知道 userId 是什么，写成必填只会让它编一个。
   *
   * 缓存是必需的而不是优化：不缓存的话**每一次工具调用**都多一次库查，
   * 而它的值在会话生命周期内不会变。上限只是防会话表被扫崩，超了整体丢弃即可。
   */
  const sessionUsers = new Map<string, string>();
  setSessionUserResolver(async (rawId) => {
    /*
     * **先把 threadId 换算成真会话 id**（M13-12 实测）。
     *
     * 这里拿到的常常是 `${sessionId}#${ts}` 形状的 threadId——ACP 装配层把
     * `carlifeSessionId` 直接填成了 threadId（见上面 createAcpStreamer 那段）。
     * 拿它去 `sessions` 表按主键查是**查不到行**的，于是解析器返回 undefined，
     * `withUserId` 只好放过模型自己编的那个 userId。
     *
     * 后果全程无报错：`trip_plan_list` 查的是一个不存在的用户，稳定返回 0 条，
     * 模型据此回答"没查到"——而车主主页上那 4 份行程一直挂着。
     * 排查了三轮才定位到这一行，因为每一层看起来都正常。
     *
     * `resolveTraceKey` 是仓里已有的换算（轨迹落库同款），复用它而不是
     * 自己再写一遍 split("#")：两处各写一份，迟早只改一处。
     */
    const sessionId = resolveTraceKey(rawId).sessionId;
    const hit = sessionUsers.get(sessionId);
    if (hit) return hit;
    const row = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!row?.userId) {
      // 喊出来：查不到的后果是"工具按模型编的 id 去查"，而那是静默的。
      console.warn(
        `[tools] 会话 → 用户解析失败（raw=${rawId} → ${sessionId}）——` +
          `用户维度的工具这次会查错人或查空`,
      );
      return undefined;
    }
    if (sessionUsers.size > 5_000) sessionUsers.clear();
    sessionUsers.set(sessionId, row.userId);
    return row.userId;
  });
  /*
   * 会话的可见域上下文（M48-06，F-57-03）。与上面的 userId 解析共用同一次查库结果，
   * 但**返回三态**：`{userId: null}` 是访客（车机声明了访客模式），
   * `undefined` 是查不到——后者不该被当成访客降级（那会让一次库抖动
   * 静默把真实用户降级，而降级本该是播报出来的）。
   *
   * 角色按"这个人对他的默认车"算：工具调用这一层拿不到本轮的 vin
   * （它在图状态里，而工具端点只有 sessionId）。默认车是既有的
   * "当前车辆"口径（F-23-09），与工具自己解析车辆时用的是同一个。
   */
  // 角色判定的唯一入口（M48-01 的 roleFor），与网关侧共用同一份实现。
  const grantRepoForRuntime = createVehicleGrantRepository(prisma);
  setSessionAccessResolver(async (rawId) => {
    const sessionId = resolveTraceKey(rawId).sessionId;
    const row = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    });
    if (!row) return undefined;
    if (!row.userId) return { userId: null, role: null };
    const vehicle = await prisma.vehicle.findFirst({
      where: { ownerId: row.userId, isDefault: true },
      select: { vin: true },
    });
    const role = vehicle
      ? await grantRepoForRuntime.roleFor(row.userId, vehicle.vin)
      : /*
         * 没有默认车 = 他名下没车。此时对"车主专属工具"的判定应当是拒绝，
         * 而不是放过——放过的话，一个没有车的人可以去写别人车的档案
         * （工具入参里的 vin 由模型给）。
         */
        null;
    return { userId: row.userId, role };
  });

  // 同行者约束带入（M17-05，F-46-10）：图这一层也要能读名单。
  // 未注入时 `intentNode` 照旧只用原话抽取——档案是补充，不是前置条件。
  setGraphMemberStore(createVehicleMemberRepository(prisma));
  /*
   * 座舱偏好（M24 收口，全面 A 型）。三样注入：
   *  · 偏好写入的仓储（`member_preference_set`，写前过权限门）
   *  · 「按人调好」的求解器与两个仓储（`cabin_apply_preferences`）
   * 翻译器仍是 `graph/cabin-translate.ts` 那个纯函数，一行未改——
   * 变的只是触发它的人从编排层换成了模型（§4.5）。
   */
  const memberRepo = createVehicleMemberRepository(prisma);
  const combinationRepo = createMemberCombinationRepository(prisma);
  setPreferenceMemberStore(memberRepo);
  setCabinApplyDeps({ translate: translateCabinPlan, members: memberRepo, combinations: combinationRepo });
  setCompanionFlagStore(createUserFlagRepository(prisma));
  // ④车辆档案：同库，强一致、不衰减、仅事件驱动更新（§7④）。
  // M14-01（F-23-13）：读走短 TTL 缓存、写路径同步失效——写后立即可见是硬性质，
  // 缓存只许影响读延迟。Redis 不可用 → 裸仓储直连，行为与无缓存时一致。
  const vehicleRepo = createVehicleRepository(prisma);
  const vehicleCacheBackend = await createRedisVehicleCacheBackend(process.env.REDIS_URL?.trim());
  const vehicleStoreForCabin =
    vehicleCacheBackend ? createCachedVehicleStore(vehicleRepo, vehicleCacheBackend) : vehicleRepo;
  setVehicleStore(vehicleStoreForCabin);
  /*
   * ④⑥ 新鲜度阈值（M26-02，AC-53-2）：**代码里不写死**，走 C 策略值热配置。
   *
   * 传的是 `getFreshnessThresholds` 本身而不是它的返回值——传值等于在进程启动那一刻
   * 把阈值定死，改一次配置要重启，AC-53-2 的"热生效"就落不了地。
   * 该函数自带 30s TTL（与 guard 策略同一段），所以这里不再另造缓存。
   */
  setFreshnessThresholds(() => getFreshnessThresholds());
  // 拒答冷却（M26-03）：独立表，**不挂在 Vehicle 上**——挂上去就会跟着档案读路径
  // 流到每个下游，而它们本不该知道车主拒答过（§4.6 约束 4）。
  const elicitationCooldownRepo = createElicitationCooldownRepository(prisma);
  // 补录留痕（M26-05，F-53-12）：走既有审计通道，**不新建表**。
  const auditRepo = createAuditRepository(prisma);
  // ⑥ 补能流水的读侧（M26-07）：算实测油耗要它。写侧已注入 enterprise/backend/shared/tools。
  const refuelRepo = createRefuelRepository(prisma);
  const tripPlanRepo = createTripPlanRepository(prisma);
  console.log(
    vehicleCacheBackend
      ? "[vehicle-cache] ④档案读缓存已接入（写后同步失效）"
      : "[vehicle-cache] ④档案读缓存未接入（Redis 不可用或未配置）——读直连 PG",
  );
  /**
   * 导览采集队列（ACR-008）。声明在前、装配在后（要等 ACP streamer 就绪）：
   * commit 只会发生在服务起来之后，晚绑定安全；`GUIDE_QUEUE` 关着时恒为
   * undefined，下面的包装层是纯透传。
   */
  let guideQueue: import("./guide-queue").GuideQueue | undefined;

  // 已确认行程（M13-01）：同库；确认的行程是承诺不是聊天，不进 Mem0 不衰减。
  //
  // ACR-008：在注入层包一手 commit/update——行程确认/变更即触发导览逐景点入队。
  // 挂在这里而不是 supervisor：这是"确认过的行程"流经的唯一水管口，
  // 且开关关着（queue 未装配）时是纯透传，行为一字不变。
  // 入队 fire-and-forget：预采集失败不许影响"确认行程"这个主动作（M20-06 同款吞法）。
  const guideEnqueueOnCommit = (plan: import("@carlife/shared").TripPlanSnapshot) => {
    void guideQueue
      ?.enqueuePlan(plan)
      .then(({ enqueued, skipped }) => {
        if (enqueued > 0) console.log(`[guide-queue] 行程落定 → 入队 ${enqueued} 个景点（跳过 ${skipped}）`);
      })
      .catch((err) => console.warn("[guide-queue] 入队失败（预采集这次不做，点击路径不受影响）", err));
  };
  setTripPlanStore(
    (() => {
      const repo = createTripPlanRepository(prisma);
      /*
       * 目的地推荐的后台补算（M32-02 修订）。挂在与导览入队**同一个水管口**：
       * "确认过的行程"只从这里流过，且两者的形态一模一样——都是十几秒的副作用，
       * 都不许拖慢确认那一跳，都在失败时只记一行日志。
       *
       * 传的是**裸 repo**：补算完要写回，走包装过的 update 会再触发一次补算与入队。
       */
      const highlights = createHighlightsBackfill(repo);
      return {
        ...repo,
        commit: async (userId, sessionId, plan) => {
          const row = await repo.commit(userId, sessionId, plan);
          guideEnqueueOnCommit(plan);
          highlights.schedule({ userId, planId: row.planId, sessionId, plan: row.plan });
          return row;
        },
        update: async (userId, planId, sessionId, plan) => {
          /*
           * 行程变更 → 推荐重新生成（用户走查定的）。
           *
           * 新快照多半不带这一栏（它从来不在图状态里），而库里那份可能属于**另一个目的地**。
           * `carryOverHighlights` 决定这十几秒里屏幕上放什么：同目的地沿用旧的，
           * 换了目的地立刻清掉——错的推荐比暂时没有推荐糟。
           */
          const prior = await repo.currentForUser(userId);
          const merged = carryOverHighlights(prior?.planId === planId ? prior.plan : undefined, plan);
          const row = await repo.update(userId, planId, sessionId, merged);
          if (row) {
            guideEnqueueOnCommit(merged);
            highlights.schedule({ userId, planId, sessionId, plan: row.plan });
          }
          return row;
        },
      };
    })(),
  );
  // 路径体检审计（route_audit）：第一条记录即「LLM 第一版顺序」，后台前后对比吃它。
  setRouteAuditStore(createTripRouteAuditRepository(prisma));
  // 分支结论提交通道（M30-01）：①Working 层进程内暂存，轮结束即弃。
  setBranchSubmissionSink({ record: (ctx, tool, payload) => recordSubmission(ctx, tool, payload) });
  // web_search 结果的按轮白名单（M36-01）：出处全等校验的依据，同为①Working 层。
  setSearchResultRecorder({ record: (ctx, results) => recordSearchResults(ctx, results) });
  // map_route 休息点候选的按轮白名单（M66-02）：出发导航的途经点零信任校验依据，同为①Working 层。
  setRestStopCandidateRecorder({ record: (ctx, stops, summary) => recordRestStopCandidates(ctx, stops, summary) });
  // 一次性标记（M14-03，F-23-12）：建档引导"只提示一次"的持久承载。
  setUserFlagStore(createUserFlagRepository(prisma));

  // ③偏好：座舱陪伴的唯一真实性抓手（US-19）。
  //
  // **读失败不吞成空列表**。零结果会被上层当成"这个用户还没有偏好"，
  // 于是一次 Mem0 故障被说成"我还不太了解你"——听起来无害，实际是拿谎话盖故障。
  // 这里把异常转成 degraded=true 交上去，由 cabin 决定怎么说。
  // ③偏好**写入**（M11-02）。读那一半由 `setPreferenceStore` 提供（座舱用），
  // 写这一半走 upsert：同领域更新而不是追加，否则③会堆着一串近义句下不去。
  setPreferenceWriter(async ({ userId, domain, content, confidence, evidence }) => {
    const client = getMemoryClient();
    return client.upsertPreference(userId, domain, content, {
      confidence,
      lastConfirmedAt: new Date().toISOString(),
      evidence,
      // 与 demo:seed 的模拟数据区分开：这条是系统真学到的。
      provenance: "learned",
    });
  });

  // ②情景（M11-03）：写按事件指纹去重，读带发生时间。
  /*
   * ⑤环境缓存（M11-04，§7⑤）。
   *
   * 连不上 Redis **不是错误**：缓存不可用只是慢，不该让出行规划整个失败。
   * 但降级要计数并出现在健康页——静默降级的话，
   * "缓存一直没生效"这件事没有任何人会发现。
   */
  const redisUrl = process.env.REDIS_URL?.trim();
  let envCacheWired = false;
  /*
   * 库里现存多少条（供健康页/控制台显示）。
   *
   * **周期性刷新而不是每次健康检查都 SCAN**：健康端点被大屏每 10 秒轮一次，
   * 每次都扫一遍 Redis 是拿观测去压被观测的东西。60 秒的新鲜度对
   * "缓存里有没有东西"这个问题完全够用。
   *
   * 取不到时保持 `undefined`——页面据此说"数不到"，而不是显示 0。
   */
  let cachedKeyCount: number | undefined;
  /** ⑤缓存后端的引用（ACR-008）：导览队列拿它判"这个景点是否已有内容"。 */
  let envCacheBackend: Awaited<ReturnType<typeof createRedisEnvCache>>;
  if (redisUrl) {
    const cache = await createRedisEnvCache(redisUrl);
    setEnvCache(cache);
    envCacheBackend = cache;
    envCacheWired = cache !== undefined;
    if (cache?.size) {
      const refresh = () => {
        void cache
          .size!()
          .then((n) => {
            cachedKeyCount = n;
          })
          .catch(() => {
            // 数不到就保持上一次的值/undefined：这是观测，不该因为它出错而喊。
          });
      };
      refresh();
      setInterval(refresh, 60_000).unref();
    }
    console.log(
      cache
        ? `[env-cache] ⑤环境缓存已接入（${redisUrl}）`
        : "[env-cache] ⑤连接失败，外部调用将全部直连（功能不受影响，只是慢且费配额）",
    );
  } else {
    console.log("[env-cache] ⑤环境缓存未接入（REDIS_URL 未配置）——外部调用全部直连");
  }

  setEpisodeWriter(async ({ userId, fingerprint, content, subType, occurredAt, occurredAtInferred, evidence }) => {
    const client = getMemoryClient();
    return client.upsertEpisodic(userId, fingerprint, content, {
      subType: subType as "trip" | "consultation" | "incident" | "interaction",
      // **用户陈述的发生时间**，不是写入时间——填错会让衰减把旧事当新鲜事。
      occurredAt: new Date(occurredAt).toISOString(),
      occurredAtInferred,
      evidence,
      provenance: "learned",
    });
  });
  setEpisodeReader(async (userId, query) => getMemoryClient().recallEpisodes(userId, query, 5));

  setPreferenceStore({
    async recall(userId, query, limit) {
      const client = getMemoryClient();
      try {
        const r = query
          ? await client.searchPreference(userId, query, limit)
          : await client.search(userId, "", { category: "preference" }, limit);
        return {
          preferences: (r.results ?? []).map((m) => ({
            content: String(m.memory ?? ""),
            score: typeof m.score === "number" ? m.score : undefined,
            domain: (m.metadata as { domain?: string } | undefined)?.domain,
            confidence: (m.metadata as { confidence?: number } | undefined)?.confidence,
          })),
          degraded: r.degraded === true,
        };
      } catch (err) {
        console.warn("[memory] ③偏好检索失败，按降级上报（不当成「没有偏好」）", err);
        return { preferences: [], degraded: true };
      }
    },
  });

  // RAGFlow 是 Cloud 托管，未配置时保持未接入。**不给假数据顶上**：
  // 空结果会被上层当成"说明书里没写这件事"，那是错误信息。
  const ragBaseUrl = guardValues.get("RAGFLOW_BASE_URL")?.trim();
  const ragApiKey = guardValues.get("RAGFLOW_API_KEY")?.trim();
  if (ragBaseUrl && ragApiKey) {
    setRagClient(
      createRagClient({
        baseUrl: ragBaseUrl,
        apiKey: ragApiKey,
        datasetIds: {
          "vehicle-manuals": guardValues.get("RAGFLOW_DATASET_VEHICLE_MANUALS") ?? "",
          "repair-kb": guardValues.get("RAGFLOW_DATASET_REPAIR_KB") ?? "",
          "car-catalog": guardValues.get("RAGFLOW_DATASET_CAR_CATALOG") ?? "",
        },
      }),
    );
  }
  console.log(
    `[rag] RAGFlow：${ragBaseUrl && ragApiKey ? "已接入" : "未接入（双路检索将只有⑥这一路）"}`,
  );

  // 地图与天气（M10-01）。未配 key 的后果是**两件不同的事**，日志要分开说：
  //   map_route 直接返回"未接入"（没有假路线可编）；
  //   weather 退回 Open-Meteo——还能用，但没有中文天气现象，也不是国内路网口径。
  const amapKey = guardValues.get("AMAP_SERVER_KEY")?.trim();
  if (amapKey) setAmapClient(createAmapClient({ key: amapKey }));
  console.log(
    `[map] 高德：${amapKey ? "已接入（weather 走高德，map_route 可用）" : "未接入（weather 退回 Open-Meteo，map_route 不可用）"}`,
  );

  /*
   * 目的地推荐的联网搜索（M32-01）。走 DeepSeek 的 **Anthropic 兼容端点**声明服务端工具
   * `web_search`，与 `src/llm` 那条 OpenAI 兼容路径是两条腿——所以模型名也是两个：
   * `DEEPSEEK_MODEL`（对话，现值 deepseek-chat）与 `DEEPSEEK_SEARCH_MODEL`（搜索）。
   * 让它俩共用一个来源的话，有人调其中一个就会连坐另一个（同 `llm/index.ts` 的那段注释）。
   *
   * 未配 key 时**不注入**：工具据此抛 unconfigured，卡上就没有推荐这一页——
   * 而不是给一份凭记忆编的推荐（`destination-highlights.ts` 文件头）。
   */
  const searchKey = guardValues.get("DEEPSEEK_API_KEY")?.trim();
  if (searchKey) {
    setDestinationSearch({
      apiKey: searchKey,
      baseUrl:
        guardValues.get("DEEPSEEK_ANTHROPIC_BASE_URL")?.trim() ||
        "https://api.deepseek.com/anthropic",
      model: guardValues.get("DEEPSEEK_SEARCH_MODEL")?.trim() || "deepseek-v4-flash",
    });
  }
  console.log(
    `[search] 目的地推荐联网搜索：${searchKey ? "已接入（DeepSeek web_search）" : "未接入（不出目的地推荐卡）"}`,
  );

  /*
   * 模拟经销商系统（M19-02）。
   *
   * **注入口留了不等于接上了**：`car_catalog` 的同款注入口留了却从没被替换过，
   * 任何调用都抛 unconfigured，因为它零调用点所以很久没被发现（M15-01 才修）。
   * 所以这里除了注入，启动时还**真调一次** `/pricing` 探活——
   * 探不通就明说未接入，而不是等到用户问门店时才发现。
   */
  const dealerUrl = (process.env.MOCK_DEALER_URL ?? "").trim();
  const repairUrl = (process.env.MOCK_REPAIR_URL ?? "").trim();
  if (dealerUrl) {
    const dealer = createHttpDealerBackend(dealerUrl);
    setDealerBackend(dealer);
    // fire-and-forget：探活失败不该拖住启动，但**必须出声**。
    void (async () => {
      try {
        const r = await getDealerBackend()!.pricing({ model: "Model 3" });
        console.log(`[dealer] 门店系统已接入（${dealerUrl}，车型报价 ${r.trims.length} 条）`);
      } catch (err) {
        console.error(
          `[dealer] ⚠️ 门店系统探活失败（${dealerUrl}）：${err instanceof Error ? err.message : String(err)}` +
            "——门店/时段/价格三项查询会如实报未连通，不会编门店名",
        );
      }
    })();
  } else {
    console.log("[dealer] 门店系统未接入（MOCK_DEALER_URL 未配）——问门店与时段会如实说查不到");
  }

  /*
   * 模拟 4S 维修系统（M41-03）。维修预约的终点从 dealer 的 service 门店挪到这里
   * （M41-00 决策 1）：`appointment` 的装配优先级是 **repair > 内存 mock**——
   * dealer 不再自动接管维修预约（`createDealerAppointmentBackend` 保留为可显式
   * 装配的降级路，但不在这条默认链上）。未配 URL 时保持内存 mock，与既有测试一致。
   */
  if (repairUrl) {
    const repair = createHttpRepairBackend(repairUrl);
    setRepairBackend(repair);
    setAppointmentBackend(createRepairAppointmentBackend(repair));
    void (async () => {
      try {
        const h = await repair.history("DEM00SEED0M0DELY1");
        console.log(`[repair] 维修系统已接入（${repairUrl}，演示车历史 ${h.records.length} 条）`);
      } catch (err) {
        console.error(
          `[repair] ⚠️ 维修系统探活失败（${repairUrl}）：${err instanceof Error ? err.message : String(err)}` +
            "——维修记录/报价单/维修预约会如实报未连通，不会编维修站名",
        );
      }
    })();
  } else {
    console.log("[repair] 维修系统未接入（MOCK_REPAIR_URL 未配）——维修预约走内存 mock，历史与报价单查不到");
  }

  /*
   * 模拟保险系统（M41-03）。只读（保单 + 理赔预检），无预约类副作用。
   * precheck 的报价单由工具层自己从维修系统取——金额不经过模型的手。
   */
  const insuranceUrl = (process.env.MOCK_INSURANCE_URL ?? "").trim();
  if (insuranceUrl) {
    const insurance = createHttpInsuranceBackend(insuranceUrl);
    setInsuranceBackend(insurance);
    void (async () => {
      try {
        const p = await getInsuranceBackend()!.policies("DEM00SEED0M0DELY1");
        console.log(`[insurance] 保险系统已接入（${insuranceUrl}，演示车保单 ${p.policies.length} 张）`);
      } catch (err) {
        console.error(
          `[insurance] ⚠️ 保险系统探活失败（${insuranceUrl}）：${err instanceof Error ? err.message : String(err)}` +
            "——保单与理赔预检会如实报未连通，不会编保险金额",
        );
      }
    })();
  } else {
    console.log("[insurance] 保险系统未接入（MOCK_INSURANCE_URL 未配）——问保单与理赔会如实说查不到");
  }

  /*
   * 日历后端装配（M43-02，F-31-01/03/07/10）。
   *
   * `CARLIFE_CALENDAR_BACKEND = mock | google | caldav | both`，默认 mock。
   * **显式选了真后端但凭证不齐 → 启动抛错**，不静默回 mock：写日历是用户确认过的
   * 副作用动作，静默降级会让"确认写入"落到假后端，用户以为写进真日历了。
   */
  {
    const calendarMode = (process.env.CARLIFE_CALENDAR_BACKEND ?? "mock").trim();
    const needEnv = (key: string): string => {
      const v = (process.env[key] ?? "").trim();
      if (!v) throw new Error(`CARLIFE_CALENDAR_BACKEND=${calendarMode} 但缺少 ${key}——配齐凭证或改回 mock`);
      return v;
    };
    const makeGoogle = () =>
      createGoogleCalendarBackend({
        clientId: needEnv("GOOGLE_CAL_CLIENT_ID"),
        clientSecret: needEnv("GOOGLE_CAL_CLIENT_SECRET"),
        refreshToken: needEnv("GOOGLE_CAL_REFRESH_TOKEN"),
        calendarId: needEnv("GOOGLE_CAL_CALENDAR_ID"),
      });
    const makeCaldav = () =>
      createCaldavBackend({
        appleId: needEnv("APPLE_CALDAV_APPLE_ID"),
        appPassword: needEnv("APPLE_CALDAV_APP_PASSWORD"),
        calendarUrl: (process.env.APPLE_CALDAV_URL ?? "").trim() || undefined,
      });
    if (calendarMode === "google") {
      setCalendarBackend(makeGoogle());
      console.log("[calendar] 日历后端：Google（真实写入 + freeBusy 读）");
    } else if (calendarMode === "caldav") {
      setCalendarBackend(makeCaldav());
      console.log("[calendar] 日历后端：iCloud CalDAV（真实写入；读侧未实现，规划时如实跳过冲突检查）");
    } else if (calendarMode === "both") {
      setCalendarBackend(
        createFanoutCalendarBackend([
          { name: "google", backend: makeGoogle() },
          { name: "caldav", backend: makeCaldav() },
        ]),
      );
      console.log("[calendar] 日历后端：Google + iCloud CalDAV 双写（一次确认两边可见）");
    } else if (calendarMode === "mock") {
      console.log("[calendar] 日历后端：mock（CARLIFE_CALENDAR_BACKEND 未配真实后端，写入是模拟回执）");
    } else {
      throw new Error(`CARLIFE_CALENDAR_BACKEND=${calendarMode} 不认识（可选 mock/google/caldav/both）`);
    }
  }

  /*
   * 模拟车机舒适域（M24-02）。装配逻辑在 cabin/assemble.ts（可测——M15-01 纪律）。
   * 绑定存④档案（cabinVehicleId），mock 重启悬空由 backend 自动重建重绑。
   */
  const cabinBackend = assembleCabin(process.env.MOCK_CABIN_URL, vehicleStoreForCabin);
  if (cabinBackend) {
    // fire-and-forget：探活失败不该拖住启动，但**必须出声**（与 dealer 同一条纪律）。
    void (async () => {
      try {
        const h = await cabinBackend.health();
        console.log(`[cabin] 车机舒适域已接入（synthesizesAnyModel=${h.synthesizesAnyModel === true}）`);
        // 音频单独一行：媒体域是唯一会真出声的域，而"车机接上了"与"接上了但
        // 一声出不了"（没有播放后端 / 曲库是空的）在别的地方看起来完全一样,
        // 只有演示现场点歌那一刻才暴露。
        const a = h.audio;
        if (!a) {
          console.warn("[cabin] ⚠️ 车机没有报告音频能力——多半是旧版 mock-cabin，点歌不会出声");
        } else if (a.backend === "none" || a.playable === 0) {
          console.warn(
            `[cabin] ⚠️ 车机放不出声（后端=${a.backend}，可播曲目=${a.playable}/${a.tracks}）：${a.note}` +
              `——点歌会如实说放不了，不会假装在放。曲库目录：${a.mediaDir}`,
          );
        } else {
          console.log(`[cabin] 车机音频：后端=${a.backend}，可播曲目=${a.playable}/${a.tracks}`);
        }
      } catch (err) {
        console.error(
          `[cabin] ⚠️ 车机探活失败：${err instanceof Error ? err.message : String(err)}` +
            "——座舱设置会如实报车机没连上，不会假装调好",
        );
      }
    })();
  } else {
    console.log("[cabin] 车机未接入（MOCK_CABIN_URL 未配）——座舱设置不可用，会如实说");
  }

  // 中国气象局天气增强（M10-02）。**无 key，所以默认开**——它补的是高德结构性
  // 给不了的那几项：体感温度、湿度、降水实况、气压、风、气象预警，外加把预报
  // 窗口从 4 天拉到 7 天。它是增强不是主干：挂了只少这几个字段，不影响基础预报。
  const cmaOn = (guardValues.get("CARLIFE_WEATHER_CMA") ?? "on").trim() !== "off";
  if (cmaOn) setCmaClient(createCmaClient());
  console.log(
    `[weather] 中国气象局增强：${cmaOn ? "已开启（体感/湿度/降水实况/预警，窗口 7 天）" : "已关闭（CARLIFE_WEATHER_CMA=off，只留基础预报）"}`,
  );


  // ①Working 持久化（M4-06 / §13-3）：PG 就绪则用 PG，否则**明确降级并大声记录**
  // ——降级意味着"重启即丢上下文、挂起的 HITL 会丢"，不能悄悄退回内存。
  const checkpointerHandle = await createCheckpointer();
  await checkpointerHandle.setup();
  if (checkpointerHandle.degradedReason) {
    console.error(`[runtime] ⚠️ 检查点降级：${checkpointerHandle.degradedReason}`);
  } else {
    console.log(`[runtime] 检查点存储：${checkpointerHandle.kind}`);
  }

  /*
   * 表述路径（`CARLIFE_ANSWER_RUNTIME=direct`，施工单 TD-08 第三步）。**默认关**。
   *
   * 分支已经交出求解结果时，应答只剩"把数字说成人话"——不需要工具、不需要推理。
   * 而 pi 上跑的是推理模型，这一步实测要想 10~18 秒，占应答时长 70~84%；
   * 直连非推理模型的同一件事实测 TTFT 0.5~0.7s。
   *
   * **默认不翻**：切换会改变车主看到的那段文字，得先用 `probe:latency` 跑对照。
   * 判据不只是快多少，还有"求解结果里没有的东西它说不说得住"——
   * 这条由 07f9aac 的缺口机制供给，缺了它这条路径就是拿延迟换胡说。
   *
   * 只在 ACP 模式下构造：`useAcp=false` 时主 streamer 本来就是直连/fake，
   * 再插一层只会让离线测试凭空多一条路径。
   */
  const answerRuntime = process.env.CARLIFE_ANSWER_RUNTIME ?? "acp";
  const answerModel = resolveDeepSeekModel(process.env.CARLIFE_ANSWER_MODEL);
  const narrator =
    useAcp && answerRuntime === "direct"
      ? withLlmSpans(
          createConfiguredChatStreamer(config, {
            system: NARRATOR_SYSTEM,
            // 钉死非推理模型，**不跟 DEEPSEEK_MODEL 走**——理由见
            // `ConfiguredStreamerOptions.model` 的说明。
            model: answerModel,
          }),
        )
      : undefined;
  console.log(
    narrator
      ? `[runtime] 表述路径：直连（${answerModel}），仅在分支已出求解结果时接管`
      : "[runtime] 表述路径：随主链路（ACP）",
  );

  // 意图理解节点在 fake/direct 离线路径下关闭：Fake 模型给不出 JSON，
  // 开着只会每轮多一次无意义调用并稳定走降级分支（确定性测试不该依赖模型能力）。
  // 埋点整条链路都是 fire-and-forget：算单价要读配置（异步），
  // 但**绝不能让它挡住 token 流**（AC-44-12）。
  // 抽成具名函数：主链路与垫场话（sidecar-writer）共用同一套计价，
  // 分两处写的话涨价只会改到一处。
  const recordUsageWithPricing = (sample: {
    sessionId: string;
    turnId: string;
    agent: string;
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
    durationMs: number;
    status: "ok" | "failed";
  }): void => {
    void (async () => {
      const values = await config.runtimeValues();
      const perK = (key: string, fallback: number): number => {
        const n = Number(values.get(key));
        return Number.isFinite(n) ? n : fallback;
      };
      usage.record({
        ...sample,
        costEstimate:
          (sample.promptTokens / 1000) * perK("LLM_PRICE_PROMPT_PER_1K", 0.001) +
          (sample.completionTokens / 1000) * perK("LLM_PRICE_COMPLETION_PER_1K", 0.002),
      });
    })().catch((err: unknown) => console.error("[usage] 成本估算失败", err));
  };

  const runner = new TurnRunner(
    buildChatGraph(streamer, {
      enableIntent: useAcp,
      checkpointer: checkpointerHandle.saver,
      narrator,
    }),
    Date.now,
    recordUsageWithPricing,
    // thread 映射落库：检查点持久化的另一半（M4-06 约束 2）。
    createWorkingThreadStore(prisma),
    guards,
    // 图节点的轨迹出口接到落库仓储（M9-01）。此前这个出口是空的——
    // 定义了不等于接上了，回放页会是空的而没有任何报错。
    // 与 `setSpanSink` 同样并列扇出给旁路（M18-02）：`intent` / `route` / `merge`
    // 这几条是 L0 模板真正有话可说的来源，只接 span sink 会漏掉它们。
    (e) => {
      traceRepo.write(e);
      observeTrace(e);
      liveTrace.publish(e);
    },
    /*
     * L1 导游生成器（M18-09）。在这一层注入——`sidecar/` 不许 import `../llm`。
     * 离线路径下为 `undefined`，旁路全程走 L0。
     */
    createFillerWriter(config, recordUsageWithPricing),
    /*
     * 事实补录询问（M26-03，§4.6）。装配在这一层，**状态不进图状态**——
     * AC-53-13 的"拒答不构成新的信息"靠"子图压根读不到它"来保证。
     *
     * `freshness` 直接调 `data_freshness` 工具本身，不另写一份取数逻辑：
     * 工具那边已经把"未接入 / 未建档 / ⑥ 缺一路"三种情况处理干净了。
     */
    createElicitationService({
      /*
       * 档案里此刻的里程（见 service.ts `odometerOf` 的说明）。
       * 走已经装配好的 ④ 读路径，**不新开第三个注入口**——
       * 多一处"忘了注入也不报错"的地方就是多一次静默降级。
       */
      async odometerOf(vin: string) {
        return (await vehicleStoreForCabin.get(vin))?.odometerKm;
      },
      async freshness(userId, vin) {
        const { data } = await dataFreshnessTool.call(
          { userId, vin },
          // 体检不属于任何一轮对话（它是编排层为了"该不该问"做的判定），
          // 所以不挂真实 sessionId——挂上去会让轨迹里多出一条没有对话来源的工具调用。
          { sessionId: "elicitation", agent: "ownership", mode: "real" },
        );
        return data;
      },
      /*
       * 抽取：**理解人话交给模型**（§4.5：不写"识别用户说的是哪个数"的正则）。
       *
       * 走一次结构化输出而不是"让模型自己调工具"，原因是实测出来的：
       * `ownership` 是 B 型子图，应答那一步是**没有工具的直连 narrator**，
       * 模型在这条路上拿不到 `vehicle_profile_write`（M26-04 验收 §5 记了那次真跑）。
       */
      async extract(userText: string) {
        return extractProfileFacts(streamer, userText);
      },
      /*
       * 复述 + 一次确认：走既有权限门，**不新造第二条通路**。
       * `summary` 就是复述本身——车主看到的那一屏写的就是要落库的那几个数。
       */
      async confirm({
        threadKey,
        summary,
        details,
      }: {
        threadKey: string;
        summary: string;
        details: string[];
      }) {
        const r = await guardGate.check({
          /*
           * **必须是 threadId**：`onInterrupt` 里是 `publishToTurn(request.sessionId, …)`，
           * 而中断总线按 threadId 登记（`interrupt-bus.ts` 文件头写着这一条）。
           * 传真会话 id 的后果实测过：运行时打出
           * 「中断 … 没有出口（本轮的流已关闭）」，弹窗永远到不了端上。
           */
          sessionId: threadKey,
          agent: "ownership",
          tool: "vehicle_profile_write",
          summary,
          details,
        });
        return r.decision === "allow";
      },
      write: (input: {
        vin: string;
        op: "maintenance" | "odometer";
        odometerKm: number;
        at?: number;
        items?: string;
      }) =>
        invokeTool(
          "vehicle_profile_write",
          { ...input, source: "owner-stated" },
          { sessionId: "elicitation", agent: "ownership", mode: "real" },
        ),
      listCooldown: (vin: string, since: number) => elicitationCooldownRepo.listActive(vin, since),
      decline: (input: Parameters<typeof elicitationCooldownRepo.decline>[0]) =>
        elicitationCooldownRepo.decline(input),
      // 一次补录问答收口时记的冷却——**不是拒答**（`declineCount` 不加）。
      // 它挡的是"车主明明答过了、档案却没变，于是下一轮又问一遍"的死循环。
      touchCooldown: (input: Parameters<typeof elicitationCooldownRepo.touch>[0]) =>
        elicitationCooldownRepo.touch(input),
      /*
       * 一次补录的留痕（M26-05，F-53-12 / AC-53-12）。
       *
       * 走既有审计通道、**不新建表**。`detail` 里只有车主自己说过的话与我们
       * 复述给他的那句——不额外抽取任何东西（AC-53-12 的"不新增 PII"）。
       */
      // `recordStrict` 而不是 `record`：留痕失败要能被上面那条 catch 看见。
      // 补录改的是用户的档案，"改了但没人知道是怎么改的"不可接受。
      audit: (entry) =>
        auditRepo.recordStrict({
          actor: entry.ownerId,
          actorRole: "system",
          action: "vehicle.elicitation.fill",
          target: entry.vin,
          result: entry.approved ? "ok" : "denied",
          detail: {
            asked: entry.asked,
            answer: entry.answer,
            restatement: entry.restatement,
            written: entry.written,
            // 车主说了但没落库的项。不记的话，"当时为什么没改他的档案"回答不出来。
            ...(entry.ignored?.length ? { ignored: entry.ignored } : {}),
          },
        }),
      /*
       * 出发前上下文（M26-07，F-54-04 / F-54-09）。
       *
       * 触发只认**明确的出发信号**——正路（行程出发时间临近）需要快照里有出发日与
       * 里程，而 `TripPlanSnapshot` 目前没有里程字段（见 M26-07 验收 §6）。
       * 宁可少问：漏问一次的代价是这一趟没算缺口，误问一次的代价是打扰预算被烧掉。
       */
      async pretrip(userId: string, userText: string, markAsked) {
        if (!looksLikeDeparting(userText)) return undefined;
        const vehicle = (await vehicleStoreForCabin.listByOwner(userId))[0];
        if (!vehicle) return undefined;
        const plan = await tripPlanRepo.currentForUser(userId);
        // 里程从**车主这一句话**里取（"这趟 500 公里"）——快照里没有这个字段。
        const distanceKm = parseDistanceKm(userText);
        // 增程车一轮只问一种：按里程判它这一趟以油还是以电为主（F-54-09）。
        const energyType = decisiveEnergyFor(vehicle.energyType, distanceKm);
        const planKey = `${vehicle.vin}#${plan?.planId ?? "adhoc"}#${plan?.plan.updatedTurnId ?? ""}`;
        return { distanceKm, energyType, alreadyAsked: markAsked(planKey) };
      },
      /*
       * 缺口测算（F-54-05）。**余量只作为入参**，不落任何库（AC-54-8）。
       *
       * 能耗优先取 ⑥ 实测，拿不到就明说缺什么——**不回落到一个编出来的数**。
       */
      async energyGap({ userId, vin, level, distanceKm }) {
        const vehicle = await vehicleStoreForCabin.get(vin);
        const trips = await tripRepo.range(userId, Date.now() - 400 * 86_400_000, Date.now(), vin);
        const refuels = await refuelRepo.range(
          userId,
          Date.now() - 400 * 86_400_000,
          Date.now(),
          vin,
        );
        const usage = await loadUsageProfile(tripRepo, userId, Date.now(), 30, vin);
        const measured = measuredEnergyPer100km(
          {
            energyType: vehicle?.energyType,
            trips,
            refuels,
            lowTempRangeKm: usage.summary.lowTempRangeKm,
            mildTempRangeKm: usage.summary.mildTempRangeKm,
            rangeSampleSize: usage.summary.sampleSize,
          },
          Date.now(),
        );
        const gap = computeEnergyGap({
          distanceKm: distanceKm ?? 0,
          consumption: measured.consumption
            ? { ...measured.consumption, source: "measured" }
            : undefined,
          currentLevel: level,
        });
        const lines = [
          "【编排层已完成的求解结果，请据此作答，不要另行推算】",
          `车主报的当前余量：${level.value}${level.unit}`,
          ...(measured.consumption ? [] : [`能耗口径拿不到：${measured.reason ?? "原因未知"}`]),
          ...gap.basis.map((b) => `- ${b}`),
          ...(gap.missing?.length ? [`缺少：${gap.missing.join("、")}`] : []),
          ...(gap.sufficient === true ? ["结论：这趟不用中途补能。**不要再建议一次「保险起见」的停靠**。"] : []),
          ...(gap.sufficient === false ? ["结论：不够，要在路上补。"] : []),
          "表述纪律：给区间与依据，**不要说「一定能开到」「不加也没事」**。",
        ];
        return lines.join("\n");
      },
      // 冷却时长是策略值，与三项阈值同一处热配置（不硬编码）。
      cooldownDays: async () =>
        (await getFreshnessThresholds())?.cooldownDays ?? DEFAULT_ELICITATION_COOLDOWN_DAYS,
      now: Date.now,
    }),
    // 裁决审计（M37-04）：内容管线四层的落库记录在 turn-runner 打
    //（管线 onAudit 没有会话归属），action_gate 在上面 guardGate 的 onAudit 打。
    guardAuditor,
  );
  // 运行时形态与风险摘要（M9-05）：把散落各处的降级状态集中暴露成一个视图。
  setHealthProvider(() => {
    const toolStats = getToolEndpointStats();
    const acpHealth = acpClient?.getHealth();
    return {
      agentRuntime: useAcp ? "acp" : "direct",
      // 由运行时自己报，别处读到的都不作数（见 RuntimeHealth.llm 的说明）。
      llm: process.env.CARLIFE_LLM === "fake" ? "fake" : "real",
      acp: acpHealth
        ? {
            connected: acpHealth.connected,
            restarts: acpHealth.restarts,
            lastError: acpHealth.lastError,
            unmappedUpdates: acpHealth.unmappedUpdates,
          }
        : undefined,
      checkpointer: { kind: checkpointerHandle.kind, degradedReason: checkpointerHandle.degradedReason },
      guardrails: { prefilter: true, moderation: moderation !== undefined, pii: true },
      /*
       * 六类记忆的接线状态（M11-05）。
       *
       * **由这里的装配事实推导，不是常量。** 每一项都指向本文件上方
       * 某个 `setXxx(...)` 是否真的执行过——页面据此显示，
       * 于是"页面说的"与"代码做的"不可能再分家。
       *
       * 走查时那一页写着"②③未接入：Mem0 尚未部署"，而 Mem0 早已部署——
       * 硬编码的状态会随代码演进变成谎话，且没有任何机制会发现。
       */
      memory: [
        {
          id: 1,
          key: "working" as const,
          store: checkpointerHandle.kind === "pg" ? "PostgreSQL 检查点" : "内存检查点（重启即丢）",
          write: true,
          read: true,
        },
        // ②③：写路径在图的 answer 节点（setEpisodeWriter/setPreferenceWriter），
        // 读路径分别是 setEpisodeReader 与 setPreferenceStore。
        { id: 2, key: "episodic" as const, store: "Mem0（pgvector 同库）", write: true, read: true },
        { id: 3, key: "preference" as const, store: "Mem0（pgvector 同库）", write: true, read: true },
        // ④不经 Mem0：VIN 不能被语义近似检索到别的车（F-23-08）。
        { id: 4, key: "vehicle" as const, store: "PostgreSQL（强一致，不衰减）", write: true, read: true },
        {
          id: 5,
          key: "cache" as const,
          store: envCacheWired ? "Redis（TTL 分钟~小时）" : "Redis（未接入）",
          write: envCacheWired,
          read: envCacheWired,
        },
        // ⑥两段式：流水入 PG（网关 telemetry 端点），画像入 Mem0（worker 聚合）。
        { id: 6, key: "usage" as const, store: "PostgreSQL 流水 + Mem0 画像", write: true, read: true },
      ],
      /*
       * ⑤环境缓存的运行数据（M-mem-detail）。
       *
       * 控制台此前只能对这一类说"不在此处统计"——它在 Redis，网关那一侧数不到，
       * 于是那张卡看起来像个空壳（用户走查时的原话是"里面是不是没东西"）。
       * 实际上它一直在工作：实测 Redis 里 75 条逆地理编码缓存。
       *
       * **`keys` 是本进程写入过的键数，不是 Redis 里现有的键数**——它是个内存计数器，
       * 进程一重启就归零而缓存还在。字段名带 `Process` 前缀，避免它被当成库存量读。
       * 真正说明"缓存有没有生效"的是命中率，那个不受重启影响地反映当下。
       */
      cache: (() => {
        const c = getEnvCacheStats();
        return {
          hits: c.hits,
          misses: c.misses,
          degraded: c.degraded,
          writtenThisProcess: c.keys,
          // 库里现存多少条。**取不到就不给这个字段**，页面据此说"数不到"，
          // 而不是显示 0——0 会被读成"缓存是空的"。
          ...(cachedKeyCount !== undefined ? { keysInStore: cachedKeyCount } : {}),
        };
      })(),
      tools: {
        mode: (process.env.CARLIFE_TOOLS as "real" | "mock" | "off") ?? "real",
        registered: TOOL_REGISTRY.length,
        invocations: toolStats.invocations,
        failures: toolStats.failures,
        extensionLoaded: toolStats.describeCalls > 0,
      },
    };
  });

  /*
   * ── 导览采集：一份采集闭包、两条触发路（ACR-008）────────────────
   * 点击同步路径（M36 起）与后台队列 worker 共用 `guideCollect`——
   * 采集实现只有一份，队列只是"谁来调、何时调"的编排层。
   */
  /*
   * 持久层（2026-08-29 走查追修）：简报落 PG 只采一次，重采只由 force 触发。
   * 读序：PG →（miss 时）runGuideBrief（内含 Redis 2 周 + 同键在途合流）→
   * 采集齐全则回写 PG。既有 Redis 里的存货会在首次点击时自动"升格"进 PG。
   */
  const guideStore = createGuideBriefRepository(prisma);
  const guideCollect = async (input: {
    spotName: string;
    city?: string;
    date?: string;
    selfDrive?: boolean;
    siblingSpots?: string[];
    prevSpot?: string;
    isLastStop?: boolean;
    force?: boolean;
  }) => {
    if (!input.force) {
      try {
        const hit = await guideStore.get(input.city, input.spotName);
        if (hit) return { brief: hit as GuideBrief, cached: true };
      } catch (err) {
        console.warn("[guide] 持久层读失败（DB 抖动？），退回缓存/采集路", err);
      }
    }
    const res = await runGuideBrief(
      streamer,
      input,
      {
        onUsage: (sample) =>
          recordUsageWithPricing({
            ...sample,
            sessionId: "__guide__",
            turnId: "__guide__",
            agent: sample.agent ?? "guide",
          }),
      },
      { force: input.force === true },
    );
    // 只持久化三支齐全的简报：半成品占位会让这个景点永远不再补全（缓存层同一条规矩）。
    if (guideBriefIsComplete(res.brief)) {
      guideStore.put(input.city, input.spotName, res.brief).catch((err) => {
        console.warn("[guide] 持久层写失败（本次结果不受影响）", err);
      });
    }
    return res;
  };

  if (process.env.GUIDE_QUEUE?.trim() === "on") {
    // 动态 import：开关关着时 pg-boss 一行代码都不加载、pgboss schema 一张表都不建。
    const [{ createGuideQueue }, { PgBoss }] = await Promise.all([
      import("./guide-queue"),
      import("pg-boss"),
    ]);
    const dbUrl = process.env.DATABASE_URL?.trim();
    if (!dbUrl) {
      console.warn("[guide-queue] GUIDE_QUEUE=on 但缺 DATABASE_URL——队列不起，仅点击路径可用");
    } else {
      const boss = new PgBoss(dbUrl);
      boss.on("error", (err: unknown) => console.warn("[guide-queue] pg-boss 报错", err));
      guideQueue = createGuideQueue({
        boss,
        collect: guideCollect,
        /*
         * "是否已有内容"以⑤缓存在场为准（键与 subgraphs/guide.ts 同构）。
         * Redis 未接入时恒 false——代价只是状态少了"ready(缓存)"一档、
         * 预采集不跳过已缓存点，不影响正确性。
         */
        hasCached: async (spotName, city) => {
          // PG 持久层优先（2026-08-29：只采一次）；Redis（2 周）仅作迁移期兜底。
          try {
            if ((await guideStore.get(city, spotName)) !== null) return true;
          } catch {
            /* 库抖动 → 落到 Redis 判 */
          }
          if (!envCacheBackend) return false;
          try {
            return (
              (await envCacheBackend.get(envCacheKey("guide-brief", [city ?? "-", spotName]))) !== null
            );
          } catch {
            return false;
          }
        },
      });
      await guideQueue.start();
      console.log("[guide-queue] 已启动（pg-boss，队列 guide-brief，并发 1）");
    }
  } else {
    console.log("[guide-queue] 未启用（GUIDE_QUEUE!=on）——行程确认不入队，仅点击路径可用");
  }

  createRuntimeServer(
    runner,
    config,
    /*
     * 会话标题旁路（M28-01）。与导游生成器同一条接线：装配层注入，
     * 计价走同一个 `recordUsageWithPricing`——**标题也是钱**，
     * 4f19ccc 那次"三条漏计的调用"就是各自接线时各自忘了记账。
     */
    createTitleWriter(config, recordUsageWithPricing),
    /*
     * 双路对照的表述生成器（M-dual-probe）。
     *
     * **用与生产表述路径同一个人设**（`NARRATOR_SYSTEM`）：那段人设明写
     * "你自己没有任何工具、求解结果里没有的你都不知道"，正是它让模型在
     * 缺一路时如实说"这个我没查到"而不是编。换个人设做对照，
     * 对照出来的差异里就混进了人设差异，而这一屏要证明的是数据的差异。
     *
     * 计价同样走 `recordUsageWithPricing`——**对照也是钱**，
     * 4f19ccc 那次"三条漏计的调用"就是各自接线时各自忘了记账。
     */
    async ({ context, question }) => {
      const streamer = withLlmSpans(
        createConfiguredChatStreamer(config, { system: NARRATOR_SYSTEM }),
      );
      let out = "";
      for await (const chunk of streamer(
        [{ role: "user", content: `${context}\n\n【车主的问题】\n${question}` }],
        {
          agent: "dual-probe",
          onUsage: (sample) =>
            recordUsageWithPricing({
              ...sample,
              sessionId: "__dualprobe__",
              turnId: "__dualprobe__",
              agent: sample.agent ?? "dual-probe",
            }),
        },
      )) {
        out += chunk;
      }
      return out;
    },
    /*
     * 景区导览采集（M36-01）。**必须用 ACP 那条 streamer**（上面 283 行装配的那个）——
     * 三个 guide-*-task 分支是 pi 会话，工具表按 Agent 裁剪、提交通道按轮归槽，
     * 都只在 ACP 路径上成立。计价走 `recordUsageWithPricing`（对照也是钱，同上）。
     * 同一个闭包同时喂点击同步路径与 ACR-008 的队列 worker——两条路一份采集实现。
     */
    guideCollect,
    /*
     * 导览任务面（ACR-008）：状态查询与手动「获取」。队列关着时不注入，
     * 端点回 503，网关侧照 failed-soft 处理。
     */
    guideQueue
      ? {
          status: (plan) => guideQueue!.statusForPlan(plan),
          trigger: (input) => guideQueue!.enqueueSpot(input),
        }
      : undefined,
    /*
     * 出发导航规划（M66-02）。**必须用 ACP 那条 streamer**（同导览采集的理由）：
     * nav-task 是 pi 会话，工具表按 Agent 裁剪、提交通道与候选白名单按轮归槽。
     * 常用人员走 memberRepo（同 companions），③偏好走 Mem0 客户端；计价同上。
     */
    async (input) => {
      const { runNavPlan } = await import("./graph/subgraphs/nav-plan");
      const { getMemoryClient } = await import("@carlife/memory");
      return runNavPlan(
        {
          streamer,
          memberStore: memberRepo,
          listPreferences: (userId) => getMemoryClient().listPreferences(userId),
          onUsage: (sample) =>
            recordUsageWithPricing({
              ...sample,
              sessionId: "__nav__",
              turnId: "__nav__",
              agent: sample.agent ?? "nav",
            }),
        },
        input,
      );
    },
  ).listen(PORT, BIND, () => {
    const mode = process.env.DEEPSEEK_API_KEY && process.env.CARLIFE_LLM !== "fake"
      ? "deepseek"
      : "fake";
    console.log(`[runtime] listening on ${BIND}:${PORT} (llm=${mode})`);
    if (!LOOPBACK.has(BIND)) {
      /*
       * `/internal/*` 没有鉴权——它的设计前提是"只有同机的网关会调"
       * （guard/resume、memory/cache、session/:id/turn 都能绕过网关的鉴权面）。
       * 容器部署里这个前提由网络隔离兑现：compose 用的是 `expose` 而不是
       * `ports`，端口只在 docker 网络内可达，宿主与局域网都打不到。
       *
       * 开发机上不是这样：`dev:restart runtime` 起的是宿主进程，
       * 0.0.0.0 意味着同一段 Wi-Fi 上的任何人都能打 /internal/*。
       * 所以这里如实说一句，并给出收紧的办法。默认值保持 0.0.0.0 是刻意的——
       * 改默认会让所有容器部署里的 gateway→runtime 调用当场断掉，
       * 而那条链没有任何回退路径。
       */
      console.warn(
        `[runtime] ⚠️ 监听在 ${BIND}——/internal/* 无鉴权，容器部署靠网络隔离（expose 非 ports）兑现。` +
          ` 开发机若在公共网络，设 AGENT_RUNTIME_BIND=127.0.0.1 收紧`,
      );
    }
  });
}
