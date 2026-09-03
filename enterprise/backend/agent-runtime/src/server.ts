/**
 * 内部 turn 接口（施工单 M2-02）。
 *
 * `POST /internal/session/:id/turn`
 *   请求：JSON { turnId, content, source, userId? }（content 为文本或 ASR 原文）
 *
 * `userId` 由网关注入。它**可缺省**——缺了只是拿不到⑥用车数据（双路降级为单路），
 * 而不是整轮失败：记忆是增强不是必需。但**有它时必须一路带到记忆读写**，
 * 因为跨用户混算是严重事故（M7-01 边界）。
 *   响应：`application/x-ndjson`，逐行 `SessionEvent`（M2-01 契约），流式。
 *
 * 仅供 gateway 进程内网调用（localhost），不做鉴权；对外协议治理
 * （token、限流、审计、SSE 封套）全部在 gateway（§3 职责边界）。
 * 用 node:http 实现，不为一个内部端点引入 web 框架依赖。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  hasHighlights,
  tripDayIndex,
  tripPlanNavTarget,
  type MessageSource,
  type NavPlan,
  type NavPlanOrigin,
  type TripPlanSnapshot,
} from "@carlife/shared";
import type { ConfigStore } from "@carlife/db";

import type { TurnRunner } from "./turn-runner";
import { cancelTurn } from "./turn-cancel";
import { handleToolsRequest, getGuardGate } from "./tools-endpoint";
import { knownGaps, riskSummary, type RuntimeHealth } from "./health";
import { HARD_BLOCK_RULES } from "./guard/hard-block-rules";
import { invalidateGuardSettings } from "./guard/settings";
import { liveTrace } from "./trace/live";
import {
  DEFAULT_DISCLAIMER_POLICY,
  DEFAULT_DISCLAIMER_TEXT,
  MAX_DISCLAIMER_CHARS,
  validateDisclaimerPolicy,
  validateDisclaimerText,
} from "./guard/disclaimers";

/**
 * 运行时形态与风险摘要（M9-05）。**演示前扫一眼这里**，
 * 比读十屏启动日志可靠——这套系统有大量可降级路径，
 * 每一条降级都让能力悄悄变少而系统表现正常。
 */
let healthProvider: (() => RuntimeHealth) | undefined;
export function setHealthProvider(fn: () => RuntimeHealth) {
  healthProvider = fn;
}
import { probeLlm } from "./llm/probe";
import { runOwnershipDualPath, runDualPath, stripUsageSection } from "./graph/subgraphs/ownership";

interface TurnRequestBody {
  turnId: string;
  content: string;
  source: MessageSource;
  userId?: string;
  /**
   * 端上的闲聊旁路开关（施工单 M33-04，F-45-08）。
   *
   * **显式声明而不是靠 `...body` 顺带带过去**：靠展开的话，
   * 哪天有人给 `TurnRequestBody` 加一层白名单校验，这个字段就会被静默丢掉，
   * 而现象只是"关了旁路还在说垫场"——离根因十万八千里。
   * 缺省 undefined，由 `TurnInput.fillerEnabled ?? true` 定语义。
   */
  fillerEnabled?: boolean;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isTurnRequestBody(v: unknown): v is TurnRequestBody {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.turnId === "string" &&
    typeof o.content === "string" &&
    (o.userId === undefined || typeof o.userId === "string") &&
    (o.fillerEnabled === undefined || typeof o.fillerEnabled === "boolean") &&
    (o.source === "text" || o.source === "voice")
  );
}

const GUARD_RESUME_PATH = "/internal/guard/resume";
/** 红线只读快照（TD-03）：红线在代码里，后台不抄第二份。 */
const GUARD_REDLINES_PATH = "/internal/guard/redlines";
/** 策略改完后让 TTL 缓存立刻失效（TD-03），否则最多等 30s 才生效。 */
const GUARD_INVALIDATE_PATH = "/internal/guard/invalidate";
/** 话术默认值与校验（TD-05）：业务规则在本进程，后台不抄第二份。 */
const GUARD_DISCLAIMER_DEFAULTS_PATH = "/internal/guard/disclaimer/defaults";
const GUARD_DISCLAIMER_VALIDATE_PATH = "/internal/guard/disclaimer/validate";
/** 行前物品与天气的读时重算（M20-06）。 */
const PRETRIP_REFRESH_PATH = "/internal/trip/pretrip-refresh";
/**
 * 目的地推荐的读时补齐（M32-02）。与上面那条**同族同形状**：
 * 同样的校验顺序、同样的 `skipped` 语义、同样的"失败也回 200"。
 *
 * 单独一条而不是并进 `pretrip-refresh`：两者的耗时差一个量级
 * （天气 6 秒预算 vs 推荐十几秒），并在一起就只能按慢的那个给预算，
 * 而网关那侧是**并发**发出的，各自超时互不牵连。
 */
