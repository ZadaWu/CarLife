/**
 * 分支失败的端上聚合（M37-01，F-13-03）。
 *
 * 真相源是 `update.branch` 的结构化 status——这些断言钉住的是
 * "什么进横幅、什么不进、什么时候清"，不是话术本身。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyBranchFault,
  EMPTY_FAULTS,
  type BranchFaultEvent,
} from "../src/hooks/useBranchFaults";

const ev = (
  agent: string,
  status: BranchFaultEvent["status"],
  note: string | null = null,
): BranchFaultEvent => ({ agent, status, note });

describe("分支失败聚合", () => {
  it("failed/timeout 进清单，带服务端人话", () => {
    let s = applyBranchFault(EMPTY_FAULTS, ev("hotel-task", "timeout", "酒店安排超时未返回"));
    s = applyBranchFault(s, ev("guide-spots-task", "failed", "必玩点位失败了"));
    assert.deepEqual(
      s.map((x) => x.text),
      ["酒店安排超时未返回", "必玩点位失败了"],
    );
  });

  it("started/ok **不进**——进展不是缺失，混进去横幅会常驻", () => {
    let s = applyBranchFault(EMPTY_FAULTS, ev("hotel-task", "started"));
    s = applyBranchFault(s, ev("hotel-task", "ok", "酒店安排已完成"));
    assert.equal(s.length, 0);
    assert.equal(s, EMPTY_FAULTS, "无变化时保持原引用，少一次重渲染");
  });

  it("同一分支的重复终态不叠加（服务端重试补发）", () => {
    let s = applyBranchFault(EMPTY_FAULTS, ev("tour-task", "failed", "景点安排失败了"));
    const again = applyBranchFault(s, ev("tour-task", "failed", "景点安排失败了"));
    assert.equal(again.length, 1);
    assert.equal(again, s, "重复事件返回原引用");
  });

  it("note 缺席时退化为 agent 名——不编话术", () => {
    const s = applyBranchFault(EMPTY_FAULTS, ev("drive-task", "timeout"));
    assert.equal(s[0].text, "drive-task");
  });
});
