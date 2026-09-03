/**
 * 事实补录询问骨架（施工单 M26-03，架构文档 §4.6，F-53-04/05/09、F-54-10）。
 *
 * 这一组里最重要的不是"问得对不对"，是**两条不外溢的断言**：
 *  - 一轮追加提问总数是 1，且跨故事共享（AC-54-10）；
 *  - 槽位与冷却不进图状态、不进任何 Agent 的上下文（AC-53-13）。
 *
 * 后者的失败形态不是链路挂掉，而是"少给了一个工具"或"提示词里多了一句
 * 用户拒绝提供里程"——两者都不报错，也不会让任何别的测试变红。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";

import type { ElicitationSlot } from "@carlife/shared";

import {
  ELICITATION_CARRIER_AGENTS,
  elicitationQuestion,
  looksLikeDecline,
  pickElicitation,
  slotsFromFreshness,
  type FreshnessLike,
} from "../src/graph/elicitation";
import { createElicitationService, type ElicitationDeps } from "../src/elicitation/service";

const VIN = "LSJA24U91NS654321";
const USER = "u-m26-03";
const NOW = Date.UTC(2026, 7, 26, 12);

const slot = (over: Partial<ElicitationSlot> & Pick<ElicitationSlot, "kind">): ElicitationSlot => ({
  reason: "",
  weight: 10,
  timeliness: "deferrable",
  state: "pending",
  ...over,
});

const staleReport: FreshnessLike = {
  vin: VIN,
  items: [
    { item: "odometer", verdict: "stale", reason: "已经 97 天没更新（上限 60 天）" },
    { item: "lastService", verdict: "unknown", reason: "档案里没有任何保养记录" },
    { item: "usageTrips", verdict: "stale", reason: "还没有任何用车流水" },
  ],
  suggested: ["lastService", "odometer"],
};

describe("slotsFromFreshness：⑥ 永远变不成槽位", () => {
  it("只把 ④ 的两项翻成槽位，reason 原样带过来", () => {
    const slots = slotsFromFreshness(staleReport);
    assert.deepEqual(
      slots.map((s) => s.kind),
      ["last_service", "odometer"],
    );
    assert.match(slots[1].reason, /97 天/);
  });

  it("**即使 suggested 里混进了 usageTrips 也不生成槽位**——口述补不回流水（AC-53-7）", () => {
    const slots = slotsFromFreshness({ ...staleReport, suggested: ["usageTrips"] });
    assert.deepEqual(slots, []);
  });

  it("未建档（notFound）不产生任何槽位", () => {
    assert.deepEqual(slotsFromFreshness({ ...staleReport, notFound: true }), []);
    assert.deepEqual(slotsFromFreshness(undefined), []);
  });
});

describe("pickElicitation：三条同时成立才问，且至多一个", () => {
  const base = {
    slots: [slot({ kind: "odometer" })],
    agent: "ownership",
    answered: true,
    cooldown: new Set<never>(),
  };

  it("三条都成立 → 返回一个槽位", () => {
    assert.equal(pickElicitation(base)?.kind, "odometer");
  });

  it("没有待补缺口 → 不问", () => {
    assert.equal(pickElicitation({ ...base, slots: [] }), undefined);
  });

  it("**没有合适载体 → 不问**：座舱/购车/闲聊都不是聊这辆车的场合", () => {
    for (const agent of ["cabin", "buying", "test-drive", "general", undefined]) {
      assert.equal(pickElicitation({ ...base, agent }), undefined, `${agent} 不该问`);
    }
    for (const agent of ELICITATION_CARRIER_AGENTS) {
      assert.ok(pickElicitation({ ...base, agent }), `${agent} 应该能问`);
    }
  });

  it("在冷却期内 → 不问", () => {
    assert.equal(
      pickElicitation({ ...base, cooldown: new Set(["odometer"]) as Set<never> }),
      undefined,
    );
  });

  it("本轮回答没产出 → 不问（失败的一轮后面挂提问是雪上加霜）", () => {
    assert.equal(pickElicitation({ ...base, answered: false }), undefined);
  });

  it("**同轮两边都有待问项 → 恰好 1 条，且是能源余量**（AC-54-10，跨故事共享预算）", () => {
    const picked = pickElicitation({
      ...base,
      slots: [
        slot({ kind: "odometer" }),
        slot({ kind: "last_service", weight: 20 }),
        slot({ kind: "energy_level", weight: 100, timeliness: "perishable" }),
      ],
      agent: "trip",
    });
    assert.equal(picked?.kind, "energy_level", "过期作废的那个必须优先");
    // 返回类型就是单个而不是数组——"一轮最多一个"落在类型上（§4.6 约束 1）
    assert.ok(!Array.isArray(picked));
  });

  it("同时效性内按 weight 降序，排序稳定可断言", () => {
    const picked = pickElicitation({
      ...base,
      slots: [slot({ kind: "odometer", weight: 10 }), slot({ kind: "last_service", weight: 20 })],
    });
    assert.equal(picked?.kind, "last_service");
  });

  it("能源余量被冷却时，退回 ④ 的项而不是整轮不问", () => {
    const picked = pickElicitation({
      ...base,
      slots: [
        slot({ kind: "energy_level", weight: 100, timeliness: "perishable" }),
        slot({ kind: "odometer" }),
      ],
      agent: "trip",
      cooldown: new Set(["energy_level"]) as Set<never>,
    });
    assert.equal(picked?.kind, "odometer");
  });
});

describe("looksLikeDecline：三种拒答里字面能认的那两种", () => {
  for (const t of ["不用了", "先不用", "待会说", "待会儿说", "回头说吧", "算了", "不想说"]) {
    it(`认得出「${t}」`, () => assert.ok(looksLikeDecline(t)));
  }
  for (const t of ["上个月 12 号刚做的，现在 18 万 6", "好的", "帮我规划一下去黄山"]) {
    it(`不误判「${t}」`, () => assert.equal(looksLikeDecline(t), false));
  }
});

describe("ElicitationService：搭便车、冷却、fail-open", () => {
  let declines: Array<{ vin: string; kind: string }> = [];
  let cooldownRows: Array<{ vin: string; kind: string; declinedAt: number; declineCount: number }> =
    [];
  let freshnessCalls = 0;
  let freshnessImpl: () => Promise<FreshnessLike | undefined> = async () => staleReport;
  let extracted: { lastServiceAt?: number; odometerKm?: number; items?: string } | undefined;
  let confirmCalls = 0;
  let approveNext = true;
  let writes: Array<Record<string, unknown>> = [];

  const deps = (): ElicitationDeps => ({
    async freshness() {
      freshnessCalls += 1;
      return freshnessImpl();
    },
    async listCooldown(vin, since) {
      return cooldownRows.filter((r) => r.vin === vin && r.declinedAt >= since) as never;
    },
    async decline(input) {
      declines.push({ vin: input.vin, kind: input.kind });
      cooldownRows.push({ ...input, declinedAt: input.at, declineCount: 1 });
      return undefined;
    },
    cooldownDays: () => 30,
    now: () => NOW,
    async extract() {
      return extracted;
    },
    async confirm() {
      confirmCalls += 1;
      return approveNext;
    },
    async write(input) {
      writes.push(input);
      return undefined;
    },
  });

  beforeEach(() => {
    declines = [];
    cooldownRows = [];
    freshnessCalls = 0;
    freshnessImpl = async () => staleReport;
    extracted = undefined;
    confirmCalls = 0;
    approveNext = true;
    writes = [];
  });

  const svc = () => createElicitationService(deps());

  it("有载体 + 有缺口 + 不在冷却 → 追加一句提问", async () => {
    const q = await svc().next({
      sessionKey: "s1",
      userId: USER,
      agent: "ownership",
      answered: true,
    });
    assert.ok(q);
    assert.match(q, /上一次保养是什么时候/);
    assert.match(q, /多少公里/);
  });

  it("**载体不对时连库都不查**——绝大多数轮次都不是合适载体", async () => {
    const s = svc();
    assert.equal(await s.next({ sessionKey: "s1", userId: USER, agent: "cabin", answered: true }), undefined);
    assert.equal(freshnessCalls, 0, "不该为一个注定不问的轮次去体检");
  });

  it("体检抛错时不问，也不让这一轮失败（fail-open）", async () => {
    freshnessImpl = async () => {
      throw new Error("④未接入");
    };
    const q = await svc().next({ sessionKey: "s1", userId: USER, agent: "ownership", answered: true });
    assert.equal(q, undefined);
  });

  it("未建档（体检报不出 vin）不问——冷却没处记，问了也白问", async () => {
    freshnessImpl = async () => ({ vin: null, items: [], suggested: [], notFound: true });
    assert.equal(
      await svc().next({ sessionKey: "s1", userId: USER, agent: "ownership", answered: true }),
      undefined,
    );
  });

  it("问过之后说「不用了」→ 记一次拒答，且记在**被问的那辆车**上", async () => {
    const s = svc();
    await s.next({ sessionKey: "s1", userId: USER, agent: "ownership", answered: true });
    await s.settle("s1", "t1", USER, "不用了");
    assert.deepEqual(declines, [{ vin: VIN, kind: "last_service" }]);
  });

  it("拒答之后**同一项不再被问**（冷却生效）", async () => {
    const s = svc();
    await s.next({ sessionKey: "s1", userId: USER, agent: "ownership", answered: true });
    await s.settle("s1", "t1", USER, "不用了");
    // 第二次：last_service 进冷却，退回 odometer；再拒一次两项都冷却
    const second = await s.next({ sessionKey: "s1", userId: USER, agent: "ownership", answered: true });
    assert.ok(second, "还有另一项可问");
    await s.settle("s1", "t1", USER, "别问了");
    assert.equal(
      await s.next({ sessionKey: "s1", userId: USER, agent: "ownership", answered: true }),
      undefined,
      "两项都冷却后本轮不问",
    );
  });

  it("**像是在回答就不记拒答**——把真实回答记成拒答，车主就再也不会被问第二次", async () => {
    const s = svc();
    await s.next({ sessionKey: "s1", userId: USER, agent: "ownership", answered: true });
    await s.settle("s1", "t1", USER, "上个月 12 号刚做的，现在跑了 18 万 6 千多");
    assert.deepEqual(declines, [], "这是回答不是拒答");
  });

  it("句子里有数字但明确拒绝（「先不用了，我 5 分钟后到」）仍算拒答", async () => {
    const s = svc();
    await s.next({ sessionKey: "s1", userId: USER, agent: "ownership", answered: true });
    await s.settle("s1", "t1", USER, "先不用了，我 5 分钟后到");
    assert.equal(declines.length, 1, "明确拒绝压倒「看起来像答案」");
  });

  it("忽略后转移话题（一个数字都没有）→ 记拒答", async () => {
    const s = svc();
    await s.next({ sessionKey: "s1", userId: USER, agent: "ownership", answered: true });
    await s.settle("s1", "t1", USER, "帮我看看今天天气怎么样");
    assert.equal(declines.length, 1);
  });

  it("没问过就 settle 不产生任何拒答", async () => {
    await svc().settle("s1", "t1", USER, "随便说点什么");
    assert.deepEqual(declines, []);
  });

  it("留痕失败不抛——记不上冷却只是下次可能再问一遍（fail-open）", async () => {
    const d = deps();
    const s = createElicitationService({
      ...d,
      async decline() {
        throw new Error("库挂了");
      },
    });
    await s.next({ sessionKey: "s1", userId: USER, agent: "ownership", answered: true });
    await s.settle("s1", "t1", USER, "不用了"); // 不该抛
  });
});

/**
 * 车主答了之后**不能在同一轮里再问一遍**，也不能在下一轮接着问。
 *
 * 这一组守的是一个真跑复现出来的循环：`settle()` 在轮首消费掉提问、把确认弹窗
 * 脱手发出去，`next()` 在同一轮末尾重新体检——那时写入还没发生，体检结果一个字没变，
 * 于是同一句提问被追加了第二次。车主的观感是"我明明已经回答了，它还在问"。
 */
