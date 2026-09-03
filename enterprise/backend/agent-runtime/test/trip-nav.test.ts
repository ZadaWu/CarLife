/**
 * 出发 / 结束导航的判据与话术（M31-01）。
 *
 * 判据表是导出的、可断言的——与 commit/cancel 同一条纪律（F-11-10）：
 * 判错的症状离根因很远（「出发」被当成细化诉求 → 四个分支白跑一分钟），
 * 靠真跑发现太贵。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { decideRoute } from "../src/graph/route";
import type { Intent } from "../src/graph/state";
import {
  arriveIntent,
  describeArrived,
  departIntent,
  navEndIntent,
  wantsDepart,
  wantsNavEnd,
  describeNavStarted,
  describeNavEnded,
  describeNavNotRunning,
  describeNavFailed,
  describeDepartNotConfirmed,
  describeDepartNoTrip,
  describeDepartOutOfRange,
} from "../src/graph/subgraphs/itinerary";

describe("出发判据（M31-01）", () => {
  it("车里最自然的那几种说法都要认", () => {
    for (const s of [
      "出发",
      "出发吧",
      "咱们出发吧",
      "现在出发",
      "走吧",
      "可以走了",
      "开始导航",
      "导航吧",
      "开导航",
      "上路吧",
    ]) {
      assert.equal(departIntent(s), true, `应判为出发：${s}`);
    }
  });

  /*
   * 否决项。判成出发的代价是屏幕当场切进跟车模式，车主一脸茫然；
   * 判成普通对话最坏只是再问一句——所以带时间限定与疑问的一律不认。
   */
  it("**带时间限定的是在描述计划，不是现在动身**", () => {
    for (const s of [
      "我们明天早上出发",
      "后天出发",
      "周五出发比较好",
      "27号出发",
      "下午出发吧",
      "晚上出发行不行",
    ]) {
      assert.equal(departIntent(s), false, `不应判为出发：${s}`);
    }
  });

  /*
   * 这一条守的是**路由**，不是话术。
   *
   * 「出发」在 route.ts 里是 trip 的 3 分强证据词，而出发判据要参与"不看粘性
   * 直接进 itinerary"的路由规则。判松了的后果不是多弹一次窗——是车主说
   * 「出发去广州玩三天」想规划新行程，系统翻出上个月那份旧行程开始导航。
   */
  it("**带规划内容的不算出发指令**——否则会拿旧行程去导航", () => {
    for (const s of [
      "出发去广州玩三天",
      "我们出发去看海吧",
      "安排一下出发",
      "出发去杭州旅游",
      "走吧，去桂林玩五天",
    ]) {
      assert.equal(departIntent(s), false, `不应判为出发：${s}`);
    }
  });

  it("疑问与改期不是动身指令", () => {
    for (const s of [
      "几点出发比较好",
      "什么时候出发",
      "出发时间定了吗",
      "能不能早点出发",
      "把出发时间改一下",
    ]) {
      assert.equal(departIntent(s), false, `不应判为出发：${s}`);
    }
  });

  // M62-02：「出发前 / 出发之前」是时间状语（评测 o-30 被整句当成动身指令直接进行程节点）
  it("「出发前 / 出发之前」是时间状语，不是动身指令", () => {
    for (const s of [
      "冬天出发前想先暖车，我这车的定时预热功能怎么用",
      "出发之前要检查什么",
      "动身前先把行程定了",
    ]) {
      assert.equal(departIntent(s), false, `不应判为出发：${s}`);
    }
    for (const s of ["出发", "现在出发", "走吧"]) {
      assert.equal(departIntent(s), true, `应判为出发：${s}`);
    }
  });
});

describe("结束导航判据（M31-01）", () => {
  it("常见说法都要认", () => {
    for (const s of ["结束导航", "退出导航", "关掉导航", "不导航了", "别导了", "停止导航"]) {
      assert.equal(navEndIntent(s), true, `应判为结束导航：${s}`);
    }
  });

  /*
   * 「不导航了」同时命中两张表——`导航` 在出发表里，整句在结束表里。
   * 谁先判谁赢，而这里必须是结束赢：判成出发就是"车主说别导了，它开始导航"。
   */
  it("**结束优先于出发**：两张表交叠处不能判成出发", () => {
    for (const s of ["不导航了", "别导了", "取消导航", "关掉导航"]) {
      assert.equal(wantsNavEnd(s), true, s);
      assert.equal(wantsDepart(s), false, `不该判成出发：${s}`);
    }
  });

  it("「取消行程」不是结束导航——那会把整份行程作废", () => {
    assert.equal(navEndIntent("行程取消掉"), false);
    assert.equal(navEndIntent("把这趟广州的行程删了"), false);
  });
});

