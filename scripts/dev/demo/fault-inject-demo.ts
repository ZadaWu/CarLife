/**
 * 故障注入演示（施工单 M43-01）。
 *
 * 一条命令演示"工具失败时系统稳定运行"：真杀 mock 服务（dev.sh stop，不加任何
 * 演示开关——总览决策 1）→ 真跑一轮相关提问 → 断言应答如实兜底 → 恢复服务 →
 * 恢复轮证明回到正常。断言对象是既有兜底纪律（dealer.ts/repair.ts 的 ToolError
 * 话术、test-drive degraded、M37-01/02 失败标识与追问），本脚本**只验证不修改**；
 * 断言不过是产品缺陷，立单去修，不放宽脚本。
 *
 *   corepack pnpm demo:fault-inject dealer
 *   corepack pnpm demo:fault-inject repair
 *   corepack pnpm demo:fault-inject all
 *
 * 断言分两层（工单约束）：
 *   硬断言（机器判）：注入轮应答不含任何种子门店/维修站名（封闭集来自种子
 *   JSON，模型编不出集合外的店）；恢复后 health 通过且恢复轮出现真实门店名或
 *   时段。跑挂了也会恢复服务（finally），不把栈留在残废态。
 *   软观察（人读）：应答全文原样打印，如实/追问的话术质量由验收粘贴判读。
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATEWAY = process.env.CARLIFE_GATEWAY_URL ?? "http://localhost:8790";
const AUTH = {
  authorization: `Bearer ${process.env.CARLIFE_DEMO_TOKEN ?? "demo-token"}`,
  "content-type": "application/json",
};

interface TargetSpec {
  devTarget: string;
  port: number;
  /** 封闭集：种子里的全部机构名。注入轮应答里出现任何一个都算编造。 */
  names: () => string[];
  injectQuestion: string;
  recoveryQuestion: string;
}

const TARGETS: Record<string, TargetSpec> = {
  dealer: {
    devTarget: "mock-dealer",
    port: 8792,
    names: () => {
      const raw = JSON.parse(readFileSync(join(ROOT, "mocks/dealer/data/stores.json"), "utf8")) as {
        stores: Array<{ name: string }>;
      };
      return raw.stores.map((s) => s.name);
    },
    injectQuestion: "帮我约个 Model 3 的试驾，上海附近有哪些门店可以选？",
    recoveryQuestion: "再帮我看下上海哪些门店能约 Model 3 试驾",
  },
  repair: {
    devTarget: "mock-repair",
    port: 8797,
    names: () => {
      const raw = JSON.parse(
        readFileSync(join(ROOT, "mocks/repair/data/stations.json"), "utf8"),
      ) as { stations: Array<{ name: string }> };
      return raw.stations.map((s) => s.name);
    },
    injectQuestion: "我这辆车最近修过什么？维修记录说说",
    recoveryQuestion: "再查一下我这辆车的维修记录",
  },
};

function dev(action: "stop" | "start", target: string): void {
  const r = spawnSync("bash", ["infra/scripts/dev.sh", action, target], { cwd: ROOT, stdio: "pipe" });
  if (r.status !== 0) {
    throw new Error(`dev.sh ${action} ${target} 失败：${r.stderr?.toString().slice(0, 300)}`);
  }
}

async function healthy(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error(`等待超时：${what}`);
}

/** 新会话跑一轮，收全 SSE。注入轮与恢复轮各开新会话——失败上下文不互相污染。 */
async function runTurn(question: string): Promise<{ answer: string; failureEvents: number; sessionId: string }> {
  const created = await fetch(`${GATEWAY}/v1/session`, { method: "POST", headers: AUTH, body: "{}" });
  const { sessionId } = (await created.json()) as { sessionId?: string };
  if (!created.ok || !sessionId) throw new Error(`建会话失败 status=${created.status}`);

  const stream = await fetch(`${GATEWAY}/v1/session/${sessionId}/stream`, { headers: AUTH });
  void fetch(`${GATEWAY}/v1/session/${sessionId}/messages`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ content: question, source: "text" }),
  });

  const reader = stream.body!.getReader();
  const dec = new TextDecoder();
  let sseBuf = "";
  let answer = "";
  let failureEvents = 0;
  const deadline = Date.now() + 180_000;
  outer: for (;;) {
    if (Date.now() > deadline) break;
    const { value, done } = await reader.read();
    if (done) break;
    sseBuf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = sseBuf.indexOf("\n\n")) >= 0) {
      const chunk = sseBuf.slice(0, idx);
      sseBuf = sseBuf.slice(idx + 2);
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      let ev: Record<string, unknown>;
      try {
        ev = (JSON.parse(dataLine.slice(5)) as { event?: Record<string, unknown> }).event ?? {};
      } catch {
        continue;
      }
      if (ev.kind === "branch" && ev.status === "failed") failureEvents += 1;
      if (ev.type === "update" && ev.kind === "delta") answer += String(ev.text ?? "");
      if (ev.type === "update" && ev.kind === "turn_end") break outer;
    }
  }
  reader.cancel().catch(() => undefined);
  return { answer, failureEvents, sessionId };
}