describe("补录收口：答过之后不再复问", () => {
  const VIN2 = VIN;
  let writes: Array<Record<string, unknown>> = [];
  let audits: Array<{ written: string[]; ignored?: string[]; restatement: string; approved: boolean }> = [];
  let cooldownRows: Array<{ vin: string; kind: string; declinedAt: number; declineCount: number }> = [];
  let touched: Array<{ kind: string; count: number }> = [];
  let currentOdometer: number | undefined;
  let releaseConfirm: ((ok: boolean) => void) | undefined;
  let confirmMode: "immediate" | "pending" = "immediate";

  const deps = (): ElicitationDeps => ({
    async freshness() {
      return staleReport;
    },
    async odometerOf() {
      return currentOdometer;
    },
    async listCooldown(vin, since) {
      return cooldownRows.filter((r) => r.vin === vin && r.declinedAt >= since) as never;
    },
    async decline(input) {
      cooldownRows.push({ ...input, declinedAt: input.at, declineCount: 1 });
      return undefined;
    },
    async touchCooldown(input) {
      touched.push({ kind: input.kind, count: touched.length });
      const row = cooldownRows.find((r) => r.vin === input.vin && r.kind === input.kind);
      if (row) row.declinedAt = input.at;
      else cooldownRows.push({ ...input, declinedAt: input.at, declineCount: 0 });
      return undefined;
    },
    cooldownDays: () => 30,
    now: () => NOW,
    async extract() {
      return { lastServiceAt: Date.UTC(2026, 7, 1), odometerKm: 20000 };
    },
    async confirm() {
      if (confirmMode === "immediate") return true;
      return new Promise<boolean>((resolve) => {
        releaseConfirm = resolve;
      });
    },
    async write(input) {
      writes.push(input);
      return undefined;
    },
    async audit(entry) {
      audits.push({
        written: entry.written,
        ignored: entry.ignored,
        restatement: entry.restatement,
        approved: entry.approved,
      });
      return undefined;
    },
  });

  beforeEach(() => {
    writes = [];
    audits = [];
    cooldownRows = [];
    touched = [];
    currentOdometer = undefined;
    releaseConfirm = undefined;
    confirmMode = "immediate";
  });

  /** 让脱手的确认链把 microtask 跑完。 */
  const drain = () => new Promise((r) => setTimeout(r, 0));

  it("确认弹窗还挂着的时候，同一轮**不再追加同一句提问**", async () => {
    confirmMode = "pending";
    const s = createElicitationService(deps());
    assert.ok(await s.next({ sessionKey: "s1", userId: USER, agent: "ownership", answered: true }));
    await s.settle("s1", "t1", USER, "上次保养是这个月一号，里程现在两万");
    assert.equal(
      await s.next({ sessionKey: "s1", userId: USER, agent: "ownership", answered: true }),
      undefined,
      "车主刚回答过，这一轮不该再问一遍",
    );
    releaseConfirm?.(false);
  });

  it("确认链收口后按冷却收敛——**不再问第二次**", async () => {
    const s = createElicitationService(deps());
    await s.next({ sessionKey: "s1", userId: USER, agent: "ownership", answered: true });
    await s.settle("s1", "t1", USER, "上次保养是这个月一号，里程现在两万");
    await drain();
    assert.deepEqual(
      touched.map((t) => t.kind).sort(),
      ["last_service", "odometer"],
      "④ 是一句话问出去的，收口也要一起记",
    );
    assert.equal(
      await s.next({ sessionKey: "s2", userId: USER, agent: "ownership", answered: true }),
      undefined,
      "换一个会话也不该再问——冷却在库里，不在内存里",
    );
  });

  it("记的是「问过」不是「拒答」：`declineCount` 不加", async () => {
    const s = createElicitationService(deps());
    await s.next({ sessionKey: "s1", userId: USER, agent: "ownership", answered: true });
    await s.settle("s1", "t1", USER, "上次保养是这个月一号，里程现在两万");
    await drain();
    assert.deepEqual(
      cooldownRows.map((r) => r.declineCount),
      [0, 0],
      "车主是回答了，不是拒绝了——运营侧不该看到一次并不存在的拒绝",
    );
  });

  it("里程比档案里的小 ⇒ **不写、复述里说明、留痕记 ignored**", async () => {
    currentOdometer = 41280; // 档案里已经是四万多，车主报的两万写不进去
    const s = createElicitationService(deps());
    await s.next({ sessionKey: "s1", userId: USER, agent: "ownership", answered: true });
    await s.settle("s1", "t1", USER, "上次保养是这个月一号，里程现在两万");
    await drain();
    assert.deepEqual(
      writes.map((w) => w.op),
      ["maintenance"],
      "里程只前进，这一条写不进去就不该发出去",
    );
    const last = audits.at(-1)!;
    assert.deepEqual(last.written, ["maintenance"]);
    assert.deepEqual(last.ignored, ["odometerKm"]);
    assert.match(last.restatement, /不改里程/, "车主点确认之前就要看到「什么没变」");
    assert.equal(/当前里程 20000 公里/.test(last.restatement), false, "不能承诺一个不会发生的写入");
  });

  it("只报了一个回退的里程 ⇒ 一个字都不写、也不弹窗，但仍按「答过了」收口", async () => {
    currentOdometer = 41280;
    const s = createElicitationService({
      ...deps(),
      async extract() {
        return { odometerKm: 20000 };
      },
    });
    await s.next({ sessionKey: "s1", userId: USER, agent: "ownership", answered: true });
    await s.settle("s1", "t1", USER, "里程现在两万");
    await drain();
    assert.deepEqual(writes, [], "没有任何字段可写");
    assert.deepEqual(audits.at(-1)?.ignored, ["odometerKm"]);
    assert.equal(
      await s.next({ sessionKey: "s2", userId: USER, agent: "ownership", answered: true }),
      undefined,
      "答过了就不该再问",
    );
  });

  it("里程前进时照常写，且**里程先于保养**（来源不能丢）", async () => {
    currentOdometer = 100;
    const s = createElicitationService(deps());
    await s.next({ sessionKey: "s1", userId: USER, agent: "ownership", answered: true });
    await s.settle("s1", "t1", USER, "上次保养是这个月一号，里程现在两万");
    await drain();
    assert.deepEqual(
      writes.map((w) => w.op),
      ["odometer", "maintenance"],
    );
    assert.deepEqual(audits.at(-1)?.written, ["odometerKm", "maintenance"]);
  });
});

