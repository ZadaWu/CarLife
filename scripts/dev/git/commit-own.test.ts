/**
 * commit-own（施工单 M97-02）：每条用例在临时目录 `git init` 一个仓，验的是五条不变量——
 * 只提交指定路径；共用索引不受影响；HEAD 被推进就重试；钩子失败不提交；`.jsonl` 按 entity_id 合并。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { commitOwn, gitRunner, mergeJsonlRows } from "./commit-own.mjs";

function repo() {
  const cwd = mkdtempSync(join(tmpdir(), "commit-own-test-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "tester");
  writeFileSync(join(cwd, "a.txt"), "a0\n");
  writeFileSync(join(cwd, "b.txt"), "b0\n");
  git("add", "a.txt", "b.txt");
  git("commit", "-q", "-m", "init");
  const msg = join(cwd, "msg.txt");
  writeFileSync(msg, "feat: own\n\nbody\n");
  return { cwd, git, msg };
}

describe("commit-own（M97-02）", () => {
  it("只提交指定路径：工作区改了 a、b，只传 a → 提交含 a 不含 b", () => {
    const { cwd, git, msg } = repo();
    writeFileSync(join(cwd, "a.txt"), "a1\n");
    writeFileSync(join(cwd, "b.txt"), "b1\n");
    commitOwn({ cwd, messageFile: msg, paths: [{ path: "a.txt" }], hook: null });
    assert.equal(git("show", "HEAD:a.txt"), "a1");
    assert.equal(git("show", "HEAD:b.txt"), "b0");
    assert.equal(git("log", "-1", "--format=%s %an"), "feat: own tester");
  });

  it("共用索引：别人暂存的 b 原样留着、不进提交；自己的 a 提交后索引项对齐到新 blob", () => {
    const { cwd, git, msg } = repo();
    writeFileSync(join(cwd, "b.txt"), "b1\n");
    git("add", "b.txt");
    writeFileSync(join(cwd, "a.txt"), "a1\n");
    commitOwn({ cwd, messageFile: msg, paths: [{ path: "a.txt" }], hook: null });
    assert.equal(git("diff", "--cached", "--name-only"), "b.txt", "只剩别人的暂存，a 不再显示成待提交的回退");
    assert.equal(git("show", "HEAD:b.txt"), "b0", "别人的暂存没被带进提交");
    assert.equal(git("show", "HEAD:a.txt"), "a1");
    assert.equal(git("status", "--porcelain", "--", "a.txt"), "", "a 在索引与工作区都干净");
  });

  it("可执行位不丢：755 的脚本提交后仍是 100755，索引项也是（INC-0164）", () => {
    const { cwd, git, msg } = repo();
    const sh = join(cwd, "run.sh");
    writeFileSync(sh, "#!/bin/sh\necho v0\n");
    chmodSync(sh, 0o755);
    commitOwn({ cwd, messageFile: msg, paths: [{ path: "run.sh" }], hook: null });
    assert.match(git("ls-tree", "HEAD", "run.sh"), /^100755 /, "树里必须是 100755，写死 644 会静默降权");
    assert.match(git("ls-files", "-s", "--", "run.sh"), /^100755 /, "共用索引也要对齐模式，否则 status 显示成待提交的 mode change");
    writeFileSync(join(cwd, "a.txt"), "a1\n");
    commitOwn({ cwd, messageFile: msg, paths: [{ path: "a.txt" }], hook: null });
    assert.match(git("ls-tree", "HEAD", "a.txt"), /^100644 /, "普通文件不该被抬成可执行");
  });

  it("共用索引：别人暂存了同一路径的另一版本，提交后不动它", () => {
    const { cwd, git, msg } = repo();
    writeFileSync(join(cwd, "a.txt"), "a-theirs\n");
    git("add", "a.txt");
    const mine = join(cwd, "a.mine");
    writeFileSync(mine, "a1\n");
    commitOwn({ cwd, messageFile: msg, paths: [{ path: "a.txt", contentFile: mine }], hook: null });
    assert.equal(git("show", "HEAD:a.txt"), "a1", "提交的是 contentFile 的内容");
    assert.equal(git("show", ":a.txt"), "a-theirs", "别人暂存的版本原样留在共用索引");
  });

  it("HEAD 被推进则重试：最终提交的父是被推进后的 HEAD，内容仍是自己的", () => {
    const { cwd, git, msg } = repo();
    writeFileSync(join(cwd, "a.txt"), "a1\n");
    const real = gitRunner(cwd);
    let bumped = false;
    const wrapped = (args: string[], env?: Record<string, string>) => {
      // 第一次算完树、还没 update-ref 时，模拟另一会话提交了 c.txt
      if (args[0] === "commit-tree" && !bumped) {
        bumped = true;
        writeFileSync(join(cwd, "c.txt"), "c\n");
        git("add", "c.txt");
        git("commit", "-q", "-m", "someone else");
        git("reset", "-q");
      }
      return real(args, env);
    };
    const commit = commitOwn({ cwd, messageFile: msg, paths: [{ path: "a.txt" }], hook: null, git: wrapped });
    assert.equal(git("rev-parse", "HEAD"), commit);
    assert.equal(git("log", "-1", "--format=%s", "HEAD~1"), "someone else", "父提交是别人推进后的 HEAD，没被覆盖");
    assert.equal(git("show", "HEAD:c.txt"), "c", "别人的文件在树里保住了");
    assert.equal(git("show", "HEAD:a.txt"), "a1");
  });

  it("钩子失败不提交：退出非零、HEAD 不变", () => {
    const { cwd, git, msg } = repo();
    const hook = join(cwd, "bad-hook.sh");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    writeFileSync(join(cwd, "a.txt"), "a1\n");
    const before = git("rev-parse", "HEAD");
    assert.throws(() => commitOwn({ cwd, messageFile: msg, paths: [{ path: "a.txt" }], hook }), /钩子失败/);
    assert.equal(git("rev-parse", "HEAD"), before);
  });

  it(".jsonl 按 entity_id 合并：只带指定 id 的行，别人新增的行不带，HEAD 行保序", () => {
    const { cwd, git, msg } = repo();
    mkdirSync(join(cwd, "docs"));
    const p = join(cwd, "docs", "x.catalog.jsonl");
    const row = (id: string, v: number) => JSON.stringify({ entity_id: id, v });
    writeFileSync(p, [row("A", 0), row("B", 0), row("C", 0)].join("\n") + "\n");
    git("add", "docs/x.catalog.jsonl");
    git("commit", "-q", "-m", "ledger");
    // 工作区：B 改了、D（我的）与 E（别人的）新增
    writeFileSync(p, [row("A", 0), row("B", 1), row("C", 0), row("E", 9), row("D", 1)].join("\n") + "\n");
    commitOwn({ cwd, messageFile: msg, paths: [], jsonl: [{ path: "docs/x.catalog.jsonl", ids: ["B", "D"] }], hook: null });
    assert.equal(git("show", "HEAD:docs/x.catalog.jsonl"), [row("A", 0), row("B", 1), row("C", 0), row("D", 1)].join("\n"));
    assert.equal(mergeJsonlRows(`${row("A", 0)}\n`, `${row("A", 1)}\n${row("Z", 1)}\n`, ["A"]), `${row("A", 1)}\n`);
    assert.throws(() => mergeJsonlRows("", "", ["nope"]), /找不到/);
  });

  it(".jsonl 主键字段名 id / unitId 同样认（INC-0165）", () => {
    const { cwd, git, msg } = repo();
    mkdirSync(join(cwd, "docs"));
    const p = join(cwd, "docs", "incidents.jsonl");
    // 事故台账的主键叫 id，不叫 entity_id；早先写死 entity_id 时这里必报「找不到」。
    const inc = (id: string, v: number) => JSON.stringify({ id, v });
    writeFileSync(p, [inc("INC-0001", 0), inc("INC-0002", 0)].join("\n") + "\n");
    git("add", "docs/incidents.jsonl");
    git("commit", "-q", "-m", "ledger");
    // 工作区：我加了 INC-0003，别的会话同期加了 INC-0004
    writeFileSync(p, [inc("INC-0001", 0), inc("INC-0002", 0), inc("INC-0004", 9), inc("INC-0003", 1)].join("\n") + "\n");
    commitOwn({ cwd, messageFile: msg, paths: [], jsonl: [{ path: "docs/incidents.jsonl", ids: ["INC-0003"] }], hook: null });
    assert.equal(
      git("show", "HEAD:docs/incidents.jsonl"),
      [inc("INC-0001", 0), inc("INC-0002", 0), inc("INC-0003", 1)].join("\n"),
      "只带自己那一行，别人的 INC-0004 留在工作区不进提交",
    );
    const unit = (unitId: string, v: number) => JSON.stringify({ unitId, v });
    assert.equal(mergeJsonlRows(`${unit("U1", 0)}\n`, `${unit("U1", 1)}\n`, ["U1"]), `${unit("U1", 1)}\n`);
  });

  it(".jsonl 里的 // 注释行原序保留，不因为不是 JSON 就把合并打断", () => {
    // evals/risk/cases.jsonl 一类台账开头有两行 `//` 说明；早先 JSON.parse 直接抛。
    const head = `// 红队样本集\n${JSON.stringify({ id: "R1", v: 0 })}\n`;
    const work = `// 红队样本集\n${JSON.stringify({ id: "R1", v: 1 })}\n`;
    assert.equal(mergeJsonlRows(head, work, ["R1"]), work);
  });
});
