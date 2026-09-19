/**
 * 任务工作状态的状态机（施工单 M84-01，ACR-036 §4.9）。
 *
 * 这里最要紧的不是"每个字段对不对"，是**转移表 36 格逐格对**：
 * 同一个 `task.draft.updated` 落在 `drafting` 上仍是 `drafting`、落在 `committed` 上变 `dirty`，
 * 而 `dirty` 这一态正是"确认过还一直被问确认"那个 bug 缺的那一块。
 * 所以表驱动写，表就是施工单 M84-01 的那张表——改代码之前先改那张表。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CLOSED_STATUSES,
  TASK_KINDS,
  TASK_PENDING_MAX_TURNS,
  TASK_TTL_MS,
  isActive,
  openTask,
  reduceTask,
  type TaskEvent,
  type TaskState,
  type TaskStatus,
} from "../src/index";

const T0 = 1_757_800_000_000; // 固定时刻，避免用例依赖当前时间
const DRAFT = { destination: "青岛", days: 3, skeleton: [{ day: 1, spots: ["栈桥"] }] };

function open(at = T0): TaskState {
  return openTask({
    id: "task-1",
    userId: "u-1",
    kind: "trip",
    draft: DRAFT,
    constraints: ["带老人"],
    at,
    sessionId: "sess-a",
  });
}

const stamp = (at: number, sessionId = "sess-a") => ({ at, turnId: `turn-${at}`, sessionId });

const ev = {
  draft: (at: number, draft: unknown = { ...DRAFT, days: 4 }): TaskEvent => ({
    type: "task.draft.updated",
    draft,
    ...stamp(at),
  }),
  awaiting: (at: number): TaskEvent => ({ type: "task.awaiting_confirm", ...stamp(at) }),
  committed: (at: number, ref = "plan-abc12345"): TaskEvent => ({
    type: "task.committed",
    ref,
    mode: "create",
    ...stamp(at),
  }),
  denied: (at: number): TaskEvent => ({
    type: "task.confirm.denied",
    reason: "车主点了拒绝",
    ...stamp(at),
  }),
  cancelled: (at: number): TaskEvent => ({ type: "task.cancelled", ...stamp(at) }),
  asked: (at: number): TaskEvent => ({
    type: "task.question.asked",
    pending: { kind: "cancel_pick", askedTurnId: `turn-${at}`, askedAt: at },
    ...stamp(at),
  }),
  answered: (at: number): TaskEvent => ({ type: "task.question.answered", ...stamp(at) }),
  discarded: (at: number): TaskEvent => ({ type: "task.discarded", ...stamp(at) }),
  expired: (at: number): TaskEvent => ({ type: "task.expired", at }),
};

/** 把任务推到某个开着的状态上。 */
function stateIn(status: "drafting" | "awaiting_confirm" | "committed" | "dirty"): TaskState {
  let s = open();
  if (status === "drafting") return s;
  s = reduceTask(s, ev.awaiting(T0 + 1_000));
  if (status === "awaiting_confirm") return s;
  s = reduceTask(s, ev.committed(T0 + 2_000));
  if (status === "committed") return s;
  return reduceTask(s, ev.draft(T0 + 3_000));
}

describe("[F-11-02][AC-11-1] 任务状态：可序列化与开局", () => {
  it("满字段的 TaskState 走一遍 JSON 往返后逐字段相同", () => {
    let s = stateIn("dirty");
    s = reduceTask(s, ev.asked(T0 + 4_000));
    assert.ok(s.base && s.pending && s.lastAction, "这一份要满字段才有意义");
    assert.deepStrictEqual(JSON.parse(JSON.stringify(s)), s);
  });

  it("openTask：drafting、version 1、按 kind 的 TTL、未关闭", () => {
    const s = open();
    assert.equal(s.status, "drafting");
    assert.equal(s.version, 1);
    assert.equal(s.expiresAt - s.openedAt, TASK_TTL_MS.trip);
    assert.equal(s.closedAt, undefined);
    assert.equal(isActive(s), true);
    assert.deepStrictEqual([...s.sessionIds], ["sess-a"]);
  });

  it("TTL 表：五个 kind 都有正值，trip 最长", () => {
    for (const k of TASK_KINDS) assert.ok(TASK_TTL_MS[k] > 0, `${k} 没有 TTL`);
    const max = Math.max(...TASK_KINDS.map((k) => TASK_TTL_MS[k]));
    assert.equal(TASK_TTL_MS.trip, max);
    assert.equal(TASK_PENDING_MAX_TURNS, 3);
  });
});

