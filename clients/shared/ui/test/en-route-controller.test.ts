/**
 * [F-62-08][F-62-09][F-62-15][AC-62-1][AC-62-2][AC-62-5][AC-62-6][AC-62-10] 途中提醒控制器（M77-06）。
 * 假时钟 + 假 speak：出卡出声一次、15 s 收胶囊、越段清卡、连续驾驶两个出口、到站在飞顺延、speak 回 false 当只卡片。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { NavTripProgress } from "../src/map";
import { createEnRouteController, type EnRouteCard, type EnRouteEvent } from "../src/hud/en-route-controller";

const frame = (remainingM: number, remainingSec: number | undefined, next = "云龙湖旅游景区", extra: Partial<NavTripProgress> = {}): NavTripProgress => ({
  nextStopName: next,
  remainingM,
  ...(remainingSec !== undefined ? { remainingSec } : {}),
  finished: false,
  ...extra,
});
const LEGS = [{ day: 1, fromStop: "杭州", toStop: "云龙湖旅游景区", driveMinutes: 120, reason: "rest" as const }];

function harness(opts: { speakOk?: boolean; inFlight?: () => boolean; limitMin?: number; noSpeak?: boolean } = {}) {
  let t = 1_000;
  const spoken: string[] = [];
  const cards: Array<EnRouteCard | undefined> = [];
  const events: EnRouteEvent[] = [];
  const c = createEnRouteController({
    legs: LEGS,
    limitMin: opts.limitMin,
    now: () => t,
    speak: opts.noSpeak
      ? undefined
      : async (line) => {
          spoken.push(line);
          return opts.speakOk ?? true;
        },
    isInFlight: opts.inFlight,
    onCard: (card) => cards.push(card),
    onEvent: (e) => events.push(e),
  });
  return { c, spoken, cards, events, advance: (ms: number) => (t += ms), now: () => t };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("[F-62-08][F-62-09][AC-62-1][AC-62-2][AC-62-5][AC-62-6] 停靠提前提醒 → 卡 + 声", () => {
  it("远时不出；进提前量出一张卡并说一句（含 ETA）；同站不再出；15 s 后收成胶囊；越段清卡", async () => {
    const h = harness();
    h.c.onProgress(frame(30_000, 1_500));
    assert.equal(h.c.state().card, undefined);
    h.advance(1_000);
    h.c.onProgress(frame(14_000, 590));
    const card = h.c.state().card!;
    assert.equal(card.reminder.kind, "stop");
    assert.equal(card.gate, "speak");
    await flush();
    assert.equal(h.spoken.length, 1);
    assert.match(h.spoken[0]!, /^前面 14 公里是 云龙湖旅游景区，按计划在这歇一下 · 预计 \d\d:\d\d 到$/);
    assert.match(card.text.caption ?? "", /同行者约束/ === null ? /x/ : /.*/); // 未传 limitMin → 无依据行
    assert.equal(card.text.caption, undefined);
    assert.equal(h.c.state().card?.spoken, true);
    // 再来几帧：同一站不再出第二张
    h.advance(1_000);
    h.c.onProgress(frame(13_000, 550));
    assert.equal(h.spoken.length, 1);
    // 15 s 后收胶囊
    h.advance(15_000);
    h.c.tick();
    assert.equal(h.c.state().card?.collapsed, true);
    assert.ok(h.events.some((e) => e.type === "collapse"));
    // 越过这一站：卡清掉
    h.c.onProgress(frame(40_000, 2_000, "户部山", { arrivedStopName: "云龙湖旅游景区" }));
    assert.equal(h.c.state().card, undefined);
  });

  it("speak 回 false（被正文顶掉）：卡仍在、spoken=false；不传 speak（手机端）：只卡不声", async () => {
    const h = harness({ speakOk: false });
    h.c.onProgress(frame(14_000, 590));
    await flush();
    assert.equal(h.c.state().card?.spoken, false);
    assert.ok(h.events.some((e) => e.type === "spoken" && e.ok === false));
    const m = harness({ noSpeak: true });
    m.c.onProgress(frame(14_000, 590));
    await flush();
    assert.ok(m.c.state().card);
    assert.equal(m.spoken.length, 0);
  });

  it("到站播报在飞 → 顺延不出卡；回完后下一帧出", () => {
    let inFlight = true;
    const h = harness({ inFlight: () => inFlight });
    h.c.onProgress(frame(14_000, 590));
    assert.equal(h.c.state().card, undefined);
    assert.ok(h.events.some((e) => e.type === "gate" && e.gate === "defer"));
    inFlight = false;
    h.advance(1_000);
    h.c.onProgress(frame(13_500, 580));
    assert.equal(h.c.state().card?.gate, "speak");
  });

  it("知道了 → 清卡；关掉开关 → 清卡且不再判", () => {
    const h = harness();
    h.c.onProgress(frame(14_000, 590));
    assert.ok(h.c.state().card);
    h.c.ack();
    assert.equal(h.c.state().card, undefined);
    h.c.setEnabled(false);
    h.advance(1_000);
    h.c.onProgress(frame(13_000, 500, "户部山"));
    assert.equal(h.c.state().card, undefined);
  });
});

