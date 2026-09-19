/**
 * 能耗口径按轮注入的一轮真跑取证（turn-9386d1c2 的修复）。
 *
 * # 它验的是一件单测验不了的事
 *
 * 单测能证明 `loadVehicleEnergyFacts` 算得对、`energy_gap` 取得到注入的那份，
 * 但证明不了**编排层真的把它记进了这一轮**——写入端在 supervisor 的行程节点、
 * 读取端在 pi 那侧的工具调用，中间隔着 (sessionId, turnId) 这个键与一整条 ACP 往返。
 * 键对不上的表现不是报错，是工具照常返回、`demand` 缺席，和"这辆车没数据"长得一模一样。
 *
 * # 判据（三条同时成立才算通）
 *
 * 1. 这一轮 `energy_gap` 调用的入参里**没有 consumption**（schema 撤掉了，模型填不进来）；
 * 2. 返回的 `demand` 与「里程 × 注入口径 ÷ 100」对得上，且 `basis` 说得出样本量；
 * 3. 一次 `tool_invalid` 都没有——turn-9386d1c2 里那次失败重试不该再发生。
 *
 * # 不进 check:all
 *
 * 要网关 + runtime 在跑、要真实 LLM、要 demo 用户有一辆纯电车与够用的行程流水，还会花钱。
 *
 * 用法：
 *   source .env && corepack pnpm --filter @carlife/db exec node --import tsx \
 *     ../../../../scripts/dev/probe/energy-gap-injection-probe.mts
 */

const GATEWAY = process.env.CARLIFE_GATEWAY_URL ?? "http://127.0.0.1:8790";
const USERNAME = process.env.M83_USERNAME ?? "demo";
const PASSWORD = process.env.CARLIFE_DEV_PASSWORD ?? "carlife-dev";
/** 与 turn-9386d1c2 同一句话——验的是同一条路。 */
const PROMPT = process.argv[2] ?? "帮我订一下从上海到张家港的两日行程";

async function login(): Promise<string> {
  const r = await fetch(`${GATEWAY}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`登录失败 ${r.status}：账号 ${USERNAME}（口令看 CARLIFE_DEV_PASSWORD）`);
  return ((await r.json()) as { accessToken: string }).accessToken;
}

const TOKEN = await login();
const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

async function api(path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`${GATEWAY}${path}`, { ...init, headers: { ...H, ...(init?.headers ?? {}) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} → ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const session = await api("/v1/session", { method: "POST", body: JSON.stringify({}) });
const sessionId: string = session.sessionId ?? session.id;
console.log(`[会话] ${sessionId}`);

let turnId: string | undefined;
let done = false;
let finished = false;

const sse = fetch(`${GATEWAY}/v1/session/${sessionId}/stream`, {
  headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" },
}).then(async (r) => {
  if (!r.ok || !r.body) throw new Error(`stream ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (!finished) {
    const { value, done: fin } = await reader.read();
    if (fin) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      let payload: any;
      try {
        payload = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      // SSE 帧是信封：`{ ts, event: { kind, … } }`。
      const ev = payload.event ?? payload;
      if (ev.turnId && !turnId) turnId = ev.turnId;
      if ((ev.kind ?? ev.type) === "turn_end" || (ev.kind ?? ev.type) === "done") done = true;
    }
  }
});

await new Promise((r) => setTimeout(r, 600));
console.log(`[发] ${PROMPT}`);
await api(`/v1/session/${sessionId}/messages`, { method: "POST", body: JSON.stringify({ content: PROMPT }) });

const deadline = Date.now() + 300_000;
while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
finished = true;
await sse.catch(() => {});
console.log(`[轮次] ${turnId ?? "(没拿到 turnId)"}  ${done ? "已结束" : "超时"}`);

// ── 判据：查这一轮的 energy_gap 轨迹 ──────────────────────────────────────
const { getPrisma } = await import("../../../enterprise/backend/shared/db/src/index.js");
const prisma = getPrisma();
const rows: any[] = await prisma.$queryRawUnsafe(
  `select data from trace_events where turn_id = $1 and kind = 'tool_call' and data->>'name' = 'energy_gap' order by at`,
  turnId,
);
await prisma.$disconnect();

if (rows.length === 0) {
  console.error("\n✗ 这一轮没有 energy_gap 调用——换一句会触发续航评估的话，或检查 demo 车是不是纯电");
  process.exit(1);
}

let ok = true;
for (const [n, r] of rows.entries()) {
  const d = r.data ?? {};
  const input = JSON.parse(String(d.input ?? "{}"));
  const output = d.output ? JSON.parse(String(d.output)) : undefined;
  console.log(`\n[调用 ${n + 1}] status=${d.status}`);
  console.log(`  入参 ${JSON.stringify(input)}`);
  if (output?.data) {
    console.log(`  需求 ${output.data.demand}${output.data.unit ?? ""}  缺口 ${output.data.gap}  够=${output.data.sufficient}`);
    for (const b of output.data.basis ?? []) console.log(`    · ${b}`);
  }
  if ("consumption" in input) {
    console.error("  ✗ 入参里还有 consumption——schema 没撤干净");
    ok = false;
  }
  if (d.status !== "ok") {
    console.error(`  ✗ 调用失败：${d.status}`);
    ok = false;
  }
}
if (rows.length > 1) {
  console.error(`\n✗ 调了 ${rows.length} 次——注入之后不该再有失败重试`);
  ok = false;
}
console.log(ok ? "\n✓ 三条判据全过" : "\n✗ 有判据没过");
process.exit(ok ? 0 : 1);
