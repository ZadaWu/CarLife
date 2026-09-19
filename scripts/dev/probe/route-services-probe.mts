/**
 * 沿途服务 POI 可得性探针（行程详情抽屉「沿途服务」五格）。
 *
 * 抽屉里餐饮 / 卫生间 / 停车场三格恒显「待查」，口径写在
 * `clients/shared/ui/src/hud/trip-detail.ts` 文件头第 2 条：工具层没有数据源。
 * 本脚本回答"接上之后能拿到什么"——沿一条真实路线取样，逐个类目打高德
 * `/v5/place/around`，打印每个类目在多少个取样点上有命中、命中的是什么。
 *
 * 它不改任何代码、不落库，只读。判据是**命中率与命中内容**，不是"接口通不通"
 * （那是 `probe:amap` 的事）。
 *
 * 运行（根目录）：corepack pnpm probe:route-services
 */

import { readFileSync } from "node:fs";

import { AMAP_KEY_ENV_NAMES, createAmapClient } from "../../../enterprise/backend/shared/tools/src/amap";

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

/**
 * 高德 POI 类目码与各自的搜索半径。
 *
 * `180300` 半径给到 8km 是因为服务区之间本来就隔得远，用 3km 搜等于只在
 * 恰好停在服务区门口时才命中。其余三项按"下车走两步"的尺度取 3km。
 *
 * ⚠️ `180300` 是**中类**「服务区」，一次带回三个子类（实测 2026-09-18）：
 * `180300` 高速服务区 / `180301` 高速加油站服务区（只有油枪）/ `180303` 公路驿站
 * （省道与城市道路上的停车区）。这条探针量的是「沿途有没有可停的地方」，
 * 三类都算数，所以不在这里筛——要按子类取舍的是 `map_route`，它在调用层筛。
 *
 * 这一行原先写的是 `180301`，标签却是「高速服务区」：那是加油站服务区的码，
 * 探到的东西与标签不符，而**探针不会因此报错**，只会给出一份看起来正常的低命中率。
 *
 * ⚠️ `200300` 是大类，含母婴室(200304) 与无障碍卫生间(200303)——
 * 接进产品时要么按子码过滤，要么把类型如实标出来。
 */
const CATEGORIES: ReadonlyArray<{ label: string; types: string; radiusM: number }> = [
  { label: "服务区(含驿站)", types: "180300", radiusM: 8_000 },
  { label: "餐饮", types: "050000", radiusM: 3_000 },
  { label: "公共厕所", types: "200300", radiusM: 3_000 },
  { label: "停车场", types: "150900", radiusM: 3_000 },
  // M93-04 起充电站是正式类目（此前只是这条探针里的对照组）。
  { label: "充电站", types: "011100", radiusM: 3_000 },
];

/** 一条跨城高速路线：既有高速段也有市区段，还经过粤北的稀疏地带。 */
const ORIGIN = { name: "深圳市民中心", city: "深圳" };
const DESTINATION = { name: "韶关丹霞山", city: "韶关" };
/** 取样间距（km）。与 `map_route` 的取样点上限 8 个刻意不同——这里要看的是真实密度。 */
const SAMPLE_EVERY_KM = 40;

async function main(): Promise<void> {
  const keys = AMAP_KEY_ENV_NAMES.map((n) => get(n).trim()).filter((v) => v.length > 0);
  if (keys.length === 0) {
    console.log("高德未接入（AMAP_SERVER_KEY 未配置），无法探测。先看 probe:amap。");
    return;
  }
  const client = createAmapClient({ key: keys });

  const o = await client.geocode(ORIGIN.name, ORIGIN.city);
  const d = await client.geocode(DESTINATION.name, DESTINATION.city);
  const path = await client.driving({ origin: o, destination: d });
  console.log(
    `路线 ${ORIGIN.name} → ${DESTINATION.name}：` +
      `${(path.distanceM / 1000).toFixed(0)}km / ${(path.durationS / 60).toFixed(0)}min`,
  );

  // 把各 step 的折线拉平，按点序等距抽——精度到一个 step 足够看密度。
  const pts: { lat: number; lon: number }[] = [];
  for (const s of path.steps) pts.push(...s.points);
  const want = Math.max(2, Math.round(path.distanceM / 1000 / SAMPLE_EVERY_KM));
  const stride = Math.max(1, Math.floor(pts.length / want));
  const samples = pts.filter((_, i) => i % stride === 0);
  console.log(`取样点 ${samples.length} 个（每 ~${SAMPLE_EVERY_KM}km），每类目 ${samples.length} 次请求\n`);

  for (const { label, types, radiusM } of CATEGORIES) {
    const startedAt = Date.now();
    let hitPoints = 0;
    let total = 0;
    const examples: string[] = [];
    for (const at of samples) {
      const r = await client.around({ at, types, radiusM, limit: 3 });
      if (r.length === 0) continue;
      hitPoints += 1;
      total += r.length;
      if (examples.length < 3 && r[0]) examples.push(`${r[0].name}[${r[0].typecode}]`);
    }
    console.log(
      `${label.padEnd(12)} r=${String(radiusM).padStart(5)}m  ` +
        `命中 ${hitPoints}/${samples.length} 点 · ${total} 条 · ${Date.now() - startedAt}ms\n` +
        `${" ".repeat(14)}例：${examples.join(" / ") || "（无）"}`,
    );
  }

  console.log(
    "\n注意：命中数是**直线半径内**的 POI 数，不等于可达。" +
      "高速段命中的餐饮多在下道后的镇上，接进产品前要按 F-18-08 的质量门槛筛。",
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
