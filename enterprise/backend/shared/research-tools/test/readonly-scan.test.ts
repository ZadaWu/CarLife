/**
 * 「全只读」的单测层检出点（施工单 M88-02）。
 *
 * # 为什么与 check:arch 的 `research-tools-ro` 重复一遍
 *
 * 不是重复保险，是**两个消费方**：`check:arch` 在 `check:all` 里跑，
 * 而各包的 `pnpm test` 不会去跑它。改这个包的人跑的是后者——
 * 把唯一的检出点放在另一条命令上，等于让最该看见它的那次改动看不见它。
 * 关键字与规则逐字相同，改一处要回来改另一处（规则文件里也写着这句）。
 *
 * # 原文
 *
 * 这段断言原先在 `research-runtime/test/challenge.test.ts:69`，只扫一个文件。
 * M88-02 随工具搬家扩到整个包；M89-01 加了跨用户标识符与 research-runtime 反引两条。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = join(new URL("..", import.meta.url).pathname.replace(/\/$/, ""), "src");

/** 与 `check-arch-invariants.ts` 的 `research-tools-ro` 子规则 ② 逐字相同。 */
const WRITE_OPS = ["insertMany", "upsert", "deleteMany", "\\.record\\(", "\\.create\\(", "update\\("];

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

const sources = (): Array<{ file: string; text: string }> =>
  readdirSync(SRC)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ file: f, text: readFileSync(join(SRC, f), "utf8") }));

describe("[M88-02] 整包源码扫描：研究工具全只读", () => {
  it("扫描范围非空——文件没了的话下面几条会变成恒真", () => {
    assert.ok(sources().length >= 3, "src/ 下少于三个文件，扫描可能已经落空");
  });

  it("没有写操作", () => {
    for (const { file, text } of sources()) {
      text.split("\n").forEach((line, i) => {
        if (isComment(line)) return;
        for (const w of WRITE_OPS) {
          assert.ok(
            !new RegExp(w).test(line),
            `${file}:${i + 1} 出现了写操作 ${w.replace(/\\/g, "")}——被要求挑刺的模型不该有权改动被挑的东西`,
          );
        }
      });
    }
  });

  it("不 import 车主面与协议层", () => {
    // 引了 @carlife/tools，用研面的模型手里就多出车主面的全部工具，而这件事零报错。
    // @carlife/research-runtime（M89-01 加）是反方向的：它依赖本包，反引一次就成环，
    // 而 `CodebookView` 这类形状正是为了不反引才在本包里另立的——引了它，那层解耦白做。
    const FORBIDDEN = [
      "@carlife/tools",
      "@carlife/agent-runtime",
      "@carlife/memory",
      "@carlife/acp",
      "@carlife/research-runtime",
    ];
    for (const { file, text } of sources()) {
      for (const spec of FORBIDDEN) {
        assert.ok(
          !new RegExp(`from\\s+["']${spec}["']`).test(text),
          `${file} 引了 ${spec}——工具表不该认识车主面，也不该认识协议`,
        );
      }
    }
  });

  it("零 sensitive：研究工具不接权限门", () => {
    for (const { file, text } of sources()) {
      text.split("\n").forEach((line, i) => {
        if (isComment(line)) return;
        assert.ok(
          !/sensitive\s*:\s*true/.test(line),
          `${file}:${i + 1} 声明了 sensitive: true——用研面没有权限门，这个标记会被静默忽略`,
        );
      });
    }
  });

  /*
   * M89-01 加：跨用户标识符一个都不许出现在源码里（注释除外）。
   *
   * `units.byId` 回的是**整行**，带着 user_id、车架号与会话 / 轮次 / 消息 / 行程引用。
   * 投影发生在 `research-runtime/src/challenge/deps.ts`，而且必须是挑字段的 allowlist：
   * 这条扫描守的是"本包这一侧连碰都不碰它们"——一旦哪天有人在工具里
   * 顺手写一句 `row.userId`，这些字节就会穿过 pi 的会话 jsonl 落到磁盘上。
   */
  const IDENTIFIER_KEYS = ["userId", "vin", "sessionId", "messageId", "turnId", "tripId"];

  /** 返回命中的 `键名@行号`。非注释行才算——注释里写清楚"为什么不能有它"是必要的。 */
  const identifierHits = (text: string): string[] => {
    const hits: string[] = [];
    text.split("\n").forEach((line, i) => {
      if (isComment(line)) return;
      for (const key of IDENTIFIER_KEYS) {
        if (new RegExp(`\\b${key}\\b`).test(line)) hits.push(`${key}@${i + 1}`);
      }
    });
    return hits;
  };

  it("非注释行不出现 userId / vin / sessionId / messageId / turnId / tripId", () => {
    for (const { file, text } of sources()) {
      assert.deepEqual(identifierHits(text), [], `${file} 里出现了能指认到人的字段`);
    }
  });

  it("自检：扫描真的抓得住——注入一行就该被判出", () => {
    // 这条在的理由是上一条会"恒真"：正则写错、键名拼错，表现都是永远零命中。
    assert.deepEqual(identifierHits("const x = row.userId;"), ["userId@1"]);
    assert.deepEqual(identifierHits("// const x = row.userId;"), [], "注释行不该被判出");
  });

  it("**返回里不出现 `content` 键**——穿过 pi 会话 jsonl 的只能是 textRedacted", () => {
    // 未脱敏原文一旦进了 pi 的会话记录就落在磁盘上，而那一步没有任何提示。
    for (const { file, text } of sources()) {
      text.split("\n").forEach((line, i) => {
        if (isComment(line)) return;
        assert.ok(
          !/\bcontent\s*:/.test(line),
          `${file}:${i + 1} 出现了 content 键：${line.trim().slice(0, 60)}`,
        );
      });
    }
  });
});
