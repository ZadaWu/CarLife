/**
 * 图的接线（施工单 M85-01）。
 *
 * 这个文件钉的全是**没有现象的缺口**：图建起来了却从不被执行、
 * 三个节点是桩、`threads` 从不被 `.set()`。它们的共同点是
 * 端点照常应答、测试照常绿，只是那几段代码从来没跑过。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const src = (p: string): string => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("[M85-01] runResearch 只有一个调用点", () => {
  /*
   * 曾经有两个：`startRun` 与图里的 `analyze`。两处都漏传
   * `embeddings` / `texts` / `nameTheme`，主题聚类整段被静默跳过，
   * 日志还打一句"缺 key 时是预期行为"（见 index.ts 里 themeMaterials 的注释）。
   *
   * 收敛成一个之后，**第二条路径不能悄悄回来**——回来的形态一定是
   * "为了快一点，某个端点直接调 runResearch 绕过图"，而那样写没有任何报错。
   */
  it("整个 index.ts 里 runResearch 只被调用一次，且在图的 analyze 里", () => {
    const text = src("index.ts");
    const calls = text.match(/\brunResearch\s*\(/g) ?? [];
    assert.equal(
      calls.length,
      1,
      `runResearch 被调用了 ${calls.length} 次。第二条路径会绕过 synthesize / challenge / gate，` +
        "而绕过去之后洞察卡是 0、挂起项是空的，全程零报错",
    );

    // 那一次必须在 analyze 回调里。
    const analyzeIdx = text.indexOf("analyze: async");
    const callIdx = text.indexOf("runResearch(");
    assert.ok(analyzeIdx > 0 && callIdx > analyzeIdx, "唯一那次调用应当在图的 analyze 节点里");
  });

  it("startRun 走 graphApp.invoke，不自己算快照", () => {
    const text = src("index.ts");
    const startRunIdx = text.indexOf("startRun: async");
    assert.ok(startRunIdx > 0, "startRun 还在");
    const body = text.slice(startRunIdx, startRunIdx + 3000);
    assert.ok(body.includes("graphApp.invoke"), "startRun 必须经图，不能绕过去");
    assert.ok(body.includes("threads.set"), "threads 不被 set 的话 GET runs/:id 恒 run_not_found");
  });
});

describe("[M85-01] 三个阶段不再是桩", () => {
  const text = src("index.ts");

  it("synthesizeAll / challengeAll / gate 都接到了真实现", () => {
    assert.ok(text.includes("synthesizeAll({"), "synthesizeAll 应当调 stages/synthesize");
    assert.ok(text.includes("challengeAll(insightIds"), "challengeAll 应当调 stages/challenge");
    assert.ok(text.includes("gateAll(insightIds"), "gate 应当调 stages/gate");
  });

  it("桩的记号都不在了", () => {
    assert.ok(!/challengeAll:\s*async\s*\(\s*\)\s*=>\s*0/.test(text), "challengeAll 还是 async () => 0");
    assert.ok(!/gate:\s*async\s*\(\s*\)\s*=>\s*undefined/.test(text), "gate 还是 async () => undefined");
    assert.ok(!text.includes("void contractId;"), "synthesizeAll 里 void contractId 是桩的记号");
  });
});

describe("[M85-01] 主题的需求码不从 id 解析", () => {
  /*
   * 码今天存成一列。曾经它只出现在 `theme-<版本>-<码>-<序号>` 这个 id 里，
   * 而码与版本号都带连字符——切不出唯一解，切错不报错，
   * 只会让洞察卡挂到别的码上（ADR-012）。
   */
  it("没有任何地方对 theme id 做切分取码", () => {
    for (const f of ["stages/synthesize.ts", "challenge/deps.ts", "runs/run.ts"]) {
      const text = src(f);
      assert.ok(
        !/theme-.*\.split\(/.test(text) && !/\.split\("-"\)/.test(text),
        `${f} 里出现了对 id 的切分——需求码要向已经知道它的那一方要，不要从文本解析`,
      );
    }
  });

  it("写库时把码原样传下去", () => {
    assert.ok(src("runs/run.ts").includes("needPainCode: c.needPainCode"), "upsert 要写码这一列");
  });
});
