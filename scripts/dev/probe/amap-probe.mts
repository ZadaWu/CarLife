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
 */

import { readFileSync } from "node:fs";

import { createAmapClient } from "../../../enterprise/backend/shared/tools/src/amap";
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

async function main(): Promise<void> {
  const key = get("AMAP_SERVER_KEY");
  if (!key) {
    console.log("高德未接入（AMAP_SERVER_KEY 未配置）。");
    console.log("这不是错误：此时 weather 退回 Open-Meteo（无中文天气现象），map_route 明确返回未接入。");
    return;
  }

  const client = createAmapClient({ key });
  setAmapClient(client);

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
    try {
      await weatherTool.call({ points: [{ name: "起点", ...originAt }], date: far }, ctx);
      ok(false, `${far} 的天气竟然查到了 —— 两个源最多 7 天，这说明我们在编数`);
    } catch (e) {
      ok(String(e).includes("查不到"), `${far}（超窗口）被明确拒绝，不返回空值`);
    }
  }

  const failed = checks.filter(([b]) => !b).length;
  console.log(`\n高德自检：${checks.length - failed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();
