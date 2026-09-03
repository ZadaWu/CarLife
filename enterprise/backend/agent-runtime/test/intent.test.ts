/**
 * 意图解析（`parseIntent` / `parseWhen`）。
 *
 * 这一层的纪律只有一条：**模型给的值不合格就当没给**，退回下游的兜底判据——
 * 而不是把一个坏值传下去。坏值的表现不是报错，是下游拿它去过滤真实数据，
 * 过滤出空集，然后车主看到一句完全看不懂的话。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { INTENT_INSTRUCTION, parseIntent, parseWhen } from "../src/graph/intent";

/**
 * `when`：时间点的标准化（施工单 M19-08）。
 *
 * **不合格当没给**是这一组的全部要点。一个坏的日期会被拿去过滤真实时段表，
 * 而过滤出空集的表现是"你选的那个时段不存在"——排查方向完全不指向意图解析。
 * 所以宁可整栏丢掉，让正则兜底重来一次。
 */
describe("when：时间点标准化（M19-08）", () => {
  it("合法值收下", () => {
    assert.deepEqual(parseWhen({ date: "2026-08-17", hour: 10 }), { date: "2026-08-17", hour: 10 });
    // 只说了日没说月：`--DD`
    assert.deepEqual(parseWhen({ date: "--17" }), { date: "--17" });
    assert.deepEqual(parseWhen({ hour: 0 }), { hour: 0 });
    assert.deepEqual(parseWhen({ hour: 23 }), { hour: 23 });
  });

  it("**越界或非整数的钟点当没给**", () => {
    for (const bad of [25, -1, 10.5, "十点", null]) {
      assert.equal(parseWhen({ hour: bad })?.hour, undefined, `hour=${String(bad)} 应当没给`);
    }
  });

  it("**格式不对的日期当没给**——「下周一」不是日期", () => {
    for (const bad of ["下周一", "8月17日", "2026/08/17", "17", ""]) {
      assert.equal(parseWhen({ date: bad })?.date, undefined, `date=${bad} 应当没给`);
    }
  });

  it("**两个子字段都不合格 → 整栏不给**（空对象会让下游误以为模型表态了）", () => {
    assert.equal(parseWhen({}), undefined);
    assert.equal(parseWhen({ date: "下周一", hour: 99 }), undefined);
    assert.equal(parseWhen(null), undefined);
    assert.equal(parseWhen("十点"), undefined);
  });

  it("**一半合格就留那一半**——车主常常只说了钟点没说日期", () => {
    assert.deepEqual(parseWhen({ date: "下周一", hour: 15 }), { hour: 15 });
  });

  it("parseIntent 接得上，且模型没给时 when 是 undefined", () => {
    const withWhen = parseIntent('{"goal":"约试驾","when":{"date":"2026-08-17","hour":10}}', "x");
    assert.deepEqual(withWhen.when, { date: "2026-08-17", hour: 10 });
    assert.equal(parseIntent('{"goal":"约试驾"}', "x").when, undefined);
    // 降级路径不带 when
    assert.equal(parseIntent("这不是 JSON", "x").when, undefined);
  });
});

/**
 * prompt 骨架里的占位符不能是「看起来像真值」的东西（真跑 turn-9b3b7e8e）。
 *
 * `"hour":0` 那个 0 被模型原样抄成了真值，而 0 是合法钟点、过得了校验，
 * 于是拿凌晨 0 点去过滤时段表，车主连说三轮「确认」都约不上。
 */
describe("INTENT_INSTRUCTION：占位符不能长得像真值", () => {
  it("**when 的骨架里没有裸数字**", () => {
    const skeleton = INTENT_INSTRUCTION.split("\n")[1];
    assert.match(skeleton, /"when"/);
    assert.doesNotMatch(skeleton, /"hour"\s*:\s*\d/, "裸数字会被模型当成真值抄走");
  });

  it("明写了「不要给 0」", () => {
    assert.match(INTENT_INSTRUCTION, /不要给 0/);
  });
});

/*
 * 路由边界只写在离线证据表与注释里，real 档由 LLM 给 route、证据表只兜底——
 * 于是 fake 档全过、real 档翻车（2026-09-01 场景评测：s-07/s-15/s-16/s-39 质保与维修史被判进 ownership，
 * o-20「怎么设置座椅和后视镜」判进 cabin，o-37「够不够跑一次长途」判进 itinerary）。
 * 这组断言守的是「那几条边界确实讲给模型听了」——它守不住行为，行为只能靠真实档子集重跑（M62-02 验收 §3）。
 */
describe("INTENT_INSTRUCTION：指代不明的「它还能用吗」判 none，先澄清不拦（M62-04）", () => {
  it("例句在，且落在 none 的说明里", () => {
    const i = INTENT_INSTRUCTION.indexOf("它还能用吗");
    assert.ok(i > 0, "例句没写进 prompt");
    assert.match(INTENT_INSTRUCTION.slice(i, i + 40), /判 none/);
  });
});

describe("INTENT_INSTRUCTION：route 候选说明写全了 M62-02 的四条边界", () => {
  it("质保 / 三包 / 维修历史归 service", () => {
    assert.match(INTENT_INSTRUCTION, /质保 \/ 保修 \/ 三包/);
    assert.match(INTENT_INSTRUCTION, /维修历史 \/ 保养史 \/ 事故记录/);
  });
  it("「怎么用 / 怎么设置」是咨询，归 ownership 不归 cabin", () => {
    assert.match(INTENT_INSTRUCTION, /怎么设置 \/ 在哪打开 \/ 能不能关」是咨询，归 ownership 不归 cabin/);
    assert.match(INTENT_INSTRUCTION, /怎么设置上车自动调好座椅和后视镜/);
  });
  it("「我这车 X 正不正常」的日常表现判定归 ownership，症状才是 service（M62-08 全量重跑发现 o-15/16/17 回流 service）", () => {
    assert.match(INTENT_INSTRUCTION, /正不正常 \/ 偏不偏高 \/ 快不快」是拿这辆车的数据做日常表现判定，归 ownership/);
    assert.match(INTENT_INSTRUCTION, /充电越来越慢是电池衰减了吗」都是 ownership/);
  });
  it("问自己这辆车够不够跑长途归 ownership，itinerary 只收要规划或处置行程的", () => {
    assert.match(INTENT_INSTRUCTION, /续航够不够跑一次长途/);
    assert.match(INTENT_INSTRUCTION, /且要规划或处置行程的/);
  });
});
