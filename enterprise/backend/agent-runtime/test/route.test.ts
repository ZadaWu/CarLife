/**
 * 路由判据测试集（F-03）。
 *
 * 这份用例表的价值不在覆盖率，在于**它是从真实走查里抄下来的**：
 * 下面标了「走查反例」的那几条，修复前全部判错，而且每一条都是
 * 演示时随口就会说出来的话。
 *
 * 路由错误不会报错、不会变慢，只表现为"答非所问"——用户不会说「你路由错了」，
 * 他只会觉得这个助手不太行。所以判据必须有一份能跑的对照表。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { listForAgent } from "@carlife/tools";
import { summarizeAction } from "../src/tools-endpoint";
import { canonicalAgent } from "../src/acp-client/agent-prompt";
import { branchFor, decideRoute } from "../src/graph/route";
import type { Intent } from "../src/graph/state";

const bare: Intent = { goal: "", constraints: [], context: "", riskBoundary: "" };
const withIntent = (p: Partial<Intent>): Intent => ({ ...bare, ...p });

function expectRoute(text: string, target: string, intent: Intent = bare): void {
  const r = decideRoute(intent, text);
  assert.equal(r.agent, target, `「${text}」应判 ${target}，实际 ${r.agent}（${r.reason}）`);
}

describe("「两日一晚」这类说法要判多天（M13-12 走查：酒店与乐园一次都没查）", () => {
  /*
   * 实测 turn-8a4cdf8c：车主说「这个周末从上海静安到上海嘉定的**两日一晚游**……
   * 找个亲子酒店……还要找一个亲子乐园」，判进了单程 fan-out。
   * 那条链路**没有 hotel 分支也没有 tour 分支**——整轮零次 poi_search，
   * 酒店和乐园根本没被查过，助手只能说没找到。
   *
   * 根因：多天判据只认「天/夜」，不认「日」。
   */
  for (const t of ["两日一晚游", "三日游", "两日游", "三日行程", "带孩子玩两日", "两天一夜", "住一晚"]) {
    it(`「${t}」→ itinerary`, () => {
      expectRoute(t, "itinerary");
    });
  }

  it("车主那句原话（含口语赘词）→ itinerary", () => {
    expectRoute(
      "帮我把呃预约帮我整理个行程就是这个周末从上海静安到上海嘉定的两日一晚游主要是带六岁的小朋友一起玩我们要中间找个亲子的酒最好是一个亲子酒店然后呢还要找一个亲子乐园玩",
      "itinerary",
    );
  });

  /*
   * 反向护栏：**日期不能被当成天数**。
   * 「日」的多天说法一律锚在 游/晚/玩/行程 上，不进通用量词——
   * 试过 `(?<!月)` 排除日期，正则照样能从「8月15日」的「5日」起匹配上。
   */
  /*
   * 目标在 M13-13 之后统一成 itinerary，所以断言改看**依据**：
   * 日期不能被算成天数——「8月15日」命中"多天行程/多日游说法"就是判据坏了，
   * 哪怕最终路由碰巧是对的。
   */
  for (const t of ["8月15日出发去嘉定怎么走", "15日出发", "这个月15日的天气", "今日路况如何"]) {
    it(`「${t}」的依据里不该出现"多天/多日游"`, () => {
      const r = decideRoute(bare, t);
      assert.doesNotMatch(r.reason, /多天行程|多日游说法/, `日期被当成了天数：${r.reason}`);
    });
  }
});

describe("「去某地玩」归多天链路，哪怕只有一天（M13-12 走查决定）", () => {
  /*
   * 实测那三轮（turn-2d5a87be / 48cfda34 / a6cc5d7b）：车主规划「静安→嘉定周末游」，
   * 判进了 trip 的单程 fan-out——**那条链路没有确认落库**（无确认判据、无权限门、
   * 无 trip_plan_commit，连草案都不写）。于是车主反复说「行程定了」，
   * 没有弹窗、没有落库、主页上什么都不出现，而全程零报错。
   *
   * 判据是**诉求形态**不是天数：要"去哪儿玩"的归 itinerary，要"怎么开过去"的归 trip。
   */
  for (const t of ["规划一次周末游，从上海静安出发到上海嘉定", "这周末去嘉定玩", "去嘉定一日游", "安排个周末游"]) {
    it(`「${t}」→ itinerary（能确认落库、能上主页）`, () => {
      expectRoute(t, "itinerary");
    });
  }
  // 反向：单纯问路/补能不受影响，仍走单程链路。
  for (const t of ["去嘉定怎么走", "沿途有没有充电站", "明天出发去嘉定，路上服务区在哪"]) {
    it(`「${t}」→ trip（问路不是去玩）`, () => {
      expectRoute(t, "itinerary");
    });
  }
});

