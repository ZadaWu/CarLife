/**
 * 任务工作状态的装载（施工单 M84-03 只读那一半，M84-04 接写）。
 *
 * # 本单只读
 *
 * 这一单把"他手上有几件事、办到哪一步了"摆进上下文；**谁来改它**是 M84-04 的事。
 * 分开是因为读这一半可以在 `inject` 档下先跑起来，而写那一半要动 `itineraryNode`
 * 的每一条处置路径——两件事一起改，出问题时分不清是哪一半坏的。
 *
 * # 追问的轮数计时在这里，不在 reducer 里
 *
 * `TaskPending.unansweredTurns` 每装载一次 +1，到 `TASK_PENDING_MAX_TURNS` 就清掉
 * （那个问题已经没人会答了，留着只会让下一轮的「确认」被当成对它的回答）。
 * reducer 手上没有"轮"这个概念，只有事件——所以这件事只能在装载层做。
 * **本单先不落库这个计数**（落库要走 `apply`，那是 M84-04 的写路径），
 * 只在内存里的副本上递增并据此决定渲不渲染——判断对，账还没记上，M84-04 补。
 */

import {
  TASK_PENDING_MAX_TURNS,
  openTask,
  reduceTask,
  type TaskEvent,
  type TaskKind,
  type TaskState,
} from "@carlife/shared";

/** 装配层注入的仓储。`loadActive` 是 M84-03 就在用的读，其余三个是 M84-04 的写。 */
export interface TaskReader {
  loadActive(userId: string, now: number): Promise<TaskState[]>;
  open?(task: TaskState): Promise<void>;
  apply?(id: string, expectedVersion: number, next: TaskState): Promise<boolean>;
  get?(userId: string, kind: TaskKind): Promise<TaskState | null>;
}

export type ActiveTasks = Partial<Record<TaskKind, TaskState>>;

/**
 * 装载这个人还活着的任务，按 kind 收成一张表。
 *
 * 同 kind 有多份时取最近触碰的那份——仓储的 `open` 保证了活跃唯一，
 * 这里再收一次是为了"万一"：两份并存时**取一份**比抛错好，
 * 抛错会让一次正常对话变成一次失败。
 */
export async function loadActiveTasks(
  reader: TaskReader | undefined,
  userId: string | undefined,
  now: number,
): Promise<ActiveTasks> {
  if (!reader || !userId) return {};
  let tasks: TaskState[];
  try {
    tasks = await reader.loadActive(userId, now);
  } catch (err) {
    // 读不到任务不该让对话失败——退化成"手上没有进行中的事"，与今天换会话之后的行为相同。
    console.warn("[context] 任务状态读取失败，本轮按「手上没有进行中的事」处理", err);
    return {};
  }

  const out: ActiveTasks = {};
  for (const t of tasks) {
    const prev = out[t.kind];
    if (!prev || prev.touchedAt < t.touchedAt) out[t.kind] = t;
  }

  // 追问的轮数：这一轮又过去了，没答就加一。加到上限就当那个问题不存在。
  for (const kind of Object.keys(out) as TaskKind[]) {
    const t = out[kind];
    if (!t?.pending) continue;
    const turns = t.pending.unansweredTurns + 1;
    out[kind] =
      turns >= TASK_PENDING_MAX_TURNS
        ? { ...t, pending: undefined }
        : { ...t, pending: { ...t.pending, unansweredTurns: turns } };
  }
  return out;
}

/**
 * 一行「手上那件事办到哪了」。**不含正文**——正文只给路由到的那个 Agent（`task-draft` 项）。
 *
 * `dirty` 那一档是这个 Sprint 的要点：今天没有这一态，于是收尾句说"仍是草案"、
 * 意图提示说"已经确认落库"，车主被反复要求确认而每次都判成不是确认。
 */
