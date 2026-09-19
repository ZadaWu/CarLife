/**
 * [F-21-06][AC-21-6][F-11-02][AC-11-1] 行程改读任务状态（M84-04，ACR-036 §4.9）。
 *
 * 这个 Sprint 的三个真跑现象在这一单闭合，所以这里按现象组织：
 *  ① 换会话后「把行程改成 3 天」被当成全新规划 —— 任务按 userId 存，换 thread 也在；
 *  ② 细化轮把 3 天缩成 1 天且零报错 —— 天数守卫 + 体检的事实源改成草案；
 *  ③ 已确认的行程每次细化都被说成「仍是草案」—— 收尾句与意图提示各有三档。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { openTask, reduceTask, type TaskEvent, type TaskKind, type TaskState } from "@carlife/shared";

import { AnchorPins, loadTurnContext } from "../src/context";
import { createTaskWriter, loadActiveTasks, taskStatusLine } from "../src/context/tasks";
import { planStateLine } from "../src/graph/intent";
import {
  describeItineraryPlan,
  describeSaveState,
  mergeItinerary,
  type ItineraryInput,
  type ItineraryMergeOutput,
} from "../src/graph/subgraphs/itinerary";
import type { TripPlanState } from "../src/graph/state";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const SUP = src("../src/graph/supervisor.ts");

/** 一个进程内的假仓储，形状与 `@carlife/db` 的 `createWorkingTaskStore` 一致。 */
function memoryStore() {
  const rows = new Map<string, TaskState>();
  return {
    rows,
    async loadActive(userId: string, now: number): Promise<TaskState[]> {
      const out: TaskState[] = [];
      for (const t of rows.values()) {
        if (t.userId !== userId || t.closedAt !== undefined) continue;
        if (t.expiresAt <= now) {
          rows.set(t.id, reduceTask(t, { type: "task.expired", at: now }));
          continue;
        }
        out.push(t);
      }
      return out;
    },
    async get(userId: string, kind: TaskKind): Promise<TaskState | null> {
      for (const t of rows.values()) {
        if (t.userId === userId && t.kind === kind && t.closedAt === undefined) return t;
      }
      return null;
    },
    async open(task: TaskState): Promise<void> {
      for (const [id, t] of rows) {
        if (t.userId === task.userId && t.kind === task.kind && t.closedAt === undefined) {
          rows.set(id, { ...t, status: "cancelled", closedAt: task.openedAt });
        }
      }
      rows.set(task.id, task);
    },
    async apply(id: string, expectedVersion: number, next: TaskState): Promise<boolean> {
      const cur = rows.get(id);
      if (!cur || cur.version !== expectedVersion) return false;
      rows.set(id, next);
      return true;
    },
  };
}

const T0 = 1_757_800_000_000;
const plan = (days: number): TripPlanState => ({
  status: "confirmed",
  destination: "青岛",
  days,
  skeleton: Array.from({ length: days }, (_, i) => ({
    day: i + 1,
    theme: `第 ${i + 1} 天`,
    spots: [{ name: `景点${i + 1}` }],
  })),
  caveats: [],
  updatedTurnId: "turn-0",
});

const stamp = { at: T0, turnId: "t1", sessionId: "s1" };