describe("取消指涉不看粘性（M13-12 走查：说了取消却去规划）", () => {
  /*
   * 实测那次（turn-ab3d1079）：车主说「我取消从上海到广州的行程」，
   * 会话里没有草案（行程是上一次会话确认落库的）→ 粘性不存在
   * → 行程词 9 分判进 trip → 单程 fan-out，**那条链路没有取消逻辑**
   * → 跑一分钟回一句"没查到"，而主页上那份行程原封不动。
   */
  for (const t of [
    "我取消从上海到广州的行程",
    "取消上海到广州的行程",
    "帮我取消上海-广州的行程",
    "取消广州四天的行程",
    "行程取消掉",
    "广州那趟不去了",
  ]) {
    it(`「${t}」→ itinerary（不依赖会话里有没有草案）`, () => {
      expectRoute(t, "itinerary");
    });
  }

  it("规划诉求走出行链路（M13-13 后单程与多天同一目标）", () => {
    expectRoute("帮我规划去广州的行程", "itinerary");
  });

  it("部分取消仍是细化，不走取消：「取消第二天的行程」", () => {
    const r = decideRoute(bare, "取消第二天的行程");
    assert.notEqual(r.reason, "取消指涉：对已有行程的处置，交给行程节点（不看粘性）");
  });
});

describe("走查反例：修复前判错的真实语句", () => {
  it("「我这车最近开空调总感觉制冷不太行」→ ownership（口语的「我这车」此前漏判成 general）", () => {
    expectRoute("我这车最近开空调总感觉制冷不太行", "ownership");
  });

  it("「后天上午十点去做保养」→ service（此前被一个「去」字拽去做行程规划）", () => {
    expectRoute("后天上午十点去做保养", "service");
  });

  it("意图释义里的「故障」不该把续航问题拽走（原话权重高于 context）", () => {
    // 这是最隐蔽的一条：LLM 写的 context 里带了"可能存在故障"，
    // 于是问题被判给 service，**然后连 ownership 的检索也一并失去**。
    expectRoute(
      "我的车最近续航掉得厉害，正常吗？",
      "ownership",
      withIntent({
        goal: "确认续航下降是否属于正常衰减",
        context: "车主关注是否存在异常或故障，可能为纯电动车",
      }),
    );
  });

  it("「在日历里加一条：明天上午十点洗车」不该判成出行", () => {
    const r = decideRoute(bare, "在日历里加一条：明天上午十点洗车");
    assert.notEqual(r.agent, "itinerary");
  });
});

describe("出行", () => {
  for (const q of [
    "下周六想自驾从上海去黄山，帮我规划一下行程",
    "明天几点走比较好",
    "这条路线沿途有服务区吗",
    "带我妈和孩子开电车去黄山",
  ]) {
    it(`「${q}」→ trip`, () => expectRoute(q, "itinerary"));
  }

  it("**出行优先于用车**：「去黄山要充几次电」是行程问题", () => {
    expectRoute("明天去黄山要充几次电", "itinerary");
  });

  it("约束里的出行信息也算数——四要素不是摆设", () => {
    expectRoute("帮个忙", "itinerary", withIntent({ constraints: ["下周要去黄山自驾，同行老人"] }));
  });
});

describe("售后（带着症状或周期去查的那一类）", () => {
  for (const q of [
    "刹车有异响",
    "仪表盘亮了个黄灯",
    "底下好像漏油",
    "去 4S 店能索赔吗",
    "该保养了吗",
    "多少公里换一次机油",
  ]) {
    it(`「${q}」→ service`, () => expectRoute(q, "service"));
  }

  it("**保养归售后不归用车**：保养手册在 repair-kb，判到 ownership 会去搜说明书", () => {
    // 搜错知识库的后果不是报错，是「答得很顺但没有出处」——
    // 说明书里根本没有保养周期表。
    expectRoute("我的车保养周期是多久", "service");
  });

  it("症状 + 指向自己的车：症状证据更强", () => {
    expectRoute("我这辆车刹车有异响", "service");
  });
});

