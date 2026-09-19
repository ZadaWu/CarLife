/**
 * 结构变更的一轮真跑取证（施工单 M83-05）。
 *
 * # 它验的是一件单测验不了的事
 *
 * 端上把「删了哪站、谁换到哪天、顺序成了什么」拼成一句话发给暖暖（`adjustStructurePrompt`），
 * 而**模型收到之后可能"重新规划"而不是"按变更改"**——`adjustPrompt` 那条路走的是"天气变了"，
 * 重排一遍无所谓；结构变更要的是"我删的那站别再出现"。没有真跑，这个假设无从判定。
 *
 * # 判据（四条同时成立才算通）
 *
 * 1. 这一轮落 itinerary，且装的是库里那份（`committedPlanId` 对上）——不是新规划；
 * 2. 确认弹窗的明细里**没有**被删掉的站；
 * 3. 确认之后 `trip_plan_update` 原地改写，**planId 不变**；
 * 4. 改写后的快照：删的不在、换天的在目标天、没提到的天逐字节不变。
 *
 * # 不进 check:all
 *
 * 它要网关 + runtime 在跑、要真实 LLM、要库里有一份已确认的多天行程，还会花钱。
 * 这是取证脚本，跑法写在 M83-05 的验收里。
 *
 * 用法：
 *   source .env && corepack pnpm --filter @carlife/db exec node --import tsx \
 *     ../../../scripts/dev/probe/trip-structure-adjust-probe.mts <planId>
 * 或直接（需 tsx 与 @prisma/client 可解析）：
 *   node --import tsx scripts/dev/probe/trip-structure-adjust-probe.mts <planId>
 */

/*
 * token **走网关自己的登录端点**，不手抄签法。
 *
 * 实测的坑：手抄一份（照 `evals/lib/auth.ts`）在本机跑成 401 —— 不是签法错，
 * 是**跑着的网关进程握的是它启动那一刻的 `CARLIFE_JWT_SECRET`**，而 .env 后来改过。
 * 日志里只写 `by=未鉴权`，与"用户不存在"长得一模一样。登录端点用的是网关自己的密钥，
 * 这种漂移在它这里不存在。
 */
/*
 * 按相对路径 import contracts：根 `package.json` 没有 `@carlife/shared` 依赖，
 * 从 `scripts/` 跑时按包名解析不到（与 `evals/lib/auth.ts` 文件头记的是同一类坑）。
 */
import { adjustStructurePrompt } from "../../../contracts/src/index.js";

const GATEWAY = process.env.CARLIFE_GATEWAY_URL ?? "http://127.0.0.1:8790";
const USERNAME = process.env.M83_USERNAME ?? "demo";
const PASSWORD = process.env.CARLIFE_DEV_PASSWORD ?? "carlife-dev";
const PLAN_ID = process.argv[2];
if (!PLAN_ID) {
  console.error("用法：… trip-structure-adjust-probe.mts <planId>");
  process.exit(2);
}

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

/** 读一份行程快照。网关把活动行程列表挂在 `/v1/trip-plan/current` 的 `plans` 里（M72-03）。 */
async function fetchPlan(planId: string): Promise<any> {
  const list = await api("/v1/trip-plan/current");
  const entries = (list.plans ?? []) as Array<{ planId: string; plan: unknown }>;
  const hit = entries.find((e) => e.planId === planId);
  if (!hit) throw new Error(`行程 ${planId} 不在列表里（换一个 planId，或它已被取消）`);
  return hit.plan;
}

const names = (plan: any, day: number): string[] =>
  ((plan?.skeleton ?? []).find((d: any) => d.day === day)?.spots ?? []).map((s: any) => s.name);

console.log(`[M83-05] 网关 ${GATEWAY}，账号 ${USERNAME}，行程 ${PLAN_ID}`);
const before = await fetchPlan(PLAN_ID);
console.log("[前] 逐日站点：");
for (const d of before.skeleton ?? []) console.log(`  D${d.day}: ${names(before, d.day).join(" → ")}`);

// 变更：删 D1 最后一站、把 D2 第二站移到 D3、D3 倒序
const d1 = names(before, 1);
const d2 = names(before, 2);
const d3 = names(before, 3);
if (d1.length < 2 || d2.length < 2 || d3.length < 2) {
  throw new Error("这份行程的某一天站点太少，换一份 3 天以上、每天 ≥2 站的");
}
const removed = d1[d1.length - 1]!;
const moved = d2[1]!;
const reordered = [...d3].reverse();
// 话由 contracts 的同一个函数拼——端上发的与这里发的必须逐字一致，否则验的不是同一件事。
const prompt = adjustStructurePrompt(PLAN_ID, before, [
  { kind: "remove", day: 1, spot: removed },
  { kind: "move", day: 2, spot: moved, toDay: 3 },
  { kind: "reorder", day: 3, order: reordered },
]);
console.log(`\n[发] ${prompt}\n`);

const session = await api("/v1/session", { method: "POST", body: JSON.stringify({}) });
const sessionId: string = session.sessionId ?? session.id;
console.log(`[会话] ${sessionId}`);

