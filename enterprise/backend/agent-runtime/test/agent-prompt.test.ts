/**
 * 子 Agent 业务 prompt 的加载与投递（M5-05 / M8-02 / M8-05 / M9-02）。
 *
 * 这份测试守的是一个**没有症状的缺陷**：prompt 文件在仓库里、内容看着像模像样，
 * 但没有任何代码读它。走查时六份里有五份是占位骨架，而表现只是
 * "回答很啰嗦""偶尔跑题""分支老是超时"——没人会把这些归因到 prompt 没写。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TOOL_REGISTRY, listForAgent, type AgentName } from "@carlife/tools";

import {
  PLACEHOLDER_MARKER,
  canonicalAgent,
  loadAgentPrompt,
  resetAgentPromptCache,
  MissingAgentPromptError,
} from "../src/acp-client/agent-prompt";

const AGENTS = [
  "supervisor",
  "trip",
  "ownership",
  "service",
  "buying",
  "cabin",
  // 多天行程 fan-out 四专家（M12-02）。缺文件的症状只是"分支失败"——
  // trip-task.md 那次就是这么静默挂掉的，所以存在性断言必须覆盖到它们。
  "drive",
  "hotel",
  "tour",
  "transit",
] as const;

describe("十个 Agent 的业务 prompt 都必须真的存在", () => {
  for (const agent of AGENTS) {
    it(`${agent} 有非空 prompt`, () => {
      const p = loadAgentPrompt(agent);
      assert.ok(p.trim().length > 200, `${agent} 的 prompt 只有 ${p.trim().length} 字，不像写完了`);
    });

    it(`${agent} **不是占位骨架**`, () => {
      // 占位文件当年写着"业务 prompt 归 M5-05，在那之前本 Agent 不参与路由"，
      // 而路由早就指过去了。这条断言就是为了不让它再发生一次。
      assert.ok(
        !loadAgentPrompt(agent).includes(PLACEHOLDER_MARKER),
        `${agent}.md 仍含「${PLACEHOLDER_MARKER}」`,
      );
    });
  }
});

describe("五个子 Agent 的硬约束要写在 prompt 里", () => {
  // 这些不是"最好有"，是走查暴露出的具体问题的对应修复。
  const SUB_AGENTS = ["trip", "ownership", "service", "buying", "cabin"] as const;

  for (const agent of SUB_AGENTS) {
    it(`${agent} 写明了长度上限——分支超时的直接成因`, () => {
      const p = loadAgentPrompt(agent);
      assert.match(p, /字以内/, `${agent} 没有长度约束，模型会写长文`);
    });
  }

  it("cabin 写明了 audible:false 的四种原因，而不是一句话盖过去（M63）", () => {
    // 走查里那句"这台车机这会儿没接出声的部件"就是一句话盖过四种原因的结果：
    // 出声位搬到车机端之后，它在四种成因里只有一种是对的。
    const p = loadAgentPrompt("cabin");
    assert.match(p, /sink\.kind/, "prompt 里没提 sink.kind，模型就没有分辨的依据");
    assert.match(p, /clientStatus/);
    assert.match(p, /车机还没接上播放/);
    assert.match(p, /不要把.*车机还没接上.*说成.*没有播放器件/s, "这一条正是走查那句话的反面");
  });

  it("trip 明确要求「车主说加日历就直接调 calendar」", () => {
    // 主线后半段（HITL + 写日历）此前从没跑到过，一部分原因就是没人告诉它要调。
    const p = loadAgentPrompt("trip");
    assert.match(p, /calendar/);
    assert.match(p, /直接调用/);
  });

  it("trip 明确禁止编造路线数字——它手上没有 map_route/charging", () => {
    assert.match(loadAgentPrompt("trip"), /不要给具体的公里数/);
  });

  it("service 禁止确定性诊断与否定性安全保证", () => {
    const p = loadAgentPrompt("service");
    assert.match(p, /不给确定性故障诊断/);
    assert.match(p, /放心开/);
  });

  it("buying 禁止用指导价推算落地价", () => {
    assert.match(loadAgentPrompt("buying"), /绝不拿指导价推算/);
  });

  it("cabin 禁止把降级说成「我还不太了解你」", () => {
    assert.match(loadAgentPrompt("cabin"), /绝不说.{0,2}我还不太了解你/);
  });
});

describe("四个行程专家的诚实红线要写在 prompt 里（M12-02）", () => {
  // 每条对应设计文档"数据真实性红线"的一项——prompt 是模型唯一能看到的约束面。
  it("hotel 要求酒店名来自 poi_search，估价必须带估算字样", () => {
    const p = loadAgentPrompt("hotel");
    assert.match(p, /poi_search/);
    assert.match(p, /估算/);
  });
  it("tour 要求景点名来自 poi_search", () => {
    assert.match(loadAgentPrompt("tour"), /poi_search/);
  });
  it("transit 的航班号红线已换家到 transit_route 的 promptGuidelines（M23-03）", () => {
    // 原断言查 transit.md 的 /禁止输出任何具体航班号/。纪律搬进工具注册后，
    // prompt 只留"飞机是估的"的职责框架；红线本体由 prompt-meta.test.ts 守。
    assert.match(loadAgentPrompt("transit"), /火车是真的，飞机是估的/);
  });
  it("drive 与 trip 的边界写明：单程即时出行归 trip", () => {
    assert.match(loadAgentPrompt("drive"), /单程即时出行归 trip/);
  });
  it("四个都是 -task 会话 → 思考档位 off", async () => {
    const { thinkingLevelFor } = await import("../src/acp-client/agent-prompt");
    for (const a of ["drive-task", "hotel-task", "tour-task", "transit-task"]) {
      assert.equal(thinkingLevelFor(a), "off", a);
    }
  });
});

/**
 * prompt 点名的工具，ACL 必须真的给它（M12 走查缺陷）。
 *
 * # 这条断言守的是什么
 *
 * 工具表是**按 Agent 裁剪**的（`registry.ts` 的 `agents` 字段，§4.3 能力映射），
 * 而职责说明是**另一份文件**手写的。两边各自都看得过去，凑在一起才出事：
 * `drive.md` 通篇在教模型怎么用 `map_route` 分段、用 `weather` 看沿途天气、
 * 按能源类型选 `refuel`/`charging` 查补能——而 `listForAgent("drive")` 当时
 * 只有 `pretrip_items` 与 `transit_route`，那四个一个都没有。
 *
 * # 为什么必须靠测试守，而不是靠走查
 *
 * **没有任何报错。** pi 的工具表里没有这个名字，模型不会说"我没有这个工具"，
 * 它会按常识把里程、服务区、天气写得一应俱全——正是 `drive.md` 里
 * "编造查询过程比留空严重得多"想禁掉的那种输出。
 * 这与 `pool.ts` 头部记的那次事故是同一类：工具表悄悄空着，症状只是"答案有点飘"。
 *
 * # 规则
 *
 * 职责说明里以反引号写出的名字，只要它是注册表里真实存在的工具，
 * 该 Agent 的 ACL 就必须包含它。**要让某个 Agent 别用某工具，就别在它的
 * prompt 里用反引号提这个名字**（写成普通文字即可）——反引号在这里等于"我要用它"。
 */
