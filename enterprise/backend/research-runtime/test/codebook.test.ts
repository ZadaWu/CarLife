/**
 * codebook 载入与锁版校验（施工单 M82-04）。
 *
 * 锁版那条断言是本文件的重点：**改一个锁过版的码没有任何自然现象**——
 * 图照出、一致率照样高（两批各自内部仍一致），只有跨版本比较时数字悄悄换了含义。
 * 能拦住它的只有启动期这一次 hash 比对。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";

import {
  CodebookLockedMismatchError,
  assertCodebookConsistent,
  hashOf,
  loadLatestCodebook,
  parseCodebook,
} from "../src/codebook/load";

const CODEBOOK_DIR = join(new URL("..", import.meta.url).pathname.replace(/\/$/, ""), "codebooks");

const book = loadLatestCodebook(CODEBOOK_DIR);

describe("[M82-04] codebook 载入", () => {
  it("载入 v0.1.0 并算出 hash", () => {
    assert.equal(book.version, "0.1.0");
    assert.match(book.hash, /^[0-9a-f]{64}$/);
  });

  it("六个轴齐全，`need_pain` 是多选且上限 3", () => {
    assert.deepEqual(
      book.axes.map((a) => a.id),
      ["scene", "need_pain", "job", "emotion", "deliverability", "polarity"],
    );
    const needPain = book.axes.find((a) => a.id === "need_pain");
    assert.equal(needPain?.cardinality, "multi");
    assert.equal(needPain?.max, 3);
    assert.equal(book.axes.find((a) => a.id === "emotion")?.intensity, true);
  });

  it("`need_pain` 的十个码与证据矩阵的十行对得上", () => {
    const codes = book.axes.find((a) => a.id === "need_pain")!.codes.map((c) => c.id);
    for (const expected of [
      "range-anxiety", "cold-range-loss", "charger-availability", "asr-error", "nav-detour",
      "feature-discovery", "dtc-unclear", "service-interval", "booking-friction", "shared-ownership",
    ]) {
      assert.ok(codes.includes(expected), `缺 ${expected}`);
    }
  });

  it("没有禁用推断轴（健康 / 阶层 / 性格）", () => {
    for (const a of book.axes) {
      assert.ok(!["health", "class", "personality"].includes(a.id), `禁用轴 ${a.id} 出现在 codebook 里`);
    }
  });

  it("每个码都有 definition / include / exclude 与例子", () => {
    for (const axis of book.axes) {
      for (const c of axis.codes) {
        assert.ok(c.definition.length > 0, `${axis.id}/${c.id}`);
        assert.ok(c.exclude.length > 0, `${axis.id}/${c.id} 缺 exclude——没有 exclude 的码会吸走整个语料`);
        assert.ok(c.examples.length >= 2, `${axis.id}/${c.id}`);
        assert.ok(c.counter_examples.length >= 1, `${axis.id}/${c.id}`);
      }
    }
  });
});

describe("[M82-04] codebook 结构校验", () => {
  const minimal = (over = ""): string =>
    `version: "9.9.9"\naxes:\n  - id: scene\n    label: 场景\n    cardinality: single\n    codes:\n      - id: a\n        label: A\n        definition: d\n        include: i\n        exclude: e\n        examples: ["x", "y"]\n        counter_examples: ["z"]\n${over}`;

  it("合法的最小 codebook 能过", () => {
    assert.doesNotThrow(() => parseCodebook(minimal(), "t.yaml"));
  });

  it("缺 exclude 的码被拒", () => {
    const bad = minimal().replace("        exclude: e\n", "");
    assert.throws(() => parseCodebook(bad, "t.yaml"), /缺 exclude/);
  });

  it("只有一个 example 的码被拒", () => {
    const bad = minimal().replace('examples: ["x", "y"]', 'examples: ["x"]');
    assert.throws(() => parseCodebook(bad, "t.yaml"), /两个 examples/);
  });

  it("多选轴没声明 max 被拒", () => {
    const bad = minimal().replace("cardinality: single", "cardinality: multi");
    assert.throws(() => parseCodebook(bad, "t.yaml"), /必须声明 max/);
  });

  it("重复码被拒", () => {
    const bad = minimal(
      "      - id: a\n        label: A2\n        definition: d\n        include: i\n        exclude: e\n        examples: [\"x\", \"y\"]\n        counter_examples: [\"z\"]\n",
    );
    assert.throws(() => parseCodebook(bad, "t.yaml"), /重复码/);
  });
});

describe("[M82-04] 锁版之后文件不许改", () => {
  it("未锁版：hash 变了也放行（改文件只是更新那一行）", () => {
    assert.doesNotThrow(() => assertCodebookConsistent(book, { version: book.version, hash: "old", lockedAt: null }));
  });

  it("锁过版且 hash 相同：放行", () => {
    assert.doesNotThrow(() =>
      assertCodebookConsistent(book, { version: book.version, hash: book.hash, lockedAt: new Date() }),
    );
  });

  it("锁过版而文件被改过：抛 codebook_locked_mismatch", () => {
    assert.throws(
      () => assertCodebookConsistent(book, { version: book.version, hash: hashOf("别的内容"), lockedAt: new Date() }),
      (err: Error) => {
        assert.ok(err instanceof CodebookLockedMismatchError);
        assert.match(err.message, /codebook_locked_mismatch/);
        return true;
      },
    );
  });
});
