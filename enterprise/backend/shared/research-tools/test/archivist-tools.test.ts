/**
 * archivist 的两个工具（施工单 M89-01）。
 *
 * 这一组守的是**脱敏边界**：`evidenceById` 是唯一一个按 id 取单条证据的工具，
 * 而 `research_evidence_units` 整行带着 user_id、车架号与会话 / 消息引用。
 * 这些字节会穿过 pi 的会话 jsonl 落到磁盘上，没有任何提示——所以除了逐字段
 * `deepEqual`，还要对**序列化后的整段返回**扫一遍那六个键名。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { invokeTool, type UnitView } from "../src/index";
import { stubDeps } from "./fake-deps";

/** 与 research-runtime 的 `unitById` 投影同形：allowlist 之外的列在这一层就不存在。 */
const UNIT: UnitView = {
  id: "u1",
  kind: "utterance",
  sourceId: "messages",
  occurredAt: 1_700,
  textRedacted: "充电太慢了",
  displayLevel: "internal-redacted",
  withdrawn: false,
  fingerprint: "fp-1",
};

const run = async (name: string, args: unknown, deps = stubDeps()): Promise<unknown> => {
  const out = await invokeTool(name, args, deps);
  assert.equal(out.ok, true, out.ok === false ? out.error : "");
  return out.ok === true ? out.data : null;
};

const depsWithUnit = () =>
  stubDeps({
    unitById: async (id) => (id === "u1" ? UNIT : null),
    repo: {
      codings: {
        forUnits: async () => [
          {
            id: "c1",
            unitId: "u1",
            codebookVersion: "0.1.0",
            axis: "need_pain",
            code: "charging-speed",
            confidence: 0.82,
            rationale: "明确抱怨等待时长",
            uncertain: false,
            coder: "model:deepseek",
            promptHash: "ph-1",
          },
        ],
      },
    } as never,
  });

describe("[M89-01] evidenceById", () => {
  it("回单元、编码与来源护照三样", async () => {
    const out = await run("evidenceById", { unitId: "u1" }, depsWithUnit());
    assert.deepEqual(out, {
      unit: UNIT,
      // rationale 与 promptHash 是内部过程，不给模型。
      codings: [
        {
          axis: "need_pain",
          code: "charging-speed",
          confidence: 0.82,
          uncertain: false,
          coder: "model:deepseek",
        },
      ],
      passport: {
        id: "messages",
        control: "owner",
        provenance: "first-party",
        display: "yes",
        share: "no",
        retentionDays: null,
      },
    });
  });

  /*
   * **本文件最重要的一条。** 返回里出现任何一个跨用户标识符，就等于把
   * "谁说的这句话"写进了 pi 的会话记录。扫序列化后的整段，而不是只看顶层键：
   * 嵌套一层就漏掉的检查等于没有检查。
   */
  it("序列化后不含 userId / vin / sessionId / messageId / turnId / tripId", async () => {
    const text = JSON.stringify(await run("evidenceById", { unitId: "u1" }, depsWithUnit()));
    for (const key of ["userId", "vin", "sessionId", "messageId", "turnId", "tripId"]) {
      assert.ok(!text.includes(key), `返回里出现了 ${key}——这条链能指认到人`);
    }
  });

  it("单元不存在 → { missing: true }，不抛", async () => {
    const out = (await run("evidenceById", { unitId: "nope" }, depsWithUnit())) as Record<string, unknown>;
    assert.equal(out.missing, true);
  });

  it("来源未登记护照时 passport 为 null——按不可采处理", async () => {
    const out = (await run(
      "evidenceById",
      { unitId: "u1" },
      stubDeps({ ...depsWithUnit(), unitById: async () => ({ ...UNIT, sourceId: "not-registered" }) }),
    )) as { passport: unknown };
    assert.equal(out.passport, null);
  });
});

describe("[M89-01] sourcePassport", () => {
  it("带 sourceId：回那一张护照的全部字段", async () => {
    const out = (await run("sourcePassport", { sourceId: "messages" })) as Record<string, unknown>;
    assert.equal(out.id, "messages");
    assert.equal(out.control, "owner");
    assert.equal(out.provenance, "first-party");
    assert.ok(String(out.basis).length > 0, "基础授权必须给出——Rights 门失败时要原样上界面");
    assert.deepEqual(
      Object.keys(out).sort(),
      [
        "access", "analyze", "basis", "collect", "control", "display",
        "id", "notes", "provenance", "retentionDays", "share", "store",
      ].sort(),
    );
  });

  it("不带参：回全部来源的边界摘要", async () => {
    const out = (await run("sourcePassport", {})) as {
      sources: Array<Record<string, unknown>>;
    };
    assert.ok(out.sources.length >= 5, "来源地图不该只剩几张");
    for (const s of out.sources) {
      assert.deepEqual(
        Object.keys(s).sort(),
        ["collect", "control", "display", "id", "provenance", "share"].sort(),
      );
    }
    // 模拟来源必须能被一眼认出来：它不构成市场证据。
    assert.ok(out.sources.some((s) => s.provenance === "simulated"));
  });

  it("来源未登记 → { missing: true }", async () => {
    const out = (await run("sourcePassport", { sourceId: "nope" })) as Record<string, unknown>;
    assert.equal(out.missing, true);
  });
});
