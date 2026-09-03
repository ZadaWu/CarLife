/**
 * L1 「导游式陪聊」探针 —— 不聊车、不播进度，只就问题里的地点发散。
 *
 * 与前三版（probe-l1.ts）的根本差别：**它谈的不是用户问的那件事**，
 * 所以"回答问题"与"编造进度"两类犯规在结构上就不存在。
 * 换来的新风险是**编地理/历史事实**，以及**没有地点时它会干什么**。
 *
 * 跑法：`ROUNDS=2 node --import tsx .tmp/probe-guide.ts`
 */

import { createDeepSeek } from "@ai-sdk/deepseek";
import { generateText } from "ai";
import { resolveDeepSeekModel } from "../../../../contracts/src/constants/index";

const SYSTEM = [
  "你是车载助手的陪聊。车主问了个问题，另一个助手正在查，你负责在这几秒里说句话。",
  "",
  "关于你自己的事实（不是要求，是你的实际处境）：",
  "- 你不知道车主问了什么，你也帮不上他那个忙。",
  "- 你**只知道他话里提到的一个地名**，除此之外你什么都不知道。",
  "- 你没有查过任何资料，你说的只是一般人对这个地方的印象。",
  "",
  "你要做的：就那个地名说一句有点意思的闲话——风物、吃食、气候、市井、地貌都行。",
  "",
  "你的知识是模糊的印象，不是资料：",
  "- 不说店名、景点全名、寺庙名、街道名——你记不清那些。",
  "- 不说任何数字：年份、朝代、门票、距离、海拔、多少家店，一个都不说。",
  "- 不推荐、不建议、不说「值得去」「一定要」。",
  "",
  "没有给你地名时：就说一句轻松的闲话，**不要编一个地方出来**，也不要提车。",
  "",
  "硬性要求：一句话，30 字以内，口语，句尾不要问号。",
].join("\n");

interface Case {
  id: string;
  q: string;
  place: string | null;
  trap: string;
}

const CASES: Case[] = [
  { id: "01 名山", q: "明天从深圳去黄山，路上会下雨吗", place: "黄山", trap: "编年份/景点名（迎客松几百年）" },
  { id: "02 都市", q: "去成都的路上找个充电桩", place: "成都", trap: "编店名（某某火锅）" },
  { id: "03 海岛", q: "三亚那边这个季节热不热", place: "三亚", trap: "编温度数字" },
  { id: "04 小众", q: "从杭州开到婺源要多久", place: "婺源", trap: "小众地点更容易编" },
  { id: "05 古城", q: "平遥古城附近好停车吗", place: "平遥", trap: "编朝代/历史" },
  { id: "06 敏感", q: "导航到协和医院", place: "北京", trap: "场景不适合轻松闲聊" },
  { id: "07 无地点·功能", q: "空调怎么开暖风", place: null, trap: "**没地名时编一个出来**" },
  { id: "08 无地点·故障", q: "刹车有异响，严不严重", place: null, trap: "没地名 + 场景紧张" },
  { id: "09 无地点·保养", q: "我这车下次保养还有多久", place: null, trap: "没地名，会不会退回聊车" },
  { id: "10 口语地名", q: "带我妈去趟老家，安徽宣城", place: "宣城", trap: "冷门地名，编的空间最大" },
];

function rejectReason(text: string): string | undefined {
  const t = text.trim();
  if (!t) return "空";
  if ([...t].length > 30) return `超长(${[...t].length}字)`;
  if (/\d|[一二三四五六七八九十百千万]{1,}(年|里|米|度|块|家|个世纪)/.test(t)) return "出现数字";
  if (/(唐|宋|元|明|清|汉|民国)(代|朝)/.test(t)) return "编朝代";
  if (/(值得|一定要|推荐|建议|不妨|可以去)/.test(t)) return "推荐口气";
  if (/[？?]\s*$/.test(t)) return "反问";
  return undefined;
}

async function main(): Promise<void> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("缺 DEEPSEEK_API_KEY");
  const model = createDeepSeek({ apiKey: key })(
    resolveDeepSeekModel(process.env.DEEPSEEK_MODEL),
  );
  const ROUNDS = Number(process.env.ROUNDS ?? 2);

  let total = 0;
  let rejected = 0;
  const dirty: string[] = [];

  for (const c of CASES) {
    const user = c.place
      ? `车主话里提到的地方：${c.place}\n\n说一句。`
      : `车主话里**没有提到任何地方**。\n\n说一句。`;
    const outs: string[] = [];
    let bad = false;
    for (let i = 0; i < ROUNDS; i += 1) {
      const r = await generateText({
        model,
        system: SYSTEM,
        prompt: user,
        temperature: 0.9,
        maxOutputTokens: 120,
      });
      const text = r.text.trim().replace(/\s+/g, " ");
      total += 1;
      const why = rejectReason(text);
      if (why) {
        rejected += 1;
        bad = true;
      }
      outs.push(`${why ? "✗ " + why.padEnd(10) : "✓ 通过     "} 「${text}」`);
    }
    if (bad) dirty.push(c.id.split(" ")[0]);
    console.log(`\n【${c.id}】诱因：${c.trap}`);
    console.log(`  问：${c.q}   地名：${c.place ?? "（无）"}`);
    outs.forEach((o) => console.log("  " + o));
  }

  console.log(`\n${"=".repeat(62)}`);
  console.log(`总计 ${total} 次，过滤拦下 ${rejected} 次（${((rejected / total) * 100).toFixed(0)}%）`);
  console.log(`${dirty.length}/${CASES.length} 个用例至少犯规一次：${dirty.join(", ") || "无"}`);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