describe("购车", () => {
  for (const q of ["预算 20 万买什么车", "这两款车对比一下", "落地价大概多少", "想换车了，推荐几款"]) {
    it(`「${q}」→ buying`, () => expectRoute(q, "buying"));
  }
});

describe("配置比较判到购车（M21-07：这些话此前一句都到不了 buying）", () => {
  /*
   * M21-03 施工时实测出来的缺口：证据表里唯一含"配置"的是「配置怎么选」，
   * 于是下面前四句全落到 general，而 M21-03 交付的配置比较从自然对话里到不了。
   * 第五句更糟——"续航"命中用车助手 9 分，助手会去翻**一辆他还没买的车**的说明书。
   */
  for (const q of [
    "Model Y 这几个配置差在哪",
    "顶配和低配差多少",
    "Model Y 有哪几个版本",
    "六座的贵多少",
    "长续航版值不值多花两万",
    "配置怎么选",
  ]) {
    it(`「${q}」→ buying`, () => expectRoute(q, "buying"));
  }
});

describe("车险与用车成本判到购车（M21-07 续做，M21-05 发现）", () => {
  for (const q of [
    "保险一年多少",
    "车险都包含什么",
    "三者险买多少合适",
    "Model Y 五年下来一共花多少",
    "用车成本高吗",
  ]) {
    it(`「${q}」→ buying`, () => expectRoute(q, "buying"));
  }
  // 「保养」与「保险」只差一个字，而它是售后的地盘。
  for (const q of ["保养一次多少钱", "机油多久换一次"]) {
    it(`「${q}」仍 → service`, () => expectRoute(q, "service"));
  }
});

describe("配置信号不许误伤用车与售后（M21-07 的红线）", () => {
  /*
   * 新信号要求**比较语义与配置词共现**，就是为了不碰这几句。
   * 尤其「我这车续航掉得快」：把"续航"从 ownership 里删掉能修好上面那条，
   * 但会毁掉用车助手最常用的一类问题——所以判据只能加在购买语义那一侧。
   */
  for (const [q, target] of [
    ["我这车续航掉得快", "ownership"],
    ["续航怎么这么低", "ownership"],
    ["这车配置挺高的", "ownership"],
    ["座椅配置怎么调", "ownership"],
    ["刹车片多少公里换", "service"],
    ["哪家店能修车", "service"],
    ["约个试驾", "testDrive"],
  ] as const) {
    it(`「${q}」仍 → ${target}`, () => expectRoute(q, target));
  }
});

describe("用车咨询（日常「这个功能怎么用」）", () => {
  for (const q of [
    "冬天续航掉得厉害正常吗",
    "胎压打多少",
    "说明书上怎么说",
    "这个车机怎么设置导航",
    "充电限值设多少合适",
  ]) {
    it(`「${q}」→ ownership`, () => expectRoute(q, "ownership"));
  }
});

describe("座舱陪伴（车里那些与车无关的话）", () => {
  for (const q of ["讲个笑话吧", "陪我聊聊天", "有点困了", "放首歌听听"]) {
    it(`「${q}」→ cabin`, () => expectRoute(q, "cabin"));
  }

  it("**陪伴优先级最低**：夹着「无聊」的求助仍然是求助", () => {
    // 「无聊」这类词在任何一句话里都可能出现。让它压过续航或故障，
    // 就是把一次求助当成闲聊——用户不会再问第二遍。
    expectRoute("开着有点无聊，顺便问下我这车续航正常吗", "ownership");
    expectRoute("路上没意思，仪表盘刚才亮了个黄灯", "service");
  });
});

describe("兜底", () => {
  it("闲聊走通用应答", () => {
    expectRoute("你好", "general");
    expectRoute("今天几号", "general");
  });

  it("**单条弱证据只出现在 context 里不足以定性**", () => {
    // 模型释义时顺口提到「车」不该触发专项路由。
    const r = decideRoute(withIntent({ context: "用户在车里问了一个无关问题" }), "帮我算一下");
    assert.equal(r.agent, "general");
  });

  it("降级时说明是降级——排障时要能分清「没命中」与「没理解」", () => {
    const r = decideRoute(withIntent({ goal: "今天几号", degraded: true }), "今天几号");
    assert.equal(r.agent, "general");
    assert.match(r.reason, /降级/);
  });
});