describe("到站报告（M31-03）", () => {
  it("端上发来的那两种形状都认得", () => {
    assert.equal(arriveIntent("已到达陈家祠堂，下一站沙面岛"), true);
    assert.equal(arriveIntent("已到达沙面岛，今天的行程走完了"), true);
  });

  it("**「到了」这类口语不认**——那是日常说法，误伤面太大", () => {
    for (const s of ["到了吗", "快到了", "我们到了没有", "到广州了吗"]) {
      assert.equal(arriveIntent(s), false, `不应判为到站：${s}`);
    }
  });

  it("播报指令要求短，且不许展开——车主正在开车", () => {
    const s = describeArrived("已到达陈家祠堂，下一站沙面岛");
    assert.match(s, /陈家祠堂/);
    assert.match(s, /一句话/);
    assert.match(s, /不要展开/);
  });
});

describe("路由：导航处置不看粘性直接进行程节点（M31-01）", () => {
  /*
   * 施工时真的漏过这一条：分支写在 itinerary 节点里，而「出发」按分数
   * 判进 trip（单程 fan-out）——那条链路里没有任何导航逻辑。
   * 表现是跑一分钟回一句不相干的话，主页纹丝不动，与取消当年一模一样。
   */
  /** 意图解析降级时的形状（模型没给 route/action），正是兜底路径要守的那一档。 */
  const bare: Intent = { goal: "", constraints: [], context: "", riskBoundary: "" };

  it("新会话里说「出发」也要进 itinerary，不能掉进单程 fan-out", () => {
    const r = decideRoute(bare, "出发");
    assert.equal(r.agent, "itinerary", `实际判去了 ${r.agent}：${r.reason}`);
  });

  it("「结束导航」「到站报告」同样进 itinerary", () => {
    assert.equal(decideRoute(bare, "结束导航").agent, "itinerary");
    assert.equal(decideRoute(bare, "已到达陈家祠堂，下一站沙面岛").agent, "itinerary");
  });

  /*
   * 「出发去广州玩三天」本来就该进 itinerary——它是多天规划请求。
   * 要守的不是"去哪个 agent"，而是**经哪条规则进去的**：
   * 走评分路径 → 节点跑 fan-out 规划；被导航规则截走 → 节点去导航一份旧行程。
   * 两者都返回 itinerary，只有 reason 能把它们分开。
   */
  it("**带规划内容的「出发」不能被导航规则截走**", () => {
    const r = decideRoute(bare, "出发去广州玩三天");
    assert.ok(
      !r.reason.includes("出发/结束导航"),
      `不该被导航规则截走：${r.reason}`,
    );
  });
});

describe("LLM 优先、正则兜底（与 commit/cancel 同一形态）", () => {
  it("模型给了 action，正则认不出的说法也走得通", () => {
    assert.equal(wantsDepart("那我们上路吧兄弟", { action: "depart" }), true);
    assert.equal(wantsNavEnd("先歇会儿吧", { action: "nav_end" }), true);
  });

  it("意图解析降级（没有 action）时老判据仍然管用", () => {
    assert.equal(wantsDepart("出发吧", undefined), true);
    assert.equal(wantsNavEnd("结束导航", undefined), true);
  });

  it("模型说 nav_end 时不会同时被判成出发", () => {
    assert.equal(wantsDepart("出发", { action: "nav_end" }), false);
  });
});

describe("四条拒绝路径的话术：一条都不能含糊成「好的」（M31-01）", () => {
  it("草案不能导航，而且**不替他确认**", () => {
    const s = describeDepartNotConfirmed();
    assert.match(s, /还是草案/);
    assert.match(s, /就这样定了/); // 告诉他下一步怎么做
    assert.match(s, /不要替他确认/);
  });

  it("库里没有行程时如实说，并且认领「主页还挂着就是我们的问题」", () => {
    const s = describeDepartNoTrip();
    assert.match(s, /没有已确认的行程/);
    assert.match(s, /我们的问题/);
  });

  it("不在行程日期内时要把日期说出来，不能只说不行", () => {
    const s = describeDepartOutOfRange({ destination: "广州", days: 3, startDate: "2026-08-01" });
    assert.match(s, /广州/);
    assert.match(s, /3天/);
    assert.match(s, /2026-08-01/);
  });

  it("没在导航时**不能假装刚关掉**", () => {
    const s = describeNavNotRunning();
    assert.match(s, /没有在导航/);
    assert.doesNotMatch(s, /已(结束|关闭)/);
  });

  it("置位失败时要说清行程本身没受影响", () => {
    const s = describeNavFailed("保存系统出错", false);
    assert.match(s, /没有成功/);
    assert.match(s, /行程本身没有受影响/);
  });
});

describe("成功路径的话术（M31-01）", () => {
  it("第一站要念出来——车主靠它确认说的是同一件事", () => {
    const s = describeNavStarted({ destination: "广州" }, 2, "沙面岛");
    assert.match(s, /广州/);
    assert.match(s, /第2天/);
    assert.match(s, /沙面岛/);
  });

  it("当天没有站点时如实说，不编一个", () => {
    const s = describeNavStarted({ destination: "广州" }, 3, undefined);
    assert.match(s, /没有排定的站点/);
  });

  it("结束导航后要说清屏幕回到了哪", () => {
    assert.match(describeNavEnded(), /行程视图/);
  });
});
