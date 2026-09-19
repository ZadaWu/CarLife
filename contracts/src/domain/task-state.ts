/**
 * 任务工作状态（施工单 M84-01，ACR-036，架构文档 §4.9）。
 *
 * # 它是什么
 *
 * 「这个人手上正在办的一件事」——一份还没定下来的行程、一次没走完的试驾预约、一段等着留档的问诊。
 * 与图状态的分工：**图状态只装本轮的东西**（`messages` / `intent` / `route` / `agentResults`），
 * 跨轮的业务状态住这里，键是 **`userId × kind`**，不是 sessionId。
 *
 * # 为什么不能再挂在会话上
 *
 * 今天这些状态挂在 LangGraph 的 thread 上，而 thread 绑死 sessionId（`turn-runner.ts` 的
 * `threadId = ${sessionId}#${nowMs}`），端上 30 分钟空闲就换会话、按「退下」也换。
 * 于是"行程草案跨轮存活"这条设计承诺的实际寿命是 30 分钟：车主昨晚在手机上排的三天行程，
 * 今天在车上说「把第二天换成室内的」，编排层手里什么都没有，只能当成一次全新规划。
 *
 * # 这里唯一需要动脑子的地方：`dirty`
 *
 * 已经落库的行程被改了一笔、但还没重新确认——这一态今天**不存在**，后果是同一件事有两个说法：
 * `itinerary.ts` 的收尾句无条件说"这份行程仍是草案、不在座舱主页上"（可它就在主页上），
 * 而 `intent.ts` 的 `planStateLine` 只看有没有落过库，说"再说一次「定了」而内容没变，那是 none"
 * （可内容确实变了）。车主于是反复被要求确认，而每一次确认都判成"不是确认"。
 * `dirty` 就是把这件事写下来：`base` 在场 + draft 变过。
 *
 * # 约束
 *
 * - **完全可序列化**（FL-11 F-11-02 的边界）：
 *   时间一律 epoch 毫秒 `number`，集合一律数组；不放函数、`Date`、`Map`/`Set`、连接句柄。
 *   它要进 PG 的 `Json` 列（`working_tasks.draft`），放进去就炸。
 * - **`reduceTask` 是纯函数**：返回新对象、不改入参、同一对 `(state, event)` 调两次结果相同。
 *   它要在 `agent-runtime` 与将来的 worker 两处跑，任何隐藏状态都会让两处分叉。
 * - **`version` 由 reducer 递增，调用方不给**。调用方拿它去填乐观并发的 `WHERE version = ?`
 *   （`@carlife/db` 的 `createWorkingTaskStore().apply`）；两处各自加一会跳号，而跳号让那个
 *   `WHERE` 永远不命中，表现是"写了但没保存"且不报错。
 */

/**
 * 任务种类。**本 Sprint（M84）只接 `trip`**，其余四个先占位——
 * 它们今天还在图状态的 8 个通道里（`testDrivePlan` / `repairBookingPlan` / `costPlan` /
 * `buyingPlan` / `trimPlan` / `loanPlan` / `insurancePlan` / `consultation`），迁移归 ACR-037。
 */
export type TaskKind = "trip" | "test-drive" | "repair-booking" | "buying" | "consultation";

export const TASK_KINDS: readonly TaskKind[] = [
  "trip",
  "test-drive",
  "repair-booking",
  "buying",
  "consultation",
];

/**
 * 任务状态。
 *
 * - `drafting` —— 在排、在改，还没有落过库。
 * - `awaiting_confirm` —— 确认弹窗已经发出去，权限门那边挂着（最长 10 分钟）。
 *   **它必须在 `gate.check` 之前落库**：挂起期间进程可能重启，重启后读到的必须是"在等确认"。
 * - `committed` —— 落过库，且眼前这一版与库里那一版一致。
 * - `dirty` —— 落过库，但之后又改过，改动还没保存。见文件头。
 * - `done` / `cancelled` / `expired` —— 终态。没有任何事件产出 `done`：它由装载层按业务判
 *   （行程的最后一天已经过去），经 `store.close(id, "done", at)` 写入。
 */
export type TaskStatus =
  | "drafting"
  | "awaiting_confirm"
  | "committed"
  | "dirty"
  | "done"
  | "cancelled"
  | "expired";

/** 终态。进了这几个之一就置 `closedAt`，`loadActive` 不再返回它。 */
export const CLOSED_STATUSES: readonly TaskStatus[] = ["done", "cancelled", "expired"];

/**
 * 按任务种类的空闲过期时长。**放 contracts 不放 agent-runtime**：装载层的懒过期与将来
 * worker 的定时清扫必须用同一份，两处各写一份必然漂移（同 `ELICITATION_WEIGHT` 的理由）。
 *
 * 每一项的取值理由：
 * - `trip` 7 天 —— 一次出行的筹备周期。排完放几天再回来接着改是常事。
 * - `test-drive` / `repair-booking` 24 小时 —— 选门店选时段是当天的事；隔天那批时段本来就没了。
 * - `buying` 3 天 —— 比价的耐心大约就这么长；再长的话上一轮的报价已经不作数。
 * - `consultation` 24 小时 —— 问诊到留档之间隔着一两轮对话，不该跨天。
 */
