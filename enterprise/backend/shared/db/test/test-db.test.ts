/**
 * 测试库解析器与 `_test` 安全闸（施工单 M45-01）。
 *
 * 这组用例守的是一条不变量：**测试永远不会连上开发库**。
 * 最关键的是「不许回落」那条——回落写错了不会报错，只会在某天演示前
 * 表现成"数据没了"，所以必须有一条用例专门盯着它。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_TEST_DATABASE_URL, resolveTestDatabaseUrl, TestDatabaseUrlError } from "../src/test-db";

describe("测试库地址解析与安全闸", () => {
  it("未配置时用测试库默认值，库名是 carlife_test", () => {
    const url = resolveTestDatabaseUrl({});
    assert.equal(url, DEFAULT_TEST_DATABASE_URL);
    assert.equal(new URL(url).pathname, "/carlife_test");
  });

  it("**配了 DATABASE_URL 也不回落**——这条守的是隔离本身", () => {
    // 回落一旦写错，测试照常全绿，直到演示数据没了才发现。所以单独一条盯着它。
    const url = resolveTestDatabaseUrl({
      DATABASE_URL: "postgresql://carlife:carlife@localhost:55433/carlife",
    });
    assert.equal(url, DEFAULT_TEST_DATABASE_URL);
    assert.ok(!url.endsWith("/carlife"), "回落到了开发库——隔离失效");
  });

  it("显式配置的 _test 库原样返回", () => {
    const given = "postgresql://u:p@db.example:5432/carlife_test";
    assert.equal(resolveTestDatabaseUrl({ TEST_DATABASE_URL: given }), given);
  });

  it("查询串不影响库名判定", () => {
    const given = "postgresql://u:p@localhost:5432/foo_test?schema=public&connection_limit=1";
    assert.equal(resolveTestDatabaseUrl({ TEST_DATABASE_URL: given }), given);
  });

  it("库名不以 _test 结尾时拒绝运行，且消息点名被拒的库", () => {
    let err: unknown;
    try {
      resolveTestDatabaseUrl({
        TEST_DATABASE_URL: "postgresql://carlife:carlife@localhost:55433/carlife",
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof TestDatabaseUrlError, "应抛 TestDatabaseUrlError");
    assert.match(err.message, /carlife/);
    assert.match(err.message, /_test/);
  });

  it("以 _test 为子串但不在结尾的库名同样拒绝", () => {
    assert.throws(
      () => resolveTestDatabaseUrl({ TEST_DATABASE_URL: "postgresql://l/carlife_test_backup" }),
      TestDatabaseUrlError,
    );
  });

  it("空串按未配置处理，落回默认值", () => {
    assert.equal(resolveTestDatabaseUrl({ TEST_DATABASE_URL: "   " }), DEFAULT_TEST_DATABASE_URL);
  });

  it("非法 URL 抛错而不是悄悄用默认值", () => {
    // 静默退回的话，一个拼错的连接串会表现成"测试莫名其妙过了"，
    // 而人以为自己在测另一个库。
    assert.throws(
      () => resolveTestDatabaseUrl({ TEST_DATABASE_URL: "不是一个 URL" }),
      TestDatabaseUrlError,
    );
  });
});
