/**
 * 行程确认路径（施工单 M13-02）。
 *
 * 三处最容易静默出错的地方各守一条：
 *  - `CONFIRM_REQUIRED_TOOLS` 必须含 trip_plan_commit——不在集合里的 sensitive
 *    工具会被"自动放行"，行程**无确认落库**而链路看起来完全正常；
 *  - 确认判据是规则表——「取消第二天」是细化不是整程取消，判错整份行程就没了；
 *  - deny/超时路径 status 不变、不落库——"以为定了其实没定"反过来同样致命。
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { setTripPlanStore, type TripPlanStore } from "@carlife/tools";
import type { TripPlanSnapshot } from "@carlife/shared";

import {
  GuardGate,
  CONFIRM_REQUIRED_TOOLS,
  type GuardCheckRequest,
} from "../src/guard/http-endpoint";
import { setGuardGate } from "../src/tools-endpoint";
import { buildChatGraph } from "../src/graph/supervisor";
import {
  cancelIntent,
  commitDisclosures,
  commitIntent,
  describeCommitDenied,
  describeCommitted,
  mergeItinerary,
} from "../src/graph/subgraphs/itinerary";
import type { ChatStreamer } from "../src/llm";
import type { BranchResult } from "../src/graph/fanout";

// ── 判据表 ──────────────────────────────────────────────────

test("确认判据：定下来的各种说法命中；细化句不命中", () => {
  for (const s of ["就这样定了", "就这么定吧", "就按这个定", "行程确认一下", "可以预订了", "拍板"]) {
    assert.equal(commitIntent(s), true, s);
  }
  for (const s of ["换个酒店", "第一天再细化", "预算再压一压", "定一家更好的酒店行不行"]) {
    assert.equal(commitIntent(s), false, s);
  }
});

test("取消判据：必须整程指涉——「取消第二天」是细化不是取消", () => {
  for (const s of ["行程取消掉", "整个行程取消吧", "这个计划不要了", "这趟不去了"]) {
    assert.equal(cancelIntent(s), true, s);
  }
  for (const s of ["取消第二天的安排", "第二天不去长隆了", "把那天的景点删掉", "取消酒店换一家"]) {
    assert.equal(cancelIntent(s), false, s);
  }
  // 确认与取消同现时取消优先（宁可少做副作用）——commitIntent 必须让位。
  assert.equal(commitIntent("行程取消掉，重新定"), false);
});

// ── 权限门档位 ──────────────────────────────────────────────

test("CONFIRM_REQUIRED_TOOLS 必须含 trip_plan_commit（漏了 = 无确认落库）", () => {
  assert.ok(CONFIRM_REQUIRED_TOOLS.has("trip_plan_commit"));
});

// ── energyStops 穿透（HUD charge 锚位的数据源）─────────────────

const ok = (agent: string, json: unknown): BranchResult => ({
  agent,
  status: "ok",
  text: JSON.stringify(json),
  startedAt: 0,
  endedAt: 1,
});

test("drive 分支的补能点穿过汇聚进 plan.energyStops", () => {
  const out = mergeItinerary(
    [
      ok("tour-task", { destination: "广州", days: [{ day: 1, theme: "亲子", spots: ["长隆"] }] }),
      ok("drive-task", { legMinutes: [120, 90], stops: [], energyStops: ["泌冲充电站"] }),
    ],
    { goal: "g", constraints: [], userText: "u", turnId: "t-1" },
    ["drive", "tour"],
  );
  assert.deepEqual(out.plan.energyStops, ["泌冲充电站"]);
});

// ── 图级：确认 → 弹窗批准 → 落库置位；拒绝 → 原样 ───────────────

/**
 * 假流：分支给结构化 JSON；应答收到的完整 prompt 记进 `answerPrompts`——
 * 确认/拒绝的表述是喂给 answer 的求解结果（answerNode 会把应答全文覆写回
 * `agentResults`，所以断言点必须在这里，不能看最终状态里的 agentResults）。
 */
const fakeStreamer = (answerPrompts: string[] = []): ChatStreamer =>
  async function* (m, hooks) {
    const agent = hooks?.agent ?? "?";
    if (agent.endsWith("-task")) {
      yield agent === "tour-task"
        ? '{"destination":"广州","days":[{"day":1,"theme":"亲子","spots":["长隆"]}]}'
        : agent === "hotel-task"
          ? '{"hotels":[{"name":"长隆酒店","estPrice":"约800/晚（估算）"}]}'
          : '{"findings":[]}';
      return;
    }
    answerPrompts.push(m.map((x) => x.content).join("\n"));
    yield "[答]";
  };

function memStore(): TripPlanStore & { rows: string[] } {
  const rows: string[] = [];
  return {
    rows,
    async commit() {
      rows.push("confirmed");
      return { planId: `plan-${rows.length}`, committedAt: new Date(0) };
    },
    async cancelCurrent() {
      const i = rows.lastIndexOf("confirmed");
      if (i < 0) return null;
      rows[i] = "cancelled";
      return { planId: `plan-${i + 1}`, committedAt: new Date(0) };
    },
    // M13-11 拆分后 store 接口变宽；这份假仓储只需支撑 commit/cancel 两条既有路径。
    async cancelById() {
      return null;
    },
    async update() {
      return null;
    },
    async list() {
      return [];
    },
    async query() {
      return [];
    },
  };
}

beforeEach(() => setTripPlanStore(undefined));

