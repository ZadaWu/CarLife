/**
 * `pi-research/` 目录形状的守卫（施工单 M88-03，ACR-038 步 3）。
 *
 * 这个目录不是代码包，没有 build、没有 typecheck，谁往里放一个文件都不会有人发现——
 * 而它恰恰有几条"放错了零报错"的约束：
 *
 *   1. 多一个 `package.json`，pnpm 就把它当 workspace 成员、turbo 去跑它不存在的脚本；
 *   2. `defaultModel` 与车主面不一致时，借来的 `models.json` 不认识它，pi **起不来**；
 *   3. 扩展若读回 `AGENT_RUNTIME_URL`，会回调车主面的工具端点，那边对未知 Agent 回空表，
 *      模型手里零工具却照样编出像样的答案（ACR-038 实施陷阱 1，M88-00 判定 11）。
 *
 * 所以这些断言只能在这里做：本包是离它最近、且真的会被跑到的地方。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { listAll, listForAgent, RESEARCH_AGENT_NAMES } from "@carlife/research-tools";

import {
  RESEARCH_TOOLS_DESCRIBE_PATH,
  RESEARCH_TOOLS_INVOKE_PATH,
} from "../src/acp/tools-endpoint";

const PKG = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PI_RESEARCH = resolve(PKG, "../pi-research");
const PI_AGENTS = resolve(PKG, "../pi-agents");

/** 目录下全部文件的相对路径（POSIX 分隔符），排序后可逐字比对。 */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath ?? e.path, e.name).slice(dir.length + 1).split("\\").join("/"))
    .sort();
}

describe("[M88-03] pi-research/ 的目录形状", () => {
  it("恰好七个文件，且没有 package.json / node_modules", () => {
    assert.deepEqual(filesUnder(PI_RESEARCH), [
      ".pi/extensions/research-tools.ts",
      ".pi/settings.json",
      "README.md",
      "prompts/analyst.md",
      "prompts/archivist.md",
      "prompts/challenger.md",
      "prompts/taxonomist.md",
    ]);
  });

  it("defaultModel 与车主面同一个——models.json 是借来的那份", () => {
    const read = (root: string): Record<string, unknown> =>
      JSON.parse(readFileSync(join(root, ".pi", "settings.json"), "utf8")) as Record<string, unknown>;
    const research = read(PI_RESEARCH);
    assert.equal(
      research.defaultModel,
      read(PI_AGENTS).defaultModel,
      "两个 pi 项目目录的 defaultModel 必须一致，否则借来的 models.json 不认识它",
    );
    // 思考档位反过来：用研面缺省关思考（真正生效的是 CARLIFE_PI_MODEL 拼的 :level）。
    assert.equal(research.defaultThinkingLevel, "off");
  });
});

describe("[M88-03] 扩展薄代理只认 CARLIFE_TOOLS_ENDPOINT", () => {
  const src = readFileSync(join(PI_RESEARCH, ".pi", "extensions", "research-tools.ts"), "utf8");

  it("读 CARLIFE_TOOLS_ENDPOINT，且全文不出现 AGENT_RUNTIME_URL", () => {
    assert.match(src, /CARLIFE_TOOLS_ENDPOINT/);
    assert.ok(!src.includes("AGENT_RUNTIME_URL"), "回调地址读错进程是零报错故障（ACR-038 实施陷阱 1）");
  });

  /*
   * 路径**与端点同源**（M88-04）：拿端点导出的常量去比，而不是在这里再抄一遍字面量。
   * 抄一遍的话，改了一侧两边一起绿，而真实症状是扩展启动即 404。
   */
  it("两条回调路径与 tools-endpoint 的常量逐字相同", () => {
    assert.ok(src.includes(RESEARCH_TOOLS_DESCRIBE_PATH), RESEARCH_TOOLS_DESCRIBE_PATH);
    assert.ok(src.includes(RESEARCH_TOOLS_INVOKE_PATH), RESEARCH_TOOLS_INVOKE_PATH);
  });
});

/*
 * 提示词里的工具名**必须逐字落在这个 Agent 的 ACL 里**（M89-02 关键约束 4）。
 *
 * pi 把不存在的工具名当普通文本：模型读到"用 `agreementReport` 查一下"照样会
 * "调用"它，然后照着一个编出来的返回继续答——**全程零报错**。
 * 提法错了的症状与提法对了的症状长得一模一样，所以只能在这里机械比对。
 */
describe("[M89-02] 四份提示词的工具名 ⊆ 该 Agent 的 ACL", () => {
  /** 全表工具名。提示词里的反引号还包着 `missing` / `analyze` 这类词，先按它过滤。 */
  const ALL_TOOL_NAMES = new Set(listAll().map((t) => t.name));

  /** 取出反引号里的片段，只留下"确实是某个工具名"的那些。 */
  function toolNamesIn(text: string): string[] {
    const found = new Set<string>();
    for (const seg of text.split("`")
      .filter((_, i) => i % 2 === 1)
      .map((s) => s.trim())) {
      if (ALL_TOOL_NAMES.has(seg)) found.add(seg);
    }
    return [...found].sort();
  }

  for (const agent of RESEARCH_AGENT_NAMES) {
    const file = join(PI_RESEARCH, "prompts", `${agent}.md`);

    it(`${agent}.md 提到的工具都在它自己的 ACL 里`, () => {
      const acl = new Set(listForAgent(agent).map((t) => t.name));
      const mentioned = toolNamesIn(readFileSync(file, "utf8"));
      const extra = mentioned.filter((n) => !acl.has(n));
      assert.deepEqual(extra, [], `${agent}.md 提到了它拿不到的工具：${extra.join(", ")}`);
      // 反过来也要求：一个都没提的提示词等于把工具藏起来了。
      assert.ok(mentioned.length > 0, `${agent}.md 一个工具都没提`);
    });

    it(`${agent}.md 写明"先用工具查"`, () => {
      assert.match(readFileSync(file, "utf8"), /先用工具查/);
    });
  }
});
