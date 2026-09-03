/**
 * 工具执行内部端点（施工单 M4-02）—— pi 扩展的回调落点。
 *
 * 【为什么工具在 agent-runtime 内执行，而不是在 pi 进程里】
 * §13-1 的实测判据是"**能否把 `session_id` 安全地带到工具 `execute()` 内**"（F-07-07 要求
 * 工具调用日志与后续的 `/internal/guard/check` 都必须带它）。实测结论：
 *   - pi 扩展的 `ctx.sessionManager.getSessionId()` 给的是 **pi 自己的会话 id**，
 *     与 CarLife 的 `session_id` 是两套标识，pi 侧拿不到后者；
 *   - pi 不支持 mcpServers，也没有"给扩展注入外部上下文"的入口。
 * 因此把工具**实现**留在我们的进程里，pi 侧的扩展只做一层薄代理：
 * pi 仍然在自己的工具表里看到这些工具（§10 要点 7 的注册目标达成），
 * 但真正的 `execute()` 跑在 agent-runtime——`session_id` 天然在手。
 *
 * 【顺带的架构收益】§8.4 的权限门 `POST /internal/guard/check` 就在本进程内。
 * 工具在这里执行意味着 M5 的权限检查是**进程内调用**，不必跨进程往返。
 *
 * 【会话相关性：已补齐】
 * 代理请求带的是 pi 侧的会话标识。`AcpClient` 建会话时记下
 * ACP 会话 id → (CarLife 会话, Agent) 的反向索引，这里据此反解。
 *
 * **这不是日志好看的问题**：`sessionId` 是权限门 `interrupt` 挂到哪一路 SSE 的依据，
 * 反解不出来时 HITL 结构上不可能工作——用户永远等不到那个确认弹窗。
 * `agent` 同理：它决定 §4.3 的工具 ACL 按谁裁剪，反解不出就只能按 pi 进程的身份猜。
 *
 * 解析失败仍记 `unresolved:<piSessionId>` 并**计数上报**——**绝不静默填一个假的会话 id**。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  invokeTool,
  listForAgent,
  describeForPi,
  describePreference,
  getTool,
  describeDisclosure,
  resolveContactSecret,
  type AgentName,
  type AppointmentContact,
} from "@carlife/tools";

import {
  validateCabinPreference,
  OWNER_ONLY_TOOLS,
  PRIVATE_DOMAIN_TOOLS,
  type GrantRole,
} from "@carlife/shared";

import type { GuardGate } from "./guard/http-endpoint";
import { canonicalAgent } from "./acp-client/agent-prompt";
import { currentTurnId } from "./interrupt-bus";

export const TOOLS_INVOKE_PATH = "/internal/tools/invoke";
export const TOOLS_DESCRIBE_PATH = "/internal/tools/describe";
export const TOOLS_STATS_PATH = "/internal/tools/stats";

/**
 * 调用计数：`invocations` 是"工具**确实被执行过**"的证据（区别于模型编造答案），
 * `unresolvedSessionCalls` 是会话相关性尚未补齐的暴露面——**不静默**。
 */
const stats = {
  invocations: 0,
  failures: 0,
  unresolvedSessionCalls: 0,
  byTool: {} as Record<string, number>,
  /** 被权限门拒绝的次数（含硬禁与用户拒绝）。 */
  denied: 0,
  /**
   * pi 扩展加载时会拉一次工具表。它是**扩展确实被 pi 加载**的唯一证据——
   * pi 在 `--mode rpc` 下对未信任项目会**静默忽略** `.pi/extensions/`，
   * 不报错、不告警，只是工具一个都没有（M4-02 实测踩过整整一轮）。
   */
  describeCalls: 0,
};
export function getToolEndpointStats() {
  return { ...stats, byTool: { ...stats.byTool } };
}

/**
 * 权限门（M5-02）。由装配层注入——**未注入时敏感工具一律拒绝**，
 * 而不是"没门就放行"。默认放行是这类系统最典型的致命默认值。
 */
let guardGate: GuardGate | undefined;
export function setGuardGate(gate: GuardGate) {
  guardGate = gate;
}