describe("[F-21-06][AC-21-6] 现象①：换会话之后那份行程还在", () => {
  it("同一 userId、两个不同 thread，第二个会话看得到第一个会话排的草案", async () => {
    const store = memoryStore();
    const pins = new AnchorPins();
    const deps = { readers: {}, taskReader: store, pins };

    // 第一段会话：排出一份 3 天草案
    const t1 = await loadTurnContext(deps, { userId: "u-1", threadId: "th-A", now: T0 }, "tasks");
    await t1!.writer.open({ kind: "trip", draft: plan(3), sessionId: "s-A", turnId: "t-A" });

    // 第二段会话（新 thread，同一个人）
    const t2 = await loadTurnContext(deps, { userId: "u-1", threadId: "th-B", now: T0 + 60_000 }, "tasks");
    const draft = t2!.tasks.trip?.draft as TripPlanState | undefined;
    assert.ok(draft, "换会话之后必须还看得见——这正是「被当成全新规划」的根因");
    assert.equal(draft.days, 3);
    assert.equal(draft.destination, "青岛");
  });

  it("别人的行程看不见", async () => {
    const store = memoryStore();
    const pins = new AnchorPins();
    const deps = { readers: {}, taskReader: store, pins };
    const mine = await loadTurnContext(deps, { userId: "u-1", threadId: "th-A", now: T0 }, "tasks");
    await mine!.writer.open({ kind: "trip", draft: plan(3), sessionId: "s-A", turnId: "t-A" });
    const other = await loadTurnContext(deps, { userId: "u-2", threadId: "th-C", now: T0 }, "tasks");
    assert.equal(other!.tasks.trip, undefined);
  });

  it("`tasks` 档才有写入口；`inject` 档是空实现（那一档的承诺是只加注入）", async () => {
    const store = memoryStore();
    const deps = { readers: {}, taskReader: store, pins: new AnchorPins() };
    const inject = await loadTurnContext(deps, { userId: "u-1", threadId: "th-A", now: T0 }, "inject");
    const opened = await inject!.writer.open({ kind: "trip", draft: plan(3), sessionId: "s", turnId: "t" });
    assert.equal(opened, undefined);
    assert.equal(store.rows.size, 0, "inject 档不许写库");
  });

  it("第一轮排出行程就要开出任务——emit 在「这件事还不存在」时是空转（M84-05 真跑补）", () => {
    /*
     * 2026-09-14 真跑：会话 A 排出完整的青岛三天行程，`working_tasks` 里一行都没有；
     * 换到会话 B 说「把第二天换成室内的」，编排层退回无草案兜底取了列表首条，
     * **改到了另一份普陀山的行程上**。根因是唯一能开任务的路只有迁入种子，
     * 而种子要求 `state.tripPlan` 已经在——第一轮它当然不在。
     */
    assert.ok(SUP.includes("const recordTripDraft ="), "要有一个「没有就开、有就推进」的入口");
    // 第二个参数是「另起一趟」（INC-0155）；这里钉的是"走不走这个入口"，不钉实参。
    assert.ok(/await recordTripDraft\(out\.plan[,)]/.test(SUP), "fan-out 收尾必须走它，不能只 emit");
    assert.ok(SUP.includes("await recordTripDraft(confirmed);"), "落库路径也要走它——无草案兜底装载的那份没有任务");
    assert.ok(
      !/await emitTrip\(\{\s*type: "task\.draft\.updated"/.test(SUP),
      "不许再直接 emit draft.updated：任务不存在时它是空转，而空转不报错",
    );
  });

  it("writer.emit 在任务不存在时确实是空转（上一条断言的前提）", async () => {
    const store = memoryStore();
    const writer = createTaskWriter({
      reader: store,
      userId: "u-1",
      tasks: {},
      now: () => T0,
      newId: () => "wt-x",
    });
    const r = await writer.emit("trip", { type: "task.draft.updated", draft: plan(3), ...stamp });
    assert.equal(r, undefined);
    assert.equal(store.rows.size, 0, "空转就是空转——一行都不会写，也不会报错");
  });

  it("图节点读的是任务而不是图状态（源码断言）", () => {
    assert.ok(SUP.includes("const useTasks = turnCtx?.mode === \"tasks\""), "itineraryNode 要分档");
    assert.ok(SUP.includes("let basePlan: TripPlanState | undefined = useTasks ? taskPlan : state.tripPlan;"));
    assert.ok(SUP.includes("op: \"task_seed\""), "旧检查点要有迁入种子");
  });
});

describe("[F-21-06][AC-21-6] 任务写入口：写穿、冲突重放、本轮的账", () => {
  const mk = () => {
    const store = memoryStore();
    const tasks: Record<string, TaskState> = {};
    const writer = createTaskWriter({
      reader: store,
      userId: "u-1",
      tasks: tasks as never,
      now: () => T0,
      newId: () => "wt-1",
    });
    return { store, tasks, writer };
  };

  it("open 之后同轮读到的就是新值（写穿）", async () => {
    const { tasks, writer, store } = mk();
    const t = await writer.open({ kind: "trip", draft: plan(3), sessionId: "s", turnId: "t" });
    assert.ok(t);
    assert.equal((tasks as { trip?: TaskState }).trip?.id, "wt-1");
    assert.equal(store.rows.get("wt-1")?.status, "drafting");
  });

  it("emit 之后同轮读到的也是新值——收尾句要看得到它", async () => {
    const { tasks, writer } = mk();
    await writer.open({ kind: "trip", draft: plan(3), sessionId: "s", turnId: "t" });
    await writer.emit("trip", { type: "task.committed", ref: "plan-x", mode: "create", ...stamp });
    assert.equal((tasks as { trip?: TaskState }).trip?.status, "committed");
    assert.equal((tasks as { trip?: TaskState }).trip?.base?.ref, "plan-x");
  });

  it("版本冲突时重读重放一次就成功", async () => {
    const { store, writer, tasks } = mk();
    await writer.open({ kind: "trip", draft: plan(3), sessionId: "s", turnId: "t" });
    // 模拟别处先写了一次：库里的 version 前进，手上的副本落后。
    const inDb = store.rows.get("wt-1")!;
    store.rows.set("wt-1", { ...inDb, version: inDb.version + 5 });
    const next = await writer.emit("trip", { type: "task.awaiting_confirm", ...stamp });
    assert.ok(next, "重读重放之后应当写成功");
    assert.equal((tasks as { trip?: TaskState }).trip?.status, "awaiting_confirm");
  });

  it("eventsOf 记的是**本轮**发生过什么，不是查库", async () => {
    const { writer } = mk();
    await writer.open({ kind: "trip", draft: plan(3), sessionId: "s", turnId: "t" });
    assert.deepStrictEqual([...writer.eventsOf("trip")], []);
    await writer.emit("trip", { type: "task.committed", ref: "plan-x", mode: "create", ...stamp });
    assert.deepStrictEqual([...writer.eventsOf("trip")], ["task.committed"]);
  });

  it("追问跨 3 轮没人答就清掉——不然下一轮的「确认」会被当成对它的回答", async () => {
    const store = memoryStore();
    let t = openTask({ id: "wt-2", userId: "u-1", kind: "trip", draft: plan(3), at: T0, sessionId: "s" });
    t = reduceTask(t, {
      type: "task.question.asked",
      pending: { kind: "cancel_pick", askedTurnId: "t1", askedAt: T0 },
      ...stamp,
    });
    store.rows.set(t.id, t);
    let loaded = await loadActiveTasks(store, "u-1", T0 + 1);
    assert.equal(loaded.trip?.pending?.unansweredTurns, 1);
    store.rows.set(t.id, { ...t, pending: { ...t.pending!, unansweredTurns: 2 } });
    loaded = await loadActiveTasks(store, "u-1", T0 + 2);
    assert.equal(loaded.trip?.pending, undefined, "第 3 轮还没答就当那个问题不存在了");
  });
});

describe("[F-11-02][AC-11-1] 现象②：细化轮不许把天数吃掉", () => {
  const input = (prev: TripPlanState): ItineraryInput => ({
    goal: "改第二天",
    constraints: [],
    userText: "第二天换成室内的",
    plan: prev,
    turnId: "t-refine",
  });

  const tourOnly = (days: number) => [
    {
      agent: "tour-task",
      status: "ok" as const,
      text: JSON.stringify({
        destination: "青岛",
        days: Array.from({ length: days }, (_, i) => ({
          day: i + 1,
          theme: `新第 ${i + 1} 天`,
          spots: [`新景点${i + 1}`],
        })),
      }),
      startedAt: 0,
      endedAt: 1,
    },
  ];

  it("tour 只交回 1 天而草案是 3 天 → 并回旧的两天，days 仍是 3", () => {
    const prev = plan(3);
    const out: ItineraryMergeOutput = mergeItinerary(tourOnly(1), input(prev), ["tour"]);
    assert.equal(out.plan.days, 3, "三天行程不许被一次细化吃成一天");
    assert.equal(out.plan.skeleton.length, 3);
    assert.equal(out.plan.skeleton[0]!.theme, "新第 1 天", "交回来的那一天要用新的");
    assert.equal(out.plan.skeleton[1]!.theme, "第 2 天", "没交回来的沿用旧的");
  });

  it("并回来这件事要说出来——静默补齐会让车主以为模型真的重排过", () => {
    const out = mergeItinerary(tourOnly(1), input(plan(3)), ["tour"]);
    assert.ok(
      out.violations.some((v) => v.includes("沿用")),
      `violations 里要有一条说明：${JSON.stringify(out.violations)}`,
    );
  });

  it("tour 交回的天数不少于草案时不触发守卫", () => {
    const out = mergeItinerary(tourOnly(3), input(plan(3)), ["tour"]);
    assert.equal(out.plan.days, 3);
    assert.ok(!out.violations.some((v) => v.includes("沿用")));
  });

  it("体检的「车主要几天」在本轮意图没给时用草案的天数（ADR-010）", () => {
    const it = src("../src/graph/subgraphs/itinerary.ts");
    assert.ok(
      it.includes("const requestedDays = input.tripLimits?.days ?? input.plan?.days;"),
      "细化轮车主不会重说「三天」——只看本轮意图就等于这一项永远弃权",
    );
    assert.ok(!/runAudit\([^)]*input\.tripLimits\?\.days/.test(it), "不该再直接传本轮意图");
  });
});

describe("[F-21-06][AC-21-6] 现象③：已落库的行程不再被说成「仍是草案」", () => {
  const out = (): ItineraryMergeOutput => ({
    plan: { ...plan(3), status: "refining" },
    violations: [],
    missing: [],
    findings: [],
    ranBranches: ["tour"],
    solverDegraded: false,
    hotelSource: "missing",
    tourSource: "submission",
    transitSource: "missing",
    driveSource: "missing",
  });

  it("三档互斥：落库了 / 有旧版但没保存 / 纯草案", () => {
    assert.ok(describeSaveState({ committed: true }).includes("已经保存"));
    assert.ok(describeSaveState({ hasBase: true }).includes("旧版"));
    assert.ok(describeSaveState({}).includes("仍是草案"));
    // 三句互不重叠——重叠就等于模型可以挑一句说
    assert.ok(!describeSaveState({ hasBase: true }).includes("仍是草案"));
    assert.ok(!describeSaveState({ committed: true }).includes("没有保存"));
  });

  it("对已落库行程的细化轮，收尾句说的是「主页上那份是旧版」", () => {
    const text = describeItineraryPlan(out(), { hasBase: true });
    assert.ok(text.includes("旧版"), text.slice(-300));
    assert.ok(!text.includes("不在座舱主页上"), "它就在主页上——这句是事实错误");
  });

  it("那句无条件的硬编码已经不在源码里了", () => {
    const it = src("../src/graph/subgraphs/itinerary.ts");
    // 数**代码里的那个字面量**（带【】的那一份）；注释里复述旧行为不算。
    const hits = it.split("【这一轮没有保存任何东西】").length - 1;
    assert.equal(hits, 1, "只该在 describeSaveState 的第三档里出现一次，不该再有无条件的那一句");
    assert.ok(it.includes("lines.push(describeSaveState(save));"), "收尾句必须由事件决定");
  });

  it("planStateLine 三支：没落过库 / 落过且一致 / 落过但改过", () => {
    const draft = planStateLine({ status: "refining", destination: "青岛", days: 3 })!;
    const clean = planStateLine({ status: "confirmed", destination: "青岛", days: 3, committedPlanId: "p1" })!;
    const dirty = planStateLine({
      status: "refining",
      destination: "青岛",
      days: 3,
      committedPlanId: "p1",
      dirty: true,
    })!;
    assert.ok(draft.includes("还没确认、没落库"));
    assert.ok(clean.includes("内容没变"));
    assert.ok(dirty.includes("改动还没保存") && dirty.includes("就是 commit"));
    assert.ok(!dirty.includes("那是 none"), "对改过的那一版说「那是 none」正是症状三的来源");
  });

  it("任务状态行也有 dirty 那一档（装载层开着时走这条）", () => {
    let t = openTask({ id: "wt-3", userId: "u-1", kind: "trip", draft: plan(3), at: T0, sessionId: "s" });
    t = reduceTask(t, { type: "task.committed", ref: "p1", mode: "create", ...stamp });
    t = reduceTask(t, { type: "task.draft.updated", draft: plan(4), ...stamp });
    assert.equal(t.status, "dirty");
    const line = taskStatusLine({ trip: t })!;
    assert.ok(line.includes("改动还没保存"));
    assert.ok(line.includes("原地更新"));
  });

  it("确认状态在权限门**之前**落库（重启后要读得出「在等确认」）", () => {
    const awaiting = SUP.indexOf("type: \"task.awaiting_confirm\"");
    const gate = SUP.indexOf("const gate = getGuardGate();", awaiting);
    assert.ok(awaiting > 0 && gate > awaiting, "awaiting_confirm 必须排在 gate.check 之前");
  });

  it("落库成功后先记一版再发 committed（快照与 base 一起对上）", () => {
    const draft = SUP.indexOf("await recordTripDraft(confirmed);");
    const committed = SUP.indexOf("type: \"task.committed\",\n              ref: r.data.planId,");
    assert.ok(draft > 0, "要先记这一版——无草案兜底装载的那份此刻还没有任务");
    assert.ok(committed > draft, "committed 排在它之后，base 才挂得到对的那一版上");
  });
});

describe("[F-21-06][AC-21-6] 事件是唯一的写路径", () => {
  it("每个事件类型都有转移定义——漏一个会在运行时抛错而不是静默", () => {
    const base = openTask({ id: "wt-4", userId: "u-1", kind: "trip", draft: plan(3), at: T0, sessionId: "s" });
    const events: TaskEvent[] = [
      { type: "task.draft.updated", draft: plan(4), ...stamp },
      { type: "task.awaiting_confirm", ...stamp },
      { type: "task.confirm.denied", reason: "拒了", ...stamp },
      { type: "task.committed", ref: "p1", mode: "create", ...stamp },
      { type: "task.question.asked", pending: { kind: "confirm", askedTurnId: "t", askedAt: T0 }, ...stamp },
      { type: "task.question.answered", ...stamp },
      { type: "task.discarded", ...stamp },
      { type: "task.cancelled", ...stamp },
    ];
    for (const e of events) assert.doesNotThrow(() => reduceTask(base, e), `${e.type} 没有转移定义`);
  });
});
