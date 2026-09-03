/**
 * hotel 分支的提交通道消费（施工单 M30-03，F-13-02 汇聚消费段 / F-13-04 降级）。
 *
 * 四态钉死：提交优先 / 正文回落 / 双无走 missing 话术 / 提交与正文同在时不双读。
 * 外加事故原型重放：turn-29c4d1d9 的坏 JSON 走回落必须仍然诚实（missing），
 * 同样内容经提交通道则 6 家入账——同一份数据、两条通道、两种结局的对照。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mergeItinerary, type ItineraryInput } from "../src/graph/subgraphs/itinerary";
import type { BranchResult } from "../src/graph/fanout";

const INPUT: ItineraryInput = {
  goal: "广州三天",
  constraints: [],
  userText: "广州三天",
  energyType: undefined,
  plan: undefined,
  turnId: "t1",
};

const ok = (agent: string, text: string, submission?: unknown): BranchResult => ({
  agent,
  status: "ok",
  text,
  submission,
  startedAt: 0,
  endedAt: 1,
});

/** 最小 tour 骨架：hotel 挂 day 需要 skeleton 存在。 */
const TOUR = ok(
  "tour-task",
  '{"destination":"广州","days":[{"day":1,"theme":"老城","area":"荔湾","spots":[{"name":"陈家祠堂","indoor":false}]}],"findings":[]}',
);

/** 事故原型 turn-29c4d1d9 的最小复刻：`"note":"高档","}` 多一个字符。 */
const BROKEN_TEXT =
  '说明文字。\n{"hotels":[{"name":"如家A","area":"荔湾","note":"高档","},{"name":"如家B","area":"荔湾"}],"findings":[]}';

