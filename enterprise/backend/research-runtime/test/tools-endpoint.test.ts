/**
 * 研究工具回调面（施工单 M88-04，ACR-038 步 4）。
 *
 * 最要紧的一条是**计步**：直连路径的 `maxSteps: 8` 在 ACP 上没有等价物
 * （pi 自己跑工具循环，`--approve` 下每次调用都放行），上界只剩这一个落点。
 * 漏掉它不会报错——一次挑战会一直查到超时，而超时的表现是"这张卡没有挑战记录"，
 * 看起来像**没找到反例**。所以这里逐条钉：第 9 次回什么、两个会话算不算一笔账、
 * 拿不到会话 id 时是不是既不静默放行也不静默拒绝。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { CHALLENGE_MAX_STEPS, type ResearchToolDeps } from "@carlife/research-tools";

import {
  createResearchToolsEndpoint,
  RESEARCH_TOOLS_DESCRIBE_PATH,
  RESEARCH_TOOLS_INVOKE_PATH,
  type ResearchSessionResolver,
  type ResearchToolsEndpoint,
} from "../src/acp/tools-endpoint";

/**
 * 一次挑战的取数。`byId` 故意回一行"库里的样子"（带 `content` 原文列）——
 * 工具只取 `textRedacted`，出口里不该出现它。
 */
const depsFor = (tag: string): ResearchToolDeps =>
  ({
    repo: {
      units: {
        byId: async (id: string) => ({
          id,
          textRedacted: `${tag}：其实比我想的准`,
          content: "打 13800138000 给我",
        }),
      },
      systemEvents: { inWindow: async () => [{ at: 1, kind: "deploy", summary: "网关发版" }] },
    },
    codebookVersion: "0.1.0",
    themeMembers: async () => ({ memberUnitIds: ["u-0"], counterUnitIds: ["u-1", "u-2"] }),
    thresholdSensitivity: async (code: string, delta: number) => ({
      flips: delta > 0.15,
      detail: `${tag} ${code}`,
    }),
    sliceBySegment: async () => [{ segment: "高频快充", n: 3, share: 0.75 }],
  }) as unknown as ResearchToolDeps;

interface Harness {
  endpoint: ResearchToolsEndpoint;
  base: string;
  server: Server;
}

