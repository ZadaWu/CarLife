/**
 * 切档前后的前缀缓存对照（施工单 M84-05，ACR-036 §4.9）。
 *
 * # 为什么不能直接比历史数据
 *
 * M84-02 采的 30 天基线里，`*-voice` 的命中率只有 15%~21%——而那个数低的原因**不是**
 * 注入位置写错了，是**会话太短**：端上 30 分钟空闲就换会话，多数轮次是新线程的第一轮，
 * 前面根本没有可命中的前缀。拿它和切档后的数据直接比，比的是会话长度分布，不是注入位置。
 *
 * 所以这里跑**受控的多轮会话**：同一个账号、同一段话题、连续 N 轮，两档各跑一遍，
 * 只比这两组之间的差。历史基线只作旁证。
 *
 * # 判据
 *
 * `tasks` 档的 `*-voice` 命中率**不低于** `off` 档。注入多了一段锚定块（进 system）
 * 与一段本轮状态（进最后一条 user），前者进前缀、后者在尾部——按设计两者都不该打断缓存。
 * 真打断了，这里会看出来。
 *
 * 用法（根目录，先 `source .env`）：
 *   corepack pnpm --filter @carlife/db exec node --import tsx \
 *     ../../../scripts/dev/probe/context-cache-ab.mts off
 *   # 改 .env 的 CARLIFE_CONTEXT_LAYER 并 dev:restart runtime 之后
 *   corepack pnpm --filter @carlife/db exec node --import tsx \
 *     ../../../scripts/dev/probe/context-cache-ab.mts tasks
 */

import { getPrisma } from "@carlife/db";

const GATEWAY = process.env.CARLIFE_GATEWAY_URL ?? "http://127.0.0.1:8790";
const USERNAME = process.env.M84_USERNAME ?? "demo";
const PASSWORD = process.env.CARLIFE_DEV_PASSWORD ?? "carlife-dev";
const LABEL = process.argv[2] ?? "unlabeled";
const TURN_TIMEOUT_MS = Number(process.env.M84_TURN_TIMEOUT_MS ?? 240_000);

/**
 * 五轮话。**刻意都是用车 / 售后那一侧的短问答**——不走 fan-out：
 * 行程那条每轮要跑四条分支，一轮一分多钟，跑十轮太贵，而且分支的 token 会把
 * 表述那一跳的比例冲淡。这里要量的是**同一条会话里前缀命不命中**，短问答足够。
 */
const TURNS = [
  "我这车的胎压正常范围是多少",
  "那胎压低了会怎么样",
  "冬天要不要调高一点",
  "多久该检查一次",
  "刚才说的那个范围，再说一遍",
];

async function login(): Promise<string> {
  const r = await fetch(`${GATEWAY}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`登录失败 ${r.status}`);
  return ((await r.json()) as { accessToken: string }).accessToken;
}

const TOKEN = await login();
const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

async function api(path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`${GATEWAY}${path}`, { ...init, headers: { ...H, ...(init?.headers ?? {}) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} → ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

const sessionId = (await api("/v1/session", { method: "POST", body: JSON.stringify({}) })).sessionId;
const startedAt = new Date();
console.log(`[cache-ab ${LABEL}] 会话 ${sessionId}，${TURNS.length} 轮，起点 ${startedAt.toISOString()}`);

/** 一轮：开流 → 发话 → 等 turn_end。**同一条会话连着发**，前缀才有得命中。 */
for (const [i, content] of TURNS.entries()) {
  let done = false;
  const sse = fetch(`${GATEWAY}/v1/session/${sessionId}/stream`, {
    headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" },
  }).then(async (r) => {
    if (!r.ok || !r.body) return;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (!done) {
      const { value, done: fin } = await reader.read();
      if (fin) break;
      buf += dec.decode(value, { stream: true });
      let j: number;
      while ((j = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, j);
        buf = buf.slice(j + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let payload: any;
        try {
          payload = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        const ev = payload.event ?? payload;
        const t = ev.kind ?? ev.type ?? "?";
        if (t === "turn_end" || t === "done") done = true;
      }
    }
  });
  await new Promise((r) => setTimeout(r, 300));
  await api(`/v1/session/${sessionId}/messages`, { method: "POST", body: JSON.stringify({ content }) });
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
  done = true;
  await sse.catch(() => {});
  console.log(`  第 ${i + 1} 轮完`);
}

// 统计这一段时间窗里的用量。只看**带缓存数据**的那些（pi 那条是估算，两列恒 0）。
const prisma = getPrisma();
const rows = await prisma.llmUsage.findMany({
  where: { at: { gte: startedAt }, status: "ok" },
  select: { agent: true, provider: true, cacheHitTokens: true, cacheMissTokens: true, promptTokens: true },
});
const groups = new Map<string, { n: number; hit: number; miss: number; prompt: number }>();
for (const r of rows) {
  if (r.cacheHitTokens + r.cacheMissTokens === 0) continue;
  const g = groups.get(r.agent) ?? { n: 0, hit: 0, miss: 0, prompt: 0 };
  g.n += 1;
  g.hit += r.cacheHitTokens;
  g.miss += r.cacheMissTokens;
  g.prompt += r.promptTokens;
  groups.set(r.agent, g);
}
console.log(`\n[cache-ab ${LABEL}] 这一段共 ${rows.length} 条请求，其中 ${[...groups.values()].reduce((s, g) => s + g.n, 0)} 条带缓存数据`);
let hit = 0;
let miss = 0;
for (const [agent, g] of [...groups].sort((a, b) => b[1].n - a[1].n)) {
  hit += g.hit;
  miss += g.miss;
  const pct = g.hit + g.miss === 0 ? "n/a" : `${((g.hit / (g.hit + g.miss)) * 100).toFixed(1)}%`;
  console.log(`  ${agent.padEnd(22)} 请求 ${String(g.n).padStart(3)}  prompt ${String(g.prompt).padStart(7)}  命中 ${String(g.hit).padStart(7)}  未命中 ${String(g.miss).padStart(7)}  ${pct}`);
}
console.log(
  `  ${"合计".padEnd(22)} 命中率 ${hit + miss === 0 ? "n/a" : `${((hit / (hit + miss)) * 100).toFixed(1)}%`}（${hit} / ${hit + miss}）`,
);
await prisma.$disconnect();
