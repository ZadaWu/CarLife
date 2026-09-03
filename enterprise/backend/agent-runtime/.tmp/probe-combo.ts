import { createDeepSeek } from "@ai-sdk/deepseek";
import { generateText } from "ai";
import { resolveDeepSeekModel } from "../../../../contracts/src/constants/index";

const PROGRESS: Record<string, string> = {
  understanding: "后台已经开始处理您的需求",
  routing: "后台已经知道该查哪儿了",
  profile: "后台正在看您这辆车的档案",
  retrieval: "后台正在翻您这车的手册",
  composing: "后台查完了，正在整理",
};
const BRIDGE = "，要不我先跟您聊会天：";

const SYSTEM = [
  "你是车载助手的陪聊。车主问了个问题，另一个助手正在查，你负责在这几秒里说句闲话。",
  "关于你自己的事实：你不知道车主问了什么，只知道他话里提到的一个地名，没查过任何资料。",
  "就那个地名说一句有点意思的闲话——风物、吃食、气候、市井、地貌都行。",
  "不说店名、景点全名、寺庙名；不说任何数字（年份、朝代、门票、距离、海拔）。",
  "不推荐、不建议、不说「值得去」。",
  "你这句话会被接在「…要不我先跟您聊会天：」后面，所以直接从内容说起，",
  "不要再说「好的」「那我说说」这类开场。",
  "没有地名时：说一句轻松的闲话，不要编地方，也不要提车。",
  "一句话，25 字以内，口语，句尾不要问号。",
].join("\n");

const CASES: Array<{ phase: string; place: string | null; note: string }> = [
  { phase: "understanding", place: "黄山", note: "第 1 句 · 有地名" },
  { phase: "retrieval", place: "成都", note: "第 1 句 · 检索中" },
  { phase: "understanding", place: null, note: "第 1 句 · 无地名" },
  { phase: "profile", place: "婺源", note: "第 1 句 · 冷门地名" },
  { phase: "composing", place: "大理", note: "第 1 句 · 快出结果" },
  { phase: "understanding", place: "宣城", note: "第 1 句 · 口语地名" },
];

const now = new Date();
const DATE = `${now.getFullYear()}年${now.getMonth() + 1}月`;

async function main() {
  const model = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY! })(
    resolveDeepSeekModel(process.env.DEEPSEEK_MODEL),
  );
  const lens: number[] = [];
  for (const c of CASES) {
    const prompt = c.place
      ? `现在是${DATE}。车主话里提到的地方：${c.place}\n\n说一句。`
      : `现在是${DATE}。车主话里没有提到任何地方。\n\n说一句。`;
    const r = await generateText({ model, system: SYSTEM, prompt, temperature: 0.9, maxOutputTokens: 100 });
    const tail = r.text.trim().replace(/\s+/g, " ");
    const full = PROGRESS[c.phase] + BRIDGE + tail;
    lens.push([...full].length);
    console.log(`\n【${c.note}】`);
    console.log(`  ${full}`);
    console.log(`  （共 ${[...full].length} 字，其中模型写的 ${[...tail].length} 字）`);
  }
  console.log(`\n第 1 句长度：最短 ${Math.min(...lens)} / 最长 ${Math.max(...lens)} 字`);
}
void main().catch((e) => { console.error(e); process.exit(1); });
