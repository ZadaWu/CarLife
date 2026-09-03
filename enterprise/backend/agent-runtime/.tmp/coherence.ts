/**
 * 连贯性探针（M18-09 走查：「东聊一句，西聊一句」）。
 * 对照两版：A = 旧的 avoid 黑名单；B = 新的多轮上文回填。
 */
import { createDeepSeek } from "@ai-sdk/deepseek";
import { generateText } from "ai";
import { readFileSync } from "node:fs";
import { DEFAULT_DEEPSEEK_MODEL } from "../../../../contracts/src/constants/index";

for (const line of readFileSync("../../../.env", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const { GUIDE_SYSTEM, guideMessages, rejectGuideText } = await import("../src/sidecar/l1");
const model = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY! })(
  DEFAULT_DEEPSEEK_MODEL,
);

const OLD_SYSTEM = [
  "你是车载助手的陪聊。车主问了个问题，另一个助手正在查，你负责在这几秒里说句闲话。",
  "关于你自己的事实（不是要求，是你的实际处境）：",
  "- 你不知道车主问了什么，你也帮不上他那个忙。",
  "- 你只知道他话里提到的一个地名，除此之外你什么都不知道。",
  "- 你没有查过任何资料，你说的只是一般人对这个地方的印象。",
  "你要做的：就那个地名说一句有点意思的闲话——风物、吃食、气候、市井、地貌都行。",
  "不说店名、景点全名、街道名。不说任何数字。不推荐、不建议。",
  "一句话，30 字以内，口语，句尾不要问号。",
].join("\n");

const PLACES = ["深圳", "苏州", "重庆", undefined];
const N = 5;

for (const place of PLACES) {
  console.log(`\n########## ${place ?? "(无地名)"} ##########`);

  // A：旧版 —— avoid 黑名单，每次单轮
  const a: string[] = [];
  for (let i = 0; i < N; i += 1) {
    const lines = [`现在是2026年8月。`, place ? `车主话里提到的地方：${place}` : "车主话里没有提到任何地方。"];
    if (a.length) { lines.push("", "刚才已经说过这些，换个角度："); for (const s of a.slice(-4)) lines.push(`- ${s}`); }
    lines.push("", "说一句。");
    const { text } = await generateText({ model, system: OLD_SYSTEM, prompt: lines.join("\n"), temperature: 1 });
    a.push(text.trim());
  }
  console.log("--- A 旧：avoid 黑名单 ---");
  a.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));

  // B：新版 —— 多轮上文回填
  const b: string[] = [];
  for (let i = 0; i < N; i += 1) {
    const msgs = guideMessages({ ...(place ? { place } : {}), nowText: "2026年8月", said: b });
    const { text } = await generateText({ model, system: GUIDE_SYSTEM, messages: msgs as never, temperature: 1 });
    const t = text.trim();
    const bad = rejectGuideText(t);
    b.push(t);
    if (bad) console.log(`  (B#${i + 1} 会被拒：${bad})`);
  }
  console.log("--- B 新：多轮上文回填 ---");
  b.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
}
