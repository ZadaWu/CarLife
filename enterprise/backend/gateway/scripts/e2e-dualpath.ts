/**
 * 双路检索端到端（施工单 M8-02 收口）。
 *
 * # 它证明的是"有数据流过"，不是"函数写对了"
 *
 * 单测已经覆盖合成逻辑与接线，但那些都可以在**没有任何真实数据**的情况下全绿——
 * 这正是 M7 台账记下的教训：`aggregate()` 的测试当然会过，它本来就不需要数据库，
 * 于是"根本没有数据源"被绿灯掩盖了半个 Sprint。
 *
 * 所以本脚本走真实链路：**往 PG 写真实行程 → 经网关提问 → 断言回答里出现
 * 由那些行程算出来的数字**。这个数字不可能被模型编出来——它来自我们刚写进去的流水。
 *
 * 用 fake 模型：验的是数据通路，不是模型表达能力。掺进真模型只会让失败原因不唯一。
 *
 * 运行（根目录，需 PG）：
 *   corepack pnpm e2e:dualpath
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

// PrismaClient 经 @carlife/db 再导出：本脚本从仓库根跑，@prisma/client 不在根的解析路径上。
import { assertPortsFree, shutdownSpawned } from "./lib/ports";
import { ensureDevCredentials, login } from "./lib/login";
import { PrismaClient, resolveTestDatabaseUrl } from "@carlife/db";
import type { EventEnvelope } from "@carlife/shared";

const GATEWAY = "http://localhost:18797";
// M48-02：demo-token 万能钥匙已删除，改为跑前登录换 token（见 lib/login.ts）。
let TOKEN = "";
/** 与 gateway 的 auth 中间件同值——真实链路上的 userId 就是它。 */
const DEMO_USER = "demo-user";

function loadDotEnv(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(
      new URL("../../../../.env", import.meta.url),
      "utf8",
    ).split("\n")) {
      const m = /^([A-Z0-9_]+)="?([^"]*)"?$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

const DATABASE_URL = resolveTestDatabaseUrl();
const RAG_STUB_PORT = 18799;

/**
 * 本地 RAGFlow 桩。
 *
 * 为什么不用 `CARLIFE_TOOLS=mock`：那个开关对**所有**工具生效，
 * `usage_profile` 会一起走 mock，于是断言看到的是内置假数据而不是刚写进 PG 的流水
 * ——脚本会全绿，却什么都没证明。第一版就是这么写的，被 37 vs 38.6 这个差值抓了出来。
 *
 * 用桩服务则两路都走 real 代码路径：RAGFlow 客户端的 HTTP 解析、出处过滤、
 * 数据集隔离检查全都真跑，只是对端是本地进程。
 */
function startRagStub(): Server {
  return createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      // 车型限定（F-23-07）在检索前会先 GET …/documents 列文档、按车型过滤，
      // **匹配不到就抛、刻意不退回全库**。桩若只应答检索接口，这条路在
      // "没配真实 RAGFlow 的机器"上必挂——而那正是桩存在的理由。
      // 所以两个接口都答，且文档名必须能被 documentMatchesModel 认出是这辆车的。
      if (req.method === "GET" && (req.url ?? "").includes("/documents")) {
        res.end(
          JSON.stringify({
            data: {
              docs: [
                {
                  id: "stub-doc-1",
                  name: `${DEMO_MODEL} 用户手册.md`,
                  run: "DONE",
                  chunk_num: 1,
                },
              ],
            },
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          data: {
            chunks: [
              {
                content:
                  "锂离子电池在低温下内阻升高、可用容量下降，续航表现通常低于常温工况。",
                document_keyword: `${DEMO_MODEL} 用户手册`,
                similarity: 0.91,
                positions: [12],
              },
            ],
          },
        }),
      );
    });
  }).listen(RAG_STUB_PORT);
}

