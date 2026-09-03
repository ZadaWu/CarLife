/**
 * 天气链路自检（施工单 M10-02）。
 *
 * **这个脚本必须在中国大陆网络下跑才算数。** 中国气象局是本工单选它的全部理由所在——
 * 大陆确定可达；而开发机出口在境外时，跑通它不构成证据（M10-01 的教训：
 * 那次 Open-Meteo 在出口位于洛杉矶的机器上跑通了，因此**不能**用来证明大陆可用）。
 *
 * 它回答四个问题：
 *   1. 气象局接口通不通、站点表拉不拉得下来；
 *   2. 最近站点选得对不对、离取样点多远；
 *   3. 高德给不了的那几项（体感/湿度/降水/气压/风/预警）是不是真的拿到了；
 *   4. **拿不到的那几项有没有如实说出来**（紫外线/能见度/降雪量）。
 *
 * 运行（根目录）：corepack pnpm probe:weather
 */

import { readFileSync } from "node:fs";

import { createAmapClient, setAmapClient } from "../../../enterprise/backend/shared/tools/src/amap";
import { createCmaClient, setCmaClient, CMA_LIMITS } from "../../../enterprise/backend/shared/tools/src/cma";
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

/** 三个相距很远的点：验证最近邻不是碰巧选对了一个。 */
const POINTS = [
  { name: "深圳市民中心", lat: 22.5437, lon: 114.0596 },
  { name: "广州塔", lat: 23.1066, lon: 113.3245 },
  { name: "韶关", lat: 24.8, lon: 113.6 },
];

const ctx = { sessionId: "probe-weather", agent: "trip" as const };

function todayCn(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}
function plusDays(n: number): string {
  return new Date(Date.now() + 8 * 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const cma = createCmaClient();
  setCmaClient(cma);

  const amapKey = get("AMAP_SERVER_KEY");
  if (amapKey) setAmapClient(createAmapClient({ key: amapKey }));
  console.log(
    `基础预报供应商：${amapKey ? "高德（AMAP_SERVER_KEY 已配）" : "Open-Meteo（未配高德 key）"}\n`,
  );

  // ① 站点表
  try {
    const stations = await cma.stations();
    ok(stations.length > 1000, `站点表 ${stations.length} 个站`);
    const withAd = stations.filter((s) => s.adcode).length;
    console.log(
      `  带 adcode 的 ${withAd}/${stations.length} —— 正因为不是 100% 且区级码对不上，站点匹配走坐标最近邻`,
    );
  } catch (e) {
    ok(false, `站点表拉取失败 —— ${String(e)}`);
    console.log("  **如果这一步就挂了，多半是网络出不去或接口改版**，后面的检查没有意义。");
    finish();
    return;
  }

  // ② 最近邻
  for (const p of POINTS) {
    const hit = await cma.nearestStation(p).catch(() => undefined);
    ok(
      hit !== undefined,
      hit
        ? `${p.name} → 最近站点「${hit.station.name}」${hit.distanceKm}km（上限 ${CMA_LIMITS.MAX_STATION_KM}km）`
        : `${p.name} 100km 内没有观测站`,
    );
  }

  // ③ 今天：实况字段必须真的有值
  try {
    const r = await weatherTool.call({ points: POINTS }, ctx);
    const first = r.data[0];
    ok(r.data.length === POINTS.length, `weather 返回 ${r.data.length} 段`);
    console.log(`  来源标注：source.provider=${r.source.provider} / sources=${JSON.stringify(first.sources)}`);

    const o = first.observed;
    ok(o !== null && o !== undefined, "今天的查询带回了实况观测（observed 非空）");
    if (o) {
      console.log(
        `  ${first.name}（${o.station} 站，${o.stationDistanceKm}km，${o.observedAt}）\n` +
          `    气温 ${o.temperatureC}℃  体感 ${o.feelsLikeC}℃  湿度 ${o.humidityPct}%\n` +
          `    降水 ${o.precipitationMm}mm  气压 ${o.pressureHpa}hPa  ${o.windDirection} ${o.windScale}(${o.windSpeedMs}m/s)`,
      );
      ok(o.feelsLikeC !== null, "**体感温度**拿到了 —— 这是高德整条链路给不出的数");
      ok(o.humidityPct !== null, "**湿度**拿到了");
      ok(o.precipitationMm !== null, "**降水量**拿到了");
    }

    // 预警：有没有都是事实，但字段必须存在
    const alarmed = r.data.filter((s) => (s.alarms?.length ?? 0) > 0);
    ok(Array.isArray(first.alarms), "预警字段存在（当前生效的气象预警）");
    console.log(
      alarmed.length > 0
        ? `  命中预警：${alarmed.map((s) => s.alarms!.map((a) => a.title).join("；")).join(" | ")}`
        : "  这三个点当前没有生效中的气象预警 —— 是事实，不是故障",
    );

    // ④ 拿不到的要说出来
    const un = first.unavailable ?? [];
    ok(
      un.some((u) => u.startsWith("uvIndex")) && un.some((u) => u.startsWith("visibilityKm")),
      "紫外线与能见度被**如实标为该数据源不提供**，而不是留空让上层当成 0",
    );
    for (const u of un) console.log(`    · ${u}`);
  } catch (e) {
    ok(false, `今天的天气查询失败 —— ${String(e)}`);
  }

  // ④ 明天：实况必须为 null（不能拿今天的体感当明天的）
  try {
    const r = await weatherTool.call({ points: [POINTS[0]], date: plusDays(1) }, ctx);
    ok(
      r.data[0].observed === null,
      `查 ${plusDays(1)} 时 observed 为 null —— 实况是"此刻"，不能安到未来日期上`,
    );
  } catch (e) {
    ok(false, `明天的天气查询失败 —— ${String(e)}`);
  }

  // ⑤ 第 6 天：高德窗口外，应由气象局兜住而不是报错
  const day6 = plusDays(5);
  try {
    const r = await weatherTool.call({ points: [POINTS[0]], date: day6 }, ctx);
    const s = r.data[0];
    ok(
      s.tempMaxC !== null || s.condition !== null,
      `${day6}（高德 4 天窗口外）由气象局兜住：${s.condition ?? "?"} ${s.tempMinC}~${s.tempMaxC}℃`,
    );
  } catch (e) {
    ok(false, `${day6} 查询失败（预期应由气象局的 7 天窗口兜住）—— ${String(e)}`);
  }

  // ⑥ 第 9 天：两边都覆盖不到，必须明确报错
  const day9 = plusDays(8);
  try {
    await weatherTool.call({ points: [POINTS[0]], date: day9 }, ctx);
    ok(false, `${day9} 竟然查到了 —— 两个源都只有 4/7 天，这说明我们在编数`);
  } catch (e) {
    ok(String(e).includes("查不到"), `${day9}（两个窗口都覆盖不到）被明确拒绝，不返回空值`);
  }

  finish();
}

function finish(): void {
  const failed = checks.filter(([b]) => !b).length;
  console.log(`\n天气链路自检：${checks.length - failed} passed, ${failed} failed`);
  console.log(`今天（北京时间）：${todayCn()}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();