test("「就这样定了」：弹窗批准 → 落库 → status=confirmed（不跑 fan-out）", async () => {
  const store = memStore();
  setTripPlanStore(store);
  const interrupts: string[] = [];
  const seen: GuardCheckRequest[] = [];
  const gate: GuardGate = new GuardGate({
    onInterrupt: ({ interruptId, request }) => {
      interrupts.push(request.tool);
      seen.push(request);
      queueMicrotask(() => gate.resume(interruptId, true));
    },
  });
  setGuardGate(gate);

  const answerPrompts: string[] = [];
  const graph = buildChatGraph(fakeStreamer(answerPrompts), { enableIntent: false });
  const cfg = { configurable: { thread_id: "t-commit", userId: "u1", emit: { onDelta: () => {} } } };

  const s1 = await graph.invoke({ messages: [{ role: "user", content: "我们去广州玩4天，帮我安排行程" }] }, cfg);
  assert.equal(s1.tripPlan?.status, "skeleton");

  const s2 = await graph.invoke({ messages: [{ role: "user", content: "就这样定了" }] }, cfg);
  assert.deepEqual(interrupts, ["trip_plan_commit"], "确认必须经过弹窗，且只弹一次");
  assert.equal(s2.tripPlan?.status, "confirmed");
  assert.equal(s2.tripPlan?.committedPlanId, "plan-1");
  assert.deepEqual(store.rows, ["confirmed"]);
  assert.match(answerPrompts.at(-1) ?? "", /已确认并保存/, "确认表述必须喂给应答");

  /*
   * 逐日明细走 `details` 而**不是 `disclosures`**（M13-05 视觉重做时修正）。
   *
   * 端上把 `disclosures` 渲染成「将提供给门店的信息」——行程挂在那个标题下，
   * 等于告诉用户这份行程要发给门店，而它只是存进用户自己的档案，没有收件人。
   * 这一条不是版式偏好：它决定用户以为自己批准了什么。
   */
  const req = seen[0];
  assert.ok(req?.details?.some((d) => d.startsWith("第1天")), "逐日明细必须进 details");
  assert.equal(req?.disclosures, undefined, "行程没有任何外发个人信息，不该占用 disclosures");

  // 确认后细化仍粘回 itinerary，status 回 refining——HUD 只信确认过的版本。
  const s3 = await graph.invoke({ messages: [{ role: "user", content: "换个酒店" }] }, cfg);
  assert.equal(s3.tripPlan?.status, "refining");
  assert.equal(s3.tripPlan?.committedPlanId, "plan-1", "细化不清确认血统——取消路径靠它找 PG 的行");
});

test("弹窗拒绝：不落库、status 不变、表述如实说仍是草案", async () => {
  const store = memStore();
  setTripPlanStore(store);
  const gate: GuardGate = new GuardGate({
    onInterrupt: ({ interruptId }) => queueMicrotask(() => gate.resume(interruptId, false)),
  });
  setGuardGate(gate);

  const answerPrompts: string[] = [];
  const graph = buildChatGraph(fakeStreamer(answerPrompts), { enableIntent: false });
  const cfg = { configurable: { thread_id: "t-deny", userId: "u1", emit: { onDelta: () => {} } } };

  await graph.invoke({ messages: [{ role: "user", content: "我们去广州玩4天，帮我安排行程" }] }, cfg);
  const s2 = await graph.invoke({ messages: [{ role: "user", content: "就这样定了" }] }, cfg);

  assert.equal(s2.tripPlan?.status, "skeleton", "拒绝后行程仍是草案");
  assert.deepEqual(store.rows, [], "拒绝后绝不落库");
  assert.match(answerPrompts.at(-1) ?? "", /仍是草案/, "拒绝的事实必须如实喂给应答");
});

test("草案取消：无副作用不弹窗；已确认取消：过弹窗并置 PG 行", async () => {
  const store = memStore();
  setTripPlanStore(store);
  const interrupts: string[] = [];
  const gate: GuardGate = new GuardGate({
    onInterrupt: ({ interruptId, request }) => {
      interrupts.push(request.summary);
      queueMicrotask(() => gate.resume(interruptId, true));
    },
  });
  setGuardGate(gate);

  const graph = buildChatGraph(fakeStreamer(), { enableIntent: false });

  // ① 纯草案：取消不弹窗、不调工具。
  const cfgA = { configurable: { thread_id: "t-cancel-a", userId: "u1", emit: { onDelta: () => {} } } };
  await graph.invoke({ messages: [{ role: "user", content: "我们去广州玩4天，帮我安排行程" }] }, cfgA);
  const a2 = await graph.invoke({ messages: [{ role: "user", content: "行程取消掉" }] }, cfgA);
  assert.equal(a2.tripPlan?.status, "cancelled");
  assert.deepEqual(interrupts, [], "草案取消无副作用，不该弹窗");
  assert.deepEqual(store.rows, []);

  // 取消后粘性失效：同样的细化句不再粘回 itinerary。
  const a3 = await graph.invoke({ messages: [{ role: "user", content: "换个酒店" }] }, cfgA);
  assert.notEqual(a3.route?.agent, "itinerary");

  // ② 确认过的：取消要过弹窗，并把 PG 的行置 cancelled。
  const cfgB = { configurable: { thread_id: "t-cancel-b", userId: "u1", emit: { onDelta: () => {} } } };
  await graph.invoke({ messages: [{ role: "user", content: "我们去广州玩4天，帮我安排行程" }] }, cfgB);
  await graph.invoke({ messages: [{ role: "user", content: "就这样定了" }] }, cfgB);
  assert.deepEqual(store.rows, ["confirmed"]);
  const b3 = await graph.invoke({ messages: [{ role: "user", content: "行程取消掉" }] }, cfgB);
  assert.equal(b3.tripPlan?.status, "cancelled");
  assert.deepEqual(store.rows, ["cancelled"], "PG 的行必须被置位，否则 HUD 一直挂着");
  assert.ok(interrupts.some((s) => s.includes("取消")), "已确认行程的取消要过弹窗");
});

// ── 表述与弹窗明细 ──────────────────────────────────────────

