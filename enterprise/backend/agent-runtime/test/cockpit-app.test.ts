/**
 * 车主面的 `AcpApp` 描述符（施工单 M85-09 步 4）。
 *
 * # 为什么这一层非有不可
 *
 * 描述符的每一项漏填**都不报错**：
 *  - `toolNamesFor` 回空数组 → 模型手里零工具，照样编出像样的答案
 *    （`pool.ts` 文件头记的就是这个形状的事故，六个 Agent 共用 supervisor 的工具表，
 *    全程零报错，只能靠真跑一遍看工具有没有被调到才发现）；
 *  - `piDir` 指错 → 加载了别人的 `.pi/extensions`，同样零报错；
 *  - `decoratePrompt` 漏传 → 模型不知道今天几号，把"下周二"算成别的日子。
 *
 * typecheck 只能证明**字段在**，证明不了**填的是真东西**。所以这里逐项打一遍。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { COCKPIT_AGENTS, COCKPIT_PI_DIR, createCockpitApp } from "../src/acp-client/cockpit-app";

const app = createCockpitApp({ toolsEndpoint: "http://127.0.0.1:8791/internal/tools" });

describe("[M85-09] 车主面描述符不是空壳", () => {
  it("**piDir 真的指向 pi-agents，且那里真的有 .pi/settings.json**", () => {
    // 指错时没有任何报错——pi 会用一份空配置照常起来。
    assert.ok(existsSync(join(app.piDir, ".pi", "settings.json")), `piDir 指到了别处：${app.piDir}`);
    assert.equal(app.piDir, COCKPIT_PI_DIR);
  });

  it("promptsDir 下真的有 supervisor.md", () => {
    assert.ok(existsSync(join(app.promptsDir, "supervisor.md")), `promptsDir 不对：${app.promptsDir}`);
  });

  it("**每个 Agent 都拿得到非空的工具清单**", async () => {
    for (const agent of COCKPIT_AGENTS) {
      const names = app.toolNamesFor(agent);
      assert.ok(names.length > 0, `${agent} 的工具清单是空的——模型会照样编出像样的答案`);
    }
  });

  it("**清单是按 Agent 裁过的，不是同一份并集**", () => {
    /*
     * 反向自检：如果 `toolNamesFor` 退化成"谁来都给全量"，上面那条照样绿。
     * 判据取两个职责差得最远的 Agent——它们手里的工具不该一样。
     */
    const supervisor = [...app.toolNamesFor("supervisor")].sort();
    const hotel = [...app.toolNamesFor("hotel")].sort();
    assert.notDeepEqual(supervisor, hotel, "两个 Agent 的工具表一模一样——裁剪没有生效");
    assert.ok(hotel.includes("hotel_search"), `hotel 手里没有 hotel_search：${hotel.join(",")}`);
    assert.ok(!supervisor.includes("hotel_search"), "supervisor 手里有 hotel_search——并集泄漏了");
  });

  it("后缀会话与它的规范名拿同一张表——ACL 只认规范名", () => {
    assert.deepEqual(app.toolNamesFor("trip-task"), app.toolNamesFor("trip"));
  });

  it("思考档：`-task` 后缀 off，应答会话 high", () => {
    assert.equal(app.thinkingFor("trip-task"), "off");
    assert.equal(app.thinkingFor("supervisor-intent"), "off");
    assert.equal(app.thinkingFor("trip"), "high");
  });

  it("业务 prompt 读得出来，且不是占位骨架", async () => {
    const text = await app.promptFor("supervisor");
    assert.ok(text.length > 100, "prompt 短得不像正文");
    assert.ok(!text.includes("占位骨架"), "读到的是占位骨架——模型只有 pi 的默认提示词");
  });

  it("**decoratePrompt 真的前置了日期**，不是原样返回", () => {
    const at = Date.UTC(2026, 8, 14, 4, 0, 0); // 北京时间 2026-09-14 12:00
    const out = app.decoratePrompt!("明天出发", at);
    assert.match(out, /2026-09-14/, `没前置日期：${out}`);
    assert.ok(out.endsWith("明天出发"), "正文被改了——它只该前置，不该改写");
  });

  it("tracer 四样齐全，且 cancelled 造出的错带 `cancelled` 标", () => {
    /*
     * 底座自己 new 一个 Error 的话，调用方的 `err.cancelled` 判据就对不上——
     * 而对不上时「取消」会被当成「失败」上报，看起来像"一取消就报错"。
     */
    const err = app.tracer.cancelled("本轮已取消（trip）");
    assert.equal((err as Error & { cancelled?: boolean }).cancelled, true);
    for (const k of ["span", "recordSpan", "recordPrompt", "cancelled"] as const) {
      assert.equal(typeof app.tracer[k], "function", `tracer 少了 ${k}`);
    }
  });

  it("**Agent 清单与 connection.ts 的 AgentName 联合类型逐字对齐**", async () => {
    /*
     * 两份表（类型一份、运行期一份）必须同步。对不上的表现是某个 Agent
     * 永远不进池——它的会话会落到别人的进程里，拿着别人的工具表，零报错。
     */
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../src/acp-client/connection.ts", import.meta.url), "utf8"),
    );
    // 联合类型到第一个分号为止——别钉最后一个成员的名字（M86-03 加 tour-plan 时这里曾钉着 "nav"）。
    const start = src.indexOf("export type AgentName =");
    const block = src.slice(start, src.indexOf(";", start) + 1);
    const inType = [...block.matchAll(/\|\s*"([a-z-]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...COCKPIT_AGENTS].sort(), inType.sort());
  });
});