export function taskStatusLine(tasks: ActiveTasks): string | undefined {
  const lines: string[] = [];
  for (const kind of Object.keys(tasks) as TaskKind[]) {
    const t = tasks[kind];
    if (!t) continue;
    lines.push(`${kindLabel(kind)}：${whatLabel(t)}${statusLabel(t)}`);
  }
  return lines.length ? `他手上进行中的事：\n${lines.map((l) => `- ${l}`).join("\n")}` : undefined;
}

/**
 * 手上那件事**是关于什么的**——行程给「苏州 3 天，」（ADR-010 / INC-0155）。
 *
 * 这一行从前只说办到哪一步（草案 / 已落库 / 改过没存），不说是哪一趟。
 * 而意图理解要判的一件事是「这一轮是接着改手上那份，还是另起一趟」，
 * 它的判据就是**目的地换没换**——判据要用的事实却不在描述「手上那份」的这一行里。
 * 真跑 turn-51ac0687 时模型只能绕道去车主档案的已确认清单里找目的地；
 * 那份清单和手上这件事不是一回事（草案可以还没落库），对上是运气。
 *
 * 只取目的地与天数：正文仍然只给路由到的那个 Agent（见本函数上面那段说明）。
 */
function whatLabel(t: TaskState): string {
  const d = t.draft as { destination?: unknown; days?: unknown } | undefined;
  const dest = typeof d?.destination === "string" ? d.destination.trim() : "";
  if (!dest) return "";
  const days = typeof d?.days === "number" && d.days > 0 ? ` ${d.days} 天` : "";
  return `${dest}${days}，`;
}

function kindLabel(kind: TaskKind): string {
  switch (kind) {
    case "trip":
      return "行程";
    case "test-drive":
      return "试驾预约";
    case "repair-booking":
      return "维修预约";
    case "buying":
      return "购车比选";
    case "consultation":
      return "售后问诊";
  }
}

function statusLabel(t: TaskState): string {
  switch (t.status) {
    case "drafting":
      return "有一份**还没确认、没落库**的草案。他这一轮但凡表示认可（含「定了」「就这样」「可以」「不用改了」），就是 commit。";
    case "awaiting_confirm":
      return "确认窗已经发出去了，正在等他按。**不要再问一遍**，也不要当成没发生过。";
    case "committed":
      return "有一份**已经确认落库**的，而且眼前这一版与库里那份一致。对它提修改是 adjust；他再说一次「定了」而内容没变，那是 none。";
    case "dirty":
      return "有一份**已经落库**的，但之后又改过，**改动还没保存**。库里那份是旧版。他表示认可就是 commit（走原地更新，不新落一行）。";
    default:
      return t.status;
  }
}

/** 上一轮问过的那个问题（与候选表同序——序号要与报给车主的那份对得上）。 */
export function taskPendingLine(tasks: ActiveTasks): string | undefined {
  const blocks: string[] = [];
  for (const kind of Object.keys(tasks) as TaskKind[]) {
    const p = tasks[kind]?.pending;
    if (!p) continue;
    const head = `上一轮已经问过他一个问题（${kindLabel(kind)}，${p.kind}），还没得到回答`;
    if (!p.candidates?.length) {
      blocks.push(`${head}。他这一轮的话可能是在答它。`);
      continue;
    }
    blocks.push(
      [
        `${head}，当时给他看的是这个列表（序号一致）：`,
        ...p.candidates.map((c, i) => `${i + 1}. ${c.label}`),
        "他这一轮若指向其中某一份（按目的地、日期、序号、「上次那个」这类指代都算），就是在答它；指向不明确就再问一次，**不要替他挑**。",
      ].join("\n"),
    );
  }
  return blocks.length ? blocks.join("\n") : undefined;
}


/**
 * 任务的写入口（M84-04，ACR-036 §4.9）。**图节点只调这里，不碰仓储**——
 * `check:arch` 的 `context-state-write-in-harness` 守着这一条。
 *
 * 写是"写穿"：reducer 算新状态 → `apply(id, 旧 version, 新状态)` → 同轮后续节点读到的是新值。
 * `apply` 返回 false 是**版本冲突**（别处先写了，比如车主同时在手机上改）——
 * 重读重放一次；再失败就如实说，不再重试：第三次多半还是同样的结果，而每一次都在烧时间。
 */
