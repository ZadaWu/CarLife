/**
 * 三条实测缺陷的回归测试（TD-08 追查，会话 sess-4e05a6dd 的 turn 20 / 21）。
 *
 * 三条都不是"想到的边界情况"，是**用户已经撞上、并且在轨迹里留了证据**的：
 *  1. 车主说了出发时间，助手当没听见 —— 用户原话被编排层追加的指令挤出了 prompt；
 *  2. 助手说不出服务区名字 —— `stops` 查到了、存下了，却没写进 fan-out → 应答的唯一通道；
 *  3. 分支思考 57 秒后超时 —— 提示词里"这是燃油车"与硬约束"车辆为电动车"当面打架。
 *
 * 每条都断言在**能重现问题的那一层**，不在别处。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { modelSpecFor, trailingUserRunStart } from "../src/acp-client/connection";
import { thinkingLevelFor } from "../src/acp-client/agent-prompt";
import { PENDING_STOP, mergeBranches, solve, type TripDraft } from "../src/graph/merge";
import { describeMerged, reconcileConstraints, runTripFanout } from "../src/graph/subgraphs/trip";
import type { ChatStreamer } from "../src/llm";
import type { ChatTurnMessage } from "../src/llm";

/** 仓库里的 pi 配置目录——`modelSpecFor` 的真相源就在它下面的 `.pi/settings.json`。 */
const PI_AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../pi-agents");

describe("本轮用户输入的边界（缺陷一：说了当没听见）", () => {
  it("**编排层追加的指令不得挤掉用户原话**——这是它被发现时的原始形态", () => {
    const messages: ChatTurnMessage[] = [
      { role: "user", content: "帮我规划从上海静安到徐州邳州的行程" },
      { role: "assistant", content: "拆成三段……" },
      { role: "user", content: "我是今天下午三点出发" },
      { role: "user", content: "请先做意图理解，只输出一个 JSON 对象" },
    ];
    const start = trailingUserRunStart(messages);
    assert.equal(start, 2, "本轮输入应从「我是今天下午三点出发」开始，而不是只有那条指令");

    const current = messages.slice(start).map((m) => m.content);
    assert.ok(
      current.some((c) => c.includes("今天下午三点")),
      "车主原话必须在本轮发出的内容里——漏了它，意图模型只能从历史里瞎猜",
    );
  });

  it("assistant 隔开的旧发言不算本轮——否则每轮都在重发历史", () => {
    const messages: ChatTurnMessage[] = [
      { role: "user", content: "第一轮" },
      { role: "assistant", content: "答" },
      { role: "user", content: "第二轮" },
    ];
    assert.equal(trailingUserRunStart(messages), 2);
  });

  it("只有一条用户消息时行为不变——首轮不能因为这次改动而变形", () => {
    assert.equal(trailingUserRunStart([{ role: "user", content: "你好" }]), 0);
  });

  it("没有用户消息时返回 -1，不越界", () => {
    assert.equal(trailingUserRunStart([{ role: "assistant", content: "自言自语" }]), -1);
    assert.equal(trailingUserRunStart([]), -1);
  });
});

describe("汇聚结果的表述（缺陷二：给不出服务区）", () => {
  it("**停靠点必须出现在给应答模型的文字里**——这是它唯一的来源", () => {
    const m = solve({ legMinutes: [90, 120], stops: ["阳澄湖服务区"] } as TripDraft, {});
    const text = describeMerged(m);
    assert.ok(text.includes("阳澄湖服务区"), `停靠点被丢了：\n${text}`);
  });

  it("占位符不得冒充地名——车主听到「待定停靠点」比听到「给不了」更糟", () => {
    // maxLegMinutes=120 会把 300 分钟拆成 3 段，补 2 个占位。
    const m = solve({ legMinutes: [300], stops: [] } as TripDraft, { maxLegMinutes: 120 });
    assert.ok(m.draft.stops.includes(PENDING_STOP), "前提：solve 确实补了占位");

    const text = describeMerged(m);
    assert.ok(!text.includes(PENDING_STOP), `占位符原样漏给了模型：\n${text}`);
    assert.ok(/2 处停靠/.test(text), `应说明有几处待定：\n${text}`);
    assert.ok(/不要编/.test(text), "必须明确禁止编服务区名字");
  });

  it("真名字与占位混在一起时，两者都要说清楚", () => {
    const m = solve({ legMinutes: [300], stops: ["阳澄湖服务区"] } as TripDraft, { maxLegMinutes: 120 });
    const text = describeMerged(m);
    assert.ok(text.includes("阳澄湖服务区"));
    assert.ok(!text.includes(PENDING_STOP));
  });
});

