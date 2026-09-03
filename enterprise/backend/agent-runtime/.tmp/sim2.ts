import { renderFiller, type Phase } from "../src/sidecar/templates";
import { FILLER_PHRASE } from "@carlife/shared";

const EVENTS: Array<[number, string]> = [
  [1700, "acp.session_new"], [3200, "llm.supervisor-intent"], [3250, "route"],
  [3300, "tool.vehicle_profile"], [3350, "tool.usage_profile"],
  [12000, "tool.ragflow_retrieve"], [30000, "merge"],
];
const TOTAL = 60_000, TICK = 700, SILENCE = 1500;

function sim(base: number, factor: number, cap: number, maxPerTurn: number, maxTotalMs: number, label: string) {
  const spoken = new Map<Phase, number>();
  const signals: Array<{ name?: string }> = [];
  let n = 0, lastAt = 0, firstAt = 0, ei = 0, exhausted = 0;
  const said: Array<[number, string]> = [];

  for (let t = 0; t <= TOTAL; t += TICK) {
    while (ei < EVENTS.length && EVENTS[ei][0] <= t) signals.push({ name: EVENTS[ei++][1] });
    if (t < SILENCE) continue;
    if (n >= maxPerTurn) continue;
    if (firstAt && t - firstAt >= maxTotalMs) continue;
    if (n > 0 && t - lastAt < Math.min(base * factor ** (n - 1), cap)) continue;
    const d = renderFiller(signals, spoken);
    if (!d) { exhausted++; continue; }
    spoken.set(d.phase, d.ordinal);
    n++; lastAt = t; if (!firstAt) firstAt = t;
    said.push([t, d.text]);
  }
  const gaps: number[] = [];
  for (let i = 1; i < said.length; i++) gaps.push(said[i][0] - said[i - 1][0]);
  gaps.push(TOTAL - (said.at(-1)?.[0] ?? 0));
  console.log(label);
  said.forEach(([t, x]) => console.log(`   +${String(t).padStart(5)}ms  ${x}`));
  console.log(`   → ${said.length} 句 | 最大空档 ${(Math.max(...gaps, 0) / 1000).toFixed(1)}s | 末句 +${((said.at(-1)?.[0] ?? 0) / 1000).toFixed(1)}s | 没词可说而跳过 ${exhausted} 次\n`);
}

console.log("L0 词池：" + Object.entries(FILLER_PHRASE).map(([k, v]) => `${k}×${v.length}`).join("  ") + "  共 " +
  Object.values(FILLER_PHRASE).reduce((a, b) => a + b.length, 0) + " 句\n");
sim(2500, 1.0, 2500, 4, 20_000, "A 当前默认（无递增）");
sim(2500, 1.6, 10_000, 8, 90_000, "B 递增 1.6 / 封顶 10s / 8 句 / 90s");
sim(2500, 1.45, 8_000, 10, 90_000, "C 递增 1.45 / 封顶 8s / 10 句 / 90s");
