/**
 * Workflow 图与实际编排代码的**漂移守护**。
 *
 * # 为什么需要它，而 `validateGraph()` 不够
 *
 * `validateGraph()` 校验的是图**自身**的内部一致性——端点存在、可达、
 * 分支覆盖 `BRANCH_NODES`。它不读 `supervisor.ts`，所以上游加了节点、
 * 这边没跟的时候它一条都不会报。实际发生过两次：
 *
 *  · M13-13 摘掉 `tripFanout` + M15/M19 加三个节点 → 图停在 M5-05；
 *  · TD-09 加 `riskGate` + M24 座舱改 A 型 → 图停在 M19。
 *
 * 两次的共同形态是**没有任何东西会红**。所以这里直接读源码文本比对。
 *
 * # 为什么是读源码文本，不是 import
 *
 * 控制台不依赖 `enterprise/backend/agent-runtime`（import 它会把 LangGraph、DB、
 * ACP 客户端一起拖进浏览器包）。而这条守护要的只是"名字对不对得上"——
 * 正则抽 `addNode("x"` 与 `branchFor` 里的 `return "x"` 就够，
 * 抽不到时**必须报错而不是当成空集**（空集会静默全过，那就又回到没有守护）。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  AGENT_ROSTER,
  BRANCH_NODES,
  SIDE_LANE_NODES,
  SIDECAR_NODES,
  WAKE_NODES,
  WORKFLOW_NODES,
} from "../src/pages/workflow/graph-model";

const root = new URL("../../../", import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, root), "utf8");

const SUPERVISOR = "enterprise/backend/agent-runtime/src/graph/supervisor.ts";
const ROUTE = "enterprise/backend/agent-runtime/src/graph/route.ts";
const COMPOUND = "enterprise/backend/agent-runtime/src/graph/compound.ts";
/** Agent 名的真相源：`AgentName` 联合类型（`connection.ts` 有第二份，两处必须同步）。 */
const REGISTRY = "enterprise/backend/shared/tools/src/registry.ts";
const PROMPTS_DIR = "enterprise/backend/pi-agents/";

/**
 * `export type AgentName = | "a" | "b" …;` 里的全部名字。
 *
 * 只抽联合类型体内的字符串字面量——到第一个分号为止，注释里的 `-task` 之类不会混进来
 * （它们在 `// …` 里，但也是 `"…"` 之外的裸文本，正则只认双引号）。
 */
function registryAgents(src: string): Set<string> {
  const from = src.indexOf("export type AgentName");
  assert.notEqual(from, -1, `没能在 ${REGISTRY} 里找到 AgentName`);
  const body = src.slice(from, src.indexOf(";", from));
  const names = [...body.matchAll(/"([a-z][a-z0-9-]*)"/g)].map((m) => m[1]);
  assert.ok(names.length > 0, "没能从 AgentName 抽到任何名字——正则该跟着改动更新了");
  return new Set(names);
}