test("弹窗明细逐日列出；表述与数据不矛盾（698743e 那课）", () => {
  const plan: TripPlanSnapshot = {
    status: "refining",
    destination: "广州",
    days: 1,
    skeleton: [
      { day: 1, theme: "亲子", spots: [{ name: "长隆" }], hotel: { name: "长隆酒店", estPrice: "约800/晚（估算）" } },
    ],
    transit: { summary: "G253 8小时23分" },
    caveats: ["酒店价格为估算"],
    updatedTurnId: "t",
  };
  const d = commitDisclosures(plan);
  assert.match(d[0], /第1天 亲子：长隆；住 长隆酒店 约800\/晚（估算）/);
  assert.match(d[1], /大交通：G253/);

  assert.match(describeCommitted(plan), /已确认并保存/);
  assert.doesNotMatch(describeCommitted(plan), /没查到/, "确认表述不得夹带否定指令");
  assert.match(describeCommitDenied("用户拒绝了本次动作"), /仍是草案/);
});

test("取消判据覆盖真实说法：报路线/报目的地都算整程取消（M13-12）", async () => {
  const { cancelIntent } = await import("../src/graph/subgraphs/itinerary");
  /*
   * 线上漏判过这一句：「我取消从上海到广州的行程」。取消与行程之间隔着 7 个字，
   * 而当时的判据只允许 4 个——漏判不报错，它被当成规划诉求送进 fan-out，
   * 跑一分钟回一句"没查到"，主页上那份行程原封不动。
   */
  for (const t of [
    "我取消从上海到广州的行程",
    "取消上海到广州的行程",
    "帮我取消上海-广州的行程",
    "取消广州四天的行程",
    "广州那趟不去了",
    "行程取消掉",
  ]) {
    assert.equal(cancelIntent(t), true, `应判为整程取消：${t}`);
  }
  // 护栏不能松：部分取消仍然不是整程取消，误判会把整份行程作废。
  for (const t of ["取消第二天的行程", "第二天不去了", "取消长隆那个景点", "把酒店取消掉"]) {
    assert.equal(cancelIntent(t), false, `不该判为整程取消：${t}`);
  }
  // 规划诉求更不能被当成取消。
  for (const t of ["帮我规划去广州的行程", "查一下广州的行程"]) {
    assert.equal(cancelIntent(t), false, `不该判为整程取消：${t}`);
  }
});

test("确认判据覆盖真实说法：「行程定了」不该漏判（M13-12）", async () => {
  const { commitIntent } = await import("../src/graph/subgraphs/itinerary");
  /*
   * 实测漏判（turn-2d5a87be / 48cfda34 / a6cc5d7b）：车主反复说「OK了，行程定了」，
   * 而判据只认「就这样定了」那几种句式——漏判不报错，只是没有弹窗、没有落库。
   */
  for (const t of ["OK了，行程定了", "行程定了", "这个行程定了", "就这样定了", "好的就定这个", "计划就这么定了"]) {
    assert.equal(commitIntent(t), true, `应判为确认：${t}`);
  }
  for (const t of ["取消行程", "帮我规划去嘉定的行程", "第二天定在周日", "行程取消掉"]) {
    assert.equal(commitIntent(t), false, `不该判为确认：${t}`);
  }
});

test("大交通按实际距离推荐，市内不给机票（M13-12 走查）", async () => {
  const { assembleTransit, selectedTransit } = await import("../src/graph/subgraphs/itinerary");
  const pick = (t: ReturnType<typeof assembleTransit>) =>
    selectedTransit({
      status: "refining", destination: "x", days: 1, skeleton: [], caveats: [],
      updatedTurnId: "t", transit: t,
    } as never);

  /*
   * 实测那张弹窗：「上海静安 → 上海嘉定」的大交通写着
   * 「飞机 约2.5小时飞行，全程约4-5小时，约400-900元」——市内 40 分钟车程配机票。
   * 模型照着"给飞机的常识性对比建议"照做了，汇聚层原样收下，端上默认取了飞机。
   */
  const city = assembleTransit({
    driveLine: "自驾约0小时40分，分1段", driveMinutes: 40, trainParts: [],
    flightPart: "飞机：约2.5小时飞行，约400-900元（估算）",
  })!;
  assert.equal(city.recommended, "drive");
  assert.doesNotMatch(city.summary, /飞机/, "短途连摘要里都不该出现飞机——那条信息本身是错的");
  assert.match(pick(city)!, /^自驾/);

  // 中途：自驾 1.5 小时仍推自驾，但高铁作为候选保留在摘要里。
  const near = assembleTransit({
    driveLine: "自驾约1小时30分，分1段", driveMinutes: 90,
    trainParts: ["G7002 30分 约40元"],
  })!;
  assert.equal(near.recommended, "drive");
  assert.match(near.summary, /G7002/, "候选仍在，只是不推荐");

  // 长途：有高铁就推高铁，不推飞机。
  const far = assembleTransit({
    driveLine: "自驾约15小时10分，分5段", driveMinutes: 910,
    trainParts: ["G99 7小时18分 约860元"],
    flightPart: "飞机：约2-2.5小时，约600-1200元/人（估算）",
  })!;
  assert.equal(far.recommended, "train");
  assert.match(pick(far)!, /^G99/);

  /*
   * 飞机建议自己说了"不适用"——drive 分支挂掉、拿不到车程时的唯一护栏（M13-14）。
   *
   * 实测那张弹窗：一枚飞机图标下面写着「不适用（同城短途），无需机票……自驾最优」。
   * 内容是对的，标签是错的，而**图标和文字矛盾时用户信图标**。
   * 这一段不按飞机收，也不留原话——原话挂到「自驾」下面会读成"自驾不适用"，
   * 意思正好反过来。
   */
  const negated = assembleTransit({
    driveLine: undefined, driveMinutes: undefined, trainParts: [],
    flightPart: "飞机：不适用（同城短途），无需机票（估算），静安与嘉定同属上海市，无城际火车/航班，自驾最优",
  })!;
  assert.equal(negated.recommended, "drive");
  assert.doesNotMatch(negated.summary, /飞机/);
  assert.doesNotMatch(negated.summary, /不适用/, "否定式原话不能留——挂到自驾下面意思就反了");
  assert.match(pick(negated)!, /^自驾/);

  // 判不出来就不设推荐，弹窗整段照列——"我说不准"好过"我说错了"。
  const unknown = assembleTransit({ trainParts: [], flightPart: undefined, driveLine: undefined });
  assert.equal(unknown, undefined);
  const noRec = { summary: "轮渡 约6小时" };
  assert.equal(pick(noRec as never), "轮渡 约6小时");
});

