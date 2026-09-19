/**
 * 思考档位的源码扫描（施工单 M82-04）。
 *
 * # 为什么要扫源码而不是跑一次看看
 *
 * 绕过 `createResearchModel` 直接建一个 provider **不会报错**：
 * 调用照样成功、JSON 照样回来，只是每次多烧一份推理预算，
 * 而且 `generateObject` 在预算被推理吃光时会退化成"一个字段没填"
 * （M24 实测 49 秒 18253 字）。没有任何一层会说这件事。
 *
 * 与 `agent-runtime/test/thinking-policy.test.ts` 是同一条纪律的两份实现——
 * 研究进程不许 import 那边的代码（`check:arch` 的 research-isolation），
 * 所以纪律要在这边再守一次。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PKG = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SRC = join(PKG, "src");
/** 唯一允许构造 provider 的文件。 */
const MODEL_FACTORY = join(SRC, "llm", "index.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const read = (p: string): string => readFileSync(p, "utf8");
/** 去掉注释再扫——注释里提到 `createDeepSeek(` 是我们希望多写的。 */
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("[M82-04] 每一处模型调用都经过唯一入口", () => {
  it("只有 llm/index.ts 构造 provider", () => {
    const offenders = files
      .filter((f) => f !== MODEL_FACTORY)
      .filter((f) => /createDeepSeek\s*\(|createOpenAICompatible\s*\(/.test(stripComments(read(f))));
    assert.deepEqual(offenders, [], `这些文件绕过了 createResearchModel：${offenders.join(", ")}`);
  });

  it("调 generateObject / generateText 的文件不自己建 provider", () => {
    for (const f of files) {
      const src = stripComments(read(f));
      if (!/generateObject\s*\(|generateText\s*\(/.test(src)) continue;
      assert.ok(
        !/createDeepSeek\s*\(/.test(src),
        `${f} 既调模型又自己建 provider——思考就关不掉了`,
      );
      // 模型必须是传进来的（`deps.model.model` 那种形状），不在调用点现造。
      assert.match(src, /model:\s*[\w.]*model/, `${f} 的 model 不像是从外面传进来的`);
    }
  });

  it("provider 工厂本身挂了关思考的 fetch 包装", () => {
    const src = stripComments(read(MODEL_FACTORY));
    assert.match(src, /fetch:\s*withThinkingDisabled\(\)/);
    assert.match(src, /thinking:\s*\{\s*type:\s*"disabled"\s*\}/);
  });
});

describe("[M82-04] 关思考的包装本身", () => {
  it("给 chat/completions 的 POST 合入 disabled", async () => {
    const { withThinkingDisabled } = await import("../src/llm");
    let seen: unknown = null;
    const wrapped = withThinkingDisabled(async (_i, init) => {
      seen = JSON.parse(String(init?.body));
      return new Response("{}");
    });
    await wrapped("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-flash", messages: [] }),
    });
    assert.deepEqual((seen as { thinking: unknown }).thinking, { type: "disabled" });
  });

  it("请求体已显式声明时不覆盖——将来 SDK 自己会传时不打架", async () => {
    const { withThinkingDisabled } = await import("../src/llm");
    let seen: unknown = null;
    const wrapped = withThinkingDisabled(async (_i, init) => {
      seen = JSON.parse(String(init?.body));
      return new Response("{}");
    });
    await wrapped("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ thinking: { type: "enabled" } }),
    });
    assert.deepEqual((seen as { thinking: unknown }).thinking, { type: "enabled" });
  });

  it("非 chat/completions 的请求原样放过", async () => {
    const { withThinkingDisabled } = await import("../src/llm");
    let seen: string | undefined;
    const wrapped = withThinkingDisabled(async (_i, init) => {
      seen = String(init?.body);
      return new Response("{}");
    });
    await wrapped("https://api.deepseek.com/v1/models", { method: "POST", body: '{"a":1}' });
    assert.equal(seen, '{"a":1}');
  });
});