describe("决策依据要能被回放看懂（F-11-07）", () => {
  it("reason 写明凭哪几条证据与得分", () => {
    const r = decideRoute(bare, "仪表盘亮了个黄灯");
    assert.match(r.reason, /报警\/指示灯/);
    assert.match(r.reason, /得分 \d+/);
  });

  it("势均力敌时把次选也说出来——「差点判到哪里」同样重要", () => {
    const r = decideRoute(bare, "我这车该保养了吗，顺便看看胎压");
    assert.match(r.reason, /次选/);
  });
});

describe("context 不参与「够不够格」，只参与「选哪一个」（实测 bug）", () => {
  /**
   * 起因是一次真实对话（`turn-2fac495b`）：
   *
   *   用户：哈喽哈喽离我最近的停车场在哪里呀
   *   系统：花 42 秒、四次 LLM 调用、两条并行分支，答"我没有停车场检索"
   *
   * 原话、goal、constraints 三个字段一个信号都没命中。命中的两条全在 context 里
   * ——意图理解把上一轮的历史写了进去：「此前正在规划8月12日**去上海**…的**行程**」。
   *
   * 早先只是把 context 降权到 ×1，注释写着"一条 weak 信号只得 1 分，不足以定性"。
   * **那个判断漏了权重 3 的强信号**：3 × 1 = 3 = 门槛，一条就够。
   *
   * 下面四条是从全量轨迹（72 轮有原话可比）里捞出来的**会变的全部三例**，
   * 逐条钉住。它们同时也是"改判据不能只看一个例子"的证据——
   * 下次有人调权重，这三条会告诉他动了什么。
   */

  it("**只出现在 context 里的强信号不能单独过线**——停车场那次", () => {
    const r = decideRoute(
      withIntent({
        goal: "查询离车主当前位置最近的停车场位置",
        constraints: ["距离优先：要离得最近的停车场", "地点未指明，按当前位置就近查询"],
        context: "此前正在规划8月12日去上海海昌海洋公园奥特曼酒店的行程，天气已确认",
      }),
      "哈喽哈喽离我最近的停车场在哪里呀",
    );
    assert.equal(r.agent, "general", "找停车场不是行程规划——判成 trip 会拉起整套 fan-out");
  });

  it("陈述偏好不该被 context 推去双路检索", () => {
    const r = decideRoute(
      withIntent({
        goal: "建立/同步充电偏好",
        context: "车主此前询问过续航与充电相关话题",
      }),
      "我一般晚上十点以后在家充电，充到九成就拔",
    );
    assert.equal(r.agent, "general", "这是陈述不是提问，双路检索无事可做（偏好写入是另一条链路）");
  });

  it("**⑥用车数据的问题该走 ownership**——此前被 context 推去了维修库", () => {
    const r = decideRoute(
      withIntent({
        goal: "了解自己车辆最近一段时间的行驶频率/里程",
        context: "车主此前提到过保养周期与工单",
      }),
      "我这车最近开得多吗？",
    );
    assert.equal(r.agent, "ownership", "问的是用车数据，不是保养——context 里的「保养」不该定性");
  });

  it("**context 仍然参与排序**——它只是不能单独定性", () => {
    // 原话里的信号命中后 `break`，同一条信号不会再去看 context；
    // 所以要让 context 真的加分，得用一条**原话里没有**的信号。
    // 这里：原话给「胎压」（日常用车部件 2×3=6）与「我这车」（1×3=3）过门槛，
    // context 里另给「续航」（续航与能耗 3×1=3）——它只进总分，不进门槛分。
    const r = decideRoute(
      withIntent({ context: "车主此前问过续航" }),
      "我这车胎压多少",
    );
    assert.equal(r.agent, "ownership");
    assert.match(r.reason, /context 贡献 3/, "context 起了作用就要说出来（F-11-07）");
  });

  it("原话里有的强信号照常过线——这条规则不能把正常路由也挡掉", () => {
    // 防止"修过头"：把 context 关出闸口后，正常路径必须一点不受影响。
    for (const [text, expected] of [
      // M12 改判（向好）：「三天」是多天行程——trip 的单程 fan-out 里没有
      // 酒店/逐天分支，判过去用户问的住宿会凭空消失（实测 turn-ffe8c0b2）。
      ["我想去黄山自驾三天", "itinerary"],
      ["我这车该保养了吗", "service"],
      ["我这车续航掉得厉害正常吗", "ownership"],
    ] as const) {
      assert.equal(decideRoute(bare, text).agent, expected, `「${text}」应判为 ${expected}`);
    }
    // 这句在既有断言里是 `notEqual(trip)`——判成 general 才是对的，
    // 别把它写成"应判 trip"（我第一版就写反了）。
    assert.notEqual(decideRoute(bare, "在日历里加一条：明天上午十点洗车").agent, "itinerary");
  });
});

