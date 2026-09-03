/**
 * 系统状态端点（`GET /console/system/status`）。
 *
 * 盯得最紧的三条（与 system-status.ts 文件头的三条纪律一一对应）：
 *  1. **探不到 ≠ 挂了**：worker 可被显式停掉时是 idle、客户端窗口无通道是 unknown、
 *     redis/minio 未配置是 idle——这三种灰都不许染红。
 *  2. **响应了也未必健康**：runtime 自报 risks 非空要标 degraded，不吞掉。
 *  3. **一个探针挂了不能带塌整页**：单个 fetch 抛异常时整页仍是 200，其余服务照常。
 *
 * 全部脱网：fetch / PG / redis 均由注入的假实现顶替。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import express from "express";

import {
  ago,
  createSystemStatusRouter,
  deriveWorkerHealthState,
  deriveWorkerState,
  duration,
  summarize,
  type ServiceReport,
  type SystemStatusDeps,
  type SystemStatusSnapshot,
} from "../src/console/system-status";

const HOUR = 3_600_000;

// ── 纯函数：worker 状态推导 ─────────────────────────────────────

describe("deriveWorkerState", () => {
  const now = Date.now();

  it("有未过期租约 = 正在执行，ok", () => {
    const r = deriveWorkerState({ lease: { job: "memory-decay", holder: "h1" }, lastRun: null }, now);
    assert.equal(r.state, "ok");
    assert.match(r.detail ?? "", /memory-decay/);
  });

  it("留痕新鲜（26h 内）= ok", () => {
    const r = deriveWorkerState(
      { lease: null, lastRun: { job: "usage-aggregation", createdAt: now - 3 * HOUR } },
      now,
    );
    assert.equal(r.state, "ok");
    assert.match(r.detail ?? "", /3 小时前/);
  });

  it("留痕过期 = idle 而不是 down——可选 cron 标红等于教人忽略红色", () => {
    const r = deriveWorkerState(
      { lease: null, lastRun: { job: "kb-sync", createdAt: now - 72 * HOUR } },
      now,
    );
    assert.equal(r.state, "idle");
    assert.match(r.hint ?? "", /dev:start worker/);
  });

  it("从未留痕 = idle，且说清是「表为空」不是「查询失败」", () => {
    const r = deriveWorkerState({ lease: null, lastRun: null }, now);
    assert.equal(r.state, "idle");
    assert.match(r.detail ?? "", /从未留痕/);
  });
});

describe("deriveWorkerHealthState", () => {
  const now = Date.now();

  it("端口通 + risks 空 = ok，detail 说清任务数与运行时长", () => {
    const r = deriveWorkerHealthState(
      { uptimeSec: 3 * 3600, jobs: [{ job: "kb-sync", cron: "20 * * * *" }], risks: [] },
      { lease: null, lastRun: { job: "kb-sync", createdAt: now - HOUR } },
      now,
    );
    assert.equal(r.state, "ok");
    assert.match(r.detail ?? "", /1 个任务在调度/);
    assert.match(r.detail ?? "", /已运行 3 小时/);
    assert.match(r.detail ?? "", /1 小时前/);
  });

  it("刚起来还没到点执行时如实说，不拿旧留痕冒充「刚跑过」", () => {
    const r = deriveWorkerHealthState(
      { uptimeSec: 30, jobs: [{ job: "kb-sync", cron: "20 * * * *" }], risks: [] },
      { lease: null, lastRun: null },
      now,
    );
    assert.equal(r.state, "ok");
    assert.match(r.detail ?? "", /尚未到点执行/);
  });

  it("risks 非空 = degraded，且第一条风险直接进 detail", () => {
    const r = deriveWorkerHealthState(
      { uptimeSec: 10, jobs: [], risks: ["没有任何任务挂上调度（进程活着但不会做事）"] },
      null,
      now,
    );
    assert.equal(r.state, "degraded");
    assert.match(r.detail ?? "", /不会做事/);
  });
});

describe("duration", () => {
  it("说的是「持续多久」而不是「多久以前」——ago 会把运行时长讲成「刚刚」", () => {
    assert.equal(duration(30_000), "30 秒");
    assert.equal(duration(10 * 60_000), "10 分钟");
    assert.equal(duration(3 * HOUR), "3 小时");
    assert.equal(duration(50 * HOUR), "2 天");
  });
});

describe("ago", () => {
  it("四个量级各有各的说法", () => {
    assert.equal(ago(30_000), "刚刚");
    assert.equal(ago(5 * 60_000), "5 分钟前");
    assert.equal(ago(3 * HOUR), "3 小时前");
    assert.equal(ago(50 * HOUR), "2 天前");
  });
});

describe("summarize", () => {
  it("五种状态分开数，不合并", () => {
    const svc = (state: ServiceReport["state"]): ServiceReport => ({
      id: "x",
      label: "x",
      group: "core",
      state,
    });
    const s = summarize([svc("ok"), svc("ok"), svc("down"), svc("idle"), svc("unknown")]);
    assert.deepEqual(s, { ok: 2, degraded: 0, down: 1, idle: 1, unknown: 1 });
  });
});

// ── 端点整体（express 装配 + 注入假依赖）────────────────────────

describe("GET /console/system/status", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    for (const k of [
      "MOCK_DEALER_URL",
      "MOCK_CABIN_URL",
      "REDIS_URL",
      "S3_ENDPOINT",
      "PORT",
      "ASR_ENGINE",
      "LOCAL_ASR_URL",
      "CARLIFE_HOST_SERVICES_HOST",
    ]) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  /** 全绿的假 fetch：runtime 报零风险，其余端点一律 200。 */
  const healthyFetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/internal/health/runtime")) {
      return new Response(
        JSON.stringify({
          health: { agentRuntime: "acp", llm: "real", tools: { mode: "real" } },
          risks: [],
          gaps: [],
        }),
        { status: 200 },
      );
    }
    if (url.includes(":8796/health")) {
      return new Response(
        JSON.stringify({
          holder: "host:1",
          uptimeSec: 600,
          jobs: [
            { job: "usage-aggregation", cron: "5 * * * *", consecutiveFailures: 0 },
            { job: "kb-sync", cron: "20 * * * *", consecutiveFailures: 0 },
          ],
          skipped: [],
          risks: [],
        }),
        { status: 200 },
      );
    }
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  /** 网络也脱网：不真去读这台机器的路由表（跑 CI 的机器长什么样不该影响断言）。 */
  const fakeNetwork: NonNullable<SystemStatusDeps["hostNetwork"]> = async () => ({
    scope: "host",
    lan: [{ iface: "en1", address: "192.168.50.67", prefix: 24, primary: true }],
    gateway: { address: "192.168.50.1", iface: "en1" },
    tunnels: [],
  });

  const healthyDb: NonNullable<SystemStatusDeps["db"]> = {
    workerEvidence: async () => ({ lease: { job: "memory-decay", holder: "t" }, lastRun: null }),
    ping: async () => 3,
  };

  function appWith(
    role: "admin" | "ops" | null,
    overrides: Partial<SystemStatusDeps> = {},
  ): express.Express {
    const app = express();
    app.use((req, _res, next) => {
      if (role) (req as express.Request & { console?: unknown }).console = { subject: `t-${role}`, role };
      next();
    });
    app.use(
      createSystemStatusRouter({
        config: { runtimeValues: async () => new Map<string, string>() } as SystemStatusDeps["config"],
        runtimeUrl: "http://runtime.test",
        fetchImpl: healthyFetch,
        db: healthyDb,
        redisPing: async () => 1,
        hostNetwork: fakeNetwork,
        ...overrides,
      }),
    );
    return app;
  }

  async function get(app: express.Express): Promise<{ status: number; body: SystemStatusSnapshot }> {
    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/console/system/status`);
      return { status: r.status, body: (await r.json()) as SystemStatusSnapshot };
    } finally {
      server.close();
    }
  }

  const byId = (snap: SystemStatusSnapshot, id: string): ServiceReport => {
    const s = snap.services.find((x) => x.id === id);
    assert.ok(s, `缺服务卡片：${id}`);
    return s;
  };

  it("匿名 401；ops 可读（运维大屏不是 admin 独有）", async () => {
    assert.equal((await get(appWith(null))).status, 401);
    assert.equal((await get(appWith("ops"))).status, 200);
  });

  it("全绿时：核心/模拟/前端/基础设施 ok，客户端窗口 unknown，redis/minio 未配置是 idle", async () => {
    const { status, body } = await get(appWith("admin"));
    assert.equal(status, 200);

    for (const id of ["gateway", "runtime", "mock-dealer", "mock-cabin", "mock-tts", "cockpit", "mobile", "web", "postgres", "worker"]) {
      assert.equal(byId(body, id).state, "ok", `${id} 应为 ok`);
    }
    // 无 HTTP 通道的桌面窗口不猜死活
    assert.equal(byId(body, "cockpit-app").state, "unknown");
    assert.equal(byId(body, "mobile-app").state, "unknown");
    // 未配置的可选基础设施是灰不是红
    assert.equal(byId(body, "local-asr").state, "idle");
    assert.equal(byId(body, "redis").state, "idle");
    assert.equal(byId(body, "minio").state, "idle");
    assert.equal(body.summary.down, 0);
    // runtime 卡片要转述运行形态——大屏第一眼就该看到是不是 fake
    assert.match(byId(body, "runtime").detail ?? "", /acp.*real/);
  });

  it("卡片给的是「点开能看到东西」的地址：mock 给 /health 不给根（根是 404），PG/Redis 不给链接", async () => {
    const { body } = await get(appWith("admin"));
    assert.equal(byId(body, "mock-dealer").url, "http://localhost:8792/health");
    assert.equal(byId(body, "runtime").url, "http://runtime.test/internal/health/runtime");
    assert.equal(byId(body, "gateway").url, "http://localhost:8790/healthz");
    assert.equal(byId(body, "web").url, "http://localhost:5173/");
    // 非 HTTP 与无通道的服务不硬造链接——点开必然失败的链接比没有更糟
    assert.equal(byId(body, "postgres").url, undefined);
    assert.equal(byId(body, "redis").url, undefined);
    assert.equal(byId(body, "cockpit-app").url, undefined);
    // 地址本身写全，别再是裸端口——这一行是给人抄走/点开的
    assert.equal(byId(body, "gateway").endpoint, "http://localhost:8790");
    assert.equal(byId(body, "cockpit").endpoint, "http://localhost:1430");
  });

  it("快照带本机网络：局域网地址与默认网关，且不进 summary（读不到网关不是故障）", async () => {
    const { body } = await get(appWith("admin"));
    assert.equal(body.network.lan[0].address, "192.168.50.67");
    assert.equal(body.network.gateway?.address, "192.168.50.1");
    assert.equal(body.services.some((s) => s.id === "network"), false);
  });

  it("路由表读失败不带塌整页，也不染红横幅", async () => {
    const { status, body } = await get(
      appWith("admin", {
        hostNetwork: async () => ({ scope: "host", lan: [], tunnels: [], error: "spawn netstat ENOENT" }),
      }),
    );
    assert.equal(status, 200);
    assert.equal(body.summary.down, 0);
    assert.match(body.network.error ?? "", /ENOENT/);
  });

  it("容器 Gateway 从 host.docker.internal 探测宿主 TTS 与 Vite", async () => {
    process.env.CARLIFE_HOST_SERVICES_HOST = "host.docker.internal";
    const seen: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      seen.push(String(input));
      return healthyFetch(input);
    }) as typeof fetch;

    await get(appWith("admin", { fetchImpl }));
    assert.ok(seen.includes("http://host.docker.internal:8794/health"));
    assert.ok(seen.includes("http://host.docker.internal:1430/"));
    assert.ok(seen.includes("http://host.docker.internal:1420/"));
    assert.ok(seen.includes("http://host.docker.internal:5173/"));
  });

  it("runtime 自报风险 = degraded 而不是 ok——响应了也未必健康", async () => {
    const riskyFetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/internal/health/runtime")) {
        return new Response(
          JSON.stringify({
            health: { agentRuntime: "direct", llm: "fake", tools: { mode: "mock" } },
            risks: ["运行在 direct 形态", "工具处于 mock 模式"],
          }),
          { status: 200 },
        );
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { body } = await get(appWith("admin", { fetchImpl: riskyFetch }));
    const runtime = byId(body, "runtime");
    assert.equal(runtime.state, "degraded");
    assert.match(runtime.detail ?? "", /2 条风险/);
    assert.equal(body.summary.degraded, 1);
  });

  it("单个探针炸掉不带塌整页：dealer 联不上 = down 带处置指引，其余照常", async () => {
    const partialFetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes(":8792")) throw new Error("ECONNREFUSED");
      return healthyFetch(url);
    }) as typeof fetch;

    const { status, body } = await get(appWith("admin", { fetchImpl: partialFetch }));
    assert.equal(status, 200);
    const dealer = byId(body, "mock-dealer");
    assert.equal(dealer.state, "down");
    assert.match(dealer.hint ?? "", /dev:restart mock-dealer/);
    assert.equal(byId(body, "runtime").state, "ok");
    assert.equal(body.summary.down, 1);
  });

  it("worker 探活端点通 = ok，且卡片说清「几个任务在调度」——这正是留痕答不出的那半", async () => {
    const { body } = await get(appWith("admin"));
    const w = byId(body, "worker");
    assert.equal(w.state, "ok");
    assert.match(w.detail ?? "", /2 个任务在调度/);
    assert.match(w.detail ?? "", /已运行 10 分钟/);
  });

  it("端口不通但留痕新鲜 = idle 而不是 ok——留痕只能证明「跑过」，证明不了「还在」", async () => {
    const noWorker = (async (input: unknown) => {
      const url = String(input);
      if (url.includes(":8796")) throw new Error("ECONNREFUSED");
      return healthyFetch(url);
    }) as typeof fetch;

    const { body } = await get(
      appWith("admin", {
        fetchImpl: noWorker,
        db: {
          workerEvidence: async () => ({
            lease: null,
            lastRun: { job: "kb-sync", createdAt: Date.now() - HOUR },
          }),
          ping: async () => 3,
        },
      }),
    );
    const w = byId(body, "worker");
    assert.equal(w.state, "idle");
    assert.match(w.detail ?? "", /探活端点未应答/);
    assert.match(w.hint ?? "", /dev:start worker/);
    // 点名才起的 cron 不许染红（纪律 1）
    assert.equal(body.summary.down, 0);
  });

  it("端口通但自报 risks = degraded——响应了也未必健康，与 runtime 同一判据", async () => {
    const riskyWorker = (async (input: unknown) => {
      const url = String(input);
      if (url.includes(":8796/health")) {
        return new Response(
          JSON.stringify({
            uptimeSec: 30,
            jobs: [{ job: "kb-sync", cron: "20 * * * *", consecutiveFailures: 5 }],
            skipped: ["usage-aggregation（Mem0 连不上）"],
            risks: ["kb-sync 连续失败 5 次：RAGFLOW 401", "未挂上调度：usage-aggregation（Mem0 连不上）"],
          }),
          { status: 200 },
        );
      }
      return healthyFetch(url);
    }) as typeof fetch;

    const { body } = await get(appWith("admin", { fetchImpl: riskyWorker }));
    const w = byId(body, "worker");
    assert.equal(w.state, "degraded");
    assert.match(w.detail ?? "", /2 条风险/);
    assert.match(w.detail ?? "", /RAGFLOW 401/);
  });

  it("配置了 REDIS_URL 但 PING 失败 = down；PG 挂掉时 worker 标 unknown 不重复染红", async () => {
    process.env.REDIS_URL = "redis://localhost:56379";
    const { body } = await get(
      appWith("admin", {
        redisPing: async () => {
          throw new Error("connect refused");
        },
        db: {
          workerEvidence: async () => {
            throw new Error("PG down");
          },
          ping: async () => {
            throw new Error("PG down");
          },
        },
      }),
    );
    assert.equal(byId(body, "redis").state, "down");
    assert.equal(byId(body, "postgres").state, "down");
    assert.match(byId(body, "postgres").hint ?? "", /docker compose/);
    // PG 挂了但探活端口还通：worker 进程确实活着，这一点不该被 PG 的故障拖成灰
    assert.equal(byId(body, "worker").state, "ok");
  });

  it("端口与 PG 双双不可达 = unknown，不猜死活也不重复染红", async () => {
    const nothing = (async (input: unknown) => {
      const url = String(input);
      if (url.includes(":8796")) throw new Error("ECONNREFUSED");
      return healthyFetch(url);
    }) as typeof fetch;

    const { body } = await get(
      appWith("admin", {
        fetchImpl: nothing,
        db: {
          workerEvidence: async () => {
            throw new Error("PG down");
          },
          ping: async () => {
            throw new Error("PG down");
          },
        },
      }),
    );
    assert.equal(byId(body, "worker").state, "unknown");
    assert.match(byId(body, "worker").detail ?? "", /留痕也查不到/);
  });
  /*
   * 今日云用量（ACR-016）。这块的存在理由是"闸门要看得见"——三条断言分别守：
   * 不注入时整块不出现（老部署不受影响）、注入时如实透出、读用量失败不拖垮整页
   * （它是观测面，不是判定面；为了显示用量而让状态页 500 是本末倒置）。
   */
  it("注入用量快照时如实透出今日用量与上界", async () => {
    const { body } = await get(
      appWith("admin", {
        quota: async () => ({
          asr: { used: 42, limit: 100 },
          tts: { used: 8000, limit: 0 },
        }),
      }),
    );
    assert.deepEqual(body.quota, {
      asr: { used: 42, limit: 100 },
      tts: { used: 8000, limit: 0 },
    });
  });

  it("不注入用量快照时整块不出现——老部署行为不变", async () => {
    const { body } = await get(appWith("admin"));
    assert.equal(body.quota, undefined);
  });

  it("读用量失败不拖垮整页：quota 缺席，services 照常", async () => {
    const { status, body } = await get(
      appWith("admin", {
        quota: async () => {
          throw new Error("redis down");
        },
      }),
    );
    assert.equal(status, 200);
    assert.equal(body.quota, undefined);
    assert.ok(body.services.length > 0, "用量读不到不该影响服务探活");
  });
});
