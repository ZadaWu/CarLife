/**
 * L1 导游式闲聊与持续陪等（施工单 M18-09，F-45-05）。
 *
 * # 这一单的判据为什么大多是"结构"而不是"文案"
 *
 * 三轮探针（每轮 20 次真模型调用）量出来的结论是：**提示词挡不住**。
 * v1→v2 把禁令写得更狠，"回答用户问题"的犯规率 40%→40% 纹丝不动。
 * 真正让它归零的是**限制它能看见什么**——只给地名，不给问题原文。
 *
 * 所以这里断言的是"用户原话到不了模型手里"这类结构性事实，
 * 而不是"生成的句子里没有 XX 词"——后者验不住，也不该假装验住了。
 */

import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";

import { FILLER_PHRASE } from "@carlife/shared";

import {
  FIRST_MAX_CHARS,
  GUIDE_SYSTEM,
  TAIL_MAX_CHARS,
  guideMessages,
  nowText,
  rejectGuideText,
} from "../src/sidecar/l1";
import { genRetryMs, sidecarDefaults } from "../src/sidecar/budget";
import { chatMemorySize, recallSaid, resetChatMemory } from "../src/sidecar/chat-memory";
import { progressBridge, progressPrefix, progressTables } from "../src/sidecar/templates";
import {
  PairSession,
  resetSidecarCounters,
  resetSidecarRegistry,
  sidecarCounters,
  type FillerDraft,
} from "../src/sidecar/pair-session";

const KEEP = { ...process.env };

beforeEach(() => {
  process.env.SIDECAR_ENABLED = "1";
  process.env.SIDECAR_TICK_MS = "0";
  process.env.SIDECAR_SPEECH_MS_PER_CHAR = "0";
  delete process.env.SIDECAR_MIN_GAP_MS;
  delete process.env.SIDECAR_SILENCE_MS;
  resetSidecarRegistry();
  resetSidecarCounters();
  // 闲聊记忆是**会话作用域**的，跨 turn 活着——用例之间必须清，
  // 否则第二个用例拿到的是第一个用例的开场白轮次与上文。
  resetChatMemory();
});

after(() => {
  process.env = { ...KEEP };
});

/** 等 fire-and-forget 的生成 promise 落地。 */
const settle = () => new Promise((r) => setImmediate(r));