test("大交通只列这次要走的那一种——三种并排会被当成三种都要订", async () => {
  const { selectedTransit } = await import("../src/graph/subgraphs/itinerary");
  const base = { status: "refining" as const, destination: "广州", days: 1, skeleton: [], caveats: [], updatedTurnId: "t" };
  const summary =
    "自驾约12小时30分，分3段；D941 12小时54分 约599元；飞机：约2-2.5小时，约600-1200元/人（估算）";

  /*
   * **没有推荐就整段照列**，不再默认飞机。
   * 早先默认飞机的后果：市内 40 分钟车程的确认弹窗上出现了一张机票。
   * 推荐由 `assembleTransit` 按实际车程定，定不出就不设。
   */
  assert.equal(selectedTransit({ ...base, transit: { summary } }), summary);
  // 有选择就听选择。
  assert.match(selectedTransit({ ...base, transit: { summary, recommended: "train" } })!, /^D941/);
  assert.match(selectedTransit({ ...base, transit: { summary, recommended: "drive" } })!, /^自驾/);

  // 认不出来时整段照列——少列一种是藏信息，比多列一种糟。
  const odd = "轮渡 约6小时";
  assert.equal(selectedTransit({ ...base, transit: { summary: odd } }), odd);
  assert.equal(selectedTransit({ ...base, transit: undefined }), undefined);
});

// ── 坐标穿透（M13-06）────────────────────────────────────────

test("trustCoordHit：查到了一个对不上的，等于没查到（M27-04 真实事故）", async () => {
  const { trustCoordHit } = await import("../src/graph/subgraphs/itinerary");
  // 事故原型：广州行程混进徐州如家，剥括号在广州命中另一家如家 → 必须拒绝
  assert.equal(
    trustCoordHit({
      original: "如家快捷酒店(徐州金鹰国际购物中心店)",
      area: "徐州市中心",
      viaStripped: true,
      hitName: "如家快捷酒店(广州北京路店)",
      hitCity: "广州市",
    }),
    false,
    "城市证据冲突：自述在徐州市、命中在广州市",
  );
  // 城市对得上、门店定位词也找得回来 → 通过（当年 NOGO 公寓那类合法剥括号命中）
  assert.equal(
    trustCoordHit({
      original: "诺果NOGO城景公寓(珠江新城店)",
      area: "天河区",
      viaStripped: true,
      hitName: "诺果NOGO城景公寓(珠江新城店)",
      hitCity: "广州市",
    }),
    true,
  );
  // 剥括号命中但命中名里找不回门店定位词 → 另一家店，拒绝
  assert.equal(
    trustCoordHit({
      original: "如家快捷酒店(徐州金鹰国际购物中心店)",
      viaStripped: true,
      hitName: "如家快捷酒店(广州北京路店)",
      hitCity: "广州市",
    }),
    false,
  );
  // 剥括号命中但命中名缺失 → 放行：真实搜索永远带名字，缺的只有测试替身/旧实现，
  // 苛刻会把「查空回退去括号」这条既有约定一并判死（本文件下方那条老用例）。
  assert.equal(
    trustCoordHit({ original: "某酒店(某店)", viaStripped: true, hitCity: "广州市" }),
    true,
  );
  // 全名直接命中、无城市冲突 → 通过；hitName 缺失也通过（老搜索实现不回名字）
  assert.equal(trustCoordHit({ original: "广州塔", viaStripped: false }), true);
  // area 里的「市」必须是城市而不是店名里的字：「市中心」市前无字，不产生候选
  assert.equal(
    trustCoordHit({ original: "某店", area: "市中心", viaStripped: false, hitCity: "广州市" }),
    true,
  );
});

test("resolveTripPlanCoords：对不上的命中不落坐标——错误在场比诚实缺席难发现", async () => {
  const { resolveTripPlanCoords } = await import("../src/graph/subgraphs/itinerary");
  const search = async (name: string) => {
    // 全名查不到，剥括号后命中广州的另一家店（照抄事故时序）
    if (name.includes("徐州金鹰")) return undefined;
    if (name === "如家快捷酒店")
      return { lat: 23.12195, lon: 113.283409, name: "如家快捷酒店(广州北京路店)", cityName: "广州市" };
    return { lat: 23.1, lon: 113.3, name, cityName: "广州市" };
  };
  const plan = {
    status: "refining" as const,
    destination: "广州",
    days: 1,
    skeleton: [
      {
        day: 1,
        theme: "a",
        area: "荔湾",
        spots: [{ name: "陈家祠堂" }],
        hotel: { name: "如家快捷酒店(徐州金鹰国际购物中心店)", area: "徐州市中心" },
      },
    ],
    caveats: [],
    updatedTurnId: "t",
  };
  const out = await resolveTripPlanCoords(plan, search, { sleep: async () => {} });
  assert.equal(out.skeleton[0].spots[0].lat, 23.1, "正常景点照常落坐标");
  assert.equal(out.skeleton[0].hotel?.lat, undefined, "别家店的坐标不能安到这家头上");
});