/** `graph.addNode("x", …)` 的全部 x。装配分两支（有无意图节点），取并集。 */
function assembledNodes(src: string): Set<string> {
  const names = [...src.matchAll(/\.addNode\(\s*"([A-Za-z][A-Za-z0-9_]*)"/g)].map((m) => m[1]);
  assert.ok(names.length > 0, `没能从 ${SUPERVISOR} 抽到任何 addNode——正则该跟着改动更新了`);
  return new Set(names);
}

/** `branchFor` 函数体里 `return "x"` 的全部 x，即路由真正可能落到的节点。 */
function branchTargets(src: string): Set<string> {
  const from = src.indexOf("export function branchFor");
  assert.notEqual(from, -1, `没能在 ${ROUTE} 里找到 branchFor`);
  // 函数体到下一个顶层分节注释为止——`branchFor` 之后紧接着就是证据表那一段。
  const body = src.slice(from, src.indexOf("\n// ──", from));
  const targets = [...body.matchAll(/return\s+"([A-Za-z][A-Za-z0-9_]*)"/g)].map((m) => m[1]);
  assert.ok(targets.length > 0, "没能从 branchFor 抽到任何 return 值");
  return new Set(targets);
}

describe("图与实际编排代码不漂", () => {
  const supervisor = read(SUPERVISOR);
  const route = read(ROUTE);

  it("`addNode` 的每个节点，图上都画了（且标成图节点）", () => {
    const assembled = assembledNodes(supervisor);
    const drawn = new Set(WORKFLOW_NODES.filter((n) => n.graphNode).map((n) => n.id));
    const missing = [...assembled].filter((n) => !drawn.has(n));
    assert.deepEqual(
      missing,
      [],
      "编排里有、图上没有——这正是「图看起来对、实际不是」的形态，" +
        "读图的人会相信一个并不存在的架构",
    );
  });

  it("图上标成图节点的，除 START/END 外都真的是 `addNode` 出来的", () => {
    const assembled = assembledNodes(supervisor);
    // START / END 是 LangGraph 的常量端点，不经 addNode；
    // `deny-end` 是 END 的第二次渲染（硬禁那一支就地收口，见 graph-model 的说明）。
    const endpoints = new Set(["start", "end", "deny-end"]);
    const extra = WORKFLOW_NODES.filter(
      (n) => n.graphNode && !endpoints.has(n.id) && !assembled.has(n.id),
    ).map((n) => n.id);
    assert.deepEqual(extra, [], "图上画了一个编排里并不存在的节点");
  });

  it("`sideNodeOf` 的每个副 lane 节点，都在 SIDE_LANE_NODES 里，反之亦然（ACR-023）", () => {
    const src = read(COMPOUND);
    const from = src.indexOf("const SIDE_NODE");
    assert.notEqual(from, -1, `没能在 ${COMPOUND} 里找到 SIDE_NODE`);
    const body = src.slice(from, src.indexOf("};", from));
    const names = [...body.matchAll(/"(side[A-Z][A-Za-z]*)"/g)].map((m) => m[1]);
    assert.ok(names.length > 0, "没能从 SIDE_NODE 抽到任何副节点名——正则该跟着改动更新了");
    assert.deepEqual([...new Set(names)].sort(), [...SIDE_LANE_NODES].sort(), "副 lane 节点漂了：图上画的与 compound.ts 注册的不是同一批");
  });

  it("`branchFor` 的每个去向，都在 BRANCH_NODES 里，反之亦然", () => {
    const targets = branchTargets(route);
    assert.deepEqual(
      [...targets].sort(),
      [...BRANCH_NODES].sort(),
      "漏一个分支等于图上没有这条路，而那正好等同于「这个 Agent 不存在」——" +
        "service 漏接 ownershipDual 那次，售后拿不到 repair-kb 任何内容，回答却看起来完全正常",
    );
  });

  /*
   * 第三次漂（M36 导游三分支、M66 导航）上面两条都没抓到：那四个 Agent 是 HTTP 触发的子图，
   * 不经 `addNode`、不经 `branchFor`。Agent 的真相源是 `registry.ts` 的 `AgentName`——
   * 拿它逐个比，多一个少一个都红；`=== 11` 那种写死的数字只会跟着清单一起停住。
   */
  it("Agent 清单与 registry.ts 的 AgentName 一一对应——多一个少一个都红", () => {
    const registry = registryAgents(read(REGISTRY));
    const roster = new Set(AGENT_ROSTER.filter((a) => a.name !== "sidecar").map((a) => a.name));
    assert.deepEqual(
      [...registry].filter((n) => !roster.has(n)),
      [],
      "registry 里有、清单里没有——上游加了 Agent，这一页还停在上个 Sprint",
    );
    assert.deepEqual(
      [...roster].filter((n) => !registry.has(n)),
      [],
      "清单里有、registry 里没有——画了一个并不存在的 Agent",
    );
    // 第二份 AgentName（connection.ts）必须与 registry 同步——两处只改一处的红离改动很远。
    const second = registryAgents(read("enterprise/backend/agent-runtime/src/acp-client/connection.ts"));
    assert.deepEqual([...second].sort(), [...registry].sort(), "connection.ts 的 AgentName 与 registry.ts 不同步");
  });

  it("清单里每个 pi Agent 的 prompt 文件真实存在", () => {
    for (const a of AGENT_ROSTER) {
      if (!a.prompt) continue;
      assert.ok(existsSync(new URL(PROMPTS_DIR + a.prompt, root)), `${a.name} 的 prompt 文件找不到：${a.prompt}`);
    }
  });

  it("HTTP 触发的子图不是图节点：每个 viaHttp 方框都不在 addNode 里", () => {
    const assembled = assembledNodes(supervisor);
    for (const n of WORKFLOW_NODES.filter((x) => x.viaHttp)) {
      assert.equal(assembled.has(n.id), false, `${n.id} 标成 HTTP 子图，却在 supervisor.ts 里被 addNode 了`);
      assert.notEqual(n.graphNode, true, `${n.id} 不能同时是图节点与 HTTP 子图`);
    }
  });

  it("每个节点标的源码位置，文件是真实存在的", () => {
    /*
     * `source` 写的是**给人读的相对位置**，各图的基准目录不同
     * （编排图相对 `agent-runtime/src`，唤醒图相对车机端 `src-tauri/src`）。
     * 所以按候选前缀逐个试，一个都命中不了才算标错。
     *
     * 这条一写出来就抓到一个：`pi-agents/prompts/supervisor.md` 在
     * `services/` 下而不是 `agent-runtime/src/` 下。标错的出处比不标更糟——
     * 读者会以为是自己找错了地方。
     */
    const PREFIXES = ["", "enterprise/backend/", "enterprise/backend/agent-runtime/src/", "clients/cockpit/src-tauri/src/"];
    for (const n of [...WORKFLOW_NODES, ...SIDECAR_NODES, ...WAKE_NODES]) {
      if (!n.source) continue;
      // 取开头连续的路径字符——`source` 里常紧跟着中文括注（`sidecar/l1.ts（接口）+ …`），
      // 按空白切会把括注一起带上，然后判成"标错了"。
      const rel = (/^[A-Za-z0-9._/-]+/.exec(n.source) ?? [""])[0];
      // `prompts/{trip,ownership,…}.md` 这类是**一组**文件的写法，不是一个路径。
      if (!rel.includes("/") || rel.includes("{")) continue;
      // `existsSync` 而不是 `readFileSync`：有的 `source` 指的是**一个包**
      // （`enterprise/backend/shared/tools`），读它会 EISDIR，而它并没有标错。
      const hit = PREFIXES.some((prefix) => existsSync(new URL(prefix + rel, root)));
      assert.ok(hit, `${n.id} 标的源码位置找不到：${rel}`);
    }
  });
});
