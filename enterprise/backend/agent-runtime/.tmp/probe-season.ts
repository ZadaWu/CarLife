import { createDeepSeek } from "@ai-sdk/deepseek";
import { generateText } from "ai";
import { resolveDeepSeekModel } from "../../../../contracts/src/constants/index";

const BASE = [
  "你是车载助手的陪聊。车主问了个问题，另一个助手正在查，你负责在这几秒里说句话。",
  "关于你自己的事实：你不知道车主问了什么，只知道他话里提到的一个地名，没查过任何资料。",
  "就那个地名说一句有点意思的闲话——风物、吃食、气候、市井、地貌都行。",
  "不说店名、景点全名、寺庙名；不说任何数字（年份、朝代、门票、距离、海拔）。",
  "不推荐、不建议、不说「值得去」。一句话，30 字以内，口语，句尾不要问号。",
];
/** v5：把「现在是什么时候」写成事实，并且明说不确定时令就别提。 */
const WITH_DATE = (now: string) => [
  ...BASE,
  `现在是${now}。**你只知道这一点**——`,
  "说季节、花期、时令吃食之前先想想对不对；拿不准就不要提时令，说点四季都成立的。",
].join("\n");

const PLACES = ["婺源", "北京", "洛阳", "大理"];
const now = new Date();
const nowText = `${now.getFullYear()}年${now.getMonth() + 1}月`;
const SEASON = /(春|夏|秋|冬|油菜花|樱花|红叶|梅雨|三伏|开得正|花期|这个季节|这时候)/;

async function main() {
  const model = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY! })(
    resolveDeepSeekModel(process.env.DEEPSEEK_MODEL),
  );
  for (const [label, system] of [["无日期（v4）", BASE.join("\n")], [`有日期（${nowText}）`, WITH_DATE(nowText)]] as const) {
    console.log(`\n=== ${label} ===`);
    let hits = 0;
    for (const p of PLACES) {
      for (let i = 0; i < 2; i++) {
        const r = await generateText({ model, system, prompt: `车主话里提到的地方：${p}\n\n说一句。`, temperature: 0.9, maxOutputTokens: 100 });
        const t = r.text.trim().replace(/\s+/g, " ");
        const s = SEASON.test(t);
        if (s) hits++;
        console.log(`  ${s ? "⚠ 提了时令" : "· 无时令  "} ${p}：「${t}」`);
      }
    }
    console.log(`  → 8 句里 ${hits} 句提到时令`);
  }
}
void main().catch((e) => { console.error(e); process.exit(1); });