const HIGHLIGHTS_REFRESH_PATH = "/internal/trip/highlights-refresh";
/** 导览任务状态（ACR-008）：POST 带整份 plan（与 pretrip-refresh 同款：网关查仓储、这里算）。 */
const GUIDE_JOBS_STATUS_PATH = "/internal/guide/jobs-status";
/** 手动「获取」单景点入队（ACR-008）。 */
const GUIDE_ENQUEUE_PATH = "/internal/guide/enqueue";

/**
 * 景区导览采集（施工单 M36-01；点击景点触发，M36-02 的网关路由打到这里）。
 *
 * 计划里它本属 M36-02，挪进 M36-01 的原因是个结构性事实：pi 的工具调用经
 * `.pi/extensions` **HTTP 回流到本进程**的 tools-endpoint，standalone 脚本
 * 承载不了三分支 fan-out——真跑验收只能由跑着的 runtime 出，这条端点就是驱动。
 */
const GUIDE_BRIEF_PATH = "/internal/guide/brief";
/**
 * 出发导航规划（施工单 M66-02；点「开始行程」触发，M66-03 的网关路由打到这里）。
 * 与 pretrip-refresh 同族：网关按鉴权身份查行程并补起点，这里算；失败一律 200 + `skipped`。
 * 慢是常态（一条 nav-task 分支，预算 55 s），调用方自带超时。
 */
const NAV_PLAN_PATH = "/internal/trip/nav-plan";
const TURN_PATH = /^\/internal\/session\/([\w-]+)\/turn$/;
/**
 * 打断（施工单 M33-01，F-08-08 / F-14-04）。
 *
 * 与 turn 分开一条路径而不是往 turn 上加参数：取消是**对已在跑的那一轮**下手，
 * 它没有请求体语义上的"这一轮"，也不产生事件流——形状与 turn 完全不同。
 */