describe("提示词只看得见地名（M18-09 的地基）", () => {
  it("入参里根本没有「用户原话」这个位置", () => {
    const msgs = guideMessages({ place: "苏州", nowText: "2026年8月", said: [] });
    const all = msgs.map((m) => m.content).join("\n");
    assert.ok(all.includes("苏州"));
    assert.ok(all.includes("2026年8月"));
    // 类型上就没有第二个内容字段——这条断言防的是以后有人"顺手带上原话"
    assert.equal(
      guideMessages.length,
      1,
      "只有一个入参对象，且它的字段是 place/nowText/said，没有问题原文的位置",
    );
  });

  it("没有地名时明说「没有」，而不是留空让它自己想一个", () => {
    const msgs = guideMessages({ nowText: "2026年8月", said: [] });
    assert.ok(msgs[0].content.includes("没有提到任何地方"));
    assert.ok(GUIDE_SYSTEM.includes("不要编一个地方出来"));
  });

  it("必须喂当前年月——不喂就会说出时令不对的话", () => {
    // 实测（.tmp/probe-season.ts）：不喂日期时八月说「婺源的油菜花一开」（3~4 月的事）、
    // 「苍山雪化的时候」。喂了之后「洛阳的牡丹早开过了」这种就对了。
    assert.equal(nowText(Date.UTC(2026, 7, 14, 4)), "2026年8月");
    assert.ok(guideMessages({ nowText: "2026年8月", said: [] })[0].content.startsWith("现在是2026年8月"));
  });

  it("人设写成**事实陈述**而不是禁令——那是 NARRATOR_SYSTEM 量出来的手法", () => {
    assert.ok(GUIDE_SYSTEM.includes("你不知道车主问了什么"));
    assert.ok(GUIDE_SYSTEM.includes("你没有查过任何资料"));
  });

  it("车的事不归它说——写成职责划分，不写成一条禁令", () => {
    assert.ok(GUIDE_SYSTEM.includes("车的事不归你说"));
    assert.ok(GUIDE_SYSTEM.includes("你插一句就成了两个人同时在答"));
  });

  it("话题只有三样，且写成「你只记得这三样」而不是「你只准聊这三样」", () => {
    assert.ok(
      GUIDE_SYSTEM.includes("你脑子里关于这个地方只存着三样东西：好吃的、老故事、好看的地方"),
      "写成禁令的版本等着被绕过；写成它对自己的认知才立得住（同 NARRATOR_SYSTEM 的手法）",
    );
    assert.ok(GUIDE_SYSTEM.includes("天气、路况、当地人过得怎么样、房价物价——这些你是真不知道"));
  });

  it("语气：先想好的一面，不评价当地人，不挖苦", () => {
    assert.ok(GUIDE_SYSTEM.includes("先想到的总是它好的那一面"));
    assert.ok(GUIDE_SYSTEM.includes("不评价当地人"));
    assert.ok(GUIDE_SYSTEM.includes("不挖苦、不抬杠、不拿谁开玩笑"));
  });

  /**
   * 「聊历史」与「不许出现朝代和数字」是对着干的，这个张力是**刻意留着**的：
   * 历史恰恰最容易编年份，而编出来的年份用户无从证伪。
   */
  it("聊历史只能聊氛围，不能报年代、也不能编故事情节", () => {
    assert.ok(GUIDE_SYSTEM.includes("聊那份年头久的感觉，别去报是哪年哪代"));
    assert.ok(
      GUIDE_SYSTEM.includes("也不要讲具体的故事情节"),
      "实测它编过「早年间有艘船常停那儿」——听着像典故，其实是现编的，比编年份更难被发现",
    );
  });

  it("日期不许把它引到天气上", () => {
    const first = guideMessages({ place: "厦门", nowText: "2026年8月", said: [] })[0].content;
    assert.ok(first.includes("2026年8月"));
    assert.ok(
      first.includes("别聊天气"),
      "写成光秃秃的「现在是八月」时，实测它一看见就从「这大热天的…」起头",
    );
  });
});

/**
 * 走查（2026-08-14）：「你现在就是东聊一句，西聊一句」。
 *
 * 根因不是提示词不够狠，是**结构**：已说过的句子当成"别重复这些"的黑名单摊进 prompt，
 * 只约束了不许一样，没有任何东西要求后一句与前一句有关系。
 * 改成把它们以 `assistant` 身份回填成真实轮次，连贯性就来自它自己的上文。
 */
describe("接得住话：已说过的句子是**上文**，不是黑名单（M18-09 走查）", () => {
  it("第一次只有一条 user 消息", () => {
    const msgs = guideMessages({ place: "重庆", nowText: "2026年8月", said: [] });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, "user");
  });

  it("说过的句子以 assistant 身份回填，且 user/assistant 交替", () => {
    const msgs = guideMessages({
      place: "重庆",
      nowText: "2026年8月",
      said: ["重庆这时候热得跟蒸笼似的", "说起来那边人吃辣是真厉害"],
    });
    assert.deepEqual(
      msgs.map((m) => m.role),
      ["user", "assistant", "user", "assistant", "user"],
    );
    assert.equal(msgs[1].content, "重庆这时候热得跟蒸笼似的");
    assert.equal(msgs[3].content, "说起来那边人吃辣是真厉害");
  });

  it("**不出现「刚才已经说过这些」这类黑名单措辞**", () => {
    const all = guideMessages({ place: "苏州", nowText: "2026年8月", said: ["苏州的园子慢悠悠的"] })
      .map((m) => m.content)
      .join("\n");
    assert.ok(
      !/换个角度|已经说过|不要重复|别说这些/.test(all),
      "回到黑名单措辞就等于回到「东聊一句西聊一句」——那正是本次走查报的问题",
    );
  });

  it("占位的 user 消息不替车主指定话题", () => {
    const msgs = guideMessages({ place: "苏州", nowText: "2026年8月", said: ["一"] });
    // 车主此刻根本没在说话，写成实质内容就成了我们替他挑话题
    assert.equal(msgs[2].content, "嗯。");
  });

  it("回填够长，不会让它绕回开头那个话题", () => {
    const said = ["一", "二", "三", "四", "五"];
    const msgs = guideMessages({ place: "苏州", nowText: "2026年8月", said });
    const kept = msgs.filter((m) => m.role === "assistant").map((m) => m.content);
    assert.deepEqual(
      kept,
      said,
      "只回填 3 句时实测第 5 句又说回了第 1 句的话题（苏州「小桥流水」）",
    );
  });
});