test("resolveTripPlanCoords：代码解析、同名缓存、单点失败不阻塞、不改入参", async () => {
  const { resolveTripPlanCoords } = await import("../src/graph/subgraphs/itinerary");
  const calls: string[] = [];
  const search = async (name: string) => {
    calls.push(name);
    if (name === "查不到的店") return undefined;
    if (name === "会炸的店") throw new Error("upstream");
    return { lat: 23.1, lon: 113.3 };
  };
  const plan = {
    status: "refining" as const,
    destination: "广州",
    days: 2,
    skeleton: [
      { day: 1, theme: "a", spots: [{ name: "广州塔" }, { name: "查不到的店" }], hotel: { name: "会炸的店" } },
      { day: 2, theme: "b", spots: [{ name: "广州塔" }] },
    ],
    caveats: [],
    updatedTurnId: "t",
  };
  const out = await resolveTripPlanCoords(plan, search, { sleep: async () => {} });
  assert.equal(out.skeleton[0].spots[0].lat, 23.1);
  assert.equal(out.skeleton[0].spots[1].lat, undefined, "查不到不猜坐标");
  assert.equal(out.skeleton[0].hotel?.lat, undefined, "重试后仍失败不阻塞其它点");
  assert.equal(out.skeleton[1].spots[0].lat, 23.1);
  // 失败重试一次（QPS 超限是常态）；同名缓存让广州塔只查一次。
  assert.deepEqual(calls, ["广州塔", "查不到的店", "会炸的店", "会炸的店"]);
  assert.equal(plan.skeleton[0].spots[0].lat, undefined, "入参不被改（右值覆盖语义）");
});

test("commit schema 不剥坐标——strip 模式漏声明的话地图永远空而链路看起来正常", async () => {
  const { setTripPlanStore } = await import("@carlife/tools");
  const { invokeTool } = await import("@carlife/tools");
  let stored: unknown;
  setTripPlanStore({
    async commit(_u: string, _s: string, plan: unknown) {
      stored = plan;
      return { planId: "p1", committedAt: new Date(0) };
    },
    async cancelCurrent() {
      return null;
    },
  });
  await invokeTool(
    "trip_plan_commit",
    {
      op: "commit",
      userId: "u1",
      plan: {
        status: "refining",
        destination: "广州",
        days: 1,
        skeleton: [
          {
            day: 1,
            theme: "a",
            spots: [{ name: "广州塔", lat: 23.1064, lon: 113.3245, poiKind: "spot" }],
            hotel: { name: "万豪", lat: 23.13, lon: 113.32 },
          },
        ],
        caveats: [],
        updatedTurnId: "t",
      },
    },
    { sessionId: "s", agent: "trip", mode: "real" },
  );
  const s = stored as {
    skeleton: Array<{ spots: Array<{ lat?: number; poiKind?: string }>; hotel?: { lon?: number } }>;
  };
  assert.equal(s.skeleton[0].spots[0].lat, 23.1064, "spot 坐标必须穿过 zod 落库");
  assert.equal(s.skeleton[0].hotel?.lon, 113.32, "hotel 坐标必须穿过 zod 落库");
  assert.equal(s.skeleton[0].spots[0].poiKind, "spot", "贴纸品类必须穿过 zod 落库（M13-07）");
});

test("resolveTripPlanCoords：品类随坐标同次捕获；有坐标没品类的老行程再确认时补上", async () => {
  const { resolveTripPlanCoords } = await import("../src/graph/subgraphs/itinerary");
  const calls: string[] = [];
  const search = async (name: string) => {
    calls.push(name);
    return { lat: 23.1, lon: 113.3, poiKind: "museum" as const };
  };
  const plan = {
    status: "refining" as const,
    destination: "广州",
    days: 1,
    skeleton: [
      {
        day: 1,
        theme: "a",
        // 陈家祠堂：M13-06 已解析过坐标但没有品类——不该跳过，要把品类补上（坐标不动）。
        spots: [{ name: "陈家祠堂", lat: 23.1259, lon: 113.2467 }, { name: "广州塔" }],
      },
    ],
    caveats: [],
    updatedTurnId: "t",
  };
  const out = await resolveTripPlanCoords(plan, search, { sleep: async () => {} });
  assert.equal(out.skeleton[0].spots[0].poiKind, "museum", "老行程补品类");
  assert.equal(out.skeleton[0].spots[0].lat, 23.1259, "已确认的坐标不被 top1 覆盖");
  assert.equal(out.skeleton[0].spots[1].poiKind, "museum", "新点坐标与品类同次捕获");
  assert.equal(out.skeleton[0].spots[1].lat, 23.1);
  // 坐标品类都齐的点不再发起查询。
  const again = await resolveTripPlanCoords(out, search, { sleep: async () => {} });
  assert.deepEqual(again.skeleton[0].spots.map((s) => s.poiKind), ["museum", "museum"]);
  assert.deepEqual(calls, ["陈家祠堂", "广州塔"], "第二轮全部命中已解析状态，不再查");
});

test("坐标解析关键词变体：| 是高德分隔符必须清洗；查空回退去括号门店后缀", async () => {
  const { resolveTripPlanCoords } = await import("../src/graph/subgraphs/itinerary");
  const calls: string[] = [];
  const search = async (kw: string) => {
    calls.push(kw);
    // 只有主名（无括号后缀）能命中——模拟高德按主名收录连锁店。
    return kw === "广州•诺果 NOGO城景公寓" ? { lat: 23.0, lon: 113.3 } : undefined;
  };
  const plan = {
    status: "refining" as const,
    destination: "广州",
    days: 1,
    skeleton: [
      {
        day: 1,
        theme: "a",
        spots: [],
        hotel: { name: "广州•诺果|NOGO城景公寓(汉溪长隆地铁站店)" },
      },
    ],
    caveats: [],
    updatedTurnId: "t",
  };
  const out = await resolveTripPlanCoords(plan, search, { sleep: async () => {} });
  assert.deepEqual(calls, [
    "广州•诺果 NOGO城景公寓(汉溪长隆地铁站店)", // | 已清洗
    "广州•诺果 NOGO城景公寓", // 查空后去括号再试
  ]);
  assert.equal(out.skeleton[0].hotel?.lat, 23.0, "回退变体命中的坐标要落下来");
});

// ── 同名异地第三课：region 归一 + 坐标离群兜底 ─────────────────