const CANCEL_PATH = /^\/internal\/session\/([\w-]+)\/cancel$/;
/** 会话标题旁路（M28-01）。与 turn 无关的一次性调用，见 `title/index.ts`。 */
const TITLE_PATH = /^\/internal\/session\/([\w-]+)\/title$/;
const PREFERENCES_PATH = /^\/internal\/memory\/preferences\/([^/]+)(?:\/([^/]+))?$/;
const WORKING_MEMORY_PATH = /^\/internal\/memory\/working\/([\w#-]+)$/;
/**
 * ⑤环境缓存的分页浏览（M-mem-cache）。
 *
 * 它在 Redis 里，而 Redis 的连接握在**本进程**手上（`setEnvCache` 在装配层注入），
 * 网关那一侧数不到也读不到——所以这条只能由 runtime 出，网关做协议转换。
 */
const ENV_CACHE_PATH = "/internal/memory/cache";
/**
 * ⑤单条详情（M-mem-cache-detail）：`?key=<完整键>`。
 * 键里有冒号与中文（`carlife:env:guide-brief:杭州:灵隐寺`），放 query 不放路径——
 * 路径段的百分号编码在代理链上会被反复解码/再编码，query 不会。
 */
const ENV_CACHE_ENTRY_PATH = "/internal/memory/cache/entry";
/** 购车候选与成本的只读快照（M15-05）。与上面同族：只读检查点，不跑图。 */
const BUYING_STATE_PATH = /^\/internal\/buying\/([\w#-]+)$/;

export function createRuntimeServer(
  runner: TurnRunner,
  config?: ConfigStore,
  /**
   * 会话标题生成器（M28-01）。**由装配层注入**——本文件不 import `../llm`，
   * 与 narrator / 导游同一条接线纪律（配置热生效与离线路径都在工厂里处置）。
   * 不注入时端点回 503，网关那侧当作"这次没起出名字"，不重试。
   */
  titleWriter?: import("./title").TitleWriter,
  /**
   * 双路对照用的表述生成器（M-dual-probe 第二步）。
   *
   * **由装配层注入**，与 `titleWriter` / narrator 同一条纪律：本文件不 import `../llm`
   * （配置热生效与离线路径都在工厂里处置）。不注入时探针只回检索结果、不回答案，
   * 页面据此隐藏"生成对照答案"——不给一个点了必然失败的按钮。
   */
  answerFor?: (args: { context: string; question: string }) => Promise<string>,
  /**
   * 景区导览简报（M36-01）。**由装配层注入**——采集要驱动 ACP streamer 的三个
   * `-task` 分支，那是 index.ts 的资产，与 titleWriter / answerFor 同一条接线纪律。
   * 不注入时端点回 503（fake/单挂测试环境没有 pi，注入了也只会空跑）。
   */
  guideBrief?: (input: {
    spotName: string;
    city?: string;
    date?: string;
    selfDrive?: boolean;
    siblingSpots?: string[];
    prevSpot?: string;
    isLastStop?: boolean;
    force?: boolean;
  }) => Promise<{ brief: unknown; cached: boolean }>,
  /**
   * 导览后台任务面（ACR-008）：逐景点状态 + 手动触发。与 guideBrief 同一条
   * 注入纪律；`GUIDE_QUEUE` 关着时装配层不注入，两个端点回 503。
   */
  guideJobs?: {
    status: (plan: import("@carlife/shared").TripPlanSnapshot) => Promise<unknown>;
    trigger: (input: {
      spotName: string;
      city?: string;
      date?: string;
      selfDrive?: boolean;
      siblingSpots?: string[];
      prevSpot?: string;
      isLastStop?: boolean;
    }) => Promise<unknown>;
  },
  /**
   * 出发导航规划（M66-02）。**由装配层注入**——要驱动 ACP streamer 的 `nav-task` 分支、
   * 读常用人员与 ③偏好，都是 index.ts 的资产。不注入时端点回 503。
   */
  navPlan?: (input: {
    userId: string;
    origin: NavPlanOrigin;
    destination: { name: string; lat: number; lon: number };
    party?: string;
    vin?: string;
  }) => Promise<NavPlan>,
) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // 工具执行内部端点（施工单 M4-02）：pi 侧扩展的回调落点。
    // 工具实现留在本进程的理由见 tools-endpoint.ts 文件头（session_id 带不进 pi 扩展）。
    if (await handleToolsRequest(req, res)) return;

    // HITL 回灌（M5-03，§3）：网关把用户的确认/拒绝送回来，权限门据此放行或拒绝。
    // **不做裁决**——裁决在权限门；这里只是 `Command(resume)` 的 HTTP 入口。
    if (req.method === "POST" && req.url === GUARD_RESUME_PATH) {
      const gate = getGuardGate();
      if (!gate) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "guard_gate_unavailable" }));
        return;
      }
      let body: { interruptId?: string; approved?: boolean };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      if (!body.interruptId || typeof body.approved !== "boolean") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing_interrupt_or_decision" }));
        return;
      }
      // `resumed:false` 不是错：中断点可能已超时收敛，或用户连点重发（F-27-10）。
      const resumed = gate.resume(body.interruptId, body.approved);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ resumed }));
      return;
    }

    /*
     * 红线只读快照（TD-03）。
     *
     * 后台要能回答"到底哪些是永远不可改的"，而红线**只存在于代码里**
     * （`hard-block-rules.ts` 与 Tauri capability 白名单）。
     * 由本进程回一份快照，而不是让网关抄一遍清单——抄一遍就有了第二份真相，
     * 且它会安静地过时。**只读，没有对应的写入路径。**
     */
    if (req.method === "GET" && req.url === GUARD_REDLINES_PATH) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          hardBlocks: HARD_BLOCK_RULES.map((r) => `${r.category}：${r.why}`),
          // 端侧能力白名单由 `check:arch` 的 capabilities 不变量守着，
          // 这里给的是"哪些类别的能力被物理排除"的说明，不是文件内容。
          capabilities: [
            "端侧 capability 白名单不含任何车辆控制能力（§8.5）——即使前三层失效也下发不了控制指令",
          ],
          writable: false,
        }),
      );
      return;
    }

    if (req.method === "GET" && req.url === GUARD_DISCLAIMER_DEFAULTS_PATH) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          policy: DEFAULT_DISCLAIMER_POLICY,
          text: DEFAULT_DISCLAIMER_TEXT,
          maxChars: MAX_DISCLAIMER_CHARS,
        }),
      );
      return;
    }

    /*
     * 话术校验。三条红线都在这里，**网关不重写**：
     * 售后免责不可关、字段不能空、渲染后不超长。
     * 抄一份到网关就有了第二份真相，而漂移时通常是那边放宽了。
     */
    if (req.method === "POST" && req.url === GUARD_DISCLAIMER_VALIDATE_PATH) {
      let body: { policy?: unknown; text?: unknown };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      let error: string | null = null;
      if (body.policy !== undefined) {
        error = validateDisclaimerPolicy(body.policy as never);
      }
      if (!error && body.text !== undefined) {
        error = validateDisclaimerText(body.text as never);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(error ? { error } : { ok: true }));
      return;
    }

    /*
     * 会话标题（M28-01）。**旁路，与这一轮的成败无关**——网关在首轮 `turn_end`
     * 之后 fire-and-forget 地调一次，拿不到就算了。
     *
     * 为什么由网关来调、而不是 runtime 自己在轮次结束时算完推出去：
     * `TurnRunner.run()` 在 yield 完 `turn_end` 就 return 了（端上按它收口，
     * 之后的事件会被丢掉），标题挂不进那条流；要么让 turn_end 等标题算完再发——
     * 那就是拿一次收口延迟去换一个名字，方向反了。
     */
    if (req.method === "POST" && TITLE_PATH.test(req.url ?? "")) {
      const sessionId = TITLE_PATH.exec(req.url ?? "")![1];
      if (!titleWriter) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "title_writer_unavailable" }));
        return;
      }
      let body: { turnId?: string; userText?: string; assistantText?: string };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      if (typeof body.userText !== "string" || body.userText.trim().length === 0) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing_user_text" }));
        return;
      }
      const title = await titleWriter({
        sessionId,
        turnId: typeof body.turnId === "string" ? body.turnId : "unknown",
        userText: body.userText,
        assistantText: typeof body.assistantText === "string" ? body.assistantText : "",
      });
      // `title: null` 不是错：首句收拾完是空的（纯标点/空白）时就该没有名字。
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ title: title ?? null }));
      return;
    }

    /*
     * 打断这一轮（施工单 M33-01，F-08-08 / F-14-04）。
     *
     * 三条语义写在这里，别在调用侧再猜一遍：
     *  1. **幂等**——同一轮连取消两次都成功；
     *  2. **未命中也返回 200**（`turnId: null`）。端上无法知道服务端刚好在这一毫秒
     *     收口了，报 404 的表现就是"打断这个动作时灵时不灵"，而打断恰恰是那种
     *     必须每次都有反应的动作；
     *  3. **取消不回滚副作用**（F-14-05）。落在副作用窗口内时如实回
     *     `sideEffectInFlight: true`——外部 API 一旦发出就收不回来，
     *     骗用户说"已取消"比不取消更糟。
     */
    if (req.method === "POST" && CANCEL_PATH.test(req.url ?? "")) {
      const sessionId = CANCEL_PATH.exec(req.url ?? "")![1];
      let body: { turnId?: unknown; reason?: unknown } = {};
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        // 空 body 是合法的："取消这个会话当前在跑的那一轮"。
        body = {};
      }
      const outcome = cancelTurn(
        sessionId,
        typeof body.turnId === "string" && body.turnId.length > 0 ? body.turnId : undefined,
        typeof body.reason === "string" && body.reason.length > 0 ? body.reason : undefined,
      );
      console.info(
        `[runtime] 取消 session=${sessionId} turn=${outcome.turnId ?? "none"} sideEffect=${outcome.sideEffectInFlight}`,
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(outcome));
      return;
    }

    // 策略缓存失效（TD-03）：后台改完策略立刻调，不必等 TTL 自然过期。
    if (req.method === "POST" && req.url === GUARD_INVALIDATE_PATH) {
      invalidateGuardSettings();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    /*
     * 实时轨迹（大屏的"现在流到哪了"）。SSE，不用 WS —— §3 的既有取向。
     *
     * **这里不做鉴权**，与本文件其余端点同一条边界：它只对网关开放，
     * 对外的 token / 角色 / 审计全在网关那一侧（`/console/trace/stream`）。
     *
     * 心跳 15s，与网关下行同一个值：中间设备掐掉一条安静的连接时，
     * 表现是大屏永远停在最后一帧——**而它看起来和"系统很闲"一模一样**。
     */
    if (req.method === "GET" && req.url === "/internal/trace/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(": connected\n\n");
      const unsubscribe = liveTrace.subscribe((e) => {
        // 写失败（对端已断）不该冒泡：订阅者异常由总线吞掉，但这里更早一步收摊。
        try {
          res.write(`data: ${JSON.stringify(e)}\n\n`);
        } catch {
          unsubscribe();
        }
      });
      const heartbeat = setInterval(() => {
        try {
          res.write(": hb\n\n");
        } catch {
          /* 下一次 close 会收摊 */
        }
      }, 15_000);
      const close = (): void => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      req.on("close", close);
      res.on("close", close);
      return;
    }

    if (req.method === "GET" && req.url === "/internal/health/runtime") {
      if (!healthProvider) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "health_provider_unavailable" }));
        return;
      }
      const health = healthProvider();
      res.writeHead(200, { "content-type": "application/json" });
      // risks 为空数组才是"可以上台"的状态；gaps 是永远清不掉的欠账，
      // **分开给**——混进 risks 会让那个"空了才能上台"的判据作废。
      res.end(JSON.stringify({ health, risks: riskSummary(health), gaps: knownGaps(health) }));
      return;
    }

    /*
     * 行前物品与天气的**读时重算**（施工单 M20-06）。
     *
     * 物品是确认那一刻算的；出发前几天天气变了，卡上还是那天的推荐。
     * 用户打开 App 时由网关带 `refreshPretrip=1` 打到这里，用最新天气重算一遍。
     *
     * 三条刻意的取舍：
     *  1. **不落库**。库里那份是用户批准过的行程，环境数据不该悄悄改写它；
     *     而且重算幂等、随时可再算，读时重算没有信息损失。
     *  2. **重算逻辑必须在这一侧**——网关只做协议转换（它的红线），
     *     算天气要工具、要 registry，那是本进程的事。
     *  3. **失败不是错误**：调用方拿不到就用库里那份，所以异常一律回 200 + 原因，
     *     让网关能原样返回而不是把整块 HUD 变成一次报错。
     */
    if (req.method === "POST" && req.url === PRETRIP_REFRESH_PATH) {
      let body: { plan?: TripPlanSnapshot };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const plan = body.plan;
      if (!plan || typeof plan !== "object" || !Array.isArray(plan.skeleton)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing_plan" }));
        return;
      }
      // 已经结束的行程不值得打一次天气接口——它连卡都不会上（tripPlanToHud 返回 null）。
      const today = new Date().toISOString().slice(0, 10);
      if (tripDayIndex(plan, today) === null) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ skipped: "expired" }));
        return;
      }
      try {
        const { collectPretripItems } = await import("./graph/supervisor");
        const r = await collectPretripItems(plan as never);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            pretripItems: r.items,
            weather: r.weather,
            computedAt: new Date().toISOString(),
          }),
        );
      } catch (err) {
        console.warn("[runtime] pretrip 重算失败（调用方回落库里那份）", err);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ skipped: "failed" }));
      }
      return;
    }

    /*
     * 目的地推荐（M32-02）。**它现在是兜底**：推荐已改为确认/变更后后台算好并落库
     * （`graph/highlights.ts`），网关只在库里没有时才打这一条——老行程与
     * 后台那次没算成的行程还得靠它。逐条照抄上面那条的形状，两处不同：
     *  - 调的是 `collectDestinationHighlights`（**不在 supervisor.ts 里**，
     *    因为它刻意不挂在行程确认那一跳上）；
     *  - 三段全空时回 `skipped: "empty"` 而不是一个空对象——
     *    "搜到了但什么都没有"与"没搜成"对端上是同一件事（都不出这张卡），
     *    但对排障是两件事。
     */
    if (req.method === "POST" && req.url === HIGHLIGHTS_REFRESH_PATH) {
      let body: { plan?: TripPlanSnapshot };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const plan = body.plan;
      if (!plan || typeof plan !== "object" || !Array.isArray(plan.skeleton)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing_plan" }));
        return;
      }
      // 已经结束的行程不值得烧一次联网搜索——它连卡都不会上。
      const today = new Date().toISOString().slice(0, 10);
      if (tripDayIndex(plan, today) === null) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ skipped: "expired" }));
        return;
      }
      try {
        const { collectDestinationHighlights } = await import("./graph/highlights");
        const highlights = await collectDestinationHighlights(plan);
        if (!hasHighlights(highlights)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ skipped: "empty" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ destinationHighlights: highlights, computedAt: highlights.computedAt }),
        );
      } catch (err) {
        console.warn("[runtime] 目的地推荐失败（这次就不出这张卡）", err);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ skipped: "failed" }));
      }
      return;
    }

    /*
     * 导览任务状态（ACR-008）。快路径：只查 pg-boss 状态与⑤缓存在场，**不触发任何采集**
     * ——它是给前端轮询的，轮询绝不能变成花钱的那条路。
     */
    if (req.method === "POST" && req.url === GUIDE_JOBS_STATUS_PATH) {
      if (!guideJobs) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "guide_queue_disabled" }));
        return;
      }
      let body: { plan?: unknown };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const plan = body.plan as import("@carlife/shared").TripPlanSnapshot | undefined;
      if (!plan || !Array.isArray(plan.skeleton)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_plan" }));
        return;
      }
      try {
        const jobs = await guideJobs.status(plan);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jobs }));
      } catch (err) {
        console.warn("[runtime] 导览任务状态查询失败", err);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jobs: null }));
      }
      return;
    }

    /* 手动「获取」（ACR-008）：单景点入队，回该点即时状态。 */
    if (req.method === "POST" && req.url === GUIDE_ENQUEUE_PATH) {
      if (!guideJobs) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "guide_queue_disabled" }));
        return;
      }
      let body: { spotName?: unknown; city?: unknown; date?: unknown; selfDrive?: unknown; siblingSpots?: unknown; prevSpot?: unknown; isLastStop?: unknown; force?: unknown };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const spotName = typeof body.spotName === "string" ? body.spotName.trim() : "";
      if (!spotName) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing_spot_name" }));
        return;
      }
      try {
        const spot = await guideJobs.trigger({
          spotName,
          ...(typeof body.city === "string" && body.city.trim() ? { city: body.city.trim() } : {}),
          ...(typeof body.date === "string" && body.date.trim() ? { date: body.date.trim() } : {}),
          ...(typeof body.selfDrive === "boolean" ? { selfDrive: body.selfDrive } : {}),
          ...(Array.isArray(body.siblingSpots)
            ? { siblingSpots: (body.siblingSpots as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "") }
            : {}),
          ...(typeof body.prevSpot === "string" && body.prevSpot.trim() ? { prevSpot: body.prevSpot.trim() } : {}),
          ...(body.isLastStop === true ? { isLastStop: true } : {}),
          ...(body.force === true ? { force: true } : {}),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ spot }));
      } catch (err) {
        console.warn("[runtime] 导览手动入队失败", err);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ spot: { spotName, state: "failed", note: "这次没排上队，稍后再试" } }));
      }
      return;
    }

    /*
     * 景区导览采集（M36-01）。与两条 refresh 同族：失败不是错误，一律 200 + 原因——
     * 调用方（网关/端上）据此少一页，而不是把导览页变成一次报错。
     * ⚠️ 这是本文件最慢的一条（三分支 fan-out，冷启最坏 90s 量级）：
     * 调用方必须自带超时预算；缓存命中时毫秒级返回（`cached: true`）。
     */
    if (req.method === "POST" && req.url === GUIDE_BRIEF_PATH) {
      let body: { spotName?: unknown; city?: unknown; date?: unknown; selfDrive?: unknown; siblingSpots?: unknown; prevSpot?: unknown; isLastStop?: unknown; force?: unknown };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const spotName = typeof body.spotName === "string" ? body.spotName.trim() : "";
      if (!spotName) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing_spot_name" }));
        return;
      }
      if (!guideBrief) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "guide_brief_unavailable" }));
        return;
      }
      try {
        const { brief, cached } = await guideBrief({
          spotName,
          ...(typeof body.city === "string" && body.city.trim() ? { city: body.city.trim() } : {}),
          ...(typeof body.date === "string" && body.date.trim() ? { date: body.date.trim() } : {}),
          ...(typeof body.selfDrive === "boolean" ? { selfDrive: body.selfDrive } : {}),
          ...(Array.isArray(body.siblingSpots)
            ? { siblingSpots: (body.siblingSpots as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "") }
            : {}),
          ...(typeof body.prevSpot === "string" && body.prevSpot.trim() ? { prevSpot: body.prevSpot.trim() } : {}),
          ...(body.isLastStop === true ? { isLastStop: true } : {}),
          ...(body.force === true ? { force: true } : {}),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ brief, cached, computedAt: new Date().toISOString() }));
      } catch (err) {
        console.warn("[runtime] 导览采集失败（这次就没有导览页）", err);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ skipped: "failed" }));
      }
      return;
    }

    /*
     * 出发导航规划（M66-02）。校验顺序与 pretrip-refresh 同款；三种"这次没算成"都回 200 + skipped：
     *  - `no_target`：行程里没有带坐标的站（卡上按钮本来就是禁用的，网关不该打到这里，但要防）；
     *  - `no_origin`：网关没给起点（起点回退到常住地是网关的事，这里只认坐标）；
     *  - `failed`：分支/汇聚异常。
     */
    if (req.method === "POST" && req.url === NAV_PLAN_PATH) {
      if (!navPlan) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "nav_plan_unavailable" }));
        return;
      }
      let body: { userId?: unknown; plan?: TripPlanSnapshot; origin?: unknown; vin?: unknown };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const userId = typeof body.userId === "string" ? body.userId.trim() : "";
      const plan = body.plan;
      if (!userId || !plan || typeof plan !== "object" || !Array.isArray(plan.skeleton)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: userId ? "missing_plan" : "missing_user" }));
        return;
      }
      const o = body.origin as Partial<NavPlanOrigin> | undefined;
      if (!o || typeof o.lat !== "number" || typeof o.lon !== "number" || !Number.isFinite(o.lat) || !Number.isFinite(o.lon)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ skipped: "no_origin" }));
        return;
      }
      const target = tripPlanNavTarget(plan, new Date().toISOString().slice(0, 10));
      if (!target) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ skipped: "no_target" }));
        return;
      }
      const startedAt = Date.now();
      try {
        const result = await navPlan({
          userId,
          origin: {
            lat: o.lat,
            lon: o.lon,
            source: o.source === "home" ? "home" : "fix",
            ...(typeof o.ageMinutes === "number" ? { ageMinutes: o.ageMinutes } : {}),
          },
          destination: target,
          ...(typeof plan.party === "string" && plan.party.trim() ? { party: plan.party.trim() } : {}),
          ...(typeof body.vin === "string" && body.vin.trim() ? { vin: body.vin.trim() } : {}),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ plan: result, elapsedMs: Date.now() - startedAt }));
      } catch (err) {
        console.warn("[runtime] 出发导航规划失败（调用方按起终点直连）", err);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ skipped: "failed", elapsedMs: Date.now() - startedAt }));
      }
      return;
    }

    /*
     * 对照答案（M-dual-turns 第二步）：**同一段上下文，去掉用车数据那一节**。
     *
     * 输入是当时留在轨迹里的那份上下文，不重跑检索——重跑会引入第二个变量
     * （知识库与用车数据都在变），两边的差别里就混进了"检索结果不同"，
     * 而这个对照要证明的恰恰是"差异只来自那一路数据"。
     *
     * 剥离规则在 `ownership.ts`（与拼装它的代码同住），这里只调用。
     */
    if (req.method === "POST" && req.url === "/internal/dual-path/contrast") {
      let body: { context?: string; question?: string } = {};
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_body" }));
        return;
      }
      const context = typeof body.context === "string" ? body.context : "";
      const question = typeof body.question === "string" ? body.question : "";
      if (!context || !question) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "context_and_question_required" }));
        return;
      }
      if (!answerFor) {
        // 没接生成器就明说，不返回一个空答案——空答案会被读成"模型没话说"。
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "answer_generator_unavailable" }));
        return;
      }
      try {
        const contrastContext = stripUsageSection(context);
        const answer = await answerFor({ context: contrastContext, question });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ contrastContext, answer }));
      } catch (err) {
        console.error("[runtime] 对照答案生成失败", err);
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "contrast_failed", detail: String(err) }));
      }
      return;
    }

    /*
     * 双路检索探针（M-dual-probe）：给运营控制台把"双路到底做了什么"摊开。
     *
     * # 为什么在 runtime 侧
     *
     * 双路逻辑在 `graph/subgraphs/ownership.ts`，而它依赖工具注册表（`invokeTool`）——
     * 网关那一侧没有工具句柄。与 `probe/llm` 同一条理由。
     *
     * # 为什么复用生产那条 `runOwnershipDualPath` 而不是另写一份
     *
     * 探针要证明的正是"生产链路真的在做双路"。另写一份就成了自说自话：
     * 它可能与真实路径漂开，而漂开的方向恰好是"演示版看起来更好"。
     *
     * **不跑 LLM**：这一层只回答"两路各捞到了什么、够不够格个性化"，
     * 那已经是全部的证据。生成答案要多花十几秒与一次调用，且答案本身
     * 并不比 `personalized` + `caveats` 更能说明问题。
     */
    if (req.method === "POST" && req.url === "/internal/dual-path/probe") {
      let body: {
        query?: string;
        userId?: string;
        vin?: string;
        vehicleModel?: string;
        agent?: string;
        withAnswers?: boolean;
      } = {};
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_body" }));
        return;
      }
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (!query) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "query_required" }));
        return;
      }
      try {
        const r = await runOwnershipDualPath({
          query,
          ...(body.userId ? { userId: body.userId } : {}),
          ...(body.vin ? { vin: body.vin } : {}),
          ...(body.vehicleModel ? { vehicleModel: body.vehicleModel } : {}),
          ctx: {
            // 探针的调用也带会话维度，否则工具侧的 ACL 与轨迹换算都无处落。
            sessionId: "__dualprobe__",
            // agent 决定查哪个知识库（ownership=说明书 / service=维修库），
            // 由调用方选——这正是"同一份双路逻辑、不同的那一路"要展示的东西。
            agent: body.agent === "service" ? "service" : "ownership",
          },
        });
        /*
         * 单路对照：**同一段代码、少喂一路**。
         *
         * 不另写一个"只查 RAG"的分支——那样两边的差异里会混进实现差异，
         * 而这一屏要证明的恰恰是"差异只来自那一路数据"。
         * 复用已经捞到的 chunks，所以不产生第二次检索。
         */
        const single = await runDualPath(
          async () => r.rag.chunks,
          async () => ({ unusableReason: "对照用：本次刻意不接入用车数据" }),
        );

        // 答案是可选的：它要多花两次 LLM 调用与十几秒，只在页面明确要时才跑。
        let answers: { single: string; dual: string } | undefined;
        if (body.withAnswers && answerFor) {
          const [a, b] = await Promise.all([
            answerFor({ context: single.context, question: query }),
            answerFor({ context: r.context, question: query }),
          ]);
          answers = { single: a, dual: b };
        }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ...r,
            singleContext: single.context,
            singlePersonalized: single.personalized,
            answerAvailable: answerFor !== undefined,
            ...(answers ? { answers } : {}),
          }),
        );
      } catch (err) {
        console.error("[runtime] 双路探针失败", err);
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "dual_path_failed", detail: String(err) }));
      }
      return;
    }

    // LLM 探活（施工单 M3-03）：**必须在 runtime 侧**——网关不得 import AI SDK
    // （M2-02 已有静态断言，不能因为一个探活接口破例）。
    if (req.method === "POST" && req.url === "/internal/probe/llm") {
      if (!config) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "config_store_unavailable" }));
        return;
      }
      try {
        const report = await probeLlm(config);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(report));
      } catch (err) {
        console.error("[runtime] llm probe failed", err);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "probe_failed" }));
      }
      return;
    }

    // ③偏好：列出与删除（M11-02，F-21-11）。
    // 系统能自己往③里写，用户就必须能把写错的拿掉——③是不硬删的那一类，
    // 没有删除路径的话，一条错误偏好会一直影响后续回答且无法收敛。
    const prefMatch = req.url ? PREFERENCES_PATH.exec(req.url) : null;
    if (prefMatch) {
      const userId = decodeURIComponent(prefMatch[1]);
      const memoryId = prefMatch[2] ? decodeURIComponent(prefMatch[2]) : undefined;
      const { getMemoryClient } = await import("@carlife/memory");
      const client = getMemoryClient();

      if (req.method === "GET" && !memoryId) {
        try {
          const r = await client.listPreferences(userId);
          res.writeHead(200, { "content-type": "application/json" });
          // `degraded` 一并回传：**空结果在降级下不代表"没有偏好"**，
          // 页面要能把这两件事分开说（走查里记忆页就是混了这一点）。
          res.end(
            JSON.stringify({
              userId,
              degraded: r.degraded === true,
              preferences: (r.results ?? []).map((m) => ({
                id: m.id,
                content: m.memory,
                domain: (m.metadata as { domain?: string } | undefined)?.domain ?? null,
                confidence: (m.metadata as { confidence?: number } | undefined)?.confidence ?? null,
                evidence: (m.metadata as { evidence?: string } | undefined)?.evidence ?? null,
                provenance: (m.metadata as { provenance?: string } | undefined)?.provenance ?? null,
                supersededContent:
                  (m.metadata as { supersededContent?: string } | undefined)?.supersededContent ?? null,
              })),
            }),
          );
        } catch (err) {
          console.error(`[runtime] 读取 ③偏好失败 user=${userId}`, err);
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "memory_unavailable" }));
        }
        return;
      }

      if (req.method === "DELETE" && memoryId) {
        try {
          await client.delete(memoryId);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ deleted: true }));
        } catch (err) {
          console.error(`[runtime] 删除 ③偏好失败 id=${memoryId}`, err);
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "memory_unavailable" }));
        }
        return;
      }
    }

    /*
     * ⑤环境缓存分页列举（M-mem-cache）。
     *
     * **只读，且不经过 `withEnvCache`**：列举不该把任何键的 TTL 续上，
     * 更不该因为有人在后台翻页就去上游取数。
     */
    if (req.method === "GET" && req.url?.split("?")[0] === ENV_CACHE_PATH) {
      const q = new URL(req.url, "http://localhost").searchParams;
      const limit = Math.min(200, Math.max(1, Number(q.get("limit") ?? 20) || 20));
      const offset = Math.max(0, Number(q.get("offset") ?? 0) || 0);
      const namespace = q.get("namespace") || undefined;
      try {
        const { listEnvCache } = await import("@carlife/tools");
        const listing = await listEnvCache({ offset, limit, namespace });
        if (!listing) {
          /*
           * **不回空列表**：未接入 Redis 与"缓存里没东西"是两回事，
           * 而空列表读起来就是后者——这一类此前正是这么被误解的。
           */
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ wired: false }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ wired: true, offset, limit, ...listing }));
      } catch (err) {
        console.error("[runtime] 列举 ⑤环境缓存失败", err);
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "env_cache_unavailable" }));
      }
      return;
    }

    /*
     * ⑤单条详情（M-mem-cache-detail）。同样只读、不经 `withEnvCache`、不续期。
     * 天气预报按 adcode 存、值里没坐标，顺手把解析到这个 adcode 的逆地理点带上，
     * 控制台才有地方落针——反查不到就不带，别拿城市中心冒充。
     */
    if (req.method === "GET" && req.url?.split("?")[0] === ENV_CACHE_ENTRY_PATH) {
      const key = new URL(req.url, "http://localhost").searchParams.get("key") ?? "";
      if (!key) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "key_required" }));
        return;
      }
      try {
        const { getEnvCacheEntry, regeoPointsForAdcode } = await import("@carlife/tools");
        const entry = await getEnvCacheEntry(key);
        if (entry === undefined) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ wired: false }));
          return;
        }
        if (entry === null) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ wired: true, found: false }));
          return;
        }
        let related: unknown;
        if (entry.namespace === "amap-forecast") {
          const adcode = (entry.value as { adcode?: unknown } | null)?.adcode;
          if (typeof adcode === "string" && adcode) related = await regeoPointsForAdcode(adcode);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ wired: true, found: true, entry, ...(related ? { regeoPoints: related } : {}) }));
      } catch (err) {
        console.error("[runtime] 读取单条 ⑤环境缓存失败", key, err);
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "env_cache_unavailable" }));
      }
      return;
    }

    // ①Working 只读查询（施工单 M3-05）——不触发图执行、不改检查点。
    const memMatch = req.url ? WORKING_MEMORY_PATH.exec(req.url) : null;
    if (req.method === "GET" && memMatch) {
      try {
        const state = await runner.workingState(memMatch[1]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(state));
      } catch (err) {
        console.error(`[runtime] working state failed session=${memMatch[1]}`, err);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "working_state_failed" }));
      }
      return;
    }

    // 购车候选与成本只读查询（施工单 M15-05）——不触发图执行、不改检查点。
    const buyMatch = req.url ? BUYING_STATE_PATH.exec(req.url) : null;
    if (req.method === "GET" && buyMatch) {
      try {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(await runner.buyingState(buyMatch[1])));
      } catch (err) {
        console.error(`[runtime] buying state failed session=${buyMatch[1]}`, err);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "buying_state_failed" }));
      }
      return;
    }

    const match = req.url ? TURN_PATH.exec(req.url) : null;
    if (req.method !== "POST" || !match) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    const sessionId = match[1];

    let body: TurnRequestBody;
    try {
      const raw = await readJson(req);
      if (!isTurnRequestBody(raw)) throw new Error("bad shape");
      body = raw;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_body" }));
      return;
    }

    res.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-cache",
    });

    try {
      for await (const event of runner.run({ sessionId, ...body })) {
        res.write(`${JSON.stringify(event)}\n`);
      }
      res.end();
    } catch (err) {
      // 流已开始：以带 error 标记的终止行结束（内部协议，gateway 转换为错误事件）。
      console.error(`[runtime] turn failed session=${sessionId}`, err);
      res.write(`${JSON.stringify({ internalError: "turn_failed" })}\n`);
      res.end();
    }
  });
}