export const TASK_TTL_MS: Record<TaskKind, number> = {
  trip: 7 * 24 * 60 * 60 * 1000,
  "test-drive": 24 * 60 * 60 * 1000,
  "repair-booking": 24 * 60 * 60 * 1000,
  buying: 3 * 24 * 60 * 60 * 1000,
  consultation: 24 * 60 * 60 * 1000,
};

/**
 * 追问最多挂几轮没人答。超了由**装载层**清（`context/tasks.ts`），reducer 不做轮数计时——
 * 它手上没有"轮"这个概念，只有事件。
 */
export const TASK_PENDING_MAX_TURNS = 3;

/** 挂着的一个问题。`candidates` 的顺序就是报给车主的那份列表的顺序，序号要对得上。 */
export interface TaskPending {
  kind: "cancel_pick" | "confirm" | "elicitation";
  /** 问出这个问题的轮次；只为排查时能对上，不参与判定。 */
  askedTurnId: string;
  askedAt: number;
  /** 已经过了几轮还没答。由装载层递增，到 `TASK_PENDING_MAX_TURNS` 就清。 */
  unansweredTurns: number;
  candidates?: ReadonlyArray<{ ref: string; label: string }>;
}

/**
 * 落库那一份的引用。`ref` 对行程来说就是 `trip_plans.id`（今天图状态里的 `committedPlanId`）。
 * `version` 是**我们自己**记的第几次落库，与 `TaskState.version` 不是一回事：
 * 后者每个事件都 +1，这个只在 `task.committed` 时 +1。
 */
export interface TaskBaseRef {
  ref: string;
  version: number;
  committedAt: number;
}

/** 上一次动作。给排查与"这一轮到底做没做成"用。 */
export interface TaskLastAction {
  turnId: string;
  sessionId: string;
  /** 事件类型去掉 `task.` 前缀。 */
  op: string;
  outcome: "ok" | "denied" | "failed";
  at: number;
}

/**
 * 一件正在办的事。
 *
 * `draft` 故意是 `unknown` 而不是 `TaskState<K>` 泛型：仓储那一层只认 `Json`，
 * 泛型会让 `rowToTask` / `taskToRow` 的类型体操压过收益。消费方在自己那一侧收窄
 * （行程侧写 `draft as TripPlanState`）。**不要"顺手泛型化"**——这条取舍是想过的。
 */
export interface TaskState {
  id: string;
  userId: string;
  kind: TaskKind;
  status: TaskStatus;
  draft: unknown;
  base?: TaskBaseRef;
  pending?: TaskPending;
  lastAction?: TaskLastAction;
  /** 这份草案是照哪些硬约束排的。用途同今天的 `TripPlanState.builtWith`。 */
  constraints: readonly string[];
  version: number;
  openedAt: number;
  touchedAt: number;
  expiresAt: number;
  closedAt?: number;
  /** 触碰过它的会话。只为排障（"这份是在哪几段对话里改出来的"），不参与判定。 */
  sessionIds: readonly string[];
}

/** 事件里共有的那几栏。`task.expired` 没有轮次与会话（它由装载层判出来的，不属于任何一轮）。 */
interface TurnStamp {
  at: number;
  turnId: string;
  sessionId: string;
}

export type TaskEvent =
  | ({ type: "task.draft.updated"; draft: unknown; constraints?: readonly string[] } & TurnStamp)
  | ({ type: "task.awaiting_confirm" } & TurnStamp)
  | ({ type: "task.committed"; ref: string; mode: "create" | "update" } & TurnStamp)
  | ({ type: "task.confirm.denied"; reason: string } & TurnStamp)
  | ({ type: "task.cancelled" } & TurnStamp)
  | ({ type: "task.question.asked"; pending: Omit<TaskPending, "unansweredTurns"> } & TurnStamp)
  | ({ type: "task.question.answered" } & TurnStamp)
  | ({ type: "task.discarded" } & TurnStamp)
  | { type: "task.expired"; at: number };

export type TaskEventType = TaskEvent["type"];

/** 还开着吗。判据是 `closedAt`，不是 `status` —— 两者同时写，但前者是那一栏的本职。 */
export function isActive(state: TaskState): boolean {
  return state.closedAt === undefined;
}

export interface OpenTaskArgs {
  id: string;
  userId: string;
  kind: TaskKind;
  draft: unknown;
  constraints?: readonly string[];
  at: number;
  sessionId: string;
}