describe("能源事实要覆盖到应答节点（缺陷四：分支干净了，应答仍在讲充电）", () => {
  it("**求解结果里必须写明这是什么车**——应答模型不参与分支，只看得到这段", () => {
    const m = solve({ legMinutes: [90], stops: [] } as TripDraft, {});
    const text = describeMerged(m, "icev");
    assert.ok(text.includes("燃油"), `应答节点拿不到能源类型：\n${text}`);
    assert.ok(/不要按电车规划充电停靠/.test(text), "燃油车要明确否掉充电规划");
  });

  it("能源类型未知时，交给应答的也是「不要假设」而不是沉默", () => {
    const m = solve({ legMinutes: [90], stops: [] } as TripDraft, {});
    assert.ok(describeMerged(m).includes("不要假设"));
  });

  it("补能点按能源类型换词——给燃油车说「充电点」和给电车说「加油点」是同一类错", () => {
    const draft = { legMinutes: [90], stops: [], energyStops: ["阳澄湖服务区加油站"] };
    const m = solve(draft as TripDraft, {});
    assert.ok(describeMerged(m, "icev").includes("建议加油点"));
    assert.ok(describeMerged(m, "bev").includes("建议充电点"));
  });

  it("**补能点不得并进 stops**——那个数组与 legMinutes 的间隔一一对应", () => {
    const m = solve(
      { legMinutes: [300], stops: [], energyStops: ["某加油站"] } as TripDraft,
      { maxLegMinutes: 120 },
    );
    // 拆成 3 段 → 2 个休息停靠占位；补能点独立，不参与这个计数。
    assert.equal(m.draft.stops.length, m.draft.legMinutes.length - 1);
    assert.deepEqual(m.draft.energyStops, ["某加油站"]);
  });
});

describe("硬约束与车辆档案的校对（缺陷三：矛盾提示词）", () => {
  const EV_CLAIM = "结合上下文：车辆为电动车、续航紧张，中途必须安排充电";

  it("**档案说燃油时，「车辆为电动车」这条断言必须被剔除**", () => {
    const { kept, dropped } = reconcileConstraints(
      ["同行有老人和小朋友", EV_CLAIM],
      "icev",
    );
    assert.deepEqual(dropped, [EV_CLAIM]);
    assert.deepEqual(kept, ["同行有老人和小朋友"]);
  });

  it("档案说纯电时同一条断言应保留——剔除的判据是冲突，不是关键词", () => {
    const { kept, dropped } = reconcileConstraints([EV_CLAIM], "bev");
    assert.deepEqual(dropped, []);
    assert.deepEqual(kept, [EV_CLAIM]);
  });

  it("**档案没有能源类型时，任何断言都剔除**——不知道时模型的猜测不算证据", () => {
    const { dropped } = reconcileConstraints([EV_CLAIM, "这是燃油车"], undefined);
    assert.equal(dropped.length, 2);
  });

  it("「插电混动」不被电车规则先吃掉", () => {
    assert.deepEqual(reconcileConstraints(["车辆是插电混动"], "phev").dropped, []);
    assert.deepEqual(reconcileConstraints(["车辆是插电混动"], "icev").dropped, ["车辆是插电混动"]);
  });

  it("不点名车型的要求一律保留——剔掉车主自己说的话比留下多余约束严重得多", () => {
    const said = ["中途需要停下来上厕所、吃东西", "单段不超过 2 小时"];
    assert.deepEqual(reconcileConstraints(said, "icev").dropped, []);
  });

  it("**燃油车的分支提示词里不得再出现「车辆为电动车」**（端到端形态）", async () => {
    const seen: Record<string, string> = {};
    const streamer: ChatStreamer = async function* (messages, hooks) {
      seen[hooks?.agent ?? "?"] = messages[messages.length - 1]?.content ?? "";
      yield '{"legMinutes":[60]}';
    };

    const out = await runTripFanout(streamer, {
      goal: "规划从上海静安到徐州邳州的行程",
      constraints: ["同行有老人和小朋友", EV_CLAIM],
      energyType: "icev",
    });

    for (const [agent, prompt] of Object.entries(seen)) {
      assert.ok(!prompt.includes("车辆为电动车"), `${agent} 仍收到了矛盾约束：\n${prompt}`);
      assert.ok(prompt.includes("同行有老人和小朋友"), `${agent} 丢了车主真正说过的约束`);
      assert.ok(prompt.includes("能源类型：燃油"), `${agent} 没拿到档案里的权威事实`);
    }
    assert.deepEqual(out.droppedConstraints, [EV_CLAIM], "剔除了什么必须交待出来");
  });

  it("能源类型未知时，两条分支都被告知「不要假设」", async () => {
    const seen: string[] = [];
    const streamer: ChatStreamer = async function* (messages) {
      seen.push(messages[messages.length - 1]?.content ?? "");
      yield "";
    };
    await runTripFanout(streamer, { goal: "去黄山", constraints: [] });
    assert.equal(seen.length, 2);
    for (const p of seen) assert.ok(p.includes("不要假设"), `缺少"不知道"的显式处理：\n${p}`);
  });
});