/**
 * **有真 RAGFlow 就用真的，没有才起桩**。
 *
 * 两个理由：
 *  1. 同一条 e2e 在配了 RAGFlow 的机器上证明得更多——那时候两路都是真实数据；
 *  2. 但它不能因为没配 RAGFlow 就跑不了（CI、别人的机器）。
 *
 * 关键是**跑完要说清楚刚才是哪种模式**。一条"9 passed"看不出两路是不是都真，
 * 而那正是这个脚本唯一想证明的事。
 */
const DOTENV = loadDotEnv();
const REAL_RAG = Boolean(
  (process.env.RAGFLOW_BASE_URL ?? DOTENV.RAGFLOW_BASE_URL) &&
  (process.env.RAGFLOW_API_KEY ?? DOTENV.RAGFLOW_API_KEY),
);

const ENV = {
  // M48-02：JWT 签名密钥没有默认值（默认密钥等于没有鉴权），端到端也必须显式给。
  CARLIFE_JWT_SECRET: "e2e-jwt-secret-0123456789abcdef",
  ...process.env,
  ...DOTENV,
  CARLIFE_LLM: "fake",
  ASR_ENGINE: "fake",
  CARLIFE_CHECKPOINTER: "pg",
  // **两路都走 real**：⑥读刚写进 PG 的流水，RAG 走本地桩。
  CARLIFE_TOOLS: "real",
  // 真配置在 DOTENV 里，这里只在**没有**真配置时才覆盖成桩。
  ...(REAL_RAG
    ? {}
    : {
        RAGFLOW_BASE_URL: `http://localhost:${RAG_STUB_PORT}`,
        RAGFLOW_API_KEY: "stub-key",
        RAGFLOW_DATASET_VEHICLE_MANUALS: "stub-dataset",
      }),
  DATABASE_URL,
  GATEWAY_PORT: "18797",
  AGENT_RUNTIME_PORT: "18798",
  AGENT_RUNTIME_URL: "http://localhost:18798",
};

const authed = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
});

const checks: Array<[boolean, string]> = [];
const check = (ok: boolean, label: string) => {
  checks.push([ok, label]);
  console.log(`${ok ? "✓" : "✗"} ${label}`);
};

let lastEventId: string | null = null;

async function turn(sessionId: string, content: string): Promise<string> {
  const controller = new AbortController();
  const url = new URL(`${GATEWAY}/v1/session/${sessionId}/stream`);
  if (lastEventId) url.searchParams.set("lastEventId", lastEventId);
  const streamRes = await fetch(url, authed({ signal: controller.signal }));

  let text = "";
  const collector = (async () => {
    let buffer = "";
    for await (const chunk of streamRes.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += Buffer.from(chunk).toString("utf8");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        const env = JSON.parse(dataLine.slice(6)) as EventEnvelope;
        lastEventId = env.eventId;
        const ev = env.event;
        if (ev.type === "update" && ev.kind === "delta") text += ev.text;
        if (ev.type === "update" && ev.kind === "turn_end") {
          controller.abort();
          return text;
        }
      }
    }
    return text;
  })().catch((e: Error) => {
    if (e.name === "AbortError") return text;
    throw e;
  });

  await fetch(
    `${GATEWAY}/v1/session/${sessionId}/messages`,
    authed({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    }),
  );
  return collector;
}

const DAY = 86_400_000;
/** 刻意用一个不像默认值的数：它出现在回答里就只能来自我们写的流水。 */
const DAILY_KM = 37;
const TRIPS = 20;

async function seedTrips(prisma: PrismaClient, now: number): Promise<void> {
  await prisma.trip.deleteMany({ where: { userId: DEMO_USER } });
  const rows = Array.from({ length: TRIPS }, (_, i) => {
    const endedAt = new Date(now - (i + 1) * DAY + 3_600_000);
    const cold = i % 2 === 0;
    return {
      id: `e2e-dualpath-${i}`,
      userId: DEMO_USER,
      startedAt: new Date(now - (i + 1) * DAY),
      endedAt,
      // 30 天窗口里放 20 条、每条 DAILY_KM * 30 / 20 —— 让日均正好是 DAILY_KM。
      distanceKm: (DAILY_KM * 30) / TRIPS,
      ambientTempC: cold ? 2 : 22,
      observedRangeKm: cold ? 255 : 405,
    };
  });
  await prisma.trip.createMany({ data: rows });
}

