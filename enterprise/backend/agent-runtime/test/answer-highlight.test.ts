/**
 * [F-03-03][AC-03-1] 回答里的关键信息要标出来（2026-09-18 用户定调）。
 *
 * 这条链有两段，**两段都齐了才有效果**：服务端让模型用 `**` 标，端上渲染成浅橙底
 * （`clients/shared/ui/test/dialog-key-highlight.test.ts` 守另一半）。
 *
 * 这里守服务端那一半，重点是**两条应答路径拿到的是同一份规则**：
 * `CARLIFE_ANSWER_RUNTIME=direct` 时是叙述者，否则是 ACP 上的应答会话。
 * 少接一条的后果不报错——只是"同一个助手在不同话题下排版不一样"。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HIGHLIGHT_PROMPT } from "../src/llm/answer-format";
import { NARRATOR_SYSTEM } from "../src/llm";
import { loadAgentPrompt } from "../src/acp-client/agent-prompt";

/** `supervisor.ts` 的 `ANSWER_AGENTS` + supervisor 自己：输出全都给车主直接读。 */
const ANSWER_SESSIONS = ["trip", "ownership", "service", "buying", "test-drive", "cabin", "supervisor"];

describe("[F-03-03][AC-03-1] 关键信息标注规则只有一份，两条应答路径都拿到它", () => {
  it("叙述者（direct 路径）的人设里有这段规则", () => {
    assert.ok(NARRATOR_SYSTEM.includes(HIGHLIGHT_PROMPT), "CARLIFE_ANSWER_RUNTIME=direct 时车主读到的是它的输出");
  });

  it("每个会给车主读的 ACP 会话都拿到同一段规则", () => {
    for (const agent of ANSWER_SESSIONS) {
      assert.ok(loadAgentPrompt(agent).includes(HIGHLIGHT_PROMPT), `${agent} 的应答没有排版规则`);
    }
  });

  it("规则排在业务 prompt 之后——它讲的是怎么说，不是这一轮要做什么", () => {
    const p = loadAgentPrompt("service");
    assert.ok(p.indexOf(HIGHLIGHT_PROMPT) > p.indexOf("## 你是谁"), "身份段仍在最前");
    assert.ok(p.trimEnd().endsWith(HIGHLIGHT_PROMPT.trimEnd()), "规则在尾部");
  });

  /**
   * 产出被代码解析的会话**一个字都不能加**。
   *
   * `-task` 的输出进 `merge.ts` 的结构化字段、`-intent` 的进四要素 JSON；
   * 往那里掺 `**` 不会报错，只会让字段里多出两个星号——那是最难查的一类脏数据。
   */
  it("-task / -intent 会话不加：它们的输出是给代码解析的，不是给人读的", () => {
    for (const agent of ["ownership-task", "drive-task", "supervisor-intent"]) {
      assert.equal(loadAgentPrompt(agent).includes(HIGHLIGHT_PROMPT), false, `${agent} 不该带排版规则`);
    }
  });
});

describe("规则本身：给了上限，也给了「只包那几个字」", () => {
  it("有数量上限——不封顶模型会把整段都加粗，满屏高亮等于没有高亮", () => {
    assert.match(HIGHLIGHT_PROMPT, /最多标 2 处/);
    assert.match(HIGHLIGHT_PROMPT, /最多 4 处/);
  });

  it("点名了该标什么：凭据、时间、金额、要马上做的动作、让结论不作数的边界", () => {
    for (const kw of ["订单号", "日期与时间", "金额", "靠边停车", "数据过期"]) {
      assert.ok(HIGHLIGHT_PROMPT.includes(kw), `规则里缺「${kw}」这一类`);
    }
  });

  it("只许这一种记号：别的 markdown 会被端上原样显示成字符", () => {
    assert.match(HIGHLIGHT_PROMPT, /不要出现别的 markdown 记号/);
  });
});