/**
 * 转移表 36 格。行=事件、列=当前状态，格子里是**新状态**。
 * 与施工单 M84-01「任务」§2 的那张表逐格对应。
 */
const TABLE: ReadonlyArray<{
  name: TaskEvent["type"];
  make: (at: number) => TaskEvent;
  to: Record<"drafting" | "awaiting_confirm" | "committed" | "dirty", TaskStatus>;
}> = [
  {
    name: "task.draft.updated",
    make: ev.draft,
    to: { drafting: "drafting", awaiting_confirm: "drafting", committed: "dirty", dirty: "dirty" },
  },
  {
    name: "task.awaiting_confirm",
    make: ev.awaiting,
    to: {
      drafting: "awaiting_confirm",
      awaiting_confirm: "awaiting_confirm",
      committed: "awaiting_confirm",
      dirty: "awaiting_confirm",
    },
  },
  {
    name: "task.committed",
    make: ev.committed,
    to: { drafting: "committed", awaiting_confirm: "committed", committed: "committed", dirty: "committed" },
  },
  {
    name: "task.confirm.denied",
    make: ev.denied,
    to: { drafting: "drafting", awaiting_confirm: "drafting", committed: "committed", dirty: "dirty" },
  },
  {
    name: "task.cancelled",
    make: ev.cancelled,
    to: { drafting: "cancelled", awaiting_confirm: "cancelled", committed: "cancelled", dirty: "cancelled" },
  },
  {
    name: "task.question.asked",
    make: ev.asked,
    to: { drafting: "drafting", awaiting_confirm: "awaiting_confirm", committed: "committed", dirty: "dirty" },
  },
  {
    name: "task.question.answered",
    make: ev.answered,
    to: { drafting: "drafting", awaiting_confirm: "awaiting_confirm", committed: "committed", dirty: "dirty" },
  },
  {
    name: "task.discarded",
    make: ev.discarded,
    to: { drafting: "cancelled", awaiting_confirm: "cancelled", committed: "committed", dirty: "committed" },
  },
  {
    name: "task.expired",
    make: ev.expired,
    to: { drafting: "expired", awaiting_confirm: "expired", committed: "expired", dirty: "expired" },
  },
];

const OPEN_STATUSES = ["drafting", "awaiting_confirm", "committed", "dirty"] as const;

describe("[F-11-02][AC-11-1] 任务状态：转移表 36 格", () => {
  for (const row of TABLE) {
    for (const from of OPEN_STATUSES) {
      it(`${from} --${row.name}--> ${row.to[from]}`, () => {
        const next = reduceTask(stateIn(from), row.make(T0 + 10_000));
        assert.equal(next.status, row.to[from]);
      });
    }
  }

  it("重点一：committed 被改一笔就进 dirty（今天没有这一态，于是同一件事有两个说法）", () => {
    const next = reduceTask(stateIn("committed"), ev.draft(T0 + 10_000, { ...DRAFT, days: 4 }));
    assert.equal(next.status, "dirty");
    assert.deepStrictEqual(next.draft, { ...DRAFT, days: 4 });
    assert.ok(next.base, "base 要留着——库里那份还在");
  });

  it("重点二：dirty 再确认一次，base.version 从 1 变 2（原地改写，不是新落一行）", () => {
    const dirty = stateIn("dirty");
    assert.equal(dirty.base?.version, 1);
    const next = reduceTask(dirty, ev.committed(T0 + 10_000, "plan-abc12345"));
    assert.equal(next.status, "committed");
    assert.equal(next.base?.version, 2);
    assert.equal(next.base?.ref, "plan-abc12345");
    assert.equal(next.base?.committedAt, T0 + 10_000);
  });

  it("重点三：dirty 丢掉改动退回 committed（draft 由调用方回填 base 快照）", () => {
    const next = reduceTask(stateIn("dirty"), ev.discarded(T0 + 10_000));
    assert.equal(next.status, "committed");
    assert.equal(next.closedAt, undefined, "退回不是终结");
    assert.equal(next.lastAction?.op, "discarded");
  });
});