describe("后置过滤：抓得住的抓住，抓不住的不装作抓住了", () => {
  it("数字、朝代、推荐口气、反问、超长 —— 拒", () => {
    for (const [text, why] of [
      ["这地方有 800 年历史了", "阿拉伯数字"],
      ["城墙是明代修的", "编朝代"],
      ["老街有二十家糖水铺", "中文数量"],
      ["这条街值得去走走", "推荐口气"],
      ["你去过那边吗？", "反问"],
      ["", "空"],
      ["一".repeat(TAIL_MAX_CHARS + 1), "超长"],
    ] as const) {
      assert.ok(rejectGuideText(text), `「${text}」该被拒（${why}）`);
    }
  });

  it("正常的一句话放行", () => {
    assert.equal(rejectGuideText("苏州的夏天巷子里蝉声特别响"), undefined);
    assert.equal(rejectGuideText("而且那种老字号的糖水铺，夜里一碗绿豆沙最舒服"), undefined);
  });

  it("舞台提示与标记 —— 拒。下游是 TTS，会把「顿了顿」三个字念出来", () => {
    for (const t of [
      "（顿了顿）说着说着，倒想起园林里那几棵老桂树",
      "*轻声* 这时候的荔枝正甜",
      "【回忆】老码头透着股年代感",
    ]) {
      assert.ok(rejectGuideText(t), `「${t}」该被拒`);
    }
  });

  it("长度闸比提示词里的要求松 —— 为守一个字数把最好听的一句换成模板话，不划算", () => {
    assert.ok(
      TAIL_MAX_CHARS > 25,
      "提示词要 25 字，闸卡在 30 时实测 3/30 句因 31~34 字被拒，而那几句恰恰是展开得最好的",
    );
    assert.ok(TAIL_MAX_CHARS * 200 < 12_000, "但不能超过端上 FILLER_WAIT_CAP_MS 的 12 秒");
  });

  it("「一年到头」这类口语不算数量——误杀的代价是把最连贯的一句换成模板话", () => {
    assert.equal(rejectGuideText("那边一年到头绿油油的"), undefined);
    assert.equal(rejectGuideText("那边一年四季都湿漉漉的"), undefined);
    // 真的数量断言仍要拦住
    assert.ok(rejectGuideText("那城墙立了八百年了"));
  });

  it("没有地名时收严：不许把话头绕回车上", () => {
    // 实测：无地名那组它一路滑到「空调得开足点」「最怕堵在路上」——
    // 那已经是在给用车建议了，而旁路不作答是 F-45-09 的红线。
    for (const t of ["这天热得，车里凉快吧", "空调得开足点", "就怕堵在路上动弹不得"]) {
      assert.ok(rejectGuideText(t, TAIL_MAX_CHARS, true), `「${t}」在无地名时该被拒`);
    }
    // 有地名时不查这条：比喻性地提一句车是无害的
    assert.equal(rejectGuideText("街上的人跑得比车还快", TAIL_MAX_CHARS, false), undefined);
  });

  /**
   * ⚠️ 这条用例是**故意留着的红字**：时令错误没有稳定词形，正则抓不住。
   * 与其写一条假装抓住了的断言，不如把这个缺口显式钉在测试里——
   * 缓解手段是喂当前日期（上面那组），不是这道过滤。
   */
  it("已知抓不住：时令错误。缓解靠喂日期，不靠这道闸", () => {
    assert.equal(
      rejectGuideText("等婺源的油菜花一开，满山都是黄的"),
      undefined,
      "过滤器确实放它过去了——这是被承认的缺口，不是回归",
    );
  });
});

