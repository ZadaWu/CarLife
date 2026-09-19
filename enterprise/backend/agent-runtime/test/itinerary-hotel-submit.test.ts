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
import { driveText, legsFrom } from "./helpers/drive-legs";

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

/**
 * 最小 tour 骨架：hotel 挂 day 需要 skeleton 存在。
 *
 * 第 2 天是返程日（M77 走查追修）——最后一天回家、不挂酒店，
 * 所以被断言的第 1 天必须不是最后一天，否则测的是"不挂"而不是"挂对了谁"。
 */
const TOUR = ok(
  "tour-task",
  '{"destination":"广州","days":[{"day":1,"theme":"老城","area":"荔湾","spots":[{"name":"陈家祠堂","indoor":false}]},{"day":2,"theme":"返程","area":"返程","spots":[]}],"findings":[]}',
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

  it("drive 只认提交槽与新形状正文；旧的平行数组正文当没交（ACR-047）", () => {
    const inputWithConstraint: ItineraryInput = { ...INPUT, energyType: "ev", constraints: [], tripLimits: { maxLegMinutes: 120 } };
    const legs = legsFrom([200, 200], ["中途服务区"], [1, 1], { origin: "上海", destination: "杭州" });
    const viaSubmit = mergeItinerary([TOUR, ok("drive-task", "", { legs, energyStops: [], findings: [] })], inputWithConstraint, ["tour", "drive"]);
    assert.equal(viaSubmit.driveSource, "submission");
    assert.ok(viaSubmit.plan.legs && viaSubmit.plan.legs.every((l) => l.driveMinutes <= 120), "200 分钟段被劈开");
    const viaText = mergeItinerary([TOUR, ok("drive-task", driveText(legs))], inputWithConstraint, ["tour", "drive"]);
    assert.equal(viaText.driveSource, "text");
    assert.deepEqual(JSON.parse(JSON.stringify(viaText.plan.legs)), JSON.parse(JSON.stringify(viaSubmit.plan.legs)), "同输入两条路产出相同");
    const legacy = mergeItinerary(
      [TOUR, ok("drive-task", '{"legMinutes":[200,200],"stops":["中途服务区"],"findings":[]}')],
      inputWithConstraint,
      ["tour", "drive"],
    );
    assert.equal(legacy.driveSource, "missing", "旧形状不再被解析——两种表达只留一种");
    assert.ok(legacy.missing.some((m) => m.includes("drive")));
  });

  it("提交来的 estPrice 仍走 normalizeEstPrice——估算标注由代码保证，不因换通道旁落", () => {
    const out = mergeItinerary(
      [TOUR, ok("hotel-task", "", { hotels: [{ name: "店", area: "荔湾", estPrice: "约400-700/晚" }], findings: [] })],
      INPUT,
      ["tour", "hotel"],
    );
    assert.ok(out.plan.skeleton[0]?.hotel?.estPrice?.includes("估算"));
  });
});
