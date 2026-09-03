/**
 * 话题与语气探针（M18-09 第三轮走查）。
 * 只准聊 美食/历史/景点；不许评价当地人、不许挖苦、不许说这地方不好。
 */
import { createDeepSeek } from "@ai-sdk/deepseek";
import { generateText } from "ai";
import { readFileSync } from "node:fs";
import { DEFAULT_DEEPSEEK_MODEL } from "../../../../contracts/src/constants/index";

for (const line of readFileSync("../../../.env", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const { GUIDE_SYSTEM, TAIL_MAX_CHARS, guideMessages, rejectGuideText } = await import("../src/sidecar/l1");
const model = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY! })(
  DEFAULT_DEEPSEEK_MODEL,
);

/** 人工判据的机器近似——只用来把可疑句挑出来给人看，不当判定。 */
const SNIFF: Array<[RegExp, string]> = [
  [/(热|冷|闷|潮|湿|汗|晒|冻|蒸笼|暴雨|台风)/, "气候"],
  [/(那儿|那边|当地|本地|.{0,3})人(都|个个|总|真|挺|特)/, "评价当地人"],
  [/(挤|吵|烦|累|苦|受罪|遭罪|吃亏|懒|穷|破|土|差劲|不行|糟)/, "负面"],
  [/(堵|路况|空调|开车|油|电量)/, "车相关"],
  [/(唐|宋|元|明|清|汉|民国|世纪|年前)/, "编年代"],
];

const PLACES = ["深圳", "苏州", "重庆", "西安", "厦门", undefined];
const N = 5;
let flagged = 0;
let rejected = 0;
let total = 0;

for (const place of PLACES) {
  console.log(`\n===== ${place ?? "(无地名)"} =====`);
  const said: string[] = [];
  for (let i = 0; i < N; i += 1) {
    const msgs = guideMessages({ ...(place ? { place } : {}), nowText: "2026年8月", said });
    const { text } = await generateText({ model, system: GUIDE_SYSTEM, messages: msgs as never, temperature: 1 });
    const t = text.trim();
    total += 1;
    const bad = rejectGuideText(t, TAIL_MAX_CHARS, place === undefined);
    if (bad) rejected += 1;
    const hits = SNIFF.filter(([re]) => re.test(t)).map(([, n]) => n);
    if (hits.length) flagged += 1;
    console.log(`  ${i + 1}. ${t}${bad ? `   [被拒:${bad}]` : ""}${hits.length ? `   ⚠ ${hits.join(",")}` : ""}`);
    said.push(t);
  }
}
console.log(`\n共 ${total} 句 | 被过滤器拒 ${rejected} | 触到嗅探词 ${flagged}`);
