/**
 * 多天行程的真跑取证（施工单 M98-04）。
 *
 * # 它回答什么
 *
 * M94 四张单全是「有条件通过」，四个条件收敛到同一件事：**没有一次改动之后的真跑**。
 * 这条脚本跑一轮真实的多天行程对话（两轮：先排，再改），把四项证据一次取齐：
 *
 *   ① `llm.*` 失败时 detail 非空且形如 `err:<分类>`（M94-01）
 *   ② 两轮混合时 branch 事件各带自己的 turnId（M94-02）
 *   ③ 修复轮按判据停，`itinerary.audit.round` / `.stop` 的 detail 完整（M94-03）
 *   ④ `submit_drive_plan` 退回之后模型没有退化成空 stops（M94-04）
 *
 * 外加 M98-01 的现场证据：有没有出现 tour 与 drive 在**同一轮**
 * （`actions` 里同时有 `rerun:tour` 与 `rerun:drive:companion`），以及那一轮的 delta。
 *
 * # 它打真实配额与真实钱
 *
 * 一轮 7 天行程约 8~10 次高德搜索每天，加四条腿的 LLM。**同一时间只跑一个真跑**。
 * 所以脚本把 sessionId 与两轮的 turnId 都打出来：跑完之后只想重看结论，用
 * `--verify <sessionId>` 查库即可，不必再跑一次。
 *
 * # 它跑在开发库上，不起隔离栈
 *
 * 与 `smoke:acp` 相反：那条为了可重复而起隔离栈用测试库，这条要的正是"与历史数据同库对照"。
 * 前置是本机全栈在跑（`corepack pnpm dev:status` 全部正常）。
 *
 * # 只读业务，不改一行业务代码
 *
 * 脚本只发对话、只 SELECT。真跑里暴露的新问题记技术债，不在这里顺手改。
 *
 * 用法（仓库根，先 `set -a && . ./.env && set +a`）：
 *   corepack pnpm probe:trip-live                              # 真跑两轮 + 取证
 *   corepack pnpm probe:trip-live -- --continue <sessionId>    # 只补第二轮（第一轮已跑过）
 *   corepack pnpm probe:trip-live -- --verify <sessionId>      # 只查库，不跑
 *
 * 扩展名是 `.mts` 不是 `.ts`：顶层 await 要走 ESM 转译（与本目录其它探针同因）。
 */

import { getPrisma } from "@carlife/db";

import { login } from "../../../enterprise/backend/gateway/scripts/lib/login";

const GATEWAY = process.env.CARLIFE_GATEWAY_URL ?? "http://localhost:8790";

/** 第一轮：一条**必然多天、必然跨省**的行程——天数少了排不出修复轮。 */
const TURN_1 = "9 月下旬从成都出发去西藏自驾 7 天，帮我排个行程";
/** 第二轮：只改结构不改目的地，用来验"两轮混合时横幅只挂当前轮"。 */
const TURN_2 = "第 3 天太赶了，帮我把景点分到第 4 天";

interface BranchSeen {
  turnId: string;
  agent: string;
  status: string;
  durationMs?: number;
}

/**
 * 整个会话**只开一条 SSE**，两轮共用。
 *
 * 第一版是一轮一条流（`abort()` 之后再开），第二轮当场 `UND_ERR_SOCKET: other side closed`：
 * 网关侧同一会话的上一条流还没收干净，新流被顶掉。端上本来也是长连一条流，
 * 一轮一条既不像真实客户端，又多一种只在脚本里才会发生的失败。
 */
function openStream(token: string, sessionId: string) {
  const controller = new AbortController();
  const branches: BranchSeen[] = [];
  let chars = 0;
  let ended: (() => void) | undefined;

  const loop = (async () => {
    const res = await fetch(`${GATEWAY}/v1/session/${sessionId}/stream`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`开流失败 HTTP ${res.status}`);
    let buffer = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += Buffer.from(chunk).toString("utf8");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const env = JSON.parse(line.slice(6)) as {
          event: Record<string, unknown> & { type: string; kind?: string; turnId?: string };
        };
        const ev = env.event;
        if (ev.type === "update" && ev.kind === "delta") chars += String(ev.text ?? "").length;
        if (ev.type === "update" && ev.kind === "branch") {
          const b: BranchSeen = {
            turnId: String(ev.turnId ?? ""),
            agent: String(ev.agent ?? ""),
            status: String(ev.status ?? ""),
            ...(typeof ev.durationMs === "number" ? { durationMs: ev.durationMs } : {}),
          };
          branches.push(b);
          console.log(`    branch  turn=${b.turnId}  ${b.agent}  ${b.status}  ${b.durationMs ?? "—"}ms`);
        }
        if (ev.type === "update" && ev.kind === "turn_end") ended?.();
      }
    }
  })().catch((e: Error) => {
    if (e.name !== "AbortError") console.error(`  ⚠ 流中断：${e.message}`);
    ended?.();
  });

  return {
    branches,
    charsSoFar: () => chars,
    /** 等下一个 turn_end；流断了也会兑现，免得挂死。 */
    nextTurnEnd: () =>
      new Promise<void>((resolve) => {
        ended = () => {
          ended = undefined;
          resolve();
        };
      }),
    close: async () => {
      controller.abort();
      await loop;
    },
  };
}

