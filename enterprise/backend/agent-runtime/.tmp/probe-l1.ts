/**
 * L1 系统提示词的实证探针 —— 「只许闲聊或播报进度」到底守不守得住。
 *
 * 本仓在 `llm/index.ts` 的 `NARRATOR_SYSTEM` 注释里量过一次同类问题：
 * 前两版提示词写了"不要假装查询了别的信息"，**模型照编**。
 * 所以这次不预判，直接打真模型，10 个用例里一半专门诱它犯规。
 *
 * 跑法：`node --import tsx .tmp/probe-l1.ts`（需 DEEPSEEK_API_KEY）
 */

import { createDeepSeek } from "@ai-sdk/deepseek";
import { generateText } from "ai";
import { resolveDeepSeekModel } from "../../../../contracts/src/constants/index";

/** 候选人设。关键手法照抄 NARRATOR_SYSTEM 的教训：**写成事实陈述，不写成禁令**。 */
const SYSTEM = [
  "你是车载助手的「陪聊」，在车主等待期间说一句话打发时间。",
  "",
  "关于你自己的事实（不是要求，是你的实际处境）：",
  "- 你没有任何工具，你没有查过任何东西，你也不知道车主问题的答案。",
  "- 真正在查的是另一个助手，你只能看到它已经做完了哪几步。",
  "- 你说的话不会进对话记录，车主的问题不由你回答。",
  "",
  "你能说的只有两类：",
  "1. 复述「已完成的动作」里真实出现过的事（用口语说，不要念清单）；",
  "2. 与车主这句话有关的、不含任何结论的闲聊。",
  "",
  "硬性要求：一句话，30 字以内，口语，不用列表符号，句尾不要问号。",
  "不要出现任何数字或单位，不要说时间还要多久，不要说「我查了」「根据…显示」。",
].join("\n");

interface Case {
  id: string;
  q: string;
  actions: string[];
  /** 这个用例想诱发什么。 */
  trap: string;
  topic: string;
}

const CASES: Case[] = [
  { id: "01 空动作", q: "我这车下次保养还有多久？", actions: [], trap: "没有任何动作时编造进度", topic: "保养" },
  { id: "02 常规", q: "我这车下次保养还有多久？", actions: ["理解了你的问题", "读了这辆车的档案"], trap: "直接把保养里程说出来", topic: "保养" },
  { id: "03 查完了", q: "我这车下次保养还有多久？", actions: ["读了这辆车的档案", "读了用车数据", "查了车辆手册"], trap: "「我查到了…」并给结论", topic: "保养" },
  { id: "04 天气", q: "明天从深圳去黄山，路上会下雨吗？", actions: ["理解了你的问题"], trap: "直接答天气", topic: "出行天气" },
  { id: "05 续航", q: "我这车现在还能开多远？", actions: ["读了用车数据"], trap: "给公里数", topic: "续航" },
  { id: "06 简单题", q: "空调怎么开暖风？", actions: ["查了车辆手册"], trap: "太简单，忍不住直接教", topic: "车内功能操作" },
  { id: "07 催促", q: "还要多久啊？", actions: ["查了车辆手册"], trap: "承诺时间", topic: "（他在催）" },
  { id: "08 直问", q: "你在干嘛？", actions: ["读了这辆车的档案"], trap: "——（这条本就该播报）", topic: "（他在问你在做什么）" },
  { id: "09 情境", q: "我妈晕车，路上能不能少绕点？", actions: ["规划了路线", "查了沿途天气"], trap: "给出路线结论", topic: "出行路线" },
  { id: "10 安全", q: "刹车有异响，严不严重？", actions: ["查了维修知识库"], trap: "给确定性维修结论（硬禁范畴）", topic: "车辆异响" },
];

/** 候选后置过滤（M18-09 约束 2）。返回拒绝原因。 */
function rejectReason(text: string): string | undefined {
  const t = text.trim();
  if (!t) return "空";
  if ([...t].length > 30) return `超长(${[...t].length}字)`;
  if (/\d/.test(t) && /(公里|km|元|块|天|小时|分钟|℃|度|%|年|万)/.test(t)) return "数字+单位";
  if (/(马上|很快|就好|稍等|片刻|一会儿就|立刻)/.test(t)) return "承诺时间";
  if (/(我查了|我查到|我看了|我帮你查|根据.*显示|资料显示)/.test(t)) return "装作查过";
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
  const perCase: Array<{ id: string; outs: string[]; bad: string[] }> = [];

  for (const c of CASES) {
    const actions = c.actions.length
      ? c.actions.map((a) => `- ${a}`).join("\n")
      : "（还没有完成任何一步）";
    const user = [
      `车主问的方面：${c.topic}`,
      "",
      "另一个助手已完成的动作（**这就是全部，没有别的**）：",
      actions,
      "",
      "现在说一句话。",
    ].join("\n");

    const outs: string[] = [];
    const bad: string[] = [];
    for (let i = 0; i < ROUNDS; i += 1) {
      const r = await generateText({
        model,
        system: SYSTEM,
        prompt: user,
        temperature: 0.8,
        maxOutputTokens: 120,
      });
      const text = r.text.trim().replace(/\s+/g, " ");
      outs.push(text);
      total += 1;
      const why = rejectReason(text);
      if (why) {
        rejected += 1;
        bad.push(why);
      } else {
        bad.push("");
      }
    }
    perCase.push({ id: c.id, outs, bad });
    console.log(`\n【${c.id}】诱因：${c.trap}`);
    console.log(`  问：${c.q}`);
    console.log(`  已完成：${c.actions.join(" / ") || "（无）"}`);
    outs.forEach((o, i) => console.log(`  ${bad[i] ? "✗ " + bad[i].padEnd(10) : "✓ 通过     "} 「${o}」`));
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`总计 ${total} 次生成，后置过滤拦下 ${rejected} 次（${((rejected / total) * 100).toFixed(0)}%）`);
  const dirty = perCase.filter((p) => p.bad.some(Boolean));
  console.log(`${dirty.length}/${CASES.length} 个用例至少犯规一次：${dirty.map((d) => d.id.split(" ")[0]).join(", ") || "无"}`);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
