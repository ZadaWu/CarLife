/**
 * Mem0 客户端封装单测（施工单 M7-01 任务 4）。**零依赖**：不连 Mem0、不连 PG、不连 Ollama。
 *
 * 这三条性质在出问题时都没有明显症状，所以必须在这里被断言，
 * 而不是靠"部署完手动试一次"：
 *
 *   1. 后端挂了要降级（对话照常，只是没有个性化）
 *   2. 但缺 userId 要**失败**，绝不退化成读全量
 *   3. 类别过滤两边都做——mem0ai 2.x 的 getAll 会静默忽略 filters
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CarLifeMemoryClient, type Mem0Like } from "../src/client";

/** 永远失败的后端，模拟 Mem0 不可用。 */
const DEAD: Mem0Like = {
  add: async () => { throw new Error("ECONNREFUSED 127.0.0.1:11434"); },
  search: async () => { throw new Error("ECONNREFUSED 127.0.0.1:11434"); },
  getAll: async () => { throw new Error("ECONNREFUSED"); },
  get: async () => { throw new Error("ECONNREFUSED"); },
  update: async () => { throw new Error("ECONNREFUSED"); },
  delete: async () => { throw new Error("ECONNREFUSED"); },
  deleteAll: async () => { throw new Error("ECONNREFUSED"); },
  reset: async () => { throw new Error("ECONNREFUSED"); },
} as unknown as Mem0Like;

function alive(results: Array<{ id: string; memory: string; metadata?: Record<string, unknown> }>) {
  const calls: Array<Record<string, unknown>> = [];
  const impl = {
    add: async (_m: unknown, o: Record<string, unknown>) => {
      calls.push({ op: "add", ...o });
      return { results: [] };
    },
    search: async (q: string, o: Record<string, unknown>) => {
      calls.push({ op: "search", q, ...o });
      return { results };
    },
    getAll: async (o: Record<string, unknown>) => {
      calls.push({ op: "getAll", ...o });
      return { results };
    },
    get: async () => null,
    update: async () => ({ message: "ok" }),
    delete: async () => ({ message: "ok" }),
    deleteAll: async () => ({ message: "ok" }),
    reset: async () => undefined,
  } as unknown as Mem0Like;
  return { impl, calls };
}

describe("降级：后端不可用不能让对话失败（M7-01 约束 5-②）", () => {
  it("读路径返回空结果而不是抛错", async () => {
    const c = new CarLifeMemoryClient({}, DEAD);
    const r = await c.searchPreference("u1", "动能回收");
    assert.deepEqual(r.results, []);
    assert.equal(r.degraded, true);
  });

  it("**degraded 必须被标出来**——空结果不等于「用户没有这个偏好」", async () => {
    const c = new CarLifeMemoryClient({}, DEAD);
    const r = await c.searchEpisodic("u1", "上次去哪了");
    assert.equal(r.degraded, true, "不标记的话，调用方会把「查不到」当成事实用");
    assert.match(r.error ?? "", /ECONNREFUSED/, "错误原因要能追到根因");
  });

  it("写路径同样降级，不把异常抛给业务层", async () => {
    const c = new CarLifeMemoryClient({}, DEAD);
    const r = await c.addPreference("u1", "喜欢安静", {
      domain: "cabin",
      confidence: 0.8,
      lastConfirmedAt: "2026-08-09T00:00:00Z",
    });
    assert.equal(r.degraded, true);
  });

  it("health() 暴露后端状态，供健康视图与后台记忆页读", async () => {
    const c = new CarLifeMemoryClient({}, DEAD);
    await c.searchPreference("u1", "x");
    assert.equal(c.health().available, false);
    assert.match(c.health().lastError ?? "", /ECONNREFUSED/);
  });
});

describe("用户隔离：无用户上下文必须失败，不能读全量（M7-01 边界）", () => {
  const c = new CarLifeMemoryClient({}, alive([]).impl);

  for (const [name, fn] of [
    ["search", () => c.search("", "q")],
    ["getAll", () => c.getAll("")],
    ["add", () => c.addPreference("", "x", { domain: "d", confidence: 1, lastConfirmedAt: "t" })],
    ["deleteAll", () => c.deleteAll("")],
  ] as const) {
    it(`${name} 在 userId 为空时抛错`, async () => {
      await assert.rejects(fn, /必须带用户维度/);
    });
  }

  it("空白字符也算没有用户", async () => {
    await assert.rejects(() => c.search("   ", "q"), /必须带用户维度/);
  });

  it("**这条不走降级**——它是调用方的错，不是后端故障", async () => {
    const dead = new CarLifeMemoryClient({}, DEAD);
    // 后端也是挂的，但依然应该抛 userId 的错而不是返回 degraded 空结果：
    // 否则一个缺 userId 的 bug 会被降级路径永久掩盖。
    await assert.rejects(() => dead.search("", "q"), /必须带用户维度/);
  });

  it("search 强制把 userId 写进 filters，调用方覆盖不掉", async () => {
    const { impl, calls } = alive([]);
    const cc = new CarLifeMemoryClient({}, impl);
    await cc.search("real-user", "q", { user_id: "someone-else" });
    const call = calls.find((x) => x.op === "search" && x.q === "q")!;
    // mem0ai ≥3 的 SearchFilters 用 snake_case——写成 userId 不会报错，
    // 只会被当成普通 metadata 字段去匹配，然后什么都查不到。
    assert.equal((call.filters as Record<string, unknown>).user_id, "real-user");
  });
});

