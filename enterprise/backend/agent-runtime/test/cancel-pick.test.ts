/**
 * [F-58-11][AC-58-5] 取消哪一份：LLM 第一信号，字面判据兜底（M77 走查追修，ADR-010）。
 *
 * 真跑两轮，两次都没删成：
 *  - turn-066bc428「帮我删除**从上海到张家港**的行程」→ 系统答"没法确定您要删哪一条"，
 *    而两份候选里只有一份是张家港。
 *  - turn-ef5d58cb「帮我删除**九月二十五号**的行程」→ 还是认不出，暖暖把"我没听懂"
 *    说成了"取消这事我这边没法直接操作，得您在手机上确认"。
 *
 * 追问文案白纸黑字写着"说目的地或出发日期都行"，而当时的判据只认序号、纯数字和「全部」——
 * **承诺了两种说法，一种都不认**。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { describeStoredPlan, matchPlanChoice, resolvePendingCancelReply } from "../src/graph/subgraphs/itinerary";
import { buildIntentInstruction, cancelCandidatesLine, parseIntent } from "../src/graph/intent";

/** 真跑那两份候选，标签逐字取自 `describeStoredPlan`。 */
const CANDIDATES = [
  { label: "普陀山 2天（2026-09-14 出发）" },
  { label: "张家港（经南通） 1天（2026-09-25 出发）" },
];

describe("[F-58-11] 字面兜底：封闭集合里的唯一命中", () => {
  it("真跑第一句：「从上海到张家港的行程」→ 第 2 份", () => {
    assert.equal(matchPlanChoice("帮我删除从上海到张家港的行程。", CANDIDATES), 2);
  });

  it("真跑第二句：「九月二十五号的行程」→ 第 2 份；阿拉伯与斜杠写法同样认", () => {
    assert.equal(matchPlanChoice("帮我删除九月二十五号的行程", CANDIDATES), 2);
    assert.equal(matchPlanChoice("删掉 9月25 那条", CANDIDATES), 2);
    assert.equal(matchPlanChoice("9/25 那个不要了", CANDIDATES), 2);
    assert.equal(matchPlanChoice("9月14号那条删了", CANDIDATES), 1);
  });

  it("括号里的地名也认——车主会说「南通那趟」", () => {
    assert.equal(matchPlanChoice("南通那趟取消掉", CANDIDATES), 2);
  });

  it("序号与「全部」照旧", () => {
    assert.equal(matchPlanChoice("第二个", CANDIDATES), 2);
    assert.equal(matchPlanChoice("2", CANDIDATES), 2);
    assert.equal(matchPlanChoice("全部都取消", CANDIDATES), "all");
  });

  it("**含糊就不挑**：命中两份、一份都不命中、越界序号，一律退回追问", () => {
    const both = [{ label: "杭州 2天（2026-09-14 出发）" }, { label: "杭州 3天（2026-10-01 出发）" }];
    assert.equal(matchPlanChoice("杭州那个删了", both), undefined, "两份都叫杭州，挑了就是替他决定");
    assert.equal(matchPlanChoice("把那个删了", CANDIDATES), undefined);
    assert.equal(matchPlanChoice("第五个", CANDIDATES), undefined);
  });

  it("光说「确认」只在一个候选时才认（既有纪律不变）", () => {
    assert.equal(resolvePendingCancelReply("确认", CANDIDATES), undefined);
    assert.equal(resolvePendingCancelReply("确认", [CANDIDATES[0]!]), 1);
  });
});

describe("[F-58-11] LLM 那一路：候选进 probe，cancelPick 出结果", () => {
  it("候选行带序号、与报给车主的列表同序，并交代指向不明就别给", () => {
    const line = cancelCandidatesLine(CANDIDATES)!;
    assert.match(line, /1\. 普陀山 2天/);
    assert.match(line, /2\. 张家港（经南通） 1天/);
    assert.match(line, /出发日期/);
    assert.match(line, /不要给这一栏/);
  });

  it("没有待澄清的取消时不加这一行，也不加 schema 那一栏", () => {
    assert.equal(cancelCandidatesLine([]), undefined);
    assert.doesNotMatch(buildIntentInstruction(true, false), /cancelPick/);
    assert.match(buildIntentInstruction(true, true), /cancelPick/);
  });

  it("解析 cancelPick：数字与 all 认，其余一律当没给", () => {
    const of = (raw: string) => parseIntent(raw, "x").cancelPick;
    assert.equal(of('{"goal":"删行程","cancelPick":2}'), 2);
    assert.equal(of('{"goal":"删行程","cancelPick":"2"}'), 2);
    assert.equal(of('{"goal":"删行程","cancelPick":"all"}'), "all");
    assert.equal(of('{"goal":"删行程","cancelPick":"第二个"}'), undefined, "挑错一份是删掉不该删的");
    assert.equal(of('{"goal":"删行程","cancelPick":0}'), undefined);
    assert.equal(of('{"goal":"删行程"}'), undefined);
  });
});

