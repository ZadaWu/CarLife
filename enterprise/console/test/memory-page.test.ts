/**
 * 记忆浏览页的**防退化断言**（M11-05）。
 *
 * 这一页此前把六类的接线状态写死在代码里，于是它说的话随实现演进变成了谎话：
 * 「②③未接入：Mem0 尚未部署（§13-11 未定案 + LangChain v1 版本冲突）」
 * ——那时 Mem0 早已部署、版本冲突早已解决、④的表与工具都在。
 *
 * **我据此在能力矩阵里写下过错误的判断。** 一份写错的状态说明比没有说明更糟：
 * 它让人停止查证。
 *
 * 所以这里守两条：状态不得再从常量来；「未接线」与「0 条」不得再合并成一句话。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGE = readFileSync(join(process.cwd(), "src/pages/memory/index.tsx"), "utf8");

describe("状态必须来自运行时，不是常量", () => {
  it("页面拉取 /console/memory/overview", () => {
    assert.match(PAGE, /console\/memory\/overview/);
  });

  it("**不再使用 taxonomy 的 `connected` 常量判定接线**", () => {
    // `c.connected` 来自 MEMORY_TAXONOMY，是写死的。用它判定就是回到老路。
    assert.ok(
      !/\bc\.connected\b/.test(PAGE),
      "检测到 c.connected：接线状态又被写回常量了，这正是本工单要根治的",
    );
  });

  it("接线状态取自 overview.wiring", () => {
    assert.match(PAGE, /overview\?\.wiring/);
  });
});

describe("**「未接线」与「0 条」必须分开说**", () => {
  it("0 条时明说是「这个用户还没有」", () => {
    /*
     * 断言的是**那句话**，不是它的排版。
     *
     * 原来匹配整串 `0 条（这个用户还没有，不是没做）`；2026-08-27 把条数改成
     * 大字主角后，数字与说明拆进了两个元素，整串就不再连续存在了——
     * 而这条守卫要守的从来是"0 有没有被解释清楚"，不是"它是不是写成一行"。
     */
    assert.match(PAGE, /这个用户还没有，不是没做/);
  });

  it("未接线是另一句话", () => {
    assert.match(PAGE, /未接线/);
  });

  it("运行时读不到时不冒充「未接入」", () => {
    // 读不到与「它说未接入」是两回事：前者是我们看不见，后者是它真没接。
    assert.match(PAGE, /状态未知|接线状态.*读不到|运行时不可达/);
  });
});

describe("只通一端要能显示出来", () => {
  it("有「仅读/仅写」这一档", () => {
    // ③曾经长期只能读不能写。两态显示会把它标成"已接入"，
    // 而那正是这一页此前误导人的方式。
    assert.match(PAGE, /仅\{w\.read \? "读" : "写"\}已接线/);
  });
});