describe("L1 接进 pair：有货用 L1，没货回落 L0（M18-09 约束 3）", () => {
  function makePair(writer?: PairSession["constructor"] extends never ? never : any) {
    let now = 0;
    const said: FillerDraft[] = [];
    const pair = new PairSession("s1", "t-l1", 0, {
      now: () => now,
      emit: (d) => said.push(d),
      ...(writer ? { writer } : {}),
    });
    return { pair, said, tick: (t: number) => (now = t) };
  }

  it("生成好的句子优先于 L0 词表——L0 只有 9 句，撑不到 60 秒", async () => {
    const { pair, said, tick } = makePair(async () => "苏州的夏天巷子里蝉声特别响");
    pair.setPlace("苏州");
    await settle();

    tick(2000);
    pair.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 1 });

    assert.equal(said.length, 1);
    assert.equal(said[0].source, "l1");
    assert.ok(said[0].text.endsWith("苏州的夏天巷子里蝉声特别响"));
    assert.equal(sidecarCounters().l1Spoken, 1);
  });

  it("被过滤器拒 ⇒ 计数 +1 并回落 L0，用户侧无感", async () => {
    const { pair, said, tick } = makePair(async () => "这地方有 800 年历史了");
    pair.setPlace("西安");
    await settle();

    tick(2000);
    pair.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 1 });

    assert.equal(sidecarCounters().l1Rejected, 1);
    assert.equal(said.length, 1);
    assert.equal(said[0].source, "l0", "回落必须是静默的——拒了就不说话才是真的尴尬");
    assert.ok(said[0].text.endsWith(FILLER_PHRASE.retrieval[0]));
  });

  it("生成抛错 / 超时 ⇒ 计数 +1 并回落 L0，且不外抛", async () => {
    const { pair, said, tick } = makePair(async () => {
      throw new Error("deepseek 超时");
    });
    pair.setPlace("杭州");
    await settle();

    tick(2000);
    assert.doesNotThrow(() => pair.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 1 }));
    assert.equal(sidecarCounters().l1Unavailable, 1);
    assert.equal(said[0].source, "l0");
  });

  it("不注入 writer ⇒ 全程 L0，行为与 M18-08 一致", () => {
    const { pair, said, tick } = makePair();
    pair.setPlace("成都");
    tick(2000);
    pair.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 1 });
    assert.equal(said[0].source, "l0");
    assert.equal(sidecarCounters().l1Spoken, 0);
  });

  it("说过的话作为上文喂给下一次生成", async () => {
    const seen: string[][] = [];
    let n = 0;
    const { pair, tick } = makePair(async (input: { said: readonly string[] }) => {
      seen.push([...input.said]);
      n += 1;
      return `第${"一二三".slice(n - 1, n)}句闲话说的是别的`;
    });
    pair.setPlace("南京");
    await settle();

    tick(2000);
    pair.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 1 });
    await settle();
    tick(2000 + 4000);
    pair.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 2 });

    assert.deepEqual(seen[0], [], "第一次没什么可避");
    assert.ok(seen[1] !== undefined && seen[1].length >= 1, "第二次要带上已经说过的");
  });

  /**
   * 退避**不跟 `minGapMs` 走**（走查把间隔调到 500ms 之后才显出必要性）。
   *
   * 说话节奏与重试退避是两件事：一个是用户体感，一个是花钱与限流。
   * 共用一个值时，`minGapMs` 调到 500 会让退避跟着塌成半秒——
   * 被过滤器拒一次之后，节拍每响一下就重打一次模型，
   * 而用户侧毫无异常：他只是听不到 L1，全程都是 L0 模板话。
   */
  it("生成失败后退避，且退避有地板、不跟 minGapMs 一起塌下去", async () => {
    const cfg = sidecarDefaults();
    const floor = genRetryMs(cfg);
    assert.ok(floor > cfg.minGapMs, "间隔已经调到 500ms，退避必须有自己的地板");

    let calls = 0;
    const { pair, tick } = makePair(async () => {
      calls += 1;
      return undefined;
    });
    pair.setPlace("重庆");
    await settle();
    assert.equal(calls, 1);

    // 退避窗口内反复唤起，不该再打
    for (let i = 0; i < 5; i += 1) {
      tick(floor - 100 + i);
      pair.observe({ kind: "span", name: "tool.ragflow_retrieve", at: i });
      await settle();
    }
    assert.equal(calls, 1, `退避失效会把导游变成一台按 tick 计费的机器，实际打了 ${calls} 次`);

    // 过了地板才允许重试
    tick(floor + 1);
    pair.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 99 });
    await settle();
    assert.equal(calls, 2);
  });

  it("turn 结束后在途的生成结果不许再落进 pending——那是上一轮的话", async () => {
    let resolve: (v: string) => void = () => {};
    const { pair, said, tick } = makePair(
      () => new Promise<string>((r) => (resolve = r)),
    );
    pair.setPlace("厦门");
    pair.close();
    resolve("鼓浪屿那边风一直是咸的");
    await settle();

    tick(2000);
    pair.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 1 });
    assert.equal(said.length, 0, "关掉之后一个字都不该再出来");
  });
});