describe("[F-11-02][AC-11-1] 任务状态：reducer 是纯函数", () => {
  it("同一对 (state, event) 调两次结果相同", () => {
    const s = stateIn("committed");
    const e = ev.draft(T0 + 10_000);
    assert.deepStrictEqual(reduceTask(s, e), reduceTask(s, e));
  });

  it("入参不被修改", () => {
    const s = stateIn("committed");
    const before = JSON.parse(JSON.stringify(s));
    reduceTask(s, ev.draft(T0 + 10_000));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(s)), before);
  });

  it("version 每个事件恰好 +1", () => {
    let s = open();
    const events = [
      ev.awaiting(T0 + 1_000),
      ev.committed(T0 + 2_000),
      ev.draft(T0 + 3_000),
      ev.asked(T0 + 4_000),
      ev.answered(T0 + 5_000),
    ];
    for (const e of events) s = reduceTask(s, e);
    assert.equal(s.version, 1 + events.length);
  });

  it("sessionIds 去重追加", () => {
    let s = open();
    s = reduceTask(s, ev.draft(T0 + 1_000));
    assert.deepStrictEqual([...s.sessionIds], ["sess-a"]);
    s = reduceTask(s, { type: "task.draft.updated", draft: DRAFT, ...stamp(T0 + 2_000, "sess-b") });
    assert.deepStrictEqual([...s.sessionIds], ["sess-a", "sess-b"]);
  });

  it("expiresAt 每次触碰都从此刻重新计时", () => {
    const a = reduceTask(open(), ev.draft(T0 + 1_000));
    const b = reduceTask(a, ev.draft(T0 + 9_000));
    assert.equal(a.expiresAt, T0 + 1_000 + TASK_TTL_MS.trip);
    assert.equal(b.expiresAt - a.expiresAt, 8_000);
  });
});

describe("[F-11-02][AC-11-1] 任务状态：终态与 pending", () => {
  it("进终态时置 closedAt 且 isActive 变 false", () => {
    for (const e of [ev.cancelled(T0 + 10_000), ev.expired(T0 + 10_000)]) {
      const next = reduceTask(open(), e);
      assert.ok(CLOSED_STATUSES.includes(next.status));
      assert.equal(next.closedAt, T0 + 10_000);
      assert.equal(isActive(next), false);
    }
  });

  it("终态 + 非 expired 事件抛错，消息里带得出是哪一步", () => {
    const closed = reduceTask(open(), ev.cancelled(T0 + 10_000));
    for (const e of [ev.draft(T0 + 11_000), ev.committed(T0 + 11_000), ev.discarded(T0 + 11_000)]) {
      assert.throws(
        () => reduceTask(closed, e),
        (err: unknown) => err instanceof Error && err.message.includes("-->"),
        `${e.type} 落在终态上应当抛错`,
      );
    }
  });

  it("终态 + expired 是空转：不改状态、不加 version（取消过就是取消过，不能被改写成过期）", () => {
    const closed = reduceTask(open(), ev.cancelled(T0 + 10_000));
    const again = reduceTask(closed, ev.expired(T0 + 20_000));
    assert.strictEqual(again, closed);
    assert.equal(again.status, "cancelled");
  });

  it("question.asked 挂上 pending 但不改状态；answered 清掉它", () => {
    const asked = reduceTask(stateIn("committed"), ev.asked(T0 + 10_000));
    assert.equal(asked.status, "committed");
    assert.equal(asked.pending?.kind, "cancel_pick");
    assert.equal(asked.pending?.unansweredTurns, 0);
    const answered = reduceTask(asked, ev.answered(T0 + 11_000));
    assert.equal(answered.pending, undefined);
    assert.equal(answered.status, "committed");
  });

  it("confirm.denied 记 outcome=denied，其余事件记 ok", () => {
    const denied = reduceTask(stateIn("awaiting_confirm"), ev.denied(T0 + 10_000));
    assert.equal(denied.lastAction?.outcome, "denied");
    assert.equal(denied.lastAction?.op, "confirm.denied");
    const ok = reduceTask(stateIn("drafting"), ev.awaiting(T0 + 10_000));
    assert.equal(ok.lastAction?.outcome, "ok");
  });
});
