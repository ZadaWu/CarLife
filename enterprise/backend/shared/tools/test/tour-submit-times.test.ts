/**
 * M34-01：submit_tour_days 的时段与住宿字段。
 * schema 层只挡形状（HH:MM 正则、strategy 枚举）；语义校验在 agent-runtime merge 侧，
 * 这里只测提交通道：合法原样落槽、非法被 zod 当场拒绝（模型在工具循环里自愈）。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { setBranchSubmissionSink } from "../src/branch-submit";
import { invokeTool } from "../src/registry";

describe("submit_tour_days 时段与住宿（M34-01）", () => {
  afterEach(() => setBranchSubmissionSink(undefined));

  const ctx = { sessionId: "s1", turnId: "t1", agent: "tour" };

  it("estStart/estEnd 与 lodging 原样落槽，不加工", async () => {
    const recorded: unknown[] = [];
    setBranchSubmissionSink({
      record(_ctx, _tool, payload) {
        recorded.push(payload);
        return true;
      },
    });
    await invokeTool(
      "submit_tour_days",
      {
        days: [
          {
            day: 1,
            spots: [
              { name: "陈家祠堂", estStart: "09:00", estEnd: "10:30" },
              { name: "沙面岛", estStart: "14:00", estEnd: "16:00" },
            ],
            lodging: { strategy: "checkin-evening", note: "自驾，行李放车上，晚上入住" },
          },
        ],
      },
      ctx,
    );
    const payload = recorded[0] as { days: Array<Record<string, unknown>> };
    assert.deepEqual(payload.days[0].lodging, {
      strategy: "checkin-evening",
      note: "自驾，行李放车上，晚上入住",
    });
    assert.deepEqual(payload.days[0].spots, [
      { name: "陈家祠堂", estStart: "09:00", estEnd: "10:30" },
      { name: "沙面岛", estStart: "14:00", estEnd: "16:00" },
    ]);
  });

  it("非法 HH:MM 在 schema 层被拒（模型当场重试，坏值不进暂存区）", async () => {
    for (const bad of [{ estStart: "9am", estEnd: "11:00" }, { estStart: "25:00", estEnd: "26:00" }]) {
      await assert.rejects(
        invokeTool("submit_tour_days", { days: [{ spots: [{ name: "X", ...bad }] }] }, ctx),
        /入参不合法/,
      );
    }
  });

  it("非法 strategy 在 schema 层被拒", async () => {
    await assert.rejects(
      invokeTool(
        "submit_tour_days",
        { days: [{ lodging: { strategy: "checkin-tonight" } }] },
        ctx,
      ),
      /入参不合法/,
    );
  });

  it("不带新字段的旧形状照常通过（向后兼容）", async () => {
    setBranchSubmissionSink({ record: () => true });
    const r = await invokeTool(
      "submit_tour_days",
      { days: [{ day: 1, spots: [{ name: "陈家祠堂" }] }] },
      ctx,
    );
    assert.equal((r as { data: { accepted: number } }).data.accepted, 1);
  });
});