/**
 * 试驾路由（施工单 M19-03）。
 *
 * 这一组守的是一条**实测缺陷的回归**：2026-08-12 会话 sess-330b45e7-b9e，
 * 「帮我约这个周六上午去深圳南山特斯拉中心试驾 Model Y」被判给 trip
 * （"去某地" 6 分，优先级赢），模型改调 calendar 写了条日历，
 * 然后回答"试驾已经帮您约好了"——既违反 AC-15-8，又是没做却说做了。
 */
describe("试驾路由（M19-03）", () => {
  const route = (t: string) =>
    decideRoute({ goal: t, constraints: [], context: "", riskBoundary: "" }, t, {});

  it("**「去某地试驾」回归**——不能再被 trip 拽走", () => {
    const r = route("帮我约这个周六上午去深圳南山特斯拉中心试驾 Model Y，我姓林，手机 13800138000");
    assert.equal(r.agent, "testDrive", `实际判到 ${r.agent}：${r.reason}`);
  });

  it("直白的试驾请求", () => {
    assert.equal(route("我想试驾 Model Y，帮我约一下").agent, "testDrive");
    assert.equal(route("约个试乘试驾").agent, "testDrive");
  });

  it("**特化压制不能把正常出行拽走**", () => {
    // M13-13 之后单程与多天同一目标；这条守的是"试驾不该把出行请求吸走"。
    assert.equal(route("明天去杭州怎么走").agent, "itinerary");
    assert.equal(route("我们去广州玩4天，帮我安排行程和酒店").agent, "itinerary");
  });

  it("**选型比较仍归购车顾问**——试驾迁走不该带塌 buying", () => {
    assert.equal(route("Model 3 和 Model Y 哪款好").agent, "buying");
    assert.equal(route("帮我选车，预算25万的纯电").agent, "buying");
  });

  it("**门店/时段的弱信号单独出现不够格**——「哪家店能修车」不该被拽到试驾", () => {
    assert.notEqual(route("哪家店能修车").agent, "testDrive");
    assert.notEqual(route("周六上午有没有空").agent, "testDrive");
  });

  it("故障与保养仍归售后", () => {
    assert.equal(route("车子有异响，要不要紧").agent, "service");
    assert.equal(route("保养一年要花多少钱").agent, "service");
  });
});

describe("试驾 Agent 的工具表（M19-03）", () => {
  it("四件套 + 联系方式两件套，且**没有 calendar**（AC-15-8 负向验收）", () => {
    const names = listForAgent("test-drive").map((t) => t.name);
    // 白名单式断言：新工具进来时**必须有人改这一行**。
    // 写成"包含四件套"就悄悄放过了任何多给出去的工具。
    assert.deepEqual(names.sort(), [
      // M19-06：免去每次重问手机号
      "contact_lookup",
      "contact_update",
      "dealer_pricing",
      "dealer_slots",
      "dealer_stores",
      "test_drive_book",
    ]);
    assert.equal(names.includes("calendar"), false, "试驾流程不得调 calendar——重复写日历是多余的授权动作");
  });

  it("Agent 名不以 -task/-intent/-voice 结尾——否则 loadAgentPrompt 会找错文件", () => {
    assert.equal(canonicalAgent("test-drive"), "test-drive");
  });

  it("`testDrive` 路由目标接到 `testDriveFlow` 节点（**节点名不与状态字段同名**）", () => {
    assert.equal(branchFor({ agent: "testDrive" }), "testDriveFlow");
  });
});