/** 供 HITL 回灌入口取用（`server.ts` 的 /internal/guard/resume）。 */
export function getGuardGate(): GuardGate | undefined {
  return guardGate;
}

/**
 * pi 会话 → CarLife 会话与 Agent 的反解。由装配层注入（ACP 池持有那张表）。
 *
 * 未注入时不猜：退回 `unresolved:` 并计数，让缺口在健康页上看得见。
 */
export type SessionResolver = (acpSessionId: string) => { carlifeSessionId: string; agent: AgentName } | undefined;
let resolveSession: SessionResolver | undefined;
export function setSessionResolver(r: SessionResolver): void {
  resolveSession = r;
}

/**
 * CarLife 会话 → 用户 id（施工单 M19-06）。
 *
 * # 为什么要有这个
 *
 * 用户维度的工具（`contact_lookup` / `usage_profile` / `vehicle_member` …）都要 `userId`，
 * 而**模型根本不知道它是什么**——它没见过这个值，schema 里写 `.min(1)` 只会让它编一个，
 * 然后按别人的 id 去查，或者更常见的：那个工具事实上只有子图在调，
 * 注册给模型的那一半从来没工作过（`vehicle_member` 至今如此）。
 *
 * 所以在这里注入：`userId` 缺省时从会话反查补上。**不覆盖已有值**——
 * 子图直调时自己带的那个更准（它知道是替谁问的）。
 *
 * # 为什么不做成 ACP 会话表的一列
 *
 * `sessionFor(carlifeSessionId, agent)` 建 ACP 会话时手上没有 userId，
 * 要一路改 `prompt()` 的签名与全部调用方。而 `sessions` 表本来就有 `user_id`，
 * 查一次就够，且**只在工具真的没带 userId 时才查**。
 */
export type SessionUserResolver = (carlifeSessionId: string) => Promise<string | undefined>;

/**
 * 会话的可见域上下文（施工单 M48-06，F-57-03）。
 *
 *  - `userId: null` = **访客会话**（车机上车声明选了访客，M48-05）；
 *  - `userId: string` = 那个人（人的会话是登录者，车机会话是声明的那位）；
 *  - 整体 `undefined` = 会话查不到（不是访客，是不知道）。
 *
 * 三态而不是 `string | undefined`：**"访客"与"查不到"必须分开**。
 * 合并的话，一次查库抖动会被当成访客，于是把一个真实用户的会话
 * 静默降级——而降级是要播报的，静默降级只会让人以为助手忘事。
 */
export type SessionAccessResolver = (
  carlifeSessionId: string,
) => Promise<{ userId: string | null; role: GrantRole | null } | undefined>;
let resolveSessionAccess: SessionAccessResolver | undefined;
export function setSessionAccessResolver(r: SessionAccessResolver | undefined): void {
  resolveSessionAccess = r;
}
let resolveSessionUser: SessionUserResolver | undefined;
export function setSessionUserResolver(r: SessionUserResolver | undefined): void {
  resolveSessionUser = r;
}

/**
 * 会话身份**压过**入参里的 userId；查不到才退回入参，查不到也不编。
 *
 * # 为什么是覆盖而不是"缺了才补"
 *
 * 这条路径的调用方**永远是模型**（pi 经 HTTP 打进来；子图直调走的是进程内的
 * `invokeTool`，根本不经过这里）。而模型不知道 userId 是什么，schema 要求它必填，
 * 它就会从上下文里抓一个看起来像 id 的串。
 *
 * 实测过一次：取消行程时模型填了 `F-23-09`——那是代码注释里的**功能点编号**。
 * `cancelCurrent("F-23-09")` 查无此人，工具报"没有已确认的行程可取消"，
 * 而车主自己那份行程原封不动挂在主页上。**用户点了确认，什么都没发生**。
 *
 * 跨用户读写是这类系统里最贵的事故：编中了别人的 id 就是替别人取消行程。
 * 所以这里不给模型留任何余地——它填什么都不作数。
 */