test("resolveDestinationRegion：景区名归一到所在市；对不上/查不到/抛错都退回原样", async () => {
  const { resolveDestinationRegion } = await import("../src/graph/subgraphs/itinerary");
  // 照抄事故：destination=普陀山，POI top1 是舟山的景区（geocode 则命中贵州同名村）
  assert.equal(
    await resolveDestinationRegion("普陀山", async () => ({
      name: "普陀山风景名胜区",
      cityName: "舟山市",
    })),
    "舟山市",
  );
  // 命中名与目的地互不包含 = 不相干 POI，收下会把整份行程圈错城市
  assert.equal(
    await resolveDestinationRegion("某冷门目的地", async () => ({
      name: "完全无关的店",
      cityName: "北京市",
    })),
    "某冷门目的地",
  );
  assert.equal(await resolveDestinationRegion("广州", async () => undefined), "广州");
  assert.equal(
    await resolveDestinationRegion("广州", async () => {
      throw new Error("upstream");
    }),
    "广州",
  );
});

test("坐标离群兜底：泉州的同名寺混进普陀山行程，坐标被丢、其它点不动", async () => {
  const { resolveTripPlanCoords } = await import("../src/graph/subgraphs/itinerary");
  // 照抄事故数据：region 归一失手时全国搜的 top1
  const COORDS: Record<string, { lat: number; lon: number }> = {
    南海观音大佛: { lat: 29.97406, lon: 122.393802 },
    法雨禅寺: { lat: 30.001896, lon: 122.393397 },
    慧济禅寺: { lat: 24.621861, lon: 118.677716 }, // 泉州同名寺，离群 ~700km
    善财古洞: { lat: 30.003327, lon: 122.412575 },
    某客栈: { lat: 29.981175, lon: 122.376875 },
  };
  const search = async (name: string) => COORDS[name];
  const plan = {
    status: "refining" as const,
    destination: "普陀山",
    days: 2,
    skeleton: [
      {
        day: 1,
        theme: "a",
        spots: [{ name: "南海观音大佛" }, { name: "法雨禅寺" }],
        hotel: { name: "某客栈" },
      },
      {
        day: 2,
        theme: "b",
        spots: [{ name: "慧济禅寺" }, { name: "善财古洞" }],
        hotel: { name: "某客栈" },
      },
    ],
    caveats: [],
    updatedTurnId: "t",
  };
  const out = await resolveTripPlanCoords(plan, search, { sleep: async () => {} });
  assert.equal(out.skeleton[1].spots[0].lat, undefined, "700km 外的同名寺不标不猜");
  assert.equal(out.skeleton[1].spots[0].lon, undefined);
  assert.equal(out.skeleton[0].spots[0].lat, 29.97406, "正常点照常落坐标");
  assert.equal(out.skeleton[1].spots[1].lat, 30.003327);
  assert.equal(out.skeleton[0].hotel?.lat, 29.981175, "逐日重复的酒店不受影响");
});

test("坐标离群兜底：大环线的合理分散不误伤；点数<3 不判", async () => {
  const { stripCoordOutliers } = await import("../src/graph/subgraphs/itinerary");
  // 环线行程：相邻点相距上百 km，中位距离大，阈值随之放大
  const loop = {
    status: "refining" as const,
    destination: "川西",
    days: 4,
    skeleton: [
      { day: 1, theme: "a", spots: [{ name: "A", lat: 30.0, lon: 102.0 }] },
      { day: 2, theme: "b", spots: [{ name: "B", lat: 30.5, lon: 101.0 }] },
      { day: 3, theme: "c", spots: [{ name: "C", lat: 29.3, lon: 100.2 }] },
      { day: 4, theme: "d", spots: [{ name: "D", lat: 28.6, lon: 101.5 }] },
    ],
    caveats: [],
    updatedTurnId: "t",
  };
  assert.deepEqual(stripCoordOutliers(loop), [], "合理分散不是离群");
  assert.equal(loop.skeleton[2].spots[0].lat, 29.3);

  const two = {
    status: "refining" as const,
    destination: "广州",
    days: 1,
    skeleton: [
      {
        day: 1,
        theme: "a",
        spots: [
          { name: "甲", lat: 23.1, lon: 113.3 },
          { name: "乙", lat: 39.9, lon: 116.4 },
        ],
      },
    ],
    caveats: [],
    updatedTurnId: "t",
  };
  assert.deepEqual(stripCoordOutliers(two), [], "两个点互相指认不了谁是错的");
  assert.equal(two.skeleton[0].spots[1].lat, 39.9);
});

// ── 行前物品进快照（M20-04）─────────────────────────────────

/** 捕获落库那一刻的快照——本组断言全看它，因为"图里带上了、库里没有"正是要防的。 */
function capturingStore(): TripPlanStore & { last?: TripPlanSnapshot } {
  const box: { last?: TripPlanSnapshot } = {};
  return {
    get last() {
      return box.last;
    },
    async commit(_userId, _sessionId, plan) {
      box.last = plan;
      return { planId: "plan-1", committedAt: new Date(0) };
    },
    async cancelCurrent() {
      return null;
    },
    async cancelById() {
      return null;
    },
    async update() {
      return null;
    },
    async list() {
      return [];
    },
    async query() {
      return [];
    },
  } as TripPlanStore & { last?: TripPlanSnapshot };
}

async function commitOnce(store: TripPlanStore, thread: string) {
  setTripPlanStore(store);
  const gate: GuardGate = new GuardGate({
    onInterrupt: ({ interruptId }) => queueMicrotask(() => gate.resume(interruptId, true)),
  });
  setGuardGate(gate);
  const graph = buildChatGraph(fakeStreamer(), { enableIntent: false });
  const cfg = { configurable: { thread_id: thread, userId: "u1", emit: { onDelta: () => {} } } };
  await graph.invoke({ messages: [{ role: "user", content: "我们去广州玩4天，帮我安排行程" }] }, cfg);
  return graph.invoke({ messages: [{ role: "user", content: "就这样定了" }] }, cfg);
}