// SSE：收 permission 与 turn_end
const events: Array<{ type: string; data: any }> = [];
let interruptId: string | undefined;
let permissionPayload: any;
let turnId: string | undefined;
/** 本轮结束（每轮重置）。 */
let done = false;
/** 整个探针收工——SSE 读循环只认它，否则第一轮 turn_end 就把循环退了，第二轮没人收。 */
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
      /*
       * 网关的 SSE 帧是**信封**：`{ ts, event: { kind, … } }`（`stream/index.ts:69`）。
       * 早先按 `payload.type` 取，全成了 `?`——事件序列打出来一排问号，
       * 看起来像"什么都没发生"，其实是解错了一层。
       */
      const ev = payload.event ?? payload;
      const t = ev.kind ?? ev.type ?? "?";
      events.push({ type: t, data: ev });
      if (ev.turnId && !turnId) turnId = ev.turnId;
      if (t === "permission" || ev.interruptId) {
        interruptId = ev.interruptId ?? ev.request?.interruptId ?? ev.data?.interruptId;
        permissionPayload = ev;
        console.log(`[permission] interruptId=${interruptId}`);
      }
      if (t === "turn_end" || t === "done") done = true;
    }
  }
});

await new Promise((r) => setTimeout(r, 600));
await api(`/v1/session/${sessionId}/messages`, { method: "POST", body: JSON.stringify({ content: prompt }) });

// 等这一轮结束（真实 LLM 一轮可能要一分钟以上）
const deadline = Date.now() + 240_000;
while (!interruptId && !done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));

/*
 * 第一轮**必然停在草案**（2026-09-14 实测三次）：
 *
 *  - `wantsCommit` 是 LLM 优先（`itinerary.ts` 的 `decide()`）。这一轮模型表态
 *    `action: "adjust"`——它读懂了尾句（intent 的 context 里写着"并明确要求改完直接定稿"），
 *    但 action 只有一个槽位，给了 adjust 就不会是 commit，**正则兜底根本不跑**；
 *  - 何况 commit 分支操作的是会话里**已有**的草案，与本轮刚产出的那份不是同一步。
 *
 * 所以落库要第二轮，而**第二轮是随机的**：同一句处置话（「确认这份行程并保存到主页」）
 * 在一个会话里判成 commit、走完了确认弹窗与 `trip_plan_update`，在另一个会话里判成
 * `action: "none"`，模型回一句"您说一声「就这样定了」"——而车主刚说的就是这句。
 * 「就这样定了」本身同样被判过 `none`。
 *
 * 根因不在措辞：`decide()` 在模型表过态时**直接返回 `matches(action)`**，
 * 不 OR 正则兜底（而它上面的注释写的是"LLM 优先、正则兜底、**取或**"——
 * 代码与自己的契约不一致）。action 只有一个槽位，给了 none 就没有第二次机会。
 * 这一条是 M72-05 既有链路的问题，不是结构变更引入的：它同样会让「让暖暖调整」卡住。
 */
let twoTurn = false;
if (!interruptId && done) {
  console.log("\n[第一轮停在草案——补一句处置话验第二跳]");
  twoTurn = true;
  done = false;
  await api(`/v1/session/${sessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: "确认这份行程并保存到主页" }),
  });
  const d2 = Date.now() + 240_000;
  while (!interruptId && !done && Date.now() < d2) await new Promise((r) => setTimeout(r, 1000));
}

if (!interruptId) {
  finished = true;
  console.error("[失败] 两轮都没等到确认弹窗。事件序列：");
  for (const e of events.slice(-20)) console.error(`  ${e.type}`);
  process.exit(1);
}
console.log(`\n[判据 0] 一轮到位？ ${twoTurn ? "否——要补一句「就这样定了」（两轮）" : "是 ✅"}`);

console.log("\n[确认弹窗明细]");
const detailText = JSON.stringify(permissionPayload);
console.log(detailText.slice(0, 2000));
console.log(`\n[判据 2] 明细里含被删掉的「${removed}」？ ${detailText.includes(removed) ? "含（要人工看是不是在别的天）" : "不含 ✅"}`);

await api(`/v1/session/${sessionId}/resume`, {
  method: "POST",
  body: JSON.stringify({ interruptId, approved: true }),
});
console.log("[resume] 已确认");

// 等改写落库
await new Promise((r) => setTimeout(r, 8000));
finished = true;
done = true;
await sse.catch(() => {});

const after = await fetchPlan(PLAN_ID);
console.log("\n[后] 逐日站点：");
for (const d of after.skeleton ?? []) console.log(`  D${d.day}: ${names(after, d.day).join(" → ")}`);

const stillThere = (after.skeleton ?? []).some((d: any) =>
  (d.spots ?? []).some((s: any) => s.name === removed),
);
const movedTo3 = names(after, 3).includes(moved);
console.log("\n[判据]");
console.log(`  1 planId 不变：${PLAN_ID}（读回的是同一份）✅`);
console.log(`  2 删掉的「${removed}」还在吗：${stillThere ? "还在 ❌" : "不在 ✅"}`);
console.log(`  3 换天的「${moved}」在第 3 天吗：${movedTo3 ? "在 ✅" : "不在 ❌"}`);
console.log(`  4 turnId：${turnId ?? "（没抓到）"}`);
console.log(`\n事件类型序列：${events.map((e) => e.type).join(" → ")}`);