describe("[F-58-11] 两条信号的接线", () => {
  const src = () => readFileSync(new URL("../src/graph/supervisor.ts", import.meta.url), "utf8");

  it("LLM 优先、正则兜底，且越界序号丢弃", () => {
    const s = src();
    assert.match(s, /const llmPick = state\.intent\?\.cancelPick;/);
    assert.match(s, /llmPick <= pending\.candidates\.length/, "越界的序号不能用");
    assert.match(s, /: resolvePendingCancelReply\(userText, pending\.candidates\)/, "降级时字面判据仍要管用");
  });

  it("首次取消先看这句话有没有指明，指明了就不再问一遍", () => {
    const s = src();
    assert.match(s, /matchPlanChoice\(userText, plans\.map\(/, "首次取消要先看这句话有没有指明");
    assert.match(s, /const narrowed =\s*\n?\s*byDay\.length === 1 \? byDay : typeof direct === "number"/);
    assert.match(s, /if \(narrowed\.length > 1 && !wantAll\)/);
  });
});

describe("[F-58-11] 跨天：说的是行程里的某一天，不是出发日", () => {
  /** 9/25 出发的三天行程，标签由 describeStoredPlan 拼（含范围）。 */
  const SPAN = [
    { label: describeStoredPlan({ plan: { destination: "普陀山", days: 2 }, startDate: "2026-09-14", endDate: "2026-09-15" }) },
    { label: describeStoredPlan({ plan: { destination: "张家港", days: 3 }, startDate: "2026-09-25", endDate: "2026-09-27" }) },
  ];

  it("标签报的是范围，不是只报出发日——那是两边比对时唯一看得到的东西", () => {
    assert.equal(SPAN[1]!.label, "张家港 3天（2026-09-25 至 09-27）");
    // 同年省掉后一个年份；单天行程仍按出发日写
    assert.equal(
      describeStoredPlan({ plan: { destination: "南通", days: 1 }, startDate: "2026-09-25", endDate: "2026-09-25" }),
      "南通 1天（2026-09-25 出发）",
    );
  });

  it("行程中间那几天也认得出——按出发日比的话 26、27 号一天都对不上", () => {
    assert.equal(matchPlanChoice("9月25号那条删了", SPAN), 2);
    assert.equal(matchPlanChoice("9月26号那条删了", SPAN), 2);
    assert.equal(matchPlanChoice("九月二十七号的行程取消", SPAN), 2);
    assert.equal(matchPlanChoice("9月14号那个", SPAN), 1);
  });

  it("范围之外的日期不乱认", () => {
    assert.equal(matchPlanChoice("9月30号那条", SPAN), undefined);
  });
});

describe("[F-58-11] 按日期检索行程的工具能力", () => {
  const registry = () => readFileSync(new URL("../../shared/tools/src/registry.ts", import.meta.url), "utf8");

  it("trip_plan_query 有 covers 一栏，且说清它与出发日区间的区别", () => {
    const s = registry();
    assert.match(s, /covers: z/);
    assert.match(s, /这一天在行程期内/);
    assert.match(s, /不要用 startFrom\/startTo/, "不说清楚，模型会拿出发日区间去查某一天");
  });

  it("查询实现按覆盖判定，且老行（没有 endDate）退化成只比出发日", () => {
    const repo = readFileSync(new URL("../../shared/db/src/repositories/trip-plan.ts", import.meta.url), "utf8");
    assert.match(repo, /startDate: \{ lte: q\.covers \}/);
    assert.match(repo, /endDate: \{ gte: q\.covers \}/);
    assert.match(repo, /endDate: null, startDate: q\.covers/, "老行不能被整个排除掉");
  });

  it("取消流程用模型填好的日期筛，不自己从原话抠日期", () => {
    const sup = readFileSync(new URL("../src/graph/supervisor.ts", import.meta.url), "utf8");
    assert.match(sup, /const askedDay = state\.intent\?\.when\?\.date;/);
    assert.match(sup, /planCoversDay\(pl, askedDay\)/);
    // 老行没有 endDate 时退化成只比出发日
    assert.match(sup, /p\.endDate \? p\.endDate >= day : p\.startDate === day/);
  });
});
