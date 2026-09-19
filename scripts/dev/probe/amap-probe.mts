/**
 * 高德连通性自检（施工单 M10-01）。
 *
 * 配完 AMAP_SERVER_KEY 之后跑这一条：**单测全绿证明不了 key 是通的**（M7 的教训——
 * 纯逻辑层的单测当然会过，它们本来就不需要外部依赖，绿灯掩盖了"根本没有数据源"）。
 * 这个脚本走真实网络，打印真实里程与真实气温，看得见数字才算接上了。
 *
 * 它也顺手验一件容易填错的事：两把 key 不能互换。拿 Web 端(JS API) 的 key 填进
 * AMAP_SERVER_KEY，表现是 `infocode=10009`，脚本会直接把这句话说出来。
 *
 * 运行（根目录）：corepack pnpm probe:amap
 *
 * M100-03 起还打一张**用量表**：每把 key 今日各接口族发了多少、占预算几成、是不是退役了。
 * 账来自 Redis 台账（三个进程同一份），没有 `REDIS_URL` 时表里只有本次 probe 自己发的。
 * `--pool [--n 20]` 是压预算的模式：跳过 map_route / weather，连发 N 次搜索看车道怎么轮。
 */

import { readFileSync } from "node:fs";

import { amapBudgetFromEnv, createAmapClient, resolveAmapKeys } from "../../../enterprise/backend/shared/tools/src/amap";
import {
  AMAP_API_FAMILIES,
  buildAmapPoolSnapshot,
  createRedisAmapLedger,
  type AmapApiFamily,
  type AmapPoolSnapshot,
  type AmapUsageLedger,
} from "../../../enterprise/backend/shared/tools/src/amap-ledger";
import { mapRouteTool } from "../../../enterprise/backend/shared/tools/src/map-route";
import { setAmapClient } from "../../../enterprise/backend/shared/tools/src/amap";
import { weatherTool } from "../../../enterprise/backend/shared/tools/src/weather";

const env: Record<string, string> = {};
try {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)="?([^"]*)"?$/.exec(l.trim());
    if (m) env[m[1]] = m[2];
  }
} catch {
  /* 没有 .env 就只看 process.env */
}
const get = (k: string): string => process.env[k] ?? env[k] ?? "";

const checks: Array<[boolean, string]> = [];
const ok = (b: boolean, s: string): void => {
  checks.push([b, s]);
  console.log(`${b ? "✓" : "✗"} ${s}`);
};

/** 深圳市民中心 → 广州塔：一条真实存在的高速路线，长到足以触发分段插点。 */
const ORIGIN = { name: "深圳市民中心", city: "深圳" };
const DESTINATION = { name: "广州塔", city: "广州" };

const ctx = { sessionId: "probe-amap", agent: "trip" as const };

const argv = process.argv.slice(2);
const POOL_MODE = argv.includes("--pool");
const POOL_N = Number(argv[argv.indexOf("--n") + 1]) || 20;

/** 台账：有 REDIS_URL 就读 Redis 那份全局账，否则本次 probe 自己记一本。 */
function openLedger(): AmapUsageLedger | undefined {
  const url = get("REDIS_URL");
  if (!url) {
    console.log("台账：仅进程内（REDIS_URL 未配置）——下表只有本次 probe 自己发的");
    return undefined;
  }
  return createRedisAmapLedger(url);
}

/** 定宽左对齐。表是给人看的，列对不齐就得一格格数。 */
const pad = (s: string, w: number): string => (s.length >= w ? s : s + " ".repeat(w - s.length));

/**
 * 用量表。列 = 环境变量名 · 指纹 · 七族各一列 · 状态。
 * 有预算的族打 `用量/预算 占比`，没有预算的只打次数——**不给没有依据的族编一个占比**。
 */
function printPoolTable(pool: AmapPoolSnapshot): void {
  const families = AMAP_API_FAMILIES.filter(
    (f) => pool.keys.some((k) => (k.usage[f] ?? 0) > 0) || pool.keys.some((k) => k.budget?.[f]),
  );
  const cell = (k: AmapPoolSnapshot["keys"][number], f: AmapApiFamily): string => {
    const n = k.usage[f] ?? 0;
    const limit = k.budget?.[f];
    return limit ? `${n}/${limit} ${Math.round((k.ratio?.[f] ?? 0) * 100)}%` : String(n);
  };
  const widths = families.map((f) => Math.max(f.length, ...pool.keys.map((k) => cell(k, f).length)) + 2);
  const nameW = Math.max(3, ...pool.keys.map((k) => k.name.length)) + 2;
  console.log(`\n用量（北京日 ${pool.day}，台账：${{ redis: "Redis 全局", memory: "仅进程内", none: "无" }[pool.source]}）`);
  console.log(pad("key", nameW) + pad("fp", 10) + families.map((f, i) => pad(f, widths[i]!)).join("") + "状态");
  for (const k of pool.keys) {
    const state =
      k.retiredAt === undefined
        ? "活"
        : `退役 ${new Date(k.retiredAt + 8 * 3_600_000).toISOString().slice(5, 16).replace("T", " ")}` +
          `（${((Date.now() - k.retiredAt) / 3_600_000).toFixed(1)}h 前${k.retiredInfocode ? `，${k.retiredInfocode}` : ""}）`;
    console.log(pad(k.name, nameW) + pad(k.fp, 10) + families.map((f, i) => pad(cell(k, f), widths[i]!)).join("") + state);
  }
  for (const f of families) {
    const limit = pool.keys[0]?.budget?.[f];
    if (!limit) continue;
    const total = pool.keys.reduce((a, k) => a + (k.usage[f] ?? 0), 0);
    const cap = limit * pool.keys.length;
    console.log(`合计 ${f}：${total}/${cap}（${Math.round((total / cap) * 100)}%）`);
  }
  for (const o of pool.observations.slice(0, 5)) {
    console.log(`  复活观测：${o.fp} 退役 → 复活 间隔 ${o.hours.toFixed(1)}h`);
  }
}