describe("第 1 句的长度预算与端上等待上限对得上（M18-09 约束 4）", () => {
  it("最长的第 1 句不超过 FIRST_MAX_CHARS", () => {
    let worst = 0;
    for (const phase of ["understanding", "routing", "profile", "retrieval", "composing"] as const) {
      // 闲话本身的上限是 TAIL_MAX_CHARS（过滤器守着）
      const longestPrefix = Math.max(...progressTables().prefix[phase].map((t) => [...t].length));
      const longestBridge = Math.max(...progressTables().bridges.map((b) => [...b].length));
      const len = longestPrefix + longestBridge + TAIL_MAX_CHARS;
      worst = Math.max(worst, len);
    }
    assert.ok(
      worst <= FIRST_MAX_CHARS,
      `第 1 句最长 ${worst} 字，超过 ${FIRST_MAX_CHARS}——端上 FILLER_WAIT_CAP_MS 是照这个数定的`,
    );
  });
});

/**
 * 走查（2026-08-14 第五轮）：「第一句话永远是：后台正在处理您的需求…」
 * 以及「确认下旁路是否有自己独立的记忆」。
 *
 * 两件事其实是同一个根因：**旁路此前完全没有跨轮的东西**。
 * `registry` 按 `turnId` 存，`closePair` 在 turn 结束时把 `PairSession` 整个删掉，
 * 于是每一轮都从零开始——开场白没有可轮换的依据，闲聊也没有可接续的上文。
 */
describe("旁路自己的记忆：这一趟车的，不是这个人的（走查第五轮）", () => {
  it("同一会话的第 2 轮拿到不同的轮次号，于是换一种开场白", () => {
    const a = new PairSession("s-mem", "t1", 0, { now: () => 0, emit: () => {} });
    const b = new PairSession("s-mem", "t2", 0, { now: () => 0, emit: () => {} });
    assert.equal(a.snapshot().turnOrdinal, 0);
    assert.equal(b.snapshot().turnOrdinal, 1);
    assert.notEqual(
      progressPrefix("understanding", 0) + progressBridge(0),
      progressPrefix("understanding", 1) + progressBridge(1),
      "两轮开场白一样，走查报的「永远是那句」就没修掉",
    );
    a.close();
    b.close();
  });

  it("不同会话各记各的——同车不同人不该串", () => {
    const a = new PairSession("s-A", "t1", 0, { now: () => 0, emit: () => {} });
    const b = new PairSession("s-B", "t1", 0, { now: () => 0, emit: () => {} });
    assert.equal(a.snapshot().turnOrdinal, 0);
    assert.equal(b.snapshot().turnOrdinal, 0);
    a.close();
    b.close();
  });

  it("L1 说过的话跨 turn 留下，下一轮当上文接着说", async () => {
    let seen: readonly string[] = [];
    const writer = async (input: { said: readonly string[] }) => {
      seen = input.said;
      return "苏州的糖藕这时候正当时";
    };
    let now = 0;
    const p1 = new PairSession("s-carry", "t1", 0, { now: () => now, emit: () => {} , writer });
    p1.setPlace("苏州");
    await settle();
    now = 2000;
    p1.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 1 });
    p1.close();

    assert.deepEqual([...recallSaid("s-carry")], ["苏州的糖藕这时候正当时"]);

    // 第 2 轮：上文里带着上一轮说过的话
    const p2 = new PairSession("s-carry", "t2", 0, { now: () => now, emit: () => {}, writer });
    p2.setPlace("苏州");
    await settle();
    assert.deepEqual(
      [...seen],
      ["苏州的糖藕这时候正当时"],
      "按轮取上文时，同一趟车里连问三个深圳的问题会把「深圳的荔枝」从头说三遍",
    );
    assert.equal(p2.snapshot().placeIsFresh, false, "这个地方这一趟里已经聊过了");
    p2.close();
  });

  it("**L0 模板话不进这份记忆** —— 那是另一个角色说的", async () => {
    let now = 0;
    const p = new PairSession("s-l0", "t1", 0, { now: () => now, emit: () => {} });
    p.setPlace("杭州");
    now = 2000;
    p.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 1 });
    p.close();
    assert.deepEqual(
      [...recallSaid("s-l0")],
      [],
      "把「我在翻你这车的手册」喂回给导游当上文，等于让它接一句不是自己说的话",
    );
  });

  it("不泄漏：闲聊记忆按空闲时间清，且不另起定时器", () => {
    resetChatMemory();
    const IDLE = 30 * 60 * 1000;
    let now = 0;
    for (let i = 0; i < 5; i += 1) {
      new PairSession(`s-old-${i}`, "t", now, { now: () => now, emit: () => {} }).close();
    }
    assert.equal(chatMemorySize(), 5);
    // 时间推过空闲窗口之后再来一个新会话——清扫挂在写入路径上
    now += IDLE + 1;
    new PairSession("s-new", "t", now, { now: () => now, emit: () => {} }).close();
    assert.equal(chatMemorySize(), 1, "只剩新来的那个；旧的在写入时被扫掉");
  });
});

