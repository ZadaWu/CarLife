/**
 * 分支事件的端上话术（M37-01，F-13-03/F-13-07）。
 *
 * 钉两件事：
 * 1. **现役 fanout 分支全部有人话名**——漏一个不报错，症状是端上横幅显示
 *    裸会话名（"hotel-task失败了"）。新增分支时这份名单跟着 fanout 调用方走。
 * 2. branch() 产出的 SSE 事件带 status 与人话 note——端上"部分结果"标识的
 *    唯一结构化来源。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { branch, branchLabel } from "../src/events/index";

/** 现役分支会话名单：itinerary 四分支 + trip 双分支 + guide 三分支 + nav 单分支（M66-02）。 */
const ACTIVE_BRANCH_AGENTS = [
  "trip-task",
  "ownership-task",
  "hotel-task",
  "tour-task",
  "transit-task",
  "drive-task",
  "guide-access-task",
  "guide-spots-task",
  "guide-comfort-task",
  "nav-task",
];

describe("分支事件话术", () => {
  it("现役分支全部有人话名（不落回裸会话名）", () => {
    for (const agent of ACTIVE_BRANCH_AGENTS) {
      const label = branchLabel(agent);
      assert.notEqual(label, agent, `${agent} 没有人话名，端上会显示裸会话名`);
      assert.ok(!label.includes("-task"), `${agent} 的人话名不该带 -task 后缀`);
    }
  });

  it("未登记的分支名如实回落为原名——不编造", () => {
    assert.equal(branchLabel("mystery-task"), "mystery-task");
  });

  it("failed/timeout 事件带 status 与可直接渲染的 note，且两者措辞分开", () => {
    const failed = branch("t1", { agent: "hotel-task", status: "failed", durationMs: 1200 });
    const timeout = branch("t1", { agent: "hotel-task", status: "timeout", durationMs: 60000 });
    const f = failed as unknown as { kind: string; status: string; note: string; durationMs: number };
    const t = timeout as unknown as { status: string; note: string };
    assert.equal(f.kind, "branch");
    assert.equal(f.status, "failed");
    assert.equal(f.durationMs, 1200);
    assert.equal(f.note, "酒店安排失败了");
    assert.equal(t.note, "酒店安排超时未返回");
    assert.notEqual(f.note, t.note, "失败与超时要分开说：一个是出错，一个是没等到");
  });

  it("started 事件 durationMs 为 null（契约字段齐全）", () => {
    const s = branch("t1", { agent: "trip-task", status: "started" }) as unknown as {
      durationMs: number | null;
      note: string;
    };
    assert.equal(s.durationMs, null);
    assert.equal(s.note, "路线规划开始");
  });
});