/** `--pool`：连发 N 次搜索，逐次打用哪条车道、结果是什么。给 M100-04 攒真跑证据。 */
async function runPool(client: ReturnType<typeof createAmapClient>, fps: string[]): Promise<void> {
  console.log(`\n--pool：连发 ${POOL_N} 次 textSearch("西湖", "杭州")，看车道怎么轮`);
  for (let i = 1; i <= POOL_N; i += 1) {
    try {
      const r = await client.textSearch({ keywords: "西湖", region: "杭州", limit: 1 });
      console.log(`  #${i} result=ok (${r[0]?.name ?? "无结果"})`);
    } catch (e) {
      const m = /infocode=(\d+)/.exec(String(e));
      console.log(`  #${i} result=${m?.[1] ?? "error"} —— ${String(e).slice(0, 96)}`);
    }
  }
  console.log(`  （车道归属看下表的用量增量；本池 ${fps.length} 把 key：${fps.join("、")}）`);
}

async function main(): Promise<void> {
  // 与 agent-runtime / worker 同一个读法（M100-01）：空位可跳、重复的只算一条。
  const keys = resolveAmapKeys((n) => get(n)).map((k) => [k.name, k.key] as const);
  if (keys.length === 0) {
    console.log("高德未接入（AMAP_SERVER_KEY 未配置）。");
    console.log("这不是错误：此时 weather 退回 Open-Meteo（无中文天气现象），map_route 明确返回未接入。");
    return;
  }

  /*
   * ⓪ **每把 key 单独验一次**（M83 走查追修）。
   *
   * 多账号 key 池里，某一把坏掉的表现是"偶发失败"——闸门轮到它的那些请求全挂，
   * 轮到好的那把就正常，于是看起来像高德不稳定。逐把验一次，坏的那把当场点名。
   * 最常见的两种坏法都在这里说清楚：
   *   10009 = 填成了 Web 端(JS API) 的 key（那是 AMAP_JS_KEY 的位置）
   *   10008 = 这把 key 在控制台开了「数字签名」，而我们不做 sig 签名——去关掉它
   */
  for (const [name, k] of keys) {
    const solo = createAmapClient({ key: k });
    try {
      const geo = await solo.geocode(ORIGIN.name, ORIGIN.city);
      ok(true, `${name} 可用（${ORIGIN.name} → ${geo.lat.toFixed(4)},${geo.lon.toFixed(4)}）`);
    } catch (e) {
      const msg = String(e);
      ok(false, `${name} 不可用 —— ${msg}`);
      if (msg.includes("10009")) console.log("  这把是 Web 端(JS API) 的 key，AMAP_SERVER_KEY* 要填「Web 服务」类型。");
      if (msg.includes("10008")) console.log("  这把 key 开了「数字签名」。我们不做 sig 签名——去控制台把它关掉。");
      if (msg.includes("10001")) console.log("  key 不正确或已过期。");
    }
  }
  if (keys.length > 1) {
    console.log(
      `  ${keys.length} 个账号 → 闸门 ${keys.length} 条车道，持续速率与搜索月配额都是 ${keys.length} 倍。` +
        "（QPS 按账号算，同账号下的第二把 key 不算数）",
    );
  }

  // 台账与预算：probe 与 agent-runtime / 财务页读同一份账（M100-03）。
  const pool = resolveAmapKeys((n) => get(n));
  const ledger = openLedger();
  const budget = amapBudgetFromEnv(get("AMAP_DAILY_BUDGET") || undefined);
  const client = createAmapClient({ key: keys.map(([, k]) => k), ledger, budget });
  setAmapClient(client);

  const showPool = async (): Promise<void> => {
    printPoolTable(await buildAmapPoolSnapshot(pool, ledger, budget, Date.now()));
  };

  // --pool：只压搜索，不跑 map_route / weather——那两步各要好几发，会把配额账搅浑。
  if (POOL_MODE) {
    await runPool(client, pool.map((k) => k.fp));
    await showPool();
    const failedPool = checks.filter(([b]) => !b).length;
    console.log(`\n高德自检（--pool）：${checks.length - failedPool} passed, ${failedPool} failed`);
    process.exitCode = failedPool === 0 ? 0 : 1;
    return;
  }

  // ① 地理编码：地名 → 坐标。它是 map_route 接受地名入参的前提。
  let originAt: { lat: number; lon: number } | undefined;
  try {
    const geo = await client.geocode(ORIGIN.name, ORIGIN.city);
    originAt = { lat: geo.lat, lon: geo.lon };
    ok(true, `地理编码：${ORIGIN.name} → ${geo.lat.toFixed(4)},${geo.lon.toFixed(4)}（${geo.city}）`);
  } catch (e) {
    ok(false, `地理编码失败 —— ${String(e)}`);
  }

  // ② 逆地理：坐标 → adcode。高德天气按 adcode 查，这一步是天气的前置。
  if (originAt) {
    try {
      const r = await client.regeo(originAt);
      ok(true, `逆地理：adcode=${r.adcode}（${r.city} ${r.district}）`);
    } catch (e) {
      ok(false, `逆地理失败 —— ${String(e)}`);
    }
  }

  // ③ map_route：整条工具链（四件套 + 客户端 + 分段插点）走一遍。
  try {
    const r = await mapRouteTool.call(
      { origin: ORIGIN, destination: DESTINATION, maxLegMinutes: 90 },
      ctx,
    );
    const s = r.data.summary;
    ok(
      s.distanceKm > 0 && s.durationMin > 0,
      `map_route：${s.distanceKm}km / ${s.durationMin}分钟 / 过路费 ${s.tollYuan}元 / ${s.trafficLights} 个红绿灯`,
    );
    ok(
      r.data.sampledPoints.length >= 3,
      `沿途取样点 ${r.data.sampledPoints.length} 个（它们就是 weather 的入参）`,
    );
    // 找不到服务区**不判失败**：这是路线的事实，不是接入的问题。但要说出来。
    console.log(
      r.data.restStops.length > 0
        ? `  休息点：${r.data.restStops.map((x) => `${x.name}@${x.atKm}km`).join("、")}`
        : "  这条路线在 90 分钟分段处没找到高速服务区 —— 是事实，不是故障",
    );
    ok(r.source.provider === "amap" && r.source.kind === "real", "来源标注为 amap/real");

    // ④ weather：直接吃 map_route 的取样点，验证两个工具能串起来。
    const w = await weatherTool.call({ points: r.data.sampledPoints }, ctx);
    const first = w.data[0];
    ok(
      w.data.length === r.data.sampledPoints.length,
      `weather：${w.data.length} 个取样点各有一条预报`,
    );
    ok(
      Boolean(first?.condition),
      `首点 ${first?.city ?? "?"} ${first?.date}：${first?.condition ?? "?"} ${first?.tempMinC}~${first?.tempMaxC}℃ 风力${first?.windPower ?? "?"}`,
    );
    ok(
      first?.precipitationMm === null,
      "高德下 precipitationMm 为 null（它不提供降水毫米数，不反推假数）",
    );
    ok(w.source.provider === "amap", "weather 的来源标注为 amap（而不是 open-meteo）");
  } catch (e) {
    ok(false, `map_route / weather 失败 —— ${String(e)}`);
    if (String(e).includes("10009")) {
      console.log("  infocode=10009：这把 key 不是「Web 服务」类型的。");
      console.log("  AMAP_SERVER_KEY 要填 Web 服务 key，AMAP_JS_KEY 才是 Web 端(JS API) 的。");
    }
  }

  // ⑤ 超出预报窗口要明确报错，而不是给一组空值。
  //
  // 注：M10-02 接入中国气象局后窗口是 4 天(高德) + 7 天(气象局)，这里取 30 天后，
  // 两个源都覆盖不到。天气本身的逐项验收归 `corepack pnpm probe:weather`，
  // 这条只是确认 M10-01 的"超窗口不编数"没有被后续改动破坏。
  if (originAt) {
    const far = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    /*
     * 判据在 c352ea4a 之后变了形状但没变性质：超窗口**不再抛错**（抛错会进模型的
     * 工具循环，白烧一轮往返），改成照常返回这一段、字段全 null、`unavailable`
     * 里写清楚为什么。要守的仍是同一件事——**不编数**。
     */
    try {
      const w = await weatherTool.call({ points: [{ name: "起点", ...originAt }], date: far }, ctx);
      const seg = w.data[0];
      ok(
        seg?.tempMinC === null && seg?.condition === null && (seg?.unavailable?.length ?? 0) > 0,
        `${far}（超窗口）字段全空并说明原因，不编数：${seg?.unavailable?.[0]?.slice(0, 28) ?? "没有说明"}…`,
      );
    } catch (e) {
      ok(false, `${far}（超窗口）抛错了 —— 它该返回带 unavailable 的空段：${String(e)}`);
    }
  }

  await showPool();

  const failed = checks.filter(([b]) => !b).length;
  console.log(`\n高德自检：${checks.length - failed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();