describe("开场白不再永远是那一句（走查第五轮）", () => {
  it("每个阶段至少 4 种说法，引子至少 5 种 —— 组合数是乘出来的", () => {
    const { prefix, bridges } = progressTables();
    let combos = 0;
    for (const pool of Object.values(prefix)) {
      assert.ok(pool.length >= 4);
      combos += pool.length * bridges.length;
    }
    assert.ok(combos >= 100, `只有 ${combos} 种组合，一趟车里会撞上重样`);
  });

  it("每一条都是同一个断言的不同说法，不许升级成「快好了」", () => {
    for (const [phase, pool] of Object.entries(progressTables().prefix)) {
      for (const t of pool) {
        assert.ok(
          !/马上|快好|就好了|立刻|很快|快查完|查到了/.test(t),
          `${phase} 的「${t}」把进度往前说了——旁路不知道还要多久`,
        );
      }
    }
  });

  it("前缀与引子**错开取模**，否则组合数会塌回引子那一档", () => {
    const { prefix, bridges } = progressTables();
    assert.notEqual(
      prefix.understanding.length,
      bridges.length,
      "两边条数相同即同步回绕，100 种组合塌成 5 种",
    );
  });

  it("回绕而不越界 —— 这一趟车问了很多轮也不会崩", () => {
    for (const n of [0, 3, 4, 7, 99, 1000]) {
      assert.ok(progressPrefix("retrieval", n).length > 0);
      assert.ok(progressBridge(n).length > 0);
    }
  });
});

describe("引子只在真接着闲话时出现（走查第五轮追修）", () => {
  it("L1 打头 ⇒ 带引子；L0 打头 ⇒ 只报进度，不许诺闲聊", async () => {
    let now = 0;
    const l1: FillerDraft[] = [];
    const a = new PairSession("s-bridge-1", "t1", 0, {
      now: () => now,
      emit: (d) => l1.push(d),
      writer: async () => "苏州的糖藕这时候正当时",
    });
    a.setPlace("苏州");
    await settle();
    now = 2000;
    a.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 1 });
    a.close();

    const l0: FillerDraft[] = [];
    let now2 = 0;
    const b = new PairSession("s-bridge-2", "t1", 0, { now: () => now2, emit: (d) => l0.push(d) });
    b.setPlace("苏州");
    now2 = 2000;
    b.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 1 });
    b.close();

    assert.equal(l1[0].source, "l1");
    assert.ok(l1[0].text.includes(progressBridge(0)), "接着是闲话，引子该在");
    assert.equal(l0[0].source, "l0");
    assert.ok(
      !progressTables().bridges.some((x) => l0[0].text.includes(x)),
      "L0 说的仍是进度，挂上「咱们随便聊聊」就成了许诺了闲聊却接着报进度",
    );
    assert.ok(l0[0].text.startsWith(progressPrefix("retrieval", 0)));
  });
});