export interface TaskWriter {
  /** 开一件事（同 kind 的旧活跃行由仓储在同一事务里关掉）。 */
  open(args: { kind: TaskKind; draft: unknown; constraints?: readonly string[]; baseRef?: string; sessionId: string; turnId: string }): Promise<TaskState | undefined>;
  /** 推进一个事件。返回推进后的状态；没有这件事或写不进去时返回 undefined。 */
  emit(kind: TaskKind, event: TaskEvent): Promise<TaskState | undefined>;
  /** 这一轮发生过的事件（给表述层判收尾句用——不是查库，是本轮的账）。 */
  eventsOf(kind: TaskKind): readonly TaskEvent["type"][];
}

/** 没装配时的空实现：`tasks` 档没打开、或离线路径。**不抛错**，各节点走老路径。 */
export const NO_TASK_WRITER: TaskWriter = {
  async open() {
    return undefined;
  },
  async emit() {
    return undefined;
  },
  eventsOf() {
    return [];
  },
};

/**
 * 建一个写入口。`tasks` 是**本轮装载好的那份副本**，写穿之后就地更新它——
 * 同一轮里后面的节点（以及 `answerNode` 的收尾句）读到的必须是新值。
 */
export function createTaskWriter(args: {
  reader: TaskReader | undefined;
  userId: string | undefined;
  tasks: ActiveTasks;
  now: () => number;
  newId: () => string;
}): TaskWriter {
  const { reader, userId, tasks } = args;
  if (!reader?.apply || !reader.open || !userId) return NO_TASK_WRITER;
  const happened = new Map<TaskKind, TaskEvent["type"][]>();

  const note = (kind: TaskKind, type: TaskEvent["type"]) => {
    const list = happened.get(kind) ?? [];
    list.push(type);
    happened.set(kind, list);
  };

  return {
    async open({ kind, draft, constraints, baseRef, sessionId, turnId }) {
      const at = args.now();
      let task = openTask({ id: args.newId(), userId, kind, draft, ...(constraints ? { constraints } : {}), at, sessionId });
      // 从检查点迁进来的那一份可能已经落过库——直接推一个 committed 事件把 base 补上，
      // 而不是在 openTask 里加一个参数：状态只经事件产生，这一条不留例外。
      if (baseRef) {
        task = reduceTask(task, { type: "task.committed", ref: baseRef, mode: "create", at, turnId, sessionId });
      }
      try {
        await reader.open!(task);
      } catch (err) {
        console.warn("[context] 开任务失败，本轮按「手上没有进行中的事」处理", err);
        return undefined;
      }
      tasks[kind] = task;
      return task;
    },

    async emit(kind, event) {
      const current = tasks[kind];
      if (!current) return undefined;
      const write = async (base: TaskState): Promise<TaskState | undefined> => {
        const next = reduceTask(base, event);
        const ok = await reader.apply!(base.id, base.version, next);
        return ok ? next : undefined;
      };
      try {
        let next = await write(current);
        if (!next && reader.get) {
          // 版本冲突：别处先写了。重读重放一次——**只一次**。
          const fresh = await reader.get(userId, kind);
          if (fresh) next = await write(fresh);
        }
        if (!next) {
          console.warn(`[context] 任务状态写入冲突未能收敛（kind=${kind}, event=${event.type}）`);
          return undefined;
        }
        tasks[kind] = next;
        note(kind, event.type);
        return next;
      } catch (err) {
        console.warn(`[context] 任务状态写入失败（kind=${kind}, event=${event.type}）`, err);
        return undefined;
      }
    },

    eventsOf(kind) {
      return happened.get(kind) ?? [];
    },
  };
}