test("确认时算出行前物品并写进**落库的那一份**（zod strip 的经典受害者）", async () => {
  const store = capturingStore();
  await commitOnce(store, "t-pretrip");

  const items = store.last?.pretripItems;
  assert.ok(items && items.length > 0, "落库快照里必须有 pretripItems");
  // 这份草案没有真实坐标（没配高德 key），所以工具走兜底给常备三件——
  // **重点不是推了什么，是它没被 schema 剥掉**。
  assert.deepEqual(items!.map((i) => i.key), ["hat", "sunscreen", "water"]);
  for (const i of items!) assert.ok(typeof i.key === "string" && i.key.length > 0);
});

test("物品工具挂了：不把确认路径带崩（它是配角）", async () => {
  const prev = process.env.CARLIFE_TOOLS;
  // mode=off 让**所有**工具抛 unconfigured，算物品那一步首当其冲。
  // 这一条不检查行程能不能定下来（trip_plan_commit 同样挂了，定不下来是预期），
  // 只检查一件事：多出来的这次工具调用没有把图打崩、没有抛出未捕获异常。
  process.env.CARLIFE_TOOLS = "off";
  try {
    const store = capturingStore();
    const gate: GuardGate = new GuardGate({
      onInterrupt: ({ interruptId }) => queueMicrotask(() => gate.resume(interruptId, true)),
    });
    setGuardGate(gate);
    setTripPlanStore(store);
    const graph = buildChatGraph(fakeStreamer(), { enableIntent: false });
    const cfg = { configurable: { thread_id: "t-pretrip-off", userId: "u1", emit: { onDelta: () => {} } } };
    await graph.invoke({ messages: [{ role: "user", content: "我们去广州玩4天，帮我安排行程" }] }, cfg);
    const s2 = await graph.invoke({ messages: [{ role: "user", content: "就这样定了" }] }, cfg);
    assert.ok(s2.tripPlan, "图不能因为算物品失败而崩掉");
    // 算不出来就**不写这个字段**——展示层据此回落基线清单，而不是拿到一个空数组。
    assert.equal(s2.tripPlan?.pretripItems, undefined);
  } finally {
    if (prev === undefined) delete process.env.CARLIFE_TOOLS;
    else process.env.CARLIFE_TOOLS = prev;
  }
});

// ── 打开 App 时的读时重算（M20-06）─────────────────────────────

test("重算端点：算出物品与天气；行程已结束不打天气；plan 非法回 400", async () => {
  const { createRuntimeServer } = await import("../src/server");
  const server = createRuntimeServer({ run: async () => undefined } as never).listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const post = async (body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}/internal/trip/pretrip-refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  try {
    // 没有坐标 → 工具走兜底，照样给得出常备三件（这条链路本身要通）。
    const ok = await post({
      plan: {
        status: "confirmed",
        destination: "广州",
        days: 2,
        skeleton: [{ day: 1, theme: "t", spots: [{ name: "广州塔" }] }],
        caveats: [],
        updatedTurnId: "t",
      },
    });
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray(ok.body.pretripItems) && (ok.body.pretripItems as unknown[]).length > 0);
    assert.ok(ok.body.weather, "天气与物品一起返回——端上两样都要更新");

    // 已经结束的行程连卡都不会上，不值得为它打一次天气。
    const expired = await post({
      plan: {
        status: "confirmed",
        destination: "广州",
        startDate: "2020-01-01",
        days: 1,
        skeleton: [{ day: 1, theme: "t", spots: [{ name: "广州塔" }] }],
        caveats: [],
        updatedTurnId: "t",
      },
    });
    assert.equal(expired.body.skipped, "expired");

    const bad = await post({ plan: { nope: true } });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});

// ── 目的地推荐的读时补齐（M32-02）───────────────────────────────

test("推荐端点：过期不调工具；工具失败回 skipped 且仍是 200；plan 非法回 400", async () => {
  const { createRuntimeServer } = await import("../src/server");
  const server = createRuntimeServer({ run: async () => undefined } as never).listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const post = async (body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}/internal/trip/highlights-refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const planOf = (over: Record<string, unknown> = {}) => ({
    status: "confirmed",
    destination: "广州",
    days: 2,
    skeleton: [{ day: 1, theme: "t", spots: [{ name: "广州塔" }] }],
    caveats: [],
    updatedTurnId: "t",
    ...over,
  });

  try {
    /*
     * 已结束的行程：**连工具都不该调**——一次联网搜索是按次计费的，
     * 而这份行程连卡都不会上（`tripPlanToHud` 返回 null）。
     * 这条与天气那边同一个理由，只是这边的代价大一个量级。
     */
    const expired = await post({ plan: planOf({ startDate: "2020-01-01", days: 1 }) });
    assert.equal(expired.status, 200);
    assert.equal(expired.body.skipped, "expired");

    /*
     * 未配供应商（本测试环境没注入 `setDestinationSearch`）→ 工具抛 unconfigured。
     * 端点**必须回 200 + skipped**，不能回 5xx：网关那侧只关心"有没有新值"，
     * 一个 500 会让它打日志告警，而"这次没搜成"是常态不是故障。
     */
    const failed = await post({ plan: planOf() });
    assert.equal(failed.status, 200, "失败也回 200——它不是故障，只是这次没有推荐");
    assert.equal(failed.body.skipped, "failed");
    assert.equal(failed.body.destinationHighlights, undefined, "失败时不给空对象顶替");

    const bad = await post({ plan: { nope: true } });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});

test("推荐端点：搜到了就原样回，`computedAt` 与数据同一份（M32-02）", async () => {
  const { setDestinationSearch } = await import("@carlife/tools");
  const { createRuntimeServer } = await import("../src/server");
  // 录下来的回包形状（M32-01 真跑的形状），不打网络。
  setDestinationSearch({
    apiKey: "k",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          content: [
            { type: "server_tool_use", name: "web_search" },
            {
              type: "web_search_tool_result",
              content: [{ url: "https://a.com/x", title: "老字号" }],
            },
            {
              type: "text",
              text: JSON.stringify({
                foods: [{ name: "陶陶居", note: "百年茶楼", sourceUrl: "https://a.com/x" }],
                spots: [{ name: "永庆坊", note: "骑楼老街" }],
                photoTips: [{ spot: "永庆坊", tip: "入夜拍月亮桥倒影" }],
              }),
            },
          ],
          usage: { server_tool_use: { web_search_requests: 1 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  const server = createRuntimeServer({ run: async () => undefined } as never).listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/internal/trip/highlights-refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        plan: {
          status: "confirmed",
          destination: "广州",
          days: 2,
          skeleton: [{ day: 1, theme: "t", spots: [{ name: "广州塔" }] }],
          caveats: [],
          updatedTurnId: "t",
        },
      }),
    });
    const body = (await r.json()) as {
      destinationHighlights?: {
        destination: string;
        foods: Array<{ name: string; sourceUrl?: string }>;
        spots: unknown[];
        photoTips: unknown[];
        computedAt: string;
      };
      computedAt?: string;
    };
    assert.equal(r.status, 200);
    const h = body.destinationHighlights;
    assert.ok(h, "搜到了就得给出来");
    // 目的地取 plan.destination（用户说的那个地方），不取 skeleton 里的景点名。
    assert.equal(h.destination, "广州");
    assert.equal(h.foods[0].name, "陶陶居");
    assert.equal(h.foods[0].sourceUrl, "https://a.com/x", "出处对上了白名单才有值");
    assert.equal(h.spots.length, 1);
    assert.equal(h.photoTips.length, 1);
    // 两处 computedAt 必须是同一个值——分两处取会出现"回包说 A、数据里写 B"。
    assert.equal(body.computedAt, h.computedAt);
    /*
     * 「永庆坊」那条模型没给 sourceUrl → 摊平后**两个字段都不该出现**。
     * 空串在端上是"有出处但没写"，与"没有出处"是两回事。
     */
    const spot = h.spots[0] as Record<string, unknown>;
    assert.equal("sourceUrl" in spot, false);
    assert.equal("sourceTitle" in spot, false);
  } finally {
    server.close();
    setDestinationSearch(undefined);
  }
});