/** 开一件事。状态 `drafting`、`version` 从 1 起。 */
export function openTask(args: OpenTaskArgs): TaskState {
  return {
    id: args.id,
    userId: args.userId,
    kind: args.kind,
    status: "drafting",
    draft: args.draft,
    constraints: args.constraints ? [...args.constraints] : [],
    version: 1,
    openedAt: args.at,
    touchedAt: args.at,
    expiresAt: args.at + TASK_TTL_MS[args.kind],
    sessionIds: [args.sessionId],
  };
}

/** 事件类型 → `lastAction.op`。 */
function opOf(type: TaskEventType): string {
  return type.replace(/^task\./, "");
}

function outcomeOf(type: TaskEventType): TaskLastAction["outcome"] {
  return type === "task.confirm.denied" ? "denied" : "ok";
}

/** 追加会话 id，已在里面就原样返回（不产生新数组，便于上层判"变没变"）。 */
function withSession(ids: readonly string[], sessionId: string): readonly string[] {
  return ids.includes(sessionId) ? ids : [...ids, sessionId];
}

/**
 * 一个事件落在某个状态上会变成什么。**只回答 `status`**，其余字段的更新在 `reduceTask` 里统一做。
 *
 * 这张表就是施工单 M84-04 那张表的代码形态；改它之前先改那张表，别反过来。
 */
function nextStatus(current: TaskStatus, event: TaskEvent): TaskStatus {
  switch (event.type) {
    case "task.draft.updated":
      // 已经落过库的（committed / dirty）一改就进 dirty；还没落过库的照旧在 drafting。
      // 落在 awaiting_confirm 上是"确认还没批、他又改了"——回 drafting，那次确认作废。
      return current === "committed" || current === "dirty" ? "dirty" : "drafting";
    case "task.awaiting_confirm":
      return "awaiting_confirm";
    case "task.committed":
      return "committed";
    case "task.confirm.denied":
      // 拒绝不是事故，是正常路径：回到"他还没批"的那个状态。
      // 落过库的退回 committed / dirty（库里那份原样在），没落过库的退回 drafting。
      return current === "committed" || current === "dirty" ? current : "drafting";
    case "task.cancelled":
      return "cancelled";
    case "task.question.asked":
    case "task.question.answered":
      // 问一句、答一句都不改变"这件事办到哪一步了"。
      return current;
    case "task.discarded":
      // 丢掉改动：落过库的退回 committed（draft 由调用方回填 base 快照，reducer 手上没有它）；
      // 没落过库的就没什么可退的，整件事作废。
      return current === "committed" || current === "dirty" ? "committed" : "cancelled";
    case "task.expired":
      return "expired";
  }
}

/**
 * 推进一个事件。纯函数：返回新对象，不改入参。
 *
 * 两条非常规：
 * - **终态 + `task.expired` 是空转**（原样返回，连 `version` 都不加）。装载层的懒过期只对
 *   `closedAt === null` 的行发这个事件，但真发重了也不该把"他取消过"改写成"过期了"——
 *   那是审计事实。
 * - **终态 + 其它事件抛错**。静默返回原状态的后果是"状态机看起来在工作、实际停在原地"，
 *   而那正是今天 `tripPlan.status` 的毛病。
 */
export function reduceTask(state: TaskState, event: TaskEvent): TaskState {
  const closed = CLOSED_STATUSES.includes(state.status);
  if (closed) {
    if (event.type === "task.expired") return state;
    throw new Error(
      `任务状态不合法的推进：${state.status} --${event.type}--> ？（任务已终结，id=${state.id}）`,
    );
  }

  const status = nextStatus(state.status, event);
  const next: TaskState = {
    ...state,
    status,
    version: state.version + 1,
    touchedAt: event.at,
    // 过期不再顺延（它就是"到期了"本身）；其余任何一次触碰都从此刻重新计时。
    expiresAt: event.type === "task.expired" ? state.expiresAt : event.at + TASK_TTL_MS[state.kind],
    sessionIds:
      event.type === "task.expired" ? state.sessionIds : withSession(state.sessionIds, event.sessionId),
  };

  if (event.type !== "task.expired") {
    next.lastAction = {
      turnId: event.turnId,
      sessionId: event.sessionId,
      op: opOf(event.type),
      outcome: outcomeOf(event.type),
      at: event.at,
    };
  }

  switch (event.type) {
    case "task.draft.updated":
      next.draft = event.draft;
      if (event.constraints) next.constraints = [...event.constraints];
      break;
    case "task.committed":
      next.base = {
        ref: event.ref,
        version: (state.base?.version ?? 0) + 1,
        committedAt: event.at,
      };
      break;
    case "task.question.asked":
      next.pending = { ...event.pending, unansweredTurns: 0 };
      break;
    case "task.question.answered":
      delete next.pending;
      break;
    default:
      break;
  }

  if (CLOSED_STATUSES.includes(status)) next.closedAt = event.at;

  return next;
}