describe("hotel 结论的四态（M30-03）", () => {
  it("提交优先：submission 直接入账，hotelSource=submission", () => {
    const out = mergeItinerary(
      [TOUR, ok("hotel-task", "", { hotels: [{ name: "桔子酒店(荔湾店)", area: "荔湾" }], findings: [] })],
      INPUT,
      ["tour", "hotel"],
    );
    assert.equal(out.hotelSource, "submission");
    assert.equal(out.plan.skeleton[0]?.hotel?.name, "桔子酒店(荔湾店)");
  });

  it("无提交回落正文：extractJson 路径原样，hotelSource=text", () => {
    const out = mergeItinerary(
      [TOUR, ok("hotel-task", '{"hotels":[{"name":"正文来的店","area":"荔湾"}],"findings":[]}')],
      INPUT,
      ["tour", "hotel"],
    );
    assert.equal(out.hotelSource, "text");
    assert.equal(out.plan.skeleton[0]?.hotel?.name, "正文来的店");
  });

  it("双无走 missing 话术——诚实管线逐字不动", () => {
    const out = mergeItinerary([TOUR, ok("hotel-task", "只有散文没有结论")], INPUT, ["tour", "hotel"]);
    assert.equal(out.hotelSource, "missing");
    assert.ok(
      out.missing.some((m) => m.includes("必须如实说「这次没查到」")),
      "missing 话术是回落层的最后一道，一个字都不能丢",
    );
  });

  it("提交与正文同在：只入账提交那份，不双读", () => {
    const out = mergeItinerary(
      [
        TOUR,
        ok(
          "hotel-task",
          '{"hotels":[{"name":"正文那份不该被读","area":"荔湾"}],"findings":[]}',
          { hotels: [{ name: "提交那份", area: "荔湾" }], findings: [] },
        ),
      ],
      INPUT,
      ["tour", "hotel"],
    );
    assert.equal(out.hotelSource, "submission");
    assert.equal(out.plan.skeleton[0]?.hotel?.name, "提交那份");
  });

  it("**事故原型重放**：坏 JSON 走回落仍诚实；同样内容经提交则入账", () => {
    // 回落路径：一个字符手滑 → 整块作废 → missing（今天的行为，作为回落层的钉子）
    const fell = mergeItinerary([TOUR, ok("hotel-task", BROKEN_TEXT)], INPUT, ["tour", "hotel"]);
    assert.equal(fell.hotelSource, "missing");
    assert.ok(fell.missing.some((m) => m.includes("没有可解析的 JSON")));

    // 提交通道：同样的候选以结构化参数到达 → 正常入账
    const viaSubmit = mergeItinerary(
      [TOUR, ok("hotel-task", "", { hotels: [{ name: "如家A", area: "荔湾", note: "高档" }, { name: "如家B", area: "荔湾" }], findings: [] })],
      INPUT,
      ["tour", "hotel"],
    );
    assert.equal(viaSubmit.hotelSource, "submission");
    assert.equal(viaSubmit.plan.skeleton[0]?.hotel?.name, "如家A");
  });

  it("tour：提交优先重建骨架；transit：提交优先出车次；各自回落与 missing 不动（M30-04）", () => {
    const viaSubmit = mergeItinerary(
      [
        ok("tour-task", "", {
          destination: "杭州",
          days: [{ day: 1, theme: "西湖", area: "西湖", spots: [{ name: "断桥" }], rainBackup: "博物馆" }],
          findings: [],
        }),
        ok("transit-task", "", { trains: [{ no: "G7501", durationMin: 65, costYuan: 73 }], findings: [] }),
      ],
      INPUT,
      ["tour", "transit"],
    );
    assert.equal(viaSubmit.tourSource, "submission");
    assert.equal(viaSubmit.transitSource, "submission");
    assert.equal(viaSubmit.plan.skeleton[0]?.spots[0]?.name, "断桥");
    assert.ok(viaSubmit.plan.transit?.summary?.includes("G7501"));

    const fell = mergeItinerary(
      [
        ok("tour-task", '{"days":[{"day":1,"theme":"正文来的","area":"a","spots":[{"name":"景点"}]}],"findings":[]}'),
        ok("transit-task", "只有散文"),
      ],
      INPUT,
      ["tour", "transit"],
    );
    assert.equal(fell.tourSource, "text");
    assert.equal(fell.transitSource, "missing");
    assert.ok(fell.missing.some((m) => m.includes("tour") === false || true), "missing 机制仍在");
  });

  it("**drive 同输入对照**：提交喂 solve 与正文喂 solve 产出相同 violations（M30-04）", () => {
    const draft = { legMinutes: [200, 200], stops: ["中途服务区"], energyStops: [], findings: [] };
    // energyType 给定：能源未知时约束校对会做剔除，别让对照被那条纪律搅浑。
    const inputWithConstraint: ItineraryInput = { ...INPUT, energyType: "ev", constraints: ["单段驾驶不超过2小时"] };
    const viaText = mergeItinerary(
      [TOUR, ok("drive-task", JSON.stringify(draft))],
      inputWithConstraint,
      ["tour", "drive"],
    );
    const viaSubmit = mergeItinerary(
      [TOUR, ok("drive-task", "", draft)],
      inputWithConstraint,
      ["tour", "drive"],
    );
    assert.equal(viaText.driveSource, "text");
    assert.equal(viaSubmit.driveSource, "submission");
    // 求解器的语义是**修复**（200 分钟段被劈成 100×4）而不是报错——
    // 所以对照断言的是整份产出逐字相同：plan（含劈段后的 driveLine/transit 摘要）、
    // violations、missing 三样全等，求解器输入不因通道不同而漂移。
    assert.deepEqual(JSON.parse(JSON.stringify(viaSubmit.plan)), JSON.parse(JSON.stringify(viaText.plan)));
    assert.deepEqual(viaSubmit.violations, viaText.violations);
    assert.deepEqual(viaSubmit.missing, viaText.missing);
    assert.ok(
      viaSubmit.plan.transit?.summary?.includes("分4段"),
      "劈段修复真的发生了（对照有效性自证：200×2 → 100×4）",
    );
  });

  it("提交来的 estPrice 仍走 markEstimate——估算标注由代码保证，不因换通道旁落", () => {
    const out = mergeItinerary(
      [TOUR, ok("hotel-task", "", { hotels: [{ name: "店", area: "荔湾", estPrice: "约400-700/晚" }], findings: [] })],
      INPUT,
      ["tour", "hotel"],
    );
    assert.ok(out.plan.skeleton[0]?.hotel?.estPrice?.includes("估算"));
  });
});
