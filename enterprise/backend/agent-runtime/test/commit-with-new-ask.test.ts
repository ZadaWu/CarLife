/**
 * [F-58-11][AC-58-7] 一边认可一边补新要求（M77 走查追修）。
 *
 * 真跑 turn-75baf900：车主说「这样定了我们就这样定了**我们是走自驾啊**」。
 * 意图理解判得很准——constraints 里写着"自驾出行（不走高铁/飞机）"，
 * context 里也写了"同时明确交通方式是自驾"。而确认那条路**只读 action**，
 * 把按高铁排的那一版直接落了库，回一句"这个我这边没法直接改，您说一声「改成自驾」"。
 *
 * 两层防线：模型判 none 是主（提示词那一栏说明），把没进去的那几条列进弹窗是安全网。
 *
 * 安全网的判据换过一次（INC-0148）：第一版拿两轮 constraints 做集合差，
 * 上线当天在真跑 turn-fdde40ef 上误报 5/5——理由与实测见 `newAsksOf` 的注释。
 * 现在增量由模型自己报（`intent.newAsks`），编排层只消费。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildIntentInstruction, parseIntent } from "../src/graph/intent";
import { commitDisclosures, describeCommitted, newAsksOf } from "../src/graph/subgraphs/itinerary";
import type { TripPlanState } from "../src/graph/state";

const plan = (): TripPlanState => ({
  status: "refining",
  destination: "徐州",
  days: 4,
  skeleton: [{ day: 1, theme: "抵达", spots: [{ name: "云龙湖" }] }],
  caveats: [],
  updatedTurnId: "t1",
});

describe("[F-58-11] 第一层：提示词让模型判 none", () => {
  it("commit 那一栏点名「一边认可一边补新要求」的三种说法", () => {
    const instr = buildIntentInstruction();
    assert.match(instr, /一边认可一边补新要求/);
    assert.match(instr, /我们是走自驾啊/, "真跑那一句要在例子里");
    assert.match(instr, /不要的那一版/, "要说清后果，不然它不知道为什么");
    assert.match(instr, /只有认可、没有新要求时才是 commit/);
  });
});

describe("[F-58-11] 第二层：模型报的增量进弹窗，但不阻断", () => {
  it("模型报了就照单列出来", () => {
    assert.deepEqual(newAsksOf({ newAsks: ["自驾出行（不走高铁/飞机）"] }), ["自驾出行（不走高铁/飞机）"]);
  });

  it("没报就一条都不出——缺席、空数组、空白串都算没报", () => {
    assert.deepEqual(newAsksOf(undefined), []);
    assert.deepEqual(newAsksOf({}), []);
    assert.deepEqual(newAsksOf({ newAsks: [] }), []);
    assert.deepEqual(newAsksOf({ newAsks: ["  ", ""] }), []);
  });

  it("列进弹窗的是最后一行，天序与大交通照旧在前面", () => {
    const lines = commitDisclosures(plan(), ["自驾出行（不走高铁/飞机）"]);
    assert.equal(lines[lines.length - 1], "这一轮你还提到：自驾出行（不走高铁/飞机）");
    assert.ok(lines.some((l) => l.startsWith("第1天")), "逐日行还在");
  });

  it("不传新要求时，弹窗与从前逐字相同——安全网不该改老行为", () => {
    assert.deepEqual(commitDisclosures(plan()), commitDisclosures(plan(), []));
  });
});

describe("[F-58-11] 落了库也要说清哪条没进去", () => {
  it("禁掉「我改不了」那句假话，并给出下一步怎么说", () => {
    const text = describeCommitted(plan(), ["自驾出行（不走高铁/飞机）"]);
    assert.match(text, /没有.*照它改/);
    assert.match(text, /不要说自己改不了/, "真跑那句「这个我这边没法直接改」是假话——改行程一直是通的");
    assert.match(text, /改完再确认一次/);
  });

  it("没有新要求时，这一段不出现——老行为逐字不变", () => {
    assert.equal(describeCommitted(plan()), describeCommitted(plan(), []));
    assert.doesNotMatch(describeCommitted(plan()), /没有.*照它改/);
  });
});

/**
 * INC-0148 的回归：真跑 turn-fdde40ef 的原始数据。
 *
 * 车主只说了「就这样定了」，一个新要求都没提；两轮 constraints 是同五条要求的两次复述。
 * 旧判据（集合差）在这组数据上报 5 条，弹窗于是写着「您提的三点没照改」，
 * 而落库那份的 origin 就是上海、第一天首个活动 13:30、第三天末段进上海。
 */
describe("[F-58-11] 同义改写不该被当成新要求（turn-fdde40ef 回归）", () => {
  /** 建草案那轮（turn-3902edce）模型给的 constraints，逐字。 */
  const BUILT = [
    "出行方式为自驾",
    "第一天早上要睡到自然醒（不安排早起出发）",
    "第三天要在 16:00 前回到上海",
    "行程共三天",
    "从上海出发，目的地温州",
  ];
  /** 说「就这样定了」那轮（turn-fdde40ef）模型给的 constraints，逐字——同五条，五条全改了措辞。 */
  const THIS_ROUND = [
    "出行方式为自驾",
    "第一天早上睡到自然醒",
    "第三天 16:00 前回到上海",
    "共三天",
    "上海出发到温州",
  ];

  it("五条里有四条逐字不同——所以字面集合差在这组数据上必然误报", () => {
    const seen = new Set(BUILT.map((c) => c.replace(/\s+/g, "")));
    const literalDiff = THIS_ROUND.filter((c) => !seen.has(c.replace(/\s+/g, "")));
    assert.equal(literalDiff.length, 4, "这就是旧判据报出来的那几条，留作反例");
  });

  it("现在的判据只看模型报的 newAsks：那一轮它没报，于是一条都不出", () => {
    const intent = parseIntent(
      JSON.stringify({
        goal: "把当前上海到温州三日自驾行程草案定下来落库",
        route: "itinerary",
        action: "commit",
        constraints: THIS_ROUND,
        transitMode: "drive",
      }),
      "就这样定了",
    );
    assert.equal(intent.action, "commit");
    assert.deepEqual(intent.constraints, THIS_ROUND, "全量快照照旧给下游，这一栏没被动过");
    assert.equal(intent.newAsks, undefined, "没报增量就整栏不给");
    assert.deepEqual(newAsksOf(intent), []);
    assert.doesNotMatch(describeCommitted(plan(), newAsksOf(intent)), /没有.*照它改/);
  });

  it("真有增量时照旧接得住：模型报什么就列什么", () => {
    const intent = parseIntent(
      JSON.stringify({
        goal: "确认行程，同时改成自驾",
        route: "itinerary",
        action: "commit",
        constraints: THIS_ROUND,
        newAsks: ["改成自驾，不走高铁"],
      }),
      "就这样定了，我们是走自驾啊",
    );
    assert.deepEqual(newAsksOf(intent), ["改成自驾，不走高铁"]);
  });

  it("提示词里写清 newAsks 是增量不是复述——否则模型会把老要求重抄一遍", () => {
    const instr = buildIntentInstruction();
    assert.match(instr, /newAsks/);
    assert.match(instr, /子集/, "要说清它与 constraints 的关系");
    assert.match(instr, /别把老要求换个说法塞进来/);
  });
});