async function withUserId(args: unknown, sessionId: string): Promise<unknown> {
  if (typeof args !== "object" || args === null) return args;
  const bag = args as Record<string, unknown>;
  const userId = await resolveSessionUser?.(sessionId);
  // 查不到就别动：让工具自己按"缺 userId"报错，比塞一个空串到 where 里安全得多。
  if (!userId) return args;
  if (typeof bag.userId === "string" && bag.userId.trim() && bag.userId !== userId) {
    // 喊出来：模型编 id 是无症状故障，不喊的话现象只是"这次动作没生效"。
    console.warn(
      `[tools] 模型给的 userId=${JSON.stringify(bag.userId)} 已被会话身份覆盖` +
        `（session=${sessionId}）——它不知道这个值，填的是从上下文里抓的串`,
    );
  }
  return { ...bag, userId };
}

interface InvokeBody {
  name?: string;
  args?: unknown;
  /** pi 侧的会话标识（`ctx.sessionManager.getSessionId()`）。 */
  piSessionId?: string;
  /** 调用方 Agent；pi 扩展按其加载的工具表传入。 */
  agent?: AgentName;
  /** Mock 三态（FL-39 F-39-02）；由装配层决定，pi 侧不自己选。 */
  mode?: "real" | "mock" | "off";
  /** 幂等键：重试/重发不产生第二次敏感动作（F-27-10）。 */
  idempotencyKey?: string;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/**
 * 动作指纹：会话 + 工具 + 入参。
 *
 * 入参必须**稳定序列化**（键按字典序）——`JSON.stringify` 保留插入顺序，
 * 模型两次生成的参数对象字段顺序常常不同，直接 stringify 会把同一件事
 * 算成两件，拒绝记忆当场失效。这类 bug 不报错，只表现为"怎么还在弹"。
 */
export function actionFingerprint(sessionId: string, tool: string, args: unknown): string {
  return `${sessionId}::${tool}::${stableStringify(args)}`;
}

/**
 * 拒绝记忆的键。**优先按轮次，退化到入参指纹。**
 *
 * 语义是"这一轮里这个工具已经被否过"，不是"这一组入参被否过"：
 * 用户拒绝的是"把它写进我日历"，不是某个特定标题。
 *
 * 实测过按指纹的版本：模型被拒后重试四次、每次换个措辞，
 * 于是四个不同指纹、四个弹窗，抑制等于没做。
 * 反过来按会话又太宽——用户两分钟后重新开口要求写日历，不该被自动否掉。
 * 轮次是这两者之间唯一说得通的边界：一次提问对应一次表态。
 */
export function refusalKey(sessionId: string, tool: string, args: unknown): string {
  const turnId = currentTurnId(sessionId);
  return turnId ? `turn:${sessionId}#${turnId}::${tool}` : actionFingerprint(sessionId, tool, args);
}

/**
 * 「将提供给第三方的个人信息」——按工具查表（施工单 M15-04，F-26-09 / AC-15-7）。
 *
 * # 为什么是一张表而不是给所有敏感工具都塞点什么
 *
 * `calendar` / `trip_plan_commit` 也是敏感工具，但它们外发的**不是个人信息给第三方**
 * （前者写用户自己的日历，后者写我们自己的库），语义完全不同。
 * 硬塞会让这个字段失去含义——弹窗上"将提供给门店的信息"底下列着一行行程标题，
 * 用户下次就不会再认真看它了。
 *
 * # 查不到就不传，这是刻意的
 *
 * 新增敏感工具时忘了登记，后果只是没有外发块（而它本来也没有外发），
 * 不会静默出错。反过来"默认塞一份"才会。
 */
const DISCLOSURE_BUILDERS: Record<
  string,
  (args: unknown) => string[] | undefined | Promise<string[] | undefined>
> = {
  // 试驾下单（M19-02）。与 appointment 用**同一份掩码规则**——
  // 两处各拼一份时，用户看到的和实际发出去的会对不上。
  test_drive_book: async (args) => {
    const a = args as { contact?: AppointmentContact; memberId?: string; userId?: string } | undefined;
    /*
     * 走档案（M19-06）时入参里根本没有 `contact`——真号在库里，模型手上只有 memberId。
     * **这一块不能因此空掉**：外发块为空的弹窗看起来完全正常，
     * 用户会以为这次没有个人信息发出去，而实际上发了。那正是 AC-15-7 要防的。
     *
     * 在这里读真号是安全的：读完立刻过 `describeDisclosure` 掩码，
     * 明文不出这个函数、不进 verdict、不进 SSE。
     */
    const contact =
      a?.contact ??
      (a?.memberId && a?.userId ? await resolveContactSecret(a.userId, a.memberId) : undefined);
    if (!contact?.name || !contact?.phone) return undefined;
    return describeDisclosure(contact).map((d) => `${d.field}：${d.value}`);
  },
  appointment: async (args) => {
    const a = args as { contact?: AppointmentContact; memberId?: string; userId?: string } | undefined;
    /*
     * 档案路（M44-01）时入参里没有 `contact`——真号在库里，模型手上只有 memberId。
     * **这一块不能因此空掉**：外发块为空的弹窗看起来完全正常，用户会以为这次
     * 没有个人信息发出去，而实际上发了（与 test_drive_book 那份同一条纪律）。
     * 在这里读真号是安全的：读完立刻过 `describeDisclosure` 掩码，明文不出函数。
     */
    const contact =
      a?.contact ??
      (a?.memberId && a?.userId ? await resolveContactSecret(a.userId, a.memberId) : undefined);
    if (!contact?.name || !contact?.phone) return undefined;
    // **值来自 `describeDisclosure()`，不在这里拼**：手机号的掩码规则在那一侧，
    // 两处各拼一份时，用户看到的和实际发出去的会对不上——那正是这条验收要防的。
    return describeDisclosure(contact).map((d) => `${d.field}：${d.value}`);
  },
};

/**
 * 弹窗上那一行「动作」。
 *
 * # 不能直接 `JSON.stringify(args)`
 *
 * 那是原来的做法，而 `appointment` 的入参里带着**完整手机号**——
 * 确认弹窗可能出现在车机大屏上，副驾和后排都看得见。
 * 外发项那一块里手机号是掩码的，动作摘要里却是明文，等于白掩码了。
 */
/*
 * ── 最近的工具调用（M24 收口）─────────────────────────────────
 *
 * 用来核对**模型说的和做的是否一致**。A 型把动作交给模型之后多了一种 B 型没有的
 * 失败姿势：真跑 sess-36f62962-9e4 里模型只调了 `cabin_status` 查了一下状态，
 * 一个设置动作都没做，却回答"已经帮小宝把亮度调到 20 了"——**纯编造**，
 * 而车机侧 brightness 还是 30。
 *
 * 光靠 prompt 说"没调工具就别说做了"拦不住这类错；编排层拿事实核对才拦得住。
 * 这不是替模型判断意图（那是 B 型），是事后对账——与"审计对得上 /changes"同一性质。
 *
 * 环形缓冲，只留最近若干条：它服务的是"刚刚这一跳"，不是历史查询。
 */
interface RecentCall {
  sessionId: string;
  name: string;
  at: number;
  ok: boolean;
}
const RECENT_LIMIT = 200;
const recentCalls: RecentCall[] = [];

function recordCall(c: RecentCall): void {
  recentCalls.push(c);
  if (recentCalls.length > RECENT_LIMIT) recentCalls.splice(0, recentCalls.length - RECENT_LIMIT);
}

/** 某会话在某时刻之后成功调过的工具名（去重）。 */
export function successfulToolsSince(sessionId: string, sinceMs: number): string[] {
  return [
    ...new Set(recentCalls.filter((c) => c.sessionId === sessionId && c.at >= sinceMs && c.ok).map((c) => c.name)),
  ];
}

/**
 * 确认弹窗上显示的那句话（F-04-02：不只显示动作名）。
 *
 * 导出是为了能被单测直接断言——它的失效形态是"弹窗上出现写给模型看的工具描述
 * 加一段原始 JSON"，那种回落只有对着输出看才发现得了（M15-03 踩过）。
 */
export function summarizeAction(tool: string, args: unknown, fallback: string): string {
  if (tool === "test_drive_book") {
    // 摘要要说人话。id 对用户没有意义——他批的是"周六上午去南山那家"，
    // 而不是 `sz-nanshan-exp_2026-08-14_10_u05bqh`。
    // 门店名与时间由子图在 summary 里给（M19-04），这里是模型直调时的兜底。
    const a = args as { model?: string; trim?: string; storeId?: string; slotId?: string } | undefined;
    return ["预约试驾", a?.model, a?.trim, a?.storeId, a?.slotId].filter(Boolean).join(" · ");
  }
  if (tool === "appointment") {
    const a = args as
      | { kind?: string; storeName?: string; at?: string; subject?: string }
      | undefined;
    const what = a?.kind === "service" ? "预约维修" : "预约试驾";
    return [what, a?.storeName, a?.at, a?.subject].filter(Boolean).join(" · ");
  }
  if (tool === "member_preference_set") {
    /*
     * **这句就是复述**。此前复述由编排层的正则草案生成、模型念出来；改 A 型后
     * 它必须由代码从入参生成——模型说"帮您记住了 24 度"而实际参数是 26，
     * 是最难发现的一类错，弹窗照着入参念才对得上。
     */
    const a = args as { memberName?: string; memberId?: string; preference?: Record<string, unknown> } | undefined;
    const who = a?.memberName?.trim() || a?.memberId || "这位家人";
    let items: string[];
    try {
      items = describePreference(validateCabinPreference(a?.preference ?? {}));
    } catch {
      items = ["（偏好内容不合法，将被拒绝）"];
    }
    return `把「${who}」的座舱偏好记为：${items.join("、")}`;
  }
  if (tool === "vehicle_profile_write") {
    /*
     * **这句就是复述**（M26-04，AC-53-5）。
     *
     * §4.6 要求"复述 + 一次确认"，而不是"先复述、用户说对、再弹一次窗"——
     * 后者正是 FL-27 裁定过的确认疲劳。所以复述必须长在**确认弹窗**上：
     * 车主看到的那一屏，写的就是要落进档案的那几个数。
     *
     * 与 `member_preference_set` 同一条理由（M24 那次的原话）：改 A 型后复述
     * 由模型念出来就会与实际入参脱节——模型说「记住了 24 度」而参数是 26，
     * 是最难发现的一类错。照着入参生成才对得上。
     */
    const a = args as
      | { op?: string; odometerKm?: number; at?: number; items?: string; symptom?: string }
      | undefined;
    const when = a?.at ? new Date(a.at).toLocaleDateString("zh-CN") : undefined;
    const km = typeof a?.odometerKm === "number" ? `${a.odometerKm} 公里` : undefined;
    if (a?.op === "maintenance") {
      // 日期与里程都回显：车主要能一眼看出哪个数记错了。
      return ["记一次保养", when, a?.items, km].filter(Boolean).join(" · ");
    }
    if (a?.op === "repair") {
      return ["记一次维修", when, a?.symptom, km].filter(Boolean).join(" · ");
    }
    return km ? `把当前里程更新为 ${km}` : "更新车辆档案";
  }
  if (tool === "trip_plan_cancel") {
    // 取消时入参里只有 planId（要取消哪份由服务端定），**不编目的地**。
    return "取消已确认的行程";
  }
  if (tool === "trip_plan_update") {
    const a = args as { plan?: { destination?: string; days?: number } } | undefined;
    const obj = [a?.plan?.destination, a?.plan?.days ? `${a.plan.days}天` : ""]
      .filter(Boolean)
      .join(" ");
    return obj ? `变更已确认的行程：${obj}` : "变更已确认的行程";
  }
  if (tool === "trip_plan_commit") {
    /*
     * 与 `supervisor` 那条路径给出同一句话（`commitDisclosures` 旁边的摘要）。
     *
     * 不写这一条的话走的是下面的兜底：**工具描述 + 原始 JSON 入参**——
     * 那是写给模型看的文本，却会原样成为确认弹窗的标题。实测长这样：
     *   「把用户已认可的多天行程草案确认落库（需用户确认）。有副作用且不重试。（入参
     *    {"op":"cancel","userId":"F-23-09"}）」
     * 用户在这一屏要回答的是"我批的是什么"，给他看工具描述等于没说。
     */
    const a = args as { plan?: { destination?: string; days?: number } } | undefined;
    const what = "确认多天行程并保存";
    const obj = [a?.plan?.destination, a?.plan?.days ? `${a.plan.days}天` : ""]
      .filter(Boolean)
      .join(" ");
    // 取消时入参里没有 plan（要取消哪份由服务端定），此时只说动作，不编目的地。
    return obj ? `${what}：${obj}` : what;
  }
  /*
   * 兜底：**只给动作名，不倒 JSON**。
   *
   * 原先是 `描述（入参：{json}）`。它同时犯两件事：把写给模型的描述当用户文案，
   * 以及把入参原样倒进弹窗——那里面可能有手机号、地址这类不该在标题上出现的东西。
   * 新增敏感工具时应当在上面补一条专门的摘要，而不是依赖这里。
   */
  return fallback.split(/[。（(]/)[0] || tool;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(",")}}`;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** 返回 true 表示本请求已被处理。 */
export async function handleToolsRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method === "GET" && req.url?.startsWith(TOOLS_STATS_PATH)) {
    json(res, 200, getToolEndpointStats());
    return true;
  }

  if (req.method === "GET" && req.url?.startsWith(TOOLS_DESCRIBE_PATH)) {
    const agent = (new URL(req.url, "http://x").searchParams.get("agent") ?? "supervisor") as AgentName;
    stats.describeCalls += 1;
    json(res, 200, { agent, tools: describeForPi(agent) });
    return true;
  }

  if (req.method !== "POST" || req.url !== TOOLS_INVOKE_PATH) return false;

  let body: InvokeBody;
  try {
    body = (await readJson(req)) as InvokeBody;
  } catch {
    json(res, 400, { error: "invalid_json" });
    return true;
  }

  if (!body.name) {
    json(res, 400, { error: "missing_tool_name" });
    return true;
  }

  // 反解优先于 pi 进程自报的身份：进程只知道自己是哪个 Agent 的，
  // 而 fan-out 的 `trip-task` 与直达的 `trip` 跑在同一进程里、是两个会话。
  const piSessionId = body.piSessionId ?? "unknown";
  const resolved = resolveSession?.(piSessionId);
  // 会话身份带后缀（`trip-task` / `supervisor-intent`），而工具 ACL 按**规范 Agent** 裁剪。
  // 不归一的话 `listForAgent("trip-task")` 返回空表，出行分支调 calendar 会被自己人 403。
  const agent = canonicalAgent(resolved?.agent ?? body.agent ?? "supervisor") as AgentName;

  // 工具表按 Agent 裁剪（§4.3）——pi 侧即使发来不属于它的工具名也要拒。
  if (!listForAgent(agent).some((t) => t.name === body.name)) {
    json(res, 403, { error: "tool_not_allowed_for_agent", agent, tool: body.name });
    return true;
  }

  const sessionId = resolved?.carlifeSessionId ?? `unresolved:${piSessionId}`;

  /*
   * 可见域裁剪（M48-06，F-57-03）。**执行点在这里，不在提示词里。**
   *
   * spawn 时的 `--tools` 清单是按 Agent 算的、整个 pi 进程共用一份，
   * 而"谁在用"是每个会话各自的——所以裁剪只能落在每次调用上。
   * 这也是唯一真正拦得住的地方：清单是给模型的提示，这里是门。
   *
   * 两类裁剪：
   *  - **访客**（无账号）调个人域工具：它没有"自己的偏好/行程/日历"，
   *    调用的只可能是别人的；
   *  - **非车主**调只有车主能用的写类工具（设计裁决 R7）。
   *
   * 拒绝时说清是**这一步做不了**以及为什么——回一句"失败了"会让模型
   * 换个说法再试一次，而那次仍然会被拒。
   */
  const access = resolveSessionAccess ? await resolveSessionAccess(sessionId) : undefined;
  if (access) {
    const guest = access.userId === null;
    if (guest && (PRIVATE_DOMAIN_TOOLS as readonly string[]).includes(body.name)) {
      stats.denied += 1;
      json(res, 200, {
        ok: false,
        error:
          "当前是访客模式，读不到个人偏好、日历与行程安排。要用这些，请在车机上选择你的账号。",
        decision: "deny",
      });
      return true;
    }
    if (
      (OWNER_ONLY_TOOLS as readonly string[]).includes(body.name) &&
      access.role !== "owner"
    ) {
      stats.denied += 1;
      json(res, 200, {
        ok: false,
        error: "只有车主可以修改这辆车的档案与人员名单。",
        decision: "deny",
      });
      return true;
    }
  }
  stats.invocations += 1;
  if (!resolved) stats.unresolvedSessionCalls += 1;
  stats.byTool[body.name] = (stats.byTool[body.name] ?? 0) + 1;

  /*
   * 用户维度补在**权限门之前**。
   *
   * 本来放在后面（权限门看的是动作与外发项，与 userId 无关，提前补等于每次敏感调用
   * 多查一次库）。但走 `memberId` 下单时，外发块**只能**按 userId + memberId 去库里取，
   * 补晚了那一块就是空的——而"将提供给门店的信息"为空正是 AC-15-7 要防的那种失败：
   * 弹窗看起来完全正常，用户以为没有信息外发。一次库查换这个，值。
   */
  const args = await withUserId(body.args, sessionId);

  // 敏感工具过权限门；**只读工具根本不调**——零额外往返（§8.4 表第三行 / F-27-09）。
  const reg = getTool(body.name);
  if (reg?.sensitive) {
    if (!guardGate) {
      json(res, 200, { ok: false, error: "权限门未装配，敏感动作一律拒绝" });
      return true;
    }
    const verdict = await guardGate.check({
      sessionId,
      agent,
      tool: body.name,
      summary: summarizeAction(body.name, args, reg.description),
      disclosures: await DISCLOSURE_BUILDERS[body.name]?.(args),
      idempotencyKey: body.idempotencyKey,
      // 动作指纹：模型重试时**不会**重发同一个 idempotencyKey（pi 扩展根本不发它），
      // 但它重试的确实是同一件事。权限门据此不再重复打扰用户。
      actionKey: refusalKey(sessionId, body.name, args),
    });
    if (verdict.decision !== "allow") {
      stats.denied += 1;
      json(res, 200, { ok: false, error: verdict.reason, decision: verdict.decision });
      return true;
    }
  }

  const startedAt = Date.now();
  try {
    const result = await invokeTool(body.name, args, {
      sessionId,
      // 轮次维度（M30-03 真跑第一轮抓到的缺口）：ToolCallContext 里一直有 turnId 字段，
      // 但这里从来没填过——currentTurnId 此前只喂权限门指纹（上面 :198）。
      // 后果：submit_hotels 的提交归不了轮被拒；cabin deriveRequestId 的幂等
      // 也一直走的是"turnId 缺失退回随机"那条兜底。同一键空间，就该同一来源。
      turnId: currentTurnId(sessionId),
      agent,
      mode: body.mode,
    });
    console.log(
      `[tools] ${body.name} agent=${agent} session=${sessionId} ok ${Date.now() - startedAt}ms`,
    );
    recordCall({ sessionId, name: body.name, at: startedAt, ok: true });
    json(res, 200, { ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[tools] ${body.name} agent=${agent} session=${sessionId} failed ${Date.now() - startedAt}ms: ${message}`,
    );
    // 结构化失败：由调用方决定降级，底层不自动降级（FL-33 F-33-07 同一原则）。
    stats.failures += 1;
    recordCall({ sessionId, name: body.name, at: startedAt, ok: false });
    json(res, 200, { ok: false, error: message });
  }
  return true;
}