// ── 无草案的整批取消（0830 走查事故）───────────────────────────
//
// 车主说「把所有行程都取消」，弹窗弹了、逐条列了、确认也点了，
// 库里 10 份已确认的却只掉了 5 份——**主页照常挂着行程**。
// 根因：取消路径查库写死 `limit: 5`，而"全部"批的就是这次列出来的那几份。
// 全程零报错（工具成功、话术说「已取消 5 份」），只有屏幕在打脸，
// 所以这条链路必须有断言守着——它没法靠"看起来正常"发现。

/** 假仓储：`list` 如实按 limit 截断，`cancelById` 真的把行置 cancelled。 */
function multiPlanStore(n: number): TripPlanStore & { statuses: Map<string, string> } {
  const statuses = new Map<string, string>();
  for (let i = 1; i <= n; i += 1) statuses.set(`plan-${i}`, "confirmed");
  const snapshot = (i: number): TripPlanSnapshot => ({
    status: "confirmed",
    destination: `目的地${i}`,
    days: 2,
    skeleton: [{ day: 1, theme: "t", spots: [{ name: "某地" }] }],
    caveats: [],
    updatedTurnId: "t",
  });
  return {
    statuses,
    async commit() {
      return { planId: "plan-new", committedAt: new Date(0) };
    },
    async cancelCurrent() {
      return null;
    },
    async cancelById(_userId, planId) {
      if (statuses.get(planId) !== "confirmed") return null;
      statuses.set(planId, "cancelled");
      return { planId, committedAt: new Date(0) };
    },
    async update() {
      return null;
    },
    // 未取消的才进列表（同真实仓储），并**如实按 limit 截断**——
    // 假仓储在这里放水的话，这条测试就守不住它要守的那件事。
    async list(_userId, limit) {
      const alive = [...statuses.entries()]
        .filter(([, s]) => s === "confirmed")
        .map(([planId], i) => ({
          planId,
          plan: snapshot(i + 1),
          committedAt: new Date(0),
        }));
      return alive.slice(0, limit ?? 10);
    },
    async query() {
      return [];
    },
  } as TripPlanStore & { statuses: Map<string, string> };
}

test("「所有行程都取消」：库里 10 份要全掉，不能只掉列举上限那几份", async () => {
  const store = multiPlanStore(10);
  setTripPlanStore(store);
  const details: string[][] = [];
  const gate: GuardGate = new GuardGate({
    onInterrupt: ({ interruptId, request }) => {
      details.push(request.details ?? []);
      queueMicrotask(() => gate.resume(interruptId, true));
    },
  });
  setGuardGate(gate);

  const answers: string[] = [];
  const graph = buildChatGraph(fakeStreamer(answers), { enableIntent: false });
  const cfg = {
    configurable: { thread_id: "t-cancel-all", userId: "u1", emit: { onDelta: () => {} } },
  };
  await graph.invoke({ messages: [{ role: "user", content: "把所有行程都取消" }] }, cfg);

  const left = [...store.statuses.values()].filter((s) => s === "confirmed");
  assert.deepEqual(left, [], "一份都不能剩——剩下的会继续挂在座舱主页上");
  // 弹窗上批的是哪几份必须看得见（F-04-02），而"看得见"的份数就是批的份数。
  assert.equal(details.at(-1)?.length, 10, "弹窗要逐条列出全部 10 份");
  assert.ok(
    answers.at(-1)?.includes("已取消 10 份"),
    "话术里的条数要与真实取消数一致，不能说 5 份",
  );
});

test("超出列举上限时**说出还剩几份**——沉默地留一半比报错糟", async () => {
  const { describeCancelledBatch } = await import("../src/graph/subgraphs/itinerary");
  const partial = describeCancelledBatch(50, 7);
  assert.ok(partial.includes("已取消 50 份"));
  assert.ok(partial.includes("还剩 7 份"), "剩下的份数必须出现在话术里");
  // 剩 0 时不能凭空多出一句"还剩"，那会让本来干净的取消显得没做完。
  assert.ok(!describeCancelledBatch(3).includes("还剩"));
});
