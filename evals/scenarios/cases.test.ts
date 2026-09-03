/**
 * 澄清题（`sub:clarification`）的 `answer_must` 守卫（施工单 M62-01）。
 *
 * M57-00 §4 记的债：正则写的是造题时想象的反问句式，系统真实的反问「您想试驾哪款车呢？」
 * 不在词表里——0% 的澄清率里混着标注缺陷。本文件对每题构造一句**自然的反问**（取 dump 原文或同义句）
 * 断言命中、再构造一句**硬答**断言不命中且 `answer_must_not` 命中：
 * 正则放宽的判据是语义等价，不是让当前回答过关——两侧都钉住才能证明这一点。
 * 零依赖：直接读 jsonl，不起服务。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

interface Case {
  id: string;
  input: string;
  expect: { answer_must?: string[]; answer_must_not?: string[]; clarify?: boolean };
  tags: string[];
  notes?: string;
}

const CASES: Case[] = readFileSync(new URL("./cases.jsonl", import.meta.url), "utf8")
  .split("\n")
  // 题库里有 `// ──` 分节注释行（与 runner 的 loadCases 同一条规则）
  .filter((l) => l.trim() && !l.trim().startsWith("//"))
  .map((l) => JSON.parse(l) as Case);

const byId = new Map(CASES.map((c) => [c.id, c]));

/** 只在括号深度 0 处按 `|` 切——「改(成|到)(什么|哪)」里的「哪」不是顶层分支。 */
function topLevelBranches(pattern: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of pattern) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "|" && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}
const all = (pats: string[], text: string): boolean => pats.every((p) => new RegExp(p).test(text));
const any = (pats: string[], text: string): boolean => pats.some((p) => new RegExp(p).test(text));

/** 每题：自然反问（须命中）× 硬答（须不命中 answer_must、且命中 answer_must_not）。 */
const SAMPLES: Record<string, { clarify: string[]; hard: string }> = {
  "s-41": {
    clarify: ["您想试驾哪款车呢？", "您是想预约保养、维修还是试驾？", "请问要预约什么项目？"],
    hard: "好的，已经帮你约好明天上午的保养。",
  },
  "s-42": {
    clarify: ["您想了解哪方面的价格？", "您指的是什么的费用——保养、维修还是保险？", "您要查哪项报价？", "您是想问哪笔钱？比如某款车的价格、试驾相关费用？"],
    hard: "保养大概 800 块，已预约成功。",
  },
  "s-43": {
    clarify: ["您说的「它」是指哪个部件？", "「它」指的是什么呢，轮胎还是电瓶？", "您指哪一项？"],
    hard: "还能用，放心开吧，已经帮你办好了。",
  },
  "s-44": {
    clarify: ["您想改哪一次预约的时间？", "改成什么时候呢？", "您要改到几点？"],
    hard: "好的，已经帮你改好到下午三点。",
  },
  "s-45": {
    clarify: ["您说的下周三是要做什么呢——保养还是维修？", "下周三要做什么事？", "您指的是哪件事？", "现在还没有行程草案，您这趟想去哪儿？"],
    hard: "下周三没问题，已经帮你约好了。",
  },
};

describe("澄清题的 answer_must（M62-01 放宽后）", () => {
  it("五题都在库里且带 clarify 断言", () => {
    for (const id of Object.keys(SAMPLES)) {
      const c = byId.get(id);
      assert.ok(c, `${id} 不在 cases.jsonl`);
      assert.equal(c!.expect.clarify, true);
      assert.ok(c!.tags.includes("sub:clarification"));
      assert.ok((c!.expect.answer_must ?? []).length > 0);
      assert.match(c!.notes ?? "", /M62-01 放宽/, "放宽依据必须写进 notes");
    }
  });

  for (const [id, s] of Object.entries(SAMPLES)) {
    it(`${id}：自然反问全部命中`, () => {
      const c = byId.get(id)!;
      for (const text of s.clarify) {
        assert.ok(all(c.expect.answer_must!, text), `${id} 的 answer_must 认不出反问：「${text}」`);
      }
    });
    it(`${id}：硬答不命中 answer_must，且撞上 answer_must_not`, () => {
      const c = byId.get(id)!;
      assert.ok(!all(c.expect.answer_must!, s.hard), `${id} 的 answer_must 太宽，硬答也过：「${s.hard}」`);
      assert.ok(any(c.expect.answer_must_not!, s.hard), `${id} 的 answer_must_not 没接住硬答：「${s.hard}」`);
    });
  }

  it("正则里没有裸单字分支（「什么」「哪」不能独立成顶层分支）", () => {
    for (const id of Object.keys(SAMPLES)) {
      for (const p of byId.get(id)!.expect.answer_must!) {
        for (const branch of topLevelBranches(p)) {
          assert.ok(!/^(什么|哪|请问|它)$/.test(branch), `${id}：分支「${branch}」太宽`);
        }
      }
    }
  });
});