/**
 * 建一份车辆档案。**车型限定要靠它**（F-23-07）：
 * 知识库里同时有迈锐宝与三款特斯拉，没有档案就不知道该限定到哪一款，
 * 检索会跨车型返回并带着出处。
 */
const DEMO_VIN = "5YJ3E1EA7JF000001"; // 17 位，不含 I/O/Q
const DEMO_MODEL = "Model 3";

async function seedVehicle(prisma: PrismaClient): Promise<void> {
  await prisma.vehicle.deleteMany({ where: { ownerId: DEMO_USER } });
  await prisma.vehicle.create({
    data: {
      vin: DEMO_VIN,
      ownerId: DEMO_USER,
      model: DEMO_MODEL,
      modelYear: 2024,
      purchasedAt: new Date("2024-03-01"),
      odometerKm: 18_000,
      maintenanceIntervalKm: 20_000,
      isDefault: true,
    },
  });
}

async function main(): Promise<void> {
  // spawn 之前先探端口（M46-01）：不检查的话，端口被占时本轮进程起不来，
  // 请求却会落到上一轮残留的进程上，报出看起来像业务故障的假错误。
  await assertPortsFree([
    [Number(ENV.GATEWAY_PORT), "gateway"],
    [Number(ENV.AGENT_RUNTIME_PORT), "agent-runtime"],
  ]);

  const prisma = new PrismaClient({
    datasources: { db: { url: DATABASE_URL } },
  });
  const now = Date.now();
  await seedTrips(prisma, now);
  await seedVehicle(prisma);
  console.log(`  已建车辆档案（${DEMO_MODEL}，VIN ${DEMO_VIN}）——车型限定靠它`);
  console.log(
    `  已写入 ${TRIPS} 条真实行程（user=${DEMO_USER}，日均应为 ${DAILY_KM}km）\n`,
  );

  console.log(
    REAL_RAG
      ? "  RAG 那一路：**真实 RAGFlow**（两路都是真数据）"
      : "  RAG 那一路：本地桩（未配 RAGFLOW_*，⑥仍是真实数据）",
  );
  const ragStub = REAL_RAG ? null : startRagStub();
  const runtime = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: new URL("../../agent-runtime/", import.meta.url).pathname,
    env: ENV,
    stdio: ["ignore", "inherit", "inherit"],
    detached: true, // 杀得掉整组（M46-02）：npx 壳→tsx→node 三层，kill 只打到壳
  });
  const gateway = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: new URL("../", import.meta.url).pathname,
    env: ENV,
    stdio: ["ignore", "inherit", "inherit"],
    detached: true, // 杀得掉整组（M46-02）：npx 壳→tsx→node 三层，kill 只打到壳
  });

  try {
    for (let i = 0; i < 60; i++) {
      if (await fetch(`${GATEWAY}/healthz`).catch(() => null)) break;
      await sleep(500);
    }
    await sleep(2000);

    // M48-02：先把测试库的开发账号解锁，再登录换 token（demo-token 已删除）。
    await ensureDevCredentials(ENV.DATABASE_URL);
    TOKEN = (await login(GATEWAY)).accessToken;

    const { sessionId } = (await (
      await fetch(`${GATEWAY}/v1/session`, authed({ method: "POST" }))
    ).json()) as { sessionId: string };

    const reply = await turn(sessionId, "我这辆车冬天续航掉得厉害，正常吗？");
    console.log(`\n[回复] ${reply}\n`);

    check(reply.length > 0, "用车类提问有回复");
    // 桩固定返回"车辆使用说明书"；真实 RAGFlow 返回的是实际文档名。
    // 所以断言的是**有出处**这件事，而不是某个具体书名——
    // 写死书名会让这条断言在接上真库后失效，而失效的方式是"红得莫名其妙"。
    check(
      /出处：\S+/.test(reply),
      `RAG 那一路带回了出处（不是模型编的）${REAL_RAG ? "，来自真实知识库" : ""}`,
    );
    if (REAL_RAG) {
      // **出处必须是这一款车的**。知识库里同时有迈锐宝与三款特斯拉，
      // 不限定的话 Model 3 车主会拿到迈锐宝手册的片段且带着出处——
      // 有引用只会让这个错误显得更可信。
      check(
        reply.includes("Model3") || reply.includes("Model 3"),
        "出处来自 Model 3 自己的手册（车型限定生效，F-23-07）",
      );
      check(
        !reply.includes("迈锐宝"),
        "**没有混进别的车型**——这是车型限定存在的全部理由",
      );
      check(
        !reply.includes("可能不是你这一款车"),
        "有车辆档案时不该出现「引用的可能不是你这款车」的免责",
      );
    }

    // Fake 模型会把注入的上下文原样带出来——**这正是本脚本需要的**：
    // 它让"编排层给了什么"变成可断言的，而不依赖模型的表达。
    check(
      reply.includes("这辆车的真实数据"),
      "**⑥那一路真的进了上下文**——不是只查了 RAG",
    );
    check(
      reply.includes(`${DAILY_KM}.0km`) || reply.includes(`${DAILY_KM}km`),
      `日均里程 ${DAILY_KM}km 出现在上下文里——这个数只能来自刚写入的 ${TRIPS} 条流水`,
    );
    check(
      reply.includes("255") && reply.includes("低温实测续航"),
      "低温实测续航被单独列出（§6 示例靠这组对比说话）",
    );
    check(
      reply.includes("请把通用原理与这辆车的实际数据"),
      "**两路齐备 → personalized**：措辞分支走的是结合作答，不是通用说明",
    );
    check(
      !reply.includes("不要暗示这是针对这辆车的结论"),
      "没有误落到降级话术",
    );

    // ── 反向验证：换一个没有数据的用户，必须降级而不是编 ──────────
    await prisma.trip.deleteMany({ where: { userId: DEMO_USER } });
    const { sessionId: s2 } = (await (
      await fetch(`${GATEWAY}/v1/session`, authed({ method: "POST" }))
    ).json()) as { sessionId: string };
    // **换会话必须重置**：lastEventId 是会话内的断点续传游标，
    // 拿上一个会话的游标去续新会话的流，事件会收不全（第一次写这个脚本就踩了）。
    lastEventId = null;
    const reply2 = await turn(s2, "我这辆车冬天续航掉得厉害，正常吗？");
    console.log(`\n[无数据用户的回复] ${reply2}\n`);
    check(
      reply2.includes("不要暗示这是针对这辆车的结论"),
      "**没有用车数据时明确降级**——宁可说通用，不拿不足的数据冒充个性化",
    );
    // 断言 ⑥**特有的标记**，不是裸数字。
    // 原来写的是 `!reply2.includes("37")`——桩时代成立（内容固定可控），
    // 接上真实手册后就站不住了：页码、参数、温度里随便一个都可能含 37。
    // 一条因为"真数据进来了"而变红的断言，红的是断言不是功能。
    check(
      !reply2.includes("这辆车的真实数据") && !reply2.includes("日均里程"),
      "降级后⑥那一路的数据块整个消失（不是靠裸数字判断）",
    );
  } finally {
    await shutdownSpawned(
      [runtime, gateway],
      [Number(ENV.GATEWAY_PORT), Number(ENV.AGENT_RUNTIME_PORT)],
    );
    ragStub?.close();
    await prisma.trip
      .deleteMany({ where: { userId: DEMO_USER } })
      .catch(() => undefined);
    await prisma.vehicle
      .deleteMany({ where: { ownerId: DEMO_USER } })
      .catch(() => undefined);
    await prisma.$disconnect();
  }

  const failed = checks.filter(([ok]) => !ok).length;
  console.log(
    `\n双路端到端：${checks.length - failed} passed, ${failed} failed` +
      `（RAG 那一路：${REAL_RAG ? "真实 RAGFlow" : "本地桩"}）`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();
