/**
 * 温度扫描（M18-09）：默认温度下同一句会一字不差地重复，必须调高；
 * 但调高会不会把"编造具体事实"放回来？这是判据。
 */
import { createDeepSeek } from "@ai-sdk/deepseek";
import { generateText } from "ai";
import { readFileSync } from "node:fs";
import { DEFAULT_DEEPSEEK_MODEL } from "../../../../contracts/src/constants/index";

for (const line of readFileSync("../../../.env", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const { GUIDE_SYSTEM, guidePrompt, rejectGuideText } = await import("../src/sidecar/l1");
const model = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY! })(
  DEFAULT_DEEPSEEK_MODEL,
);

const PLACES = ["深圳", "广州南沙", "苏州", "洛阳", "重庆", "厦门", "西安", "婺源", "大理", undefined];
const TEMPS = [0.8, 1.0, 1.3];

for (const temperature of TEMPS) {
  let rejected = 0;
  let dup = 0;
  const all: string[] = [];
  const lines: string[] = [];
  for (const place of PLACES) {
    const said: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { text } = await generateText({
        model,
        system: GUIDE_SYSTEM,
        prompt: guidePrompt({ ...(place ? { place } : {}), nowText: "2026年8月", avoid: [...said] }),
        temperature,
      });
      const t = text.trim();
      const bad = rejectGuideText(t);
      if (bad) rejected += 1;
      if (said.includes(t)) dup += 1;
      said.push(t);
      all.push(t);
      lines.push(`  ${place ?? "(无地名)"} #${i + 1} ${bad ? "✖" + bad : "✓"} ${t}`);
    }
  }
  console.log(`\n===== temperature=${temperature}  共 ${all.length} 句 | 被拒 ${rejected} | 重复 ${dup} =====`);
  console.log(lines.join("\n"));
}