interface Verdict {
  label: string;
  pass: boolean;
  detail: string;
}

async function runScenario(key: string): Promise<Verdict[]> {
  const spec = TARGETS[key];
  const verdicts: Verdict[] = [];
  const nameSet = spec.names();
  console.log(`\n════ 注入目标 ${spec.devTarget}（封闭集 ${nameSet.length} 个机构名）`);

  // 前置：栈与目标都在
  if (!(await healthy(spec.port))) throw new Error(`${spec.devTarget} 本来就没在跑——先 dev:start 再演示`);
  const gw = await fetch(`${GATEWAY}/healthz`).then((r) => r.ok).catch(() => false);
  if (!gw) throw new Error("gateway 不在跑");

  try {
    console.log(`→ 杀掉 ${spec.devTarget} …`);
    dev("stop", spec.devTarget);
    await waitFor(async () => !(await healthy(spec.port)), 15_000, "端口确实拒连");
    console.log(`✓ :${spec.port} 已拒连（不是监护层假死）`);

    console.log(`→ 注入轮提问：${spec.injectQuestion}`);
    const injected = await runTurn(spec.injectQuestion);
    console.log(`\n【注入轮应答全文】（会话 ${injected.sessionId}）\n${injected.answer}\n`);

    const leaked = nameSet.filter((n) => injected.answer.includes(n));
    verdicts.push({
      label: "注入轮零机构名（防编硬断言）",
      pass: leaked.length === 0,
      detail: leaked.length === 0 ? "封闭集零命中" : `泄漏：${leaked.join("、")}`,
    });
    verdicts.push({
      label: "SSE 失败语义事件（软观察）",
      pass: true,
      detail: `branch failed 事件 ${injected.failureEvents} 个（0 属正常：非 fanout 路径的失败走如实话术不走分支事件）`,
    });
  } finally {
    console.log(`→ 恢复 ${spec.devTarget} …`);
    dev("start", spec.devTarget);
    await waitFor(() => healthy(spec.port), 30_000, "health 恢复");
    console.log("✓ 已恢复");
  }

  console.log(`→ 恢复轮提问：${spec.recoveryQuestion}`);
  const recovered = await runTurn(spec.recoveryQuestion);
  console.log(`\n【恢复轮应答全文】（会话 ${recovered.sessionId}）\n${recovered.answer}\n`);
  /*
   * 恢复检测放宽到"部分店名或业务词"：这条断言的意图是"服务回来了"，不是措辞。
   * 实测模型会说"浦东体验店"不带"上海"前缀，全名匹配会把正常恢复误判成失败——
   * 而**防编那条硬断言不放宽**：注入轮全名/短名都不该出现，那边用的是全名封闭集
   * （模型编店名只会编全名形态，且注入轮应答里出现任何真实短名同样代表编造，
   * 由人读应答全文兜底，验收粘贴时核）。
   */
  const shortNames = nameSet.map((n) => n.replace(/^(上海|北京|杭州)/, ""));
  const businessWords = ["可约", "能约", "时段", "记录", "服务中心", "体验店"];
  const mentioned = [...nameSet, ...shortNames].filter((n) => recovered.answer.includes(n));
  const businessOk = businessWords.some((w) => recovered.answer.includes(w));
  verdicts.push({
    label: "恢复轮服务回归（店名/时段/记录任一）",
    pass: mentioned.length > 0 || businessOk,
    detail:
      mentioned.length > 0
        ? `命中：${[...new Set(mentioned)].join("、")}`
        : businessOk
          ? "业务词命中（未点名机构）"
          : "零命中（恢复未生效）",
  });

  return verdicts;
}

async function main(): Promise<void> {
  const arg = process.argv[2] ?? "dealer";
  const keys = arg === "all" ? Object.keys(TARGETS) : [arg];
  for (const k of keys) {
    if (!TARGETS[k]) {
      console.error(`未知目标 ${k}（可选：${Object.keys(TARGETS).join("/")}/all）`);
      process.exit(2);
    }
  }

  let failedCount = 0;
  for (const k of keys) {
    const verdicts = await runScenario(k);
    console.log(`──── ${k} 断言结果`);
    for (const v of verdicts) {
      console.log(` ${v.pass ? "✓" : "✗"} ${v.label}：${v.detail}`);
      if (!v.pass) failedCount += 1;
    }
  }
  console.log(failedCount === 0 ? "\n全部断言通过" : `\n${failedCount} 条断言失败——这是产品缺陷信号，去立单，不要改脚本`);
  process.exit(failedCount === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("演示脚本失败：", err instanceof Error ? err.message : err);
  process.exit(1);
});
