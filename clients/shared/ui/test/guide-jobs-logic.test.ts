/**
 * 导览任务面板共享纯逻辑（M40-02）。钉两条端上共用规则：
 * 轮询只在有在途任务时继续；乐观置位只对可获取的行生效且 summary 同步搬账。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GuideJobsStatus } from "@carlife/shared";

import {
  applyGuideFetchOptimistic,
  outstandingGuideJobs,
  readyGuideSpots,
  shouldPollGuideJobs,
} from "../src/guide/jobs-logic";

const jobs = (states: Array<GuideJobsStatus["spots"][number]["state"]>): GuideJobsStatus => {
  const spots = states.map((state, i) => ({ spotName: `点${i}`, state }));
  const summary = { total: spots.length, ready: 0, processing: 0, pending: 0, failed: 0, unprocessed: 0 };
  for (const s of spots) summary[s.state] += 1;
  return { spots, summary };
};

describe("轮询节流", () => {
  it("有 pending/processing 才轮；全终态与 null 都停", () => {
    assert.equal(shouldPollGuideJobs(null), false);
    assert.equal(shouldPollGuideJobs(jobs(["ready", "failed", "unprocessed"])), false);
    assert.equal(shouldPollGuideJobs(jobs(["ready", "pending"])), true);
    assert.equal(shouldPollGuideJobs(jobs(["processing"])), true);
  });
});

describe("乐观置位", () => {
  it("unprocessed/failed → pending，summary 搬账一致", () => {
    for (const from of ["unprocessed", "failed"] as const) {
      const next = applyGuideFetchOptimistic(jobs([from, "ready"]), "点0");
      assert.equal(next.spots[0]!.state, "pending");
      assert.equal(next.summary.pending, 1);
      assert.equal(next.summary[from], 0);
      assert.equal(next.summary.total, 2, "total 不动——搬账不是重算");
    }
  });

  it("在途/就绪/未知行原样返回（引用相等，不触发无谓重渲染）", () => {
    for (const st of ["ready", "pending", "processing"] as const) {
      const j = jobs([st]);
      assert.equal(applyGuideFetchOptimistic(j, "点0"), j);
    }
    const j = jobs(["unprocessed"]);
    assert.equal(applyGuideFetchOptimistic(j, "不存在的点"), j);
  });
});

describe("只留未完成的行（车机 HUD 小卡）", () => {
  it("ready 去掉，其余四态留下，顺序不变", () => {
    const next = outstandingGuideJobs(jobs(["ready", "pending", "ready", "failed", "unprocessed", "processing"]));
    assert.deepEqual(
      next.spots.map((s) => s.state),
      ["pending", "failed", "unprocessed", "processing"],
    );
  });

  it("summary 原样带过——过滤是显示口径，不是重算账本", () => {
    const src = jobs(["ready", "pending"]);
    const next = outstandingGuideJobs(src);
    assert.equal(next.summary, src.summary);
    assert.equal(next.summary.total, 2);
    assert.equal(next.summary.ready, 1, "进度头仍显示 1/2 就绪");
  });

  it("全 ready → spots 空（面板自己收成 null，卡整张消失）", () => {
    assert.equal(outstandingGuideJobs(jobs(["ready", "ready"])).spots.length, 0);
  });

  it("没有 ready 行时原样返回（引用相等，不触发无谓重渲染）", () => {
    const j = jobs(["pending", "failed"]);
    assert.equal(outstandingGuideJobs(j), j);
  });
});

describe("导览就绪的景点名（主页地图角标）", () => {
  it("只认 ready；pending/processing 是\"快了\"不是\"能看\"，不标", () => {
    const j = jobs(["ready", "pending", "processing", "failed", "unprocessed", "ready"]);
    assert.deepEqual(readyGuideSpots(j), ["点0", "点5"]);
  });

  it("jobs 为 null（没确认的行程 / 队列关着）→ 空数组，一个都不标", () => {
    assert.deepEqual(readyGuideSpots(null), []);
  });
});