/**
 * ④⑥ 三个消费方的工具表（M26-02）。
 *
 * 白名单式断言，理由同上面试驾那组：**新工具进来时必须有人改这几行**。
 * 写成"包含 xxx"就悄悄放过了任何多给出去的工具——而工具是按 `--tools` 下发给模型的，
 * 多给一个就是多一条模型可以自己走的路，没有任何东西会因此变红。
 */
/**
 * 复述即确认（M26-04，AC-53-5）。
 *
 * §4.6 要的是"复述 + **一次**确认"，不是"先复述、用户说对、再弹一次窗"。
 * 所以复述必须长在确认弹窗上——`summarizeAction` 的输出就是那一屏的标题。
 */
describe("补录的确认弹窗就是复述（M26-04）", () => {
  it("保养补录：日期、项目、里程都回显，车主能一眼看出哪个数记错", () => {
    const text = summarizeAction(
      "vehicle_profile_write",
      { op: "maintenance", at: Date.UTC(2026, 6, 12), odometerKm: 186_000, items: "小保养" },
      "（工具描述，不该出现在弹窗上）",
    );
    assert.match(text, /记一次保养/);
    assert.match(text, /2026/);
    assert.match(text, /小保养/);
    assert.match(text, /186000 公里/);
    assert.equal(text.includes("工具描述"), false, "弹窗上不许出现写给模型看的文本");
  });

  it("只推里程时只说里程，不编造保养项目", () => {
    const text = summarizeAction("vehicle_profile_write", { op: "odometer", odometerKm: 186_000 }, "x");
    assert.equal(text, "把当前里程更新为 186000 公里");
  });

  it("入参缺失时给动作名，**不回落到工具描述 + 原始 JSON**（M15-03 那次的坑）", () => {
    const text = summarizeAction("vehicle_profile_write", {}, "把档案改一改（需用户确认）");
    assert.equal(text, "更新车辆档案");
    assert.equal(text.includes("需用户确认"), false);
  });
});

describe("④⑥ 消费方的工具表（M26-02）", () => {
  it("ownership：M26-02 加 data_freshness，M26-06 加 energy_gap / refuel_log，M41-03 加 repair_history", () => {
    assert.deepEqual(listForAgent("ownership").map((t) => t.name).sort(), [
      "calendar",
      "data_freshness",
      "energy_gap",
      "ragflow_retrieve",
      // `refuel` 是找加油站，`refuel_log` 是记一次加油——**两回事，别混**。
      "refuel",
      "refuel_log",
      // M41-03：4S 系统侧的维修史（F-20-05 工况关联的另半边；本地留档在 vehicle_profile）
      "repair_history",
      "usage_profile",
      "vehicle_member",
      "vehicle_profile",
      "vehicle_profile_write",
    ]);
  });

  it("service：M41-03 加四个维修/保险工具，M44-02 加维修站与进厂时段查询", () => {
    assert.deepEqual(listForAgent("service").map((t) => t.name).sort(), [
      "appointment",
      "contact_lookup",
      "contact_update",
      "data_freshness",
      // M41-03：理赔预检的报价单由工具层自己取，模型只给 VIN——金额不经模型的手
      "insurance_policy",
      "insurance_precheck",
      "ragflow_retrieve",
      "repair_history",
      "repair_quote",
      // M44-02：预约引导子图的两条查询（站名与时段只能来自这里）
      "repair_slots",
      "repair_stations",
      "usage_profile",
      "vehicle_profile",
      "vehicle_profile_write",
    ]);
  });

  it("trip：M26-02 加 data_freshness，M26-06 加 energy_gap / refuel_log，M31-01 加 trip_plan_nav，M32-01 加 destination_highlights", () => {
    assert.deepEqual(listForAgent("trip").map((t) => t.name).sort(), [
      "calendar",
      "charging",
      "data_freshness",
      // M32-01：目的地的美食榜 / 打卡点 / 拍照建议（经模型内置联网搜索）
      "destination_highlights",
      "energy_gap",
      "map_route",
      "preference_recall",
      "pretrip_items",
      "refuel",
      "refuel_log",
      // 路径顺序体检（本次）：单日多点出行的顺序也要能体检
      "route_audit",
      "trip_plan_cancel",
      "trip_plan_commit",
      "trip_plan_list",
      "trip_plan_nav",
      "trip_plan_query",
      "trip_plan_update",
      "usage_profile",
      "vehicle_member",
      "vehicle_profile",
      "weather",
    ]);
  });

  it("cabin：M27 加 cabin_media，其余不变", () => {
    // 白名单式断言，与试驾那条同一个理由：**新工具进来必须有人改这一行**。
    // 座舱此前一直没有这条断言，于是它是全仓唯一一个"多给出去也没人知道"的
    // Agent——而它手上有会真的动车内设备的工具，恰恰最不该是那一个。
    assert.deepEqual(listForAgent("cabin").map((t) => t.name).sort(), [
      "cabin_apply_preferences",
      "cabin_child_mode",
      "cabin_control",
      "cabin_media",
      "cabin_status",
      "contact_lookup",
      "contact_update",
      "member_preference_set",
      "preference_recall",
      "vehicle_member",
    ]);
  });

  it("cabin_media 只给座舱——别的 Agent 拿到就是能越权放歌", () => {
    for (const agent of ["supervisor", "ownership", "service", "buying", "trip", "test-drive"] as const) {
      assert.equal(
        listForAgent(agent).some((t) => t.name === "cabin_media"),
        false,
        `${agent} 不该拿到 cabin_media`,
      );
    }
  });

  it("其余 Agent 一律拿不到 data_freshness——它是用户私有数据", () => {
    for (const agent of ["supervisor", "buying", "cabin", "test-drive"] as const) {
      assert.equal(
        listForAgent(agent).some((t) => t.name === "data_freshness"),
        false,
        `${agent} 不该拿到 data_freshness`,
      );
    }
  });

  it("drive（行车分支）：M26-06 加 energy_gap / refuel_log；M30-04 加 submit_drive_draft", () => {
    assert.deepEqual(listForAgent("drive").map((t) => t.name).sort(), [
      "charging",
      "energy_gap",
      "map_route",
      "pretrip_items",
      "refuel",
      "refuel_log",
      // M30-04：结论提交通道——只有 drive 有它，别的分支各有各的 submit_*。
      "submit_drive_draft",
      "transit_route",
      "weather",
    ]);
  });
});

