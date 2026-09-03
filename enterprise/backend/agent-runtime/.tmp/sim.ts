import { sidecarDefaults } from "../src/sidecar/budget";
import { suppressReason } from "../src/sidecar/silence";
import { renderFiller, phaseOf, type Phase } from "../src/sidecar/templates";

/** 一轮 60 秒的等待：按实测形状铺事件（fan-out + RAG，尾部长时间无事件）。 */
const EVENTS: Array<[number, string]> = [
  [1700, "acp.session_new"],
  [3200, "llm.supervisor-intent"],
  [3250, "route"],
  [3300, "tool.vehicle_profile"],
  [3350, "tool.usage_profile"],
  [12000, "tool.ragflow_retrieve"],
  [30000, "merge"],
];
const TOTAL = 60_000;

function sim(cfg: ReturnType<typeof sidecarDefaults>, label: string) {
  const spoken = new Map<Phase, number>();
  const signals: Array<{ name?: string }> = [];
  let spokenCount = 0, lastSpokeAt = 0, firstSpokeAt = 0;
  const said: Array<[number, string]> = [];
  let ei = 0;

  for (let t = 0; t <= TOTAL; t += cfg.tickMs) {
    while (ei < EVENTS.length && EVENTS[ei][0] <= t) signals.push({ name: EVENTS[ei++][1] });
    const r = suppressReason(
      { lastUserFacingAt: 0, spokenCount, lastSpokeAt, firstSpokeAt, mutedBy: new Set(), closed: false },
      t, cfg,
    );
    if (r) continue;
    const d = renderFiller(signals, spoken);
    if (!d) continue;
    spoken.set(d.phase, d.ordinal);
    spokenCount += 1; lastSpokeAt = t; if (!firstSpokeAt) firstSpokeAt = t;
    said.push([t, d.text]);
  }

  console.log(`\n=== ${label} ===`);
  said.forEach(([t, x]) => console.log(`  +${String(t).padStart(5)}ms  ${x}`));
  const gaps: number[] = [];
  for (let i = 1; i < said.length; i++) gaps.push(said[i][0] - said[i - 1][0]);
  gaps.push(TOTAL - (said.at(-1)?.[0] ?? 0));
  console.log(`  共 ${said.length} 句 | 最大空档 ${Math.max(...gaps, 0) / 1000}s | 最后一句在 +${(said.at(-1)?.[0] ?? 0) / 1000}s`);
}

sim(sidecarDefaults(), "当前默认（maxTotalMs=20s, maxPerTurn=4, minGap=2.5s）");