describe("类别过滤两边都做——后端过滤 + 本层再筛一遍", () => {
  const rows = [
    { id: "1", memory: "去过黄山", metadata: { category: "episodic" } },
    { id: "2", memory: "喜欢安静", metadata: { category: "preference" } },
    { id: "3", memory: "又去了千岛湖", metadata: { category: "episodic" } },
  ];

  it("getAllEpisodic 只返回 episodic", async () => {
    const { impl } = alive(rows);
    const c = new CarLifeMemoryClient({}, impl);
    const r = await c.getAll("u1", { category: "episodic" });
    assert.deepEqual(r.results.map((m) => m.id), ["1", "3"]);
  });

  it("**本层的过滤不能省**——2.x 的 getAll 会静默忽略 filters，返回全部类别", async () => {
    // 这个 fake 刻意**无视** filters（正是 mem0ai 2.x getAll 的行为）。
    // 断言仍要求结果只有 episodic：靠的就是封装层拿回来后自己再筛一遍。
    const { impl } = alive(rows);
    const c = new CarLifeMemoryClient({}, impl);
    const r = await c.getAll("u1", { category: "episodic" });
    assert.deepEqual(r.results.map((m) => m.id), ["1", "3"]);
  });

  it("同时把 user_id 传给后端——不能只靠本层过滤做用户隔离", async () => {
    const { impl, calls } = alive(rows);
    const c = new CarLifeMemoryClient({}, impl);
    await c.getAll("u1", { category: "episodic" });
    const call = calls.find((x) => x.op === "getAll")!;
    assert.equal((call.filters as Record<string, unknown>).user_id, "u1");
  });

  it("无类别时原样返回，不做多余处理", async () => {
    const { impl } = alive(rows);
    const c = new CarLifeMemoryClient({}, impl);
    assert.equal((await c.getAll("u1")).results.length, 3);
  });

  it("过滤后仍受 limit 约束", async () => {
    const { impl } = alive(rows);
    const c = new CarLifeMemoryClient({}, impl);
    assert.equal((await c.getAll("u1", { category: "episodic" }, 1)).results.length, 1);
  });
});

describe("类别红线：④⑤① 不进 Mem0（§7）", () => {
  const c = new CarLifeMemoryClient({}, alive([]).impl);

  it("写入非 Mem0 类别直接拒绝", async () => {
    await assert.rejects(
      // 绕过类型层，模拟运行期传进来的错误类别（跨包调用、JSON 反序列化都可能）
      () => c.add("u1", "VIN LSJA1234", { category: "vehicle" } as never),
      /只承载/,
    );
  });

  it("**这条也不降级**——静默吞掉会让车辆档案悄悄进向量库", async () => {
    const dead = new CarLifeMemoryClient({}, DEAD);
    await assert.rejects(() => dead.add("u1", "x", { category: "vehicle" } as never), /只承载/);
  });

  it("三类合法类别都放行", async () => {
    const { impl, calls } = alive([]);
    const cc = new CarLifeMemoryClient({}, impl);
    await cc.addEpisodic("u1", "a", { occurredAt: "2026-08-09T00:00:00Z" });
    await cc.addPreference("u1", "b", { domain: "d", confidence: 1, lastConfirmedAt: "t" });
    await cc.addUsagePattern("u1", "c", {
      summaryType: "weekly", periodStart: "s", periodEnd: "e",
    });
    assert.equal(calls.filter((x) => x.op === "add").length, 3);
  });
});

describe("metadata 类型回归：别再用 Omit 拆带索引签名的类型", () => {
  it("三类写入都把 category 落进 metadata", async () => {
    const { impl, calls } = alive([]);
    const c = new CarLifeMemoryClient({}, impl);
    await c.addEpisodic("u1", "去过黄山", { occurredAt: "2026-08-09T00:00:00Z", vin: "L123" });
    // calls[0] 是 ensureReady 的探活 search，真正的写入要按 op 找。
    const meta = (calls.find((x) => x.op === "add")!.metadata ?? {}) as Record<string, unknown>;
    assert.equal(meta.category, "episodic");
    // occurredAt 是衰减层的输入（M7-02）。它曾因 Omit<T,K> 对带索引签名的类型
    // 会抹掉全部具名字段而在编译期形同虚设——这条断言守的是那个回归。
    assert.equal(meta.occurredAt, "2026-08-09T00:00:00Z");
    assert.equal(meta.vin, "L123");
  });

  it("infer 关闭：metadata 由 CarLife 自己管，不交给模型猜", async () => {
    const { impl, calls } = alive([]);
    const c = new CarLifeMemoryClient({}, impl);
    await c.addPreference("u1", "x", { domain: "d", confidence: 1, lastConfirmedAt: "t" });
    assert.equal(calls.find((x) => x.op === "add")!.infer, false);
  });
});