async function start(opts: { resolveSession?: ResearchSessionResolver } = {}): Promise<Harness> {
  const endpoint = createResearchToolsEndpoint(opts);
  // 与 `createInternalApi` 同一种挂法：先问工具面，没接住才轮到别人。
  const server = createServer((req, res) => {
    void endpoint.handle(req, res).then((handled) => {
      if (handled) return;
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { endpoint, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

interface InvokeBody {
  name: string;
  args?: unknown;
  agent?: string;
  piSessionId?: string;
}

const invoke = async (
  base: string,
  body: InvokeBody,
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> => {
  const res = await fetch(`${base}${RESEARCH_TOOLS_INVOKE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  return { status: res.status, body: JSON.parse(raw) as Record<string, unknown>, raw };
};

const counterEvidence = (piSessionId?: string): InvokeBody => ({
  name: "findCounterEvidence",
  args: { themeId: "th-1", limit: 2 },
  agent: "challenger",
  ...(piSessionId ? { piSessionId } : {}),
});

/** 挑战键 = `challenge:<insightId>:<runId ?? "batch">`（M88-05 由 `challengeOne` 登记）。 */
const KEY_A = "challenge:insight-1:batch";
const KEY_B = "challenge:insight-2:run-9";

/** pi 会话 → 挑战键。形状与 `AcpClientPool.resolveSession` 逐字相同。 */
const ROUTES = new Map<string, string>([
  ["pi-a", KEY_A],
  ["pi-b", KEY_B],
]);
const resolveSession: ResearchSessionResolver = (id) => {
  const carlifeSessionId = ROUTES.get(id);
  return carlifeSessionId ? { carlifeSessionId, agent: "challenger" } : undefined;
};

describe("[M88-04] describe：扩展取工具表", () => {
  let h: Harness;
  before(async () => {
    h = await start({ resolveSession });
  });
  after(() => h.server.close());

  it("回 4 条，且 describeCalls 加一——它是扩展确实被 pi 加载的唯一证据", async () => {
    const before0 = h.endpoint.stats().describeCalls;
    const res = await fetch(`${h.base}${RESEARCH_TOOLS_DESCRIBE_PATH}?agent=challenger`);
    const body = (await res.json()) as { agent: string; tools: Array<{ name: string; parameters: { type?: string } }> };
    assert.equal(res.status, 200);
    assert.equal(body.agent, "challenger");
    assert.deepEqual(
      body.tools.map((t) => t.name),
      ["findCounterEvidence", "listSystemEvents", "sliceBySegment", "thresholdSensitivity"],
    );
    // 顶层不是 object 的话，pi 注册工具表时会拒——而症状是这个 Agent 整个哑掉。
    for (const t of body.tools) assert.equal(t.parameters.type, "object");
    assert.equal(h.endpoint.stats().describeCalls, before0 + 1);
  });

  it("不带 ?agent= 时缺省 challenger", async () => {
    const res = await fetch(`${h.base}${RESEARCH_TOOLS_DESCRIBE_PATH}`);
    assert.equal(((await res.json()) as { agent: string }).agent, "challenger");
  });

  it("没接住的路径原样放过，由别的路由去管", async () => {
    const res = await fetch(`${h.base}/internal/research/insights`);
    assert.equal(res.status, 404);
  });
});

describe("[M88-04] invoke：ACL 与入参", () => {
  let h: Harness;
  before(async () => {
    h = await start({ resolveSession });
    h.endpoint.registerChallengeSession(KEY_A, depsFor("A"));
  });
  after(() => {
    h.endpoint.release(KEY_A);
    h.server.close();
  });

  it("不在 ACL 里的工具名回 403", async () => {
    const { status, body } = await invoke(h.base, {
      name: "dropEverything",
      agent: "challenger",
      piSessionId: "pi-a",
    });
    assert.equal(status, 403);
    assert.equal(body.error, "tool_not_allowed_for_agent");
    assert.equal(h.endpoint.stats().denied, 1);
    // 403 在计步之前——被拒的调用不该吃掉这次挑战的步数。
    assert.equal(h.endpoint.stepsOf("pi-a"), undefined);
  });

  it("反解不出的会话按自报 Agent 裁剪：未知 Agent 手里是空表，回 403", async () => {
    const { status, body } = await invoke(h.base, {
      name: "findCounterEvidence",
      args: { themeId: "th-1" },
      agent: "synthesizer",
      piSessionId: "pi-unrouted",
    });
    assert.equal(status, 403);
    assert.equal(body.agent, "synthesizer");
  });

  it("缺工具名回 400，不是 500", async () => {
    const res = await fetch(`${h.base}${RESEARCH_TOOLS_INVOKE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "challenger", piSessionId: "pi-a" }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "missing_tool_name");
  });

  it("入参不合法回 200 + ok:false——那是「参数写错了」，不是「工具坏了」", async () => {
    const { status, body } = await invoke(h.base, {
      name: "thresholdSensitivity",
      args: { code: "cold-range-loss", delta: 9 },
      agent: "challenger",
      piSessionId: "pi-a",
    });
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.match(String(body.error), /入参不合法/);
  });

  it("执行结果回 { ok: true, result }——扩展读的就是 result 这个键", async () => {
    const { status, body, raw } = await invoke(h.base, counterEvidence("pi-a"));
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    const result = body.result as { count: number; units: Array<Record<string, unknown>> };
    assert.equal(result.count, 2);
    assert.ok("unitId" in result.units[0] && "text" in result.units[0]);
    // 原文不出研究面：这些字节还要穿过 pi 的会话 jsonl 落到磁盘上。
    assert.ok(!raw.includes('"content"'), "响应里出现了 content——那是 messages 的列名");
    assert.ok(!raw.includes("13800138000"), "原文漏出去了");
  });
});

describe("[M88-04] invoke：按 pi 会话计步", () => {
  let h: Harness;
  before(async () => {
    h = await start({ resolveSession });
    h.endpoint.registerChallengeSession(KEY_A, depsFor("A"));
    h.endpoint.registerChallengeSession(KEY_B, depsFor("B"));
  });
  after(() => {
    h.endpoint.release(KEY_A);
    h.endpoint.release(KEY_B);
    h.server.close();
  });

  it(`同一会话连发 ${CHALLENGE_MAX_STEPS + 1} 次：前 ${CHALLENGE_MAX_STEPS} 次成功，第 ${CHALLENGE_MAX_STEPS + 1} 次回「步数已用满」`, async () => {
    for (let i = 1; i <= CHALLENGE_MAX_STEPS; i += 1) {
      const { status, body } = await invoke(h.base, counterEvidence("pi-a"));
      assert.equal(status, 200, `第 ${i} 次`);
      assert.equal(body.ok, true, `第 ${i} 次应当成功`);
    }
    assert.deepEqual(h.endpoint.stepsOf("pi-a"), { steps: CHALLENGE_MAX_STEPS, hitLimit: false });

    const last = await invoke(h.base, counterEvidence("pi-a"));
    // HTTP 200 而不是 4xx：回 4xx 的话 pi 当传输错误重试，模型根本读不到这句话。
    assert.equal(last.status, 200);
    assert.equal(last.body.ok, false);
    assert.equal(
      last.body.error,
      "工具步数已用满（8 步）——没查清楚的条目请判 inconclusive，不要判 holds",
    );
    // 收口跳（M88-05）读这个标记：超限时把 holds 强制成 inconclusive。
    assert.deepEqual(h.endpoint.stepsOf("pi-a"), { steps: CHALLENGE_MAX_STEPS, hitLimit: true });
    assert.equal(h.endpoint.stats().limitHits, 1);
  });

  /*
   * 探查跳结束后要按**挑战键**读 `hitLimit`（M88-05）——它手里没有 pi 会话 id，
   * 那是 pi 侧生成的。反解表在底座里且是单向的，所以这一层在第一次 invoke 时
   * 顺手记下反过来的那一半。记不上的症状是"步数永远读成 0"：超限不再降级，
   * 而「没查完」会被判成 holds。
   */
  it("[M88-05] `stepsForKey`：按挑战键也问得到同一份计步", () => {
    assert.deepEqual(h.endpoint.stepsForKey(KEY_A), h.endpoint.stepsOf("pi-a"));
    assert.equal(h.endpoint.stepsForKey(KEY_A)?.hitLimit, true);
    assert.equal(h.endpoint.stepsForKey("challenge:从没挑战过"), undefined);
  });

  it("另一个 pi 会话各计各的——按进程计步会让第二张卡一上来就用满", async () => {
    const { body } = await invoke(h.base, counterEvidence("pi-b"));
    assert.equal(body.ok, true);
    assert.deepEqual(h.endpoint.stepsOf("pi-b"), { steps: 1, hitLimit: false });
    // 上一条已经把 pi-a 用满了，两者互不影响。
    assert.equal(h.endpoint.stepsOf("pi-a")?.hitLimit, true);
  });

  it("拿不到 piSessionId 时不计步、打警告——不静默放行也不静默拒绝", async () => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args.join(" "));
    try {
      await invoke(h.base, counterEvidence());
    } finally {
      console.warn = original;
    }
    assert.equal(h.endpoint.stepsOf("unknown"), undefined);
    assert.ok(
      warned.some((w) => w.includes("没带 piSessionId")),
      `警告没打出来：${JSON.stringify(warned)}`,
    );
  });

  it("stats() 的六个计数都在", () => {
    const s = h.endpoint.stats();
    assert.deepEqual(Object.keys(s).sort(), [
      "activeSessions",
      "denied",
      "describeCalls",
      "invokeCalls",
      "limitHits",
      "trackedSteps",
    ]);
    assert.equal(s.activeSessions, 2);
    assert.ok(s.invokeCalls >= CHALLENGE_MAX_STEPS + 1);
    // 两个会话各有一行计步：`trackedSteps` 是按 pi 会话数的那笔账。
    assert.equal(s.trackedSteps, 2);
  });
});

/*
 * ── 计步按轮重置（M89-02）────────────────────────────────────────────────
 *
 * 上界的语义是"**一轮**最多查几步"，不是"这个 pi 会话一辈子最多查几步"。
 * 池按 `carlifeSessionId` 复用会话：C7 的追问与批量挑战落回同一个 pi 会话、
 * 同一个挑战键。跨轮累加的话第二轮一上来就满，表现是"追问一次就 inconclusive"，
 * 而日志里只有一句"步数已用满"——看不出那 8 步是上一轮花的。
 *
 * 清得掉的前提是 `hitLimit` 没有跨过 `release` 的读者：真实调用序
 * （`stages/challenge.ts:135-157`）是 register → challenge()（内部 `exploreAcp`
 * 返回时已读完 hitLimit）→ finally release。M88-04 §6 当初的顾虑不成立。
 */
describe("[M89-02] 计步按轮：register 归零、release 销账", () => {
  let h: Harness;
  before(async () => {
    h = await start({ resolveSession });
  });
  after(() => h.server.close());

  it("① 第一轮用满 → release → register → 第二轮第一步就成功，步数从 1 起算", async () => {
    h.endpoint.registerChallengeSession(KEY_A, depsFor("A"));
    for (let i = 1; i <= CHALLENGE_MAX_STEPS; i += 1) {
      assert.equal((await invoke(h.base, counterEvidence("pi-a"))).body.ok, true, `第 ${i} 次`);
    }
    const overflow = await invoke(h.base, counterEvidence("pi-a"));
    assert.equal(overflow.body.ok, false);
    assert.deepEqual(h.endpoint.stepsOf("pi-a"), { steps: CHALLENGE_MAX_STEPS, hitLimit: true });

    // 一轮 = 一次 register…release。这两步之间没有任何读者。
    h.endpoint.release(KEY_A);
    h.endpoint.registerChallengeSession(KEY_A, depsFor("A"));

    // 第二轮的第一次调用（对同一个 pi 会话而言是第 9 次）必须放行。
    const first = await invoke(h.base, counterEvidence("pi-a"));
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true, "第二轮起手就被判用满——计步没有按轮归零");
    assert.deepEqual(h.endpoint.stepsOf("pi-a"), { steps: 1, hitLimit: false });
    // 按挑战键问也是这一份：piSessionOfKey 保留，才靶得到同一行。
    assert.deepEqual(h.endpoint.stepsForKey(KEY_A), { steps: 1, hitLimit: false });
  });

  it("② release 之后 stepsForKey 回 undefined，trackedSteps 减一", () => {
    const before0 = h.endpoint.stats().trackedSteps;
    assert.equal(before0, 1);
    h.endpoint.release(KEY_A);
    assert.equal(h.endpoint.stepsForKey(KEY_A), undefined);
    assert.equal(h.endpoint.stepsOf("pi-a"), undefined);
    // 只增不减就是漏了销账——那是个只能等内存变大才发现的慢性泄漏。
    assert.equal(h.endpoint.stats().trackedSteps, before0 - 1);
    assert.equal(h.endpoint.stats().activeSessions, 0);
  });

  it("③ 第一轮之前 register 无事可做——那时还没有 piSessionOfKey 这一行", async () => {
    // KEY_B 从没被 invoke 过，piSessionOfKey 里没有它：register 不该凭空造一行。
    h.endpoint.registerChallengeSession(KEY_B, depsFor("B"));
    assert.equal(h.endpoint.stepsForKey(KEY_B), undefined);
    assert.equal(h.endpoint.stats().trackedSteps, 0);

    assert.equal((await invoke(h.base, counterEvidence("pi-b"))).body.ok, true);
    assert.deepEqual(h.endpoint.stepsOf("pi-b"), { steps: 1, hitLimit: false });
    assert.equal(h.endpoint.stats().trackedSteps, 1);
    h.endpoint.release(KEY_B);
  });
});

/*
 * 引用核对那本账（M89-03）。
 *
 * 它守的是一种**读起来完全正常**的错：模型写 `citedUnitIds: ["unit-0007"]`，
 * 而那条 id 它从没查到过。收口后要拿这本账取交集，所以这本账错了没人看得出——
 * 少收 id 就是把真引用剥掉（看起来像"模型总在编"），
 * 跨轮不清就是拿上一轮返回过的 id 给这一轮的引用背书。
 */
describe("[M89-03] invoke：本轮工具返回过的 id 收进 seenIds", () => {
  let h: Harness;
  before(async () => {
    h = await start({ resolveSession });
  });
  after(() => {
    h.endpoint.release(KEY_A);
    h.server.close();
  });

  it("成功的一次 invoke 把返回里的 unitId 收进来，按会话键也问得到", async () => {
    h.endpoint.registerChallengeSession(KEY_A, depsFor("A"));
    assert.equal(h.endpoint.seenIdsOf("pi-a"), undefined, "还没 invoke 就有账了");

    const { body } = await invoke(h.base, counterEvidence("pi-a"));
    assert.equal(body.ok, true);
    // depsFor 的 counterUnitIds 是 u-1 / u-2，limit 2 → 两条都回。
    assert.deepEqual([...(h.endpoint.seenIdsOf("pi-a") ?? [])].sort(), ["u-1", "u-2"]);
    assert.deepEqual(
      [...(h.endpoint.seenIdsForKey(KEY_A) ?? [])].sort(),
      [...(h.endpoint.seenIdsOf("pi-a") ?? [])].sort(),
    );
  });

  it("**stepsOf 的形状一个字段都没加**——seenIds 走自己的访问器", () => {
    assert.deepEqual(h.endpoint.stepsOf("pi-a"), { steps: 1, hitLimit: false });
    assert.deepEqual(Object.keys(h.endpoint.stepsOf("pi-a") ?? {}).sort(), ["hitLimit", "steps"]);
  });

  it("[M89-02 同寿命] register 归零时这本账一起清——上一轮的 id 不给这一轮背书", async () => {
    h.endpoint.release(KEY_A);
    assert.equal(h.endpoint.seenIdsForKey(KEY_A), undefined, "release 之后账还在");

    // register 时 piSessionOfKey 还在（它刻意不跟着 release 清），所以这一行被归零成空集。
    h.endpoint.registerChallengeSession(KEY_A, depsFor("A"));
    assert.deepEqual([...(h.endpoint.seenIdsForKey(KEY_A) ?? [])], [], "register 没把上一轮的 id 清掉");

    // 第二轮只取一条，于是账里应当只剩 u-1——u-2 是上一轮的。
    await invoke(h.base, { ...counterEvidence("pi-a"), args: { themeId: "th-1", limit: 1 } });
    assert.deepEqual([...(h.endpoint.seenIdsOf("pi-a") ?? [])], ["u-1"], "第二轮带着上一轮的 id");
  });

  it("失败的调用不进账——错误文本里没有数据，收它等于给不存在的 id 背书", async () => {
    const before0 = new Set(h.endpoint.seenIdsOf("pi-a") ?? []);
    // limit 超上界 → invokeTool 回 { ok: false }，这一跳没有 data。
    const { body } = await invoke(h.base, { ...counterEvidence("pi-a"), args: { themeId: "th-1", limit: 999 } });
    assert.equal(body.ok, false);
    assert.deepEqual([...(h.endpoint.seenIdsOf("pi-a") ?? [])].sort(), [...before0].sort());
  });
});

describe("[M88-04] invoke：deps 按挑战键查表", () => {
  let h: Harness;
  before(async () => {
    h = await start({ resolveSession });
    h.endpoint.registerChallengeSession(KEY_A, depsFor("A"));
  });
  after(() => h.server.close());

  it("两次挑战各拿各的窗——不共用一份进程级 deps", async () => {
    h.endpoint.registerChallengeSession(KEY_B, depsFor("B"));
    const a = await invoke(h.base, {
      name: "thresholdSensitivity",
      args: { code: "x", delta: 0.1 },
      piSessionId: "pi-a",
    });
    const b = await invoke(h.base, {
      name: "thresholdSensitivity",
      args: { code: "x", delta: 0.1 },
      piSessionId: "pi-b",
    });
    assert.match(String((a.body.result as { detail: string }).detail), /^A /);
    assert.match(String((b.body.result as { detail: string }).detail), /^B /);
    h.endpoint.release(KEY_B);
  });

  it("release 之后再来的调用回「挑战会话已结束」，不拿别人的窗去答", async () => {
    h.endpoint.release(KEY_A);
    assert.equal(h.endpoint.stats().activeSessions, 0);
    const { status, body } = await invoke(h.base, counterEvidence("pi-a"));
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: false, error: "挑战会话已结束" });
  });
});

/*
 * 没注入反解时的回落（留给 M88-05：接池之前只有一次挑战在跑）。
 * **必须是确定性的**：恰好一个会话时用它，0 个或 ≥2 个一律按结束处理——
 * "挑一个最近的"那种回落在并发两张卡时会静默串台。
 */
describe("[M88-04] 没注入 resolveSession 时的单会话回落", () => {
  let h: Harness;
  before(async () => {
    h = await start();
  });
  after(() => h.server.close());

  it("一个会话时认得，两个时按结束处理", async () => {
    assert.equal((await invoke(h.base, counterEvidence("pi-x"))).body.error, "挑战会话已结束");

    h.endpoint.registerChallengeSession(KEY_A, depsFor("A"));
    assert.equal((await invoke(h.base, counterEvidence("pi-x"))).body.ok, true);

    h.endpoint.registerChallengeSession(KEY_B, depsFor("B"));
    assert.equal((await invoke(h.base, counterEvidence("pi-x"))).body.error, "挑战会话已结束");
  });
});