describe("[F-62-08][F-62-09][AC-62-1][AC-62-2][AC-62-5][AC-62-6] 连续驾驶提醒", () => {
  it("本段 ≥ 90% 且前方来不及 → alert 卡、一句话、依据行带上限；「不用」→ 本段静默；越段后恢复", async () => {
    const h = harness({ limitMin: 120 });
    h.c.onProgress(frame(60_000, 3_600));
    h.advance(110 * 60_000);
    h.c.onProgress(frame(30_000, 1_800));
    const card = h.c.state().card!;
    assert.equal(card.reminder.kind, "rest");
    assert.match(card.text.headline, /已经开了 1 小时 50 分/);
    assert.match(card.text.body!, /前面 30 公里有 云龙湖旅游景区，要不要歇一下/);
    assert.match(card.text.caption!, /每 2 小时 停一次 · 已到 92%/);
    await flush();
    assert.equal(h.spoken.length, 1);
    assert.ok(!/累|疲劳/.test(h.spoken[0]!));
    h.c.decideRest(false);
    assert.equal(h.c.state().card, undefined);
    h.advance(60_000);
    h.c.tick();
    assert.equal(h.c.state().card, undefined, "拒绝后本段不再催");
    // 越段 → 新段从头计
    h.c.onProgress(frame(50_000, 3_000, "户部山", { arrivedStopName: "云龙湖旅游景区" }));
    h.advance(10 * 60_000);
    h.c.tick();
    assert.equal(h.c.state().card, undefined);
  });

  it("只需要时钟：没有帧、位置陈旧也能催（tick）", () => {
    const h = harness({ limitMin: 120 });
    h.c.onProgress(frame(60_000, undefined));
    h.advance(115 * 60_000);
    h.c.tick();
    const card = h.c.state().card!;
    assert.equal(card.reminder.kind, "rest");
    assert.equal(card.text.body, "要不要找个地方歇一下", "位置陈旧不带距离与站名");
  });

  it("「闭嘴」→ 清卡且本段不再提醒", () => {
    const h = harness({ limitMin: 120 });
    h.c.onProgress(frame(60_000, 3_600));
    h.advance(110 * 60_000);
    h.c.tick();
    assert.ok(h.c.state().card);
    h.c.hush();
    assert.equal(h.c.state().card, undefined);
    h.advance(60_000);
    h.c.onProgress(frame(7_000, 400));
    assert.equal(h.c.state().card, undefined, "停靠提醒也被本段闭嘴挡住");
  });
});

describe("[F-62-08][F-62-09][AC-62-1][AC-62-2][AC-62-5][AC-62-6] 密度", () => {
  it("high 档：停靠提醒多带「下一段约 X」（有下一段才有）", async () => {
    let t = 1_000;
    const c = createEnRouteController({
      legs: [...LEGS, { day: 1, fromStop: "云龙湖旅游景区", toStop: "户部山", driveMinutes: 45 }],
      now: () => t,
    });
    c.setDensity("high");
    c.onProgress(frame(14_000, 590));
    assert.match(c.state().card?.text.caption ?? "", /下一段约 45 分/);
    t += 1;
    const solo = createEnRouteController({ legs: LEGS, now: () => t });
    solo.setDensity("high");
    solo.onProgress(frame(14_000, 590));
    assert.equal(solo.state().card?.text.caption, undefined, "没有下一段就不编");
  });
  it("low 档：停靠只卡不声；连续驾驶仍出声", async () => {
    const h = harness({ limitMin: 120 });
    h.c.setDensity("low");
    h.c.onProgress(frame(14_000, 590));
    await flush();
    assert.equal(h.c.state().card?.gate, "card-only");
    assert.equal(h.spoken.length, 0);
    h.c.ack();
    // 前方那站 590 s 就到，来得及歇——连续驾驶不催；换成一小时外的站再看
    h.c.onProgress(frame(60_000, 3_600, "户部山"));
    h.advance(110 * 60_000);
    h.c.tick();
    await flush();
    assert.equal(h.c.state().card?.reminder.kind, "rest");
    assert.equal(h.spoken.length, 1);
  });
});