describe("职责说明点名的工具，ACL 里必须真的有（M12 走查缺陷）", () => {
  const KNOWN = new Set(TOOL_REGISTRY.map((t) => t.name));

  /** 只认反引号里的标识符；`source` 这类非工具名会被 KNOWN 过滤掉。 */
  function toolsNamedIn(prompt: string): string[] {
    const hits = prompt.match(/`[a-z][a-z0-9_]{2,}`/g) ?? [];
    return [...new Set(hits.map((h) => h.slice(1, -1)))].filter((n) => KNOWN.has(n));
  }

  // 比上面那张表多一个 `test-drive`（M19-03 的第六个业务 Agent，它也有自己的 prompt）。
  const ALL = [...AGENTS, "test-drive"] as const;

  for (const agent of ALL) {
    it(`${agent}`, () => {
      const granted = new Set(listForAgent(agent as AgentName).map((t) => t.name));
      const named = toolsNamedIn(loadAgentPrompt(agent));
      const missing = named.filter((n) => !granted.has(n));
      assert.deepEqual(
        missing,
        [],
        `${agent}.md 点名了 ${missing.join("/")}，但 registry.ts 的 agents 里没给它——` +
          `模型看不到这些工具，也不会报错，只会把答案编出来`,
      );
    });
  }

  it("drive 拿得到它 prompt 里点名的全部五个工具", () => {
    // 单列一条：这是缺陷的原始现场，回归时要一眼看得出是哪个分支塌了。
    const granted = new Set(listForAgent("drive").map((t) => t.name));
    for (const n of ["map_route", "weather", "refuel", "charging", "transit_route"]) {
      assert.ok(granted.has(n), `drive 缺 ${n}`);
    }
  });
});

describe("fan-out 分支用的是同一份职责说明", () => {
  it("`trip-task` / `ownership-task` 落到 trip.md / ownership.md", () => {
    // 这条是补票：接上 prompt 投递的当天，两条分支双双 1.6 秒内 failed——
    // `trip-task.md` 不存在，loadAgentPrompt 抛错，
    // 而外部症状只是"分支失败"，看不出跟 prompt 有任何关系。
    assert.equal(canonicalAgent("trip-task"), "trip");
    assert.equal(canonicalAgent("ownership-task"), "ownership");
    // 两者读**同一个文件**，但返回值不逐字相等：`-task` 的产出被 `merge.ts`
    // 正则解析，不拼身份段（见 loadAgentPrompt）。所以比的是包含关系。
    assert.ok(loadAgentPrompt("trip").endsWith(loadAgentPrompt("trip-task")));
  });

  it("非分支名不受影响", () => {
    assert.equal(canonicalAgent("supervisor"), "supervisor");
    assert.equal(canonicalAgent("cabin"), "cabin");
  });
});

describe("投递（M23-02 起走系统提示词）", () => {
  // 首轮前置已删：职责说明经 `--append-system-prompt` 进系统提示词
  // （env 拼装在 connection.ts 的 connect()，argv 逐字性由 tool-allowlist.test.ts 的
  // 假 pi 替身守着）。本文件只守加载语义。

  it("**读不到时抛错，不静默降级成空 prompt**", () => {
    resetAgentPromptCache();
    assert.throws(
      () => loadAgentPrompt("nonexistent" as never),
      MissingAgentPromptError,
      "静默返回空串正是此前那半年的状态，而它的症状看起来完全像模型能力问题",
    );
  });
});