describe("座舱设置路由（M24-04）", () => {
  const route = (t: string) =>
    decideRoute({ goal: t, constraints: [], context: "", riskBoundary: "" }, t, {});

  it("设置指令归 cabin：带动作语义的温度/座椅/媒体/儿童模式", () => {
    assert.equal(route("帮我把空调调到 23 度").agent, "cabin");
    assert.equal(route("空调调到 23 度，座椅加热开 2 档").agent, "cabin");
    assert.equal(route("后排通风开一下，温度 35 度").agent, "cabin");
    assert.equal(route("后排放个儿歌，屏幕锁上").agent, "cabin");
    assert.equal(route("今天副驾是妈妈，后排是小宝").agent, "cabin", "乘坐声明触发按人调好，不是出行规划");
  });

  it("**咨询句照旧归 ownership**：温度信号要求数字在场，咨询一分拿不到", () => {
    assert.equal(route("空调怎么用").agent, "ownership");
    assert.equal(route("座椅加热在哪打开").agent, "ownership");
  });
});

describe("「出发前」是时间状语，不是动身指令（M62-02，评测 o-30）", () => {
  /*
   * 「冬天出发前想先暖车，我这车的定时预热功能怎么用」——问的是功能。
   * 此前 `DEPART_PATTERNS` 命中「出发」、`DEPART_AS_PLAN` 没有「出发前」这个否决项，
   * 整句被当成动身指令一律走 itinerary、不看分数，连用车助手的双路检索一起丢掉。
   */
  it("o-30 原话 → ownership", () => {
    expectRoute("冬天出发前想先暖车，我这车的定时预热功能怎么用", "ownership");
  });
  it("「出发之前把行程定了」不是动身指令（它在说计划）", () => {
    const r = decideRoute(bare, "出发之前把行程定了再说");
    assert.doesNotMatch(r.reason, /出发\/结束导航/, `被当成了动身指令：${r.reason}`);
  });
  it("「现在出发」仍是动身指令", () => {
    const r = decideRoute(bare, "现在出发");
    assert.match(r.reason, /出发\/结束导航/);
  });
});
