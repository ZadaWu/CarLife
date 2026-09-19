/**
 * 用研面 `AcpApp` 描述符的守卫（施工单 M88-04，ACR-038 步 4）。
 *
 * 这个文件里的每一条都对应一种**零报错**的错法：
 *
 *   1. `piDir` 指错 → 用研面加载车主面的 `.pi/extensions` 与提示词，工具表与口径
 *      都是别人的，而没有任何报错（底座 `app.ts` 文件头记的就是它）；
 *   2. `binDir` 指错 → 借不到那份 pi 安装，或借到一份版本不同的；
 *   3. `toolNamesFor` 与 ACL 不同源 → pi 对 `--tools` 里的未知名**静默忽略**，
 *      表现是某个工具无声消失；
 *   4. `thinkingFor` 不是 `off` → Challenger 把预算烧在没人读的思考上
 *      （`ownership-task` 曾思考 49.5 秒、一个工具没调）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { listForAgent, RESEARCH_AGENT_NAMES } from "@carlife/research-tools";

import {
  createResearchApp,
  loadResearchPrompt,
  RESEARCH_AGENTS,
  RESEARCH_BIN_DIR,
  RESEARCH_PI_DIR,
} from "../src/acp/research-app";

const app = createResearchApp({ toolsEndpoint: "http://127.0.0.1:8800" });

describe("[M88-04] 描述符的目录由这里给，不靠底座推", () => {
  it("piDir 缺省是 pi-research/，binDir 缺省是 pi-agents/，两者都真的在", () => {
    assert.equal(app.piDir, RESEARCH_PI_DIR);
    assert.equal(app.binDir, RESEARCH_BIN_DIR);
    assert.ok(RESEARCH_PI_DIR.endsWith("/pi-research"), RESEARCH_PI_DIR);
    assert.ok(RESEARCH_BIN_DIR.endsWith("/pi-agents"), RESEARCH_BIN_DIR);
    assert.ok(existsSync(RESEARCH_PI_DIR), "pi 项目目录不存在——扩展与提示词都在它下面");
    assert.ok(existsSync(RESEARCH_BIN_DIR), "借来的 pi 安装不在——binDir 指错了");
    // 两个目录必须是两个：合成一个就回到了"用研面跑在车主面的项目里"。
    assert.notEqual(app.piDir, app.binDir);
  });

  it("promptsDir 在 piDir 下，id 是 research，toolsEndpoint 原样透传", () => {
    assert.equal(app.promptsDir, join(RESEARCH_PI_DIR, "prompts"));
    assert.equal(app.id, "research");
    assert.equal(app.toolsEndpoint, "http://127.0.0.1:8800");
  });

  it("不实现 decoratePrompt——用研面分析的是一段已经发生过的窗", () => {
    assert.equal(app.decoratePrompt, undefined);
  });
});

describe("[M88-04] Agent 清单、提示词与工具 ACL 同源", () => {
  it("每个 Agent 在 pi-research/prompts/ 有同名 .md", async () => {
    for (const agent of RESEARCH_AGENTS) {
      const text = await app.promptFor(agent);
      assert.ok(text.length > 0, `${agent}.md 是空的`);
    }
  });

  it("后缀会话读的是同一份提示词（会话隔离靠会话键，不靠后缀）", async () => {
    assert.equal(await app.promptFor("challenger-task"), await app.promptFor("challenger"));
  });

  it("提示词缺文件时抛，不回空串", async () => {
    await assert.rejects(() => app.promptFor("nonexistent"), /提示词不存在/);
    // 四个 Agent 的 .md 现在都在了（M89-02），拿一个**不可能存在**的名字试这条纪律。
    await assert.rejects(() => loadResearchPrompt(app.promptsDir, "opportunity"), /opportunity\.md/);
  });

  it("toolNamesFor 恰好是 ACL 那四个，且不是另一份手写清单", () => {
    const names = app.toolNamesFor("challenger");
    assert.deepEqual([...names], listForAgent("challenger").map((t) => t.name));
    assert.equal(names.length, 4);
    // 后缀归一：`challenger-task` 查的仍是 `challenger` 的 ACL，否则它拿到空表。
    assert.deepEqual([...app.toolNamesFor("challenger-task")], [...names]);
  });

  it("RESEARCH_AGENTS 里每个名字在工具表里都认得（ACL 值域同源）", () => {
    for (const agent of RESEARCH_AGENTS) {
      assert.ok(listForAgent(agent).length > 0, `${agent} 在工具表里一个工具都没有`);
    }
  });

  /*
   * ── 以下四条是 M89-02 扩到四个 Agent 之后加的 ────────────────────────
   *
   * 少一个名字的表现是那个 Agent **起不来**；多一个则更坏：`toolNamesFor` 回空表，
   * 模型手里零工具却照样编出像样的答案（`pool.ts` 文件头记的同一类事故）。
   */

  it("[M89-02] RESEARCH_AGENTS 与 RESEARCH_AGENT_NAMES 是同一个集合", () => {
    // 按**集合**比而不按顺序：那边按设计稿 §4 表行序，这里以 challenger 起手
    // （它是唯一一条不由研究员发起的路）。要钉的是"不许有第二份名单"。
    assert.deepEqual([...RESEARCH_AGENTS].sort(), [...RESEARCH_AGENT_NAMES].sort());
    assert.equal(RESEARCH_AGENTS.length, 4);
  });

  it("[M89-02] 四个 Agent 各自的 prompts/<名>.md 都读得到且非空", async () => {
    for (const agent of RESEARCH_AGENTS) {
      const text = await app.promptFor(agent);
      assert.ok(text.length > 200, `${agent}.md 太短，不像一份口径`);
    }
  });

  it("[M89-02] toolNamesFor('analyst') 与 listForAgent('analyst') 逐字相同", () => {
    const names = app.toolNamesFor("analyst");
    assert.deepEqual([...names], listForAgent("analyst").map((t) => t.name));
    assert.deepEqual([...names], ["lensQuery", "themeMembers", "evidenceByCode", "codebookLookup"]);
  });

  it("[M89-02] 后缀归一对新 Agent 同样生效", async () => {
    assert.equal(await app.promptFor("taxonomist-task"), await app.promptFor("taxonomist"));
    assert.deepEqual(
      [...app.toolNamesFor("taxonomist-task")],
      [...app.toolNamesFor("taxonomist")],
    );
  });
});

describe("[M88-04] 思考恒关", () => {
  it("研究面的 Agent 名没有 -task 后缀，所以档位要自己给", () => {
    assert.equal(app.thinkingFor("challenger"), "off");
    assert.equal(app.thinkingFor("challenger-task"), "off");
  });
});

describe("[M88-04] 轨迹实现只打 console，不落原文", () => {
  it("span 把返回值原样透出，失败时把异常抛回去", async () => {
    assert.equal(await app.tracer.span("t1", "probe", async () => 42), 42);
    await assert.rejects(
      () => app.tracer.span("t1", "probe", async () => { throw new Error("炸了"); }),
      /炸了/,
    );
  });

  it("cancelled 造的错带 cancelled 标记——调用方按它把取消与真失败分开", () => {
    const err = app.tracer.cancelled("本轮已取消") as Error & { cancelled?: boolean };
    assert.equal(err.cancelled, true);
    assert.match(err.message, /已取消/);
  });
});