describe("分支字段清单按任务分（缺陷五：补能评估被要求交行车分段）", () => {
  async function promptsFor(energyType: "icev" | "bev" | undefined) {
    const seen: Record<string, string> = {};
    const streamer: ChatStreamer = async function* (messages, hooks) {
      seen[hooks?.agent ?? "?"] = messages[messages.length - 1]?.content ?? "";
      yield "";
    };
    await runTripFanout(streamer, { goal: "去黄山", constraints: [], energyType });
    return seen;
  }

  it("**补能评估分支不得被要求交 legMinutes**——那是行程规划的活，它答不了只能空转", async () => {
    const seen = await promptsFor("icev");
    assert.ok(seen["trip-task"].includes("legMinutes"), "行程分支仍要分段时长");
    assert.ok(
      !seen["ownership-task"].includes("legMinutes"),
      `补能分支还在被要求交行车分段：\n${seen["ownership-task"]}`,
    );
  });

  it("燃油车的补能分支要加油点，且结构上没有百分比字段可填", async () => {
    const p = (await promptsFor("icev"))["ownership-task"];
    assert.ok(p.includes("energyStops"));
    assert.ok(p.includes("加油点"));
    assert.ok(!p.includes("rangeMarginPct"), `燃油车不该有续航余量字段：\n${p}`);
  });

  it("纯电车的补能分支才要 rangeMarginPct 与充电点", async () => {
    const p = (await promptsFor("bev"))["ownership-task"];
    assert.ok(p.includes("rangeMarginPct"));
    assert.ok(p.includes("充电点"));
  });

  it("**能源类型未知时不给任何补能字段**——给了字段就等于允许它猜", async () => {
    const p = (await promptsFor(undefined))["ownership-task"];
    assert.ok(!p.includes("energyStops"));
    assert.ok(!p.includes("rangeMarginPct"));
  });

  it("energyStops 能从分支返回的 JSON 里解析出来并汇聚", () => {
    const m = mergeBranches(
      [
        { agent: "trip-task", status: "ok", text: '{"legMinutes":[90],"stops":[]}' },
        { agent: "ownership-task", status: "ok", text: '{"energyStops":["中国石化阳澄湖站"]}' },
      ],
      [],
    );
    assert.deepEqual(m.draft.energyStops, ["中国石化阳澄湖站"]);
    assert.deepEqual(m.missing, [], "只返回 energyStops 的分支不该被判成「未返回结构化字段」");
  });
});

describe("思考档位按会话用途分（缺陷六：没人看的思考也在烧 50 秒）", () => {
  it("**被代码解析的会话关掉思考**——那几十秒没有任何人看得到", () => {
    assert.equal(thinkingLevelFor("supervisor-intent"), "off");
    assert.equal(thinkingLevelFor("trip-task"), "off");
    assert.equal(thinkingLevelFor("ownership-task"), "off");
  });

  it("车主直接读的应答保持 high——关掉它那次实测答案明显退化", () => {
    assert.equal(thinkingLevelFor("trip"), "high");
    assert.equal(thinkingLevelFor("ownership"), "high");
    assert.equal(thinkingLevelFor("supervisor"), "high");
  });

  it("模型 id 只来自 .pi/settings.json，不在别处再写一遍", () => {
    assert.equal(modelSpecFor(PI_AGENTS_DIR, "off"), "deepseek/deepseek-v4-flash:off");
  });

  it("**没指定档位时不加 --model**——降级到原行为，不是降级到未知行为", () => {
    assert.equal(modelSpecFor(PI_AGENTS_DIR, undefined), undefined);
  });

  it("读不到 settings.json 时静默不加参数，不抛错拖垮启动", () => {
    assert.equal(modelSpecFor("/nonexistent/dir", "off"), undefined);
  });
});