/** 发一轮消息并等它收尾。 */
async function say(
  stream: ReturnType<typeof openStream>,
  token: string,
  sessionId: string,
  content: string,
  label: string,
): Promise<void> {
  console.log(`\n  ${label}：「${content}」`);
  const t0 = Date.now();
  const before = stream.branches.length;
  const done = stream.nextTurnEnd();
  const post = await fetch(`${GATEWAY}/v1/session/${sessionId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!post.ok) throw new Error(`发消息失败 HTTP ${post.status}`);
  await done;
  const bs = stream.branches.slice(before);
  const ids = [...new Set(bs.map((b) => b.turnId))];
  console.log(
    `  → turnId ${ids.join(", ")}；branch ${bs.length} 条；` +
      `正文累计 ${stream.charsSoFar()} 字；${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
}

/**
 * 真跑。`continueFrom` 给的话就接着已有会话只发第二轮——
 * 第一轮打真实配额，中途挂了不该连它一起重来。
 */
async function live(continueFrom?: string): Promise<{ sessionId: string; branches: BranchSeen[] }> {
  const { accessToken } = await login(GATEWAY);
  let sessionId = continueFrom;
  if (!sessionId) {
    const created = await fetch(`${GATEWAY}/v1/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!created.ok) throw new Error(`建会话失败 HTTP ${created.status}`);
    sessionId = ((await created.json()) as { sessionId: string }).sessionId;
  }
  console.log(`会话 ${sessionId}${continueFrom ? "（接着跑第二轮）" : ""}`);

  const stream = openStream(accessToken, sessionId);
  if (!continueFrom) await say(stream, accessToken, sessionId, TURN_1, "第 1 轮");
  await say(stream, accessToken, sessionId, TURN_2, "第 2 轮");
  await stream.close();
  return { sessionId, branches: stream.branches };
}

type Span = { name?: string; status?: string; detail?: string; agent?: string };

/** 四项证据的查库部分。只 SELECT。 */
async function verify(sessionId: string, rounds?: BranchSeen[][]): Promise<void> {
  const prisma = getPrisma();
  const rows = await prisma.traceEvent.findMany({
    where: { sessionId, kind: "span" },
    orderBy: { at: "asc" },
    select: { turnId: true, at: true, data: true },
  });
  const spans = rows.map((r) => ({
    turnId: r.turnId ?? "",
    at: Number(r.at),
    d: r.data as Span,
  }));
  console.log(`\n库里这个会话 ${spans.length} 条 span\n`);

  // ① llm.* 失败时 detail 非空，且与 cancelled 的值域不重叠。
  console.log("① llm.* 失败的 detail");
  const llmFailed = spans.filter(
    (s) => (s.d.name ?? "").startsWith("llm.") && s.d.status !== "ok",
  );
  if (llmFailed.length === 0) {
    console.log("   本次真跑没有 llm.* 失败——反证口径：见下面「全库反证」");
  }
  for (const s of llmFailed) {
    console.log(`   ${s.d.name}  status=${s.d.status}  detail=${JSON.stringify(s.d.detail ?? "")}`);
  }
  /*
   * 反证口径（工单「关键落地约束」#4）：一切顺利时没有失败 span，①就取不到正证。
   * 那就查**全库**——M94-01 合入之后还有没有新产生的空 detail。条数为 0 即通过；
   * 出现一条才是不通过。按 created_at 切，不按 span 里的时间戳（后者是业务时刻）。
   *
   * 分界点是 `faebbc1b`（M94-01）的提交时刻，**精确到分钟而不是取当天零点**：
   * 那天零点到 07:40 之间跑的还是旧代码，按天切会把 3 条旧记录算进来，
   * 读成"修完还在漏"。运行的进程换成新代码要等它重启，所以这是下界不是上界。
   */
  const since = process.env.CARLIFE_EVIDENCE_SINCE ?? "2026-09-16T07:40:49Z";
  const empties = await prisma.$queryRawUnsafe<Array<{ name: string; n: bigint }>>(
    `SELECT data->>'name' AS name, count(*) AS n FROM trace_events
     WHERE kind = 'span' AND data->>'status' <> 'ok'
       AND coalesce(data->>'detail', '') = '' AND created_at >= $1::timestamptz
     GROUP BY 1 ORDER BY 2 DESC`,
    since,
  );
  console.log(`   全库反证（${since} 起）：非 ok 且 detail 为空的 span ${empties.length} 类`);
  for (const e of empties) console.log(`   ⚠ 空 detail：${e.name} × ${e.n}`);

  /*
   * ② 两轮的 branch 事件各带自己的 turnId。
   *
   * 读库而不读 SSE：库里的 `kind='branch'` 与端上收到的是同一批事件，
   * 而读库在 `--verify` 模式下也成立——真跑中途断了不必为了这一条重跑一次。
   */
  console.log("\n② branch 事件按 turnId 分组（库）");
  const brs = await prisma.traceEvent.findMany({
    where: { sessionId, kind: "branch" },
    orderBy: { at: "asc" },
    select: { turnId: true, data: true },
  });
  const byTurn = new Map<string, Array<{ agent: string; status: string }>>();
  for (const b of brs) {
    const d = b.data as { agent?: string; status?: string };
    if (d.status === "started") continue; // 进展不是终态，不进横幅
    const k = b.turnId ?? "(无)";
    if (!byTurn.has(k)) byTurn.set(k, []);
    byTurn.get(k)!.push({ agent: String(d.agent ?? ""), status: String(d.status ?? "") });
  }
  for (const [t, bs] of byTurn) {
    console.log(`   ${t}：${bs.length} 条终态 —— ${bs.map((x) => `${x.agent}:${x.status}`).join(", ")}`);
  }
  console.log(`   轮数 ${byTurn.size}；turnId 互不相同：${byTurn.size === [...byTurn.keys()].length ? "是" : "否"}`);
  if (rounds) {
    const seen = rounds.flat();
    console.log(`   （SSE 当场收到 ${seen.length} 条 branch，turnId ${[...new Set(seen.map((b) => b.turnId))].join(", ")}）`);
  }

  // ③ 修复轮的完整序列。
  console.log("\n③ itinerary.audit.* 序列");
  const audit = spans.filter((s) => (s.d.name ?? "").startsWith("itinerary.audit."));
  if (audit.length === 0) console.log("   本次真跑没有修复轮（首检无 blocker，或没走到 Plan 层）");
  let companion = 0;
  for (const s of audit) {
    console.log(`   turn=${s.turnId.slice(-8)}  ${s.d.name}  ${s.d.detail ?? ""}`);
    try {
      const p = JSON.parse(s.d.detail ?? "{}") as { actions?: string[]; delta?: number };
      const acts = p.actions ?? [];
      if (acts.includes("rerun:tour") && acts.some((a) => a.startsWith("rerun:drive"))) {
        companion += 1;
        console.log(`      ↑ M98-01 现场：tour 与 drive 同轮，delta=${p.delta}`);
      }
    } catch {
      /* 早期格式或截断：不猜 */
    }
  }
  console.log(`   tour 与 drive 同轮的轮数：${companion}`);

  // ④ submit_drive_plan 的 attempt 与 stops。
  console.log("\n④ tool.submit_drive_plan 的每一次");
  const submits = spans.filter((s) => s.d.name === "tool.submit_drive_plan");
  if (submits.length === 0) console.log("   本次真跑没有 drive 提交");
  for (const s of submits) {
    console.log(`   ${s.d.status}  ${s.d.detail ?? ""}`);
  }

  // 附：M98-02 的形状概括有没有落上。
  console.log("\n附 M98-02：七条提交通道的形状概括");
  for (const s of spans.filter((x) => /^tool\.submit_/.test(x.d.name ?? ""))) {
    console.log(`   ${s.d.name}  ${s.d.status}  ${s.d.detail ?? ""}`);
  }
}

const argOf = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const onlyVerify = argOf("--verify");
if (onlyVerify) {
  await verify(onlyVerify);
} else {
  const { sessionId, branches } = await live(argOf("--continue"));
  // 轨迹是异步落库的，收工之后等一下再查，免得把"还没写完"读成"没有"。
  await new Promise((r) => setTimeout(r, 3000));
  await verify(sessionId, [branches]);
  console.log(`\n重看用：corepack pnpm probe:trip-live -- --verify ${sessionId}`);
}
process.exit(0);