/**
 * AC-53-13：**拒答不构成新的信息**。
 *
 * 这一组是结构性断言。真正的两态真跑对比在验收里，
 * 但那种测试贵且慢；这里守的是让它永远成立的那个前提——
 * **槽位与冷却压根不在图状态里**，子图与 prompt 拼装读不到它。
 */
describe("AC-53-13：拒答不外溢（结构性断言）", () => {
  const src = (rel: string) => fs.readFileSync(path.join(process.cwd(), "src", rel), "utf8");
  const listTs = (dir: string): string[] => {
    const abs = path.join(process.cwd(), "src", dir);
    return fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => path.join(dir, e.name));
  };

  it("图状态里没有任何 elicitation / 补录 / 冷却字段", () => {
    const state = src("graph/state.ts");
    for (const needle of ["elicitation", "Elicitation", "cooldown", "Cooldown"]) {
      assert.equal(
        state.includes(needle),
        false,
        `graph/state.ts 不该出现「${needle}」——它一旦进图状态，子图就可能读到它`,
      );
    }
  });

  it("**子图一律不引用 elicitation 模块**——下游降级只能是数据本身的函数", () => {
    for (const file of listTs("graph/subgraphs")) {
      const text = src(file);
      assert.equal(
        /from\s+["'].*elicitation["']/.test(text),
        false,
        `${file} 不该 import elicitation`,
      );
      assert.equal(
        text.includes("resolveElicitation") || text.includes("settleElicitation"),
        false,
        `${file} 不该碰补录询问的钩子`,
      );
    }
  });

  it("补录询问不碰权限门：既不 import 也不调用 interrupt / guard 端点", () => {
    // 只看代码，不看注释——这两个文件的注释里**正是**在讲"它不是权限门"。
    const stripComments = (t: string) =>
      t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const code = stripComments(src("graph/elicitation.ts") + src("elicitation/service.ts"));
    assert.equal(/from\s+["'][^"']*guard[^"']*["']/.test(code), false, "不该 import guard 任何模块");
    assert.equal(/\binterrupt\s*\(/.test(code), false, "不该调用 interrupt()");
    assert.equal(code.includes("internal/guard/check"), false, "不该碰权限门端点");
  });

  it("提问文案一句话说完、不要求点任何控件（车机驾驶态）", () => {
    for (const kind of ["odometer", "last_service", "energy_type", "energy_level"] as const) {
      const q = elicitationQuestion(kind);
      assert.ok(q.length <= 90, `「${kind}」的问句太长：${q.length} 字`);
      assert.equal(/点击|点一下|打开设置|填写表单/.test(q), false, "驾驶态不得要求屏幕操作");
    }
  });
});
