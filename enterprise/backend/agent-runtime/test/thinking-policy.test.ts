/**
 * 思考档策略（施工单 M70-01）。
 *
 * 守两件事：**请求体里真的带了档位**（fetch 包装），以及**没有一处调用点能不声明就过**（源码扫描）。
 * 第二条是这份测试的骨头——2026-08-28 到 09-04 narrator / 标题 / 填充语在隐式思考，代码注释还写着"非推理"，
 * 没有任何东西会红。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  DIRECT_CALL_SITES,
  PI_NARRATING_ANSWER_SESSIONS,
  anthropicThinkingFields,
  deepseekThinkingFields,
  piThinkingLevelFor,
  thinkingForSite,
  withDeepSeekThinking,
} from "../src/llm/thinking-policy";
import { thinkingLevelFor } from "../src/acp-client/agent-prompt";

const root = new URL("../", import.meta.url).pathname;
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("[F-33-01][AC-33-1] 档位 → DeepSeek 请求体字段", () => {
  it("off → thinking disabled；low → enabled + reasoning_effort low；high → enabled 不带 effort", () => {
    assert.deepEqual(deepseekThinkingFields("off"), { thinking: { type: "disabled" } });
    assert.deepEqual(deepseekThinkingFields("low"), { thinking: { type: "enabled" }, reasoning_effort: "low" });
    assert.deepEqual(deepseekThinkingFields("high"), { thinking: { type: "enabled" } });
    assert.deepEqual(anthropicThinkingFields("off"), { thinking: { type: "disabled" } });
    assert.deepEqual(anthropicThinkingFields("high"), { thinking: { type: "enabled" } });
  });

  it("fetch 包装把档位合进 chat/completions 的 JSON 请求体；已有同名字段以显式为准；别的请求原样放过", async () => {
    const seen: Array<{ url: string; body: unknown; method?: string }> = [];
    const base = async (input: RequestInfo | URL, init?: RequestInit) => {
      let body: unknown;
      try {
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      } catch {
        body = undefined;
      }
      seen.push({ url: String(input), body, method: init?.method });
      return new Response("{}", { status: 200 });
    };
    const f = withDeepSeekThinking("off", base as typeof fetch);
    await f("https://api.deepseek.com/chat/completions", { method: "POST", body: JSON.stringify({ model: "deepseek-v4-flash", messages: [] }) });
    assert.deepEqual(seen[0].body, { thinking: { type: "disabled" }, model: "deepseek-v4-flash", messages: [] });

    await f("https://api.deepseek.com/chat/completions", { method: "POST", body: JSON.stringify({ model: "x", thinking: { type: "enabled" } }) });
    assert.deepEqual((seen[1].body as { thinking: unknown }).thinking, { type: "enabled" }, "调用点显式给了就不覆盖");

    await f("https://api.deepseek.com/models", { method: "GET" });
    assert.equal(seen[2].body, undefined);
    await f("https://api.deepseek.com/chat/completions", { method: "POST", body: "not json" });
    assert.equal(seen[3].body, undefined);
  });
});

describe("[F-33-01][AC-33-1] 每一处直连调用点都显式声明了档位（源码扫描）", () => {
  const files = walk(join(root, "src")).map((p) => ({ p, src: readFileSync(p, "utf8") }));

  it("每个 createConfiguredChatStreamer( 调用都带 thinking:", () => {
    for (const { p, src } of files) {
      let i = 0;
      while ((i = src.indexOf("createConfiguredChatStreamer(", i)) >= 0) {
        const lineStart = src.lastIndexOf("\n", i) + 1;
        const line = src.slice(lineStart, i).trimStart();
        const isDef = src.slice(Math.max(0, i - 20), i).includes("function ");
        const isComment = line.startsWith("//") || line.startsWith("*") || line.startsWith("/*");
        if (!isDef && !isComment) {
          const window = src.slice(i, i + 900);
          assert.ok(/thinking:\s*thinkingForSite\(/.test(window), `${p} 的 createConfiguredChatStreamer 没有从策略表取档：\n${window.slice(0, 200)}`);
        }
        i += 1;
      }
    }
  });

  it("每个 createDeepSeek( 调用都经 withDeepSeekThinking 包 fetch", () => {
    for (const { p, src } of files) {
      let i = 0;
      while ((i = src.indexOf("createDeepSeek(", i)) >= 0) {
        const line = src.slice(src.lastIndexOf("\n", i) + 1, i).trimStart();
        if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) {
          i += 1;
          continue;
        }
        const window = src.slice(i, i + 200);
        assert.ok(window.includes("withDeepSeekThinking("), `${p} 的 createDeepSeek 没包 fetch：${window.slice(0, 120)}`);
        i += 1;
      }
    }
  });

  it("策略表覆盖的调用点与源码里实际用到的一致", () => {
    const used = new Set<string>();
    for (const { src } of files) for (const m of src.matchAll(/thinkingForSite\("([a-z-]+)"\)/g)) used.add(m[1]);
    const declared = new Set(Object.keys(DIRECT_CALL_SITES));
    // web-search（tools 包，不能 import 本表）与 judge（evals）用字面量，见下两条
    for (const s of ["web-search", "judge"]) declared.delete(s);
    assert.deepEqual([...used].sort(), [...declared].sort(), "表里有但没人用、或有人用但表里没有——两个方向都不该发生");
  });

  it("tools 包的 web_search 与 evals 的裁判各自显式带了 thinking（它们不能 import 本表）", () => {
    assert.match(read("../shared/tools/src/web-search.ts"), /thinking:\s*\{\s*type:\s*"disabled"\s*\}/);
    assert.match(read("../../../evals/lib/judge.ts"), /thinking:\s*\{\s*type:\s*"enabled"\s*\}/);
  });
});

describe("[F-33-01][AC-33-1] pi 侧档位规则", () => {
  afterEach(() => {
    delete process.env.CARLIFE_PI_ANSWER_THINKING;
  });
  it("-task / -intent 后缀 off，应答会话 high；agent-prompt 的旧入口与策略同源", () => {
    for (const a of ["drive-task", "tour-task", "ownership-task", "cabin-task", "nav-task", "guide-spots-task", "supervisor-intent"]) {
      assert.equal(piThinkingLevelFor(a), "off", a);
      assert.equal(thinkingLevelFor(a), "off", a);
    }
    for (const a of ["trip", "buying", "supervisor", "ownership", "service", "cabin", "test-drive"]) {
      assert.equal(piThinkingLevelFor(a), "high", a);
      assert.equal(thinkingLevelFor(a), "high", a);
    }
  });
  it("CARLIFE_PI_ANSWER_THINKING 只覆盖五个表述型应答会话，trip / buying 与 -task 不受影响；非法值忽略", () => {
    assert.equal(piThinkingLevelFor("service", { CARLIFE_PI_ANSWER_THINKING: "low" }), "low");
    assert.equal(piThinkingLevelFor("trip", { CARLIFE_PI_ANSWER_THINKING: "low" }), "high");
    assert.equal(piThinkingLevelFor("buying", { CARLIFE_PI_ANSWER_THINKING: "off" }), "high");
    assert.equal(piThinkingLevelFor("tour-task", { CARLIFE_PI_ANSWER_THINKING: "high" }), "off");
    assert.equal(piThinkingLevelFor("service", { CARLIFE_PI_ANSWER_THINKING: "medium" }), "high");
    assert.deepEqual([...PI_NARRATING_ANSWER_SESSIONS], ["supervisor", "ownership", "service", "cabin", "test-drive"]);
  });
  it("表本身：表述类 off、主链路与裁判 high", () => {
    assert.equal(thinkingForSite("narrator"), "off");
    assert.equal(thinkingForSite("title"), "off");
    assert.equal(thinkingForSite("filler"), "off");
    assert.equal(thinkingForSite("dual-probe"), "off");
    assert.equal(thinkingForSite("probe"), "off");
    assert.equal(thinkingForSite("web-search"), "off");
    assert.equal(thinkingForSite("main-direct"), "high");
    assert.equal(thinkingForSite("judge"), "high");
  });
});
