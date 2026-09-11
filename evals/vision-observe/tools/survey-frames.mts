/**
 * 盘点一批帧里有哪些警示灯（施工单 M79-01）。
 *
 * 用途是**粗筛负样本候选**：跑真实观察层，把「零警示灯」的帧挑出来。
 * 注意它的结论不能直接当判据——观察层会把地图导航标记报成指示灯（2026-09-09 抽样里
 * 蓝色三角形/矩形/圆形基本都是地图上的东西），所以粗筛之后必须人眼再过一遍裁图联系表。
 *
 * 用法：node --import tsx evals/vision-observe/tools/survey-frames.mts <候选清单.json> <输出.json>
 * 候选清单是一个字符串数组（绝对路径），由 vision_trainer 的 pick_negatives 产出。
 */

import { readFileSync, writeFileSync } from "node:fs";

// `evals/` 不是 workspace 成员，`@carlife/*` 解析不到——照 `../run.ts` 的先例走相对路径
import { createDashScopeVisionProvider, observePhoto } from "../../../enterprise/backend/shared/tools/src/vision/index";

const [listPath, outPath] = process.argv.slice(2);
if (!listPath || !outPath) {
  console.error("用法：survey-frames.mts <候选清单.json> <输出.json>");
  process.exit(2);
}
const apiKey = process.env.DASHSCOPE_API_KEY;
if (!apiKey) {
  console.error("DASHSCOPE_API_KEY 为空——.env 里的变量要 set -a 导出");
  process.exit(2);
}

const files: string[] = JSON.parse(readFileSync(listPath, "utf8"));
// describePass=always：粗筛要的是"有没有灯"，第二遍逐框描述能把地图标记的形状说清楚，便于人眼复核
const provider = createDashScopeVisionProvider({ apiKey, describePass: "always" });

interface Row {
  file: string;
  items: number;
  warn: number;
  lights: string[];
  error?: string;
}

const rows: Row[] = [];
for (const [i, f] of files.entries()) {
  const name = f.split("/").pop()!;
  try {
    const obs = await observePhoto(readFileSync(f), provider);
    const warn = obs.items.filter((it) => it.category === "warning_light");
    rows.push({ file: f, items: obs.items.length, warn: warn.length, lights: warn.map((w) => `${w.color}/${w.state}/${w.shape}`) });
  } catch (e) {
    rows.push({ file: f, items: 0, warn: -1, lights: [], error: String(e).slice(0, 160) });
  }
  const r = rows.at(-1)!;
  console.log(`[${i + 1}/${files.length}] ${name}  警示灯 ${r.warn < 0 ? "失败" : r.warn}  ${r.lights.join(" ")}`);
}
writeFileSync(outPath, JSON.stringify(rows, null, 1));
const clean = rows.filter((r) => r.warn === 0).length;
console.log(`\n零警示灯 ${clean} / ${rows.length}（候选负样本）；失败 ${rows.filter((r) => r.warn < 0).length}`);
console.log(`→ ${outPath}`);
