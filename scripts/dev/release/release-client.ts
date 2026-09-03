/**
 * 客户端发版：把一个端的三处版本号一起推上去，并生成它自己的 CHANGELOG。
 *
 *   corepack pnpm release:client cockpit patch      # 0.1.0 → 0.1.1
 *   corepack pnpm release:client mobile  minor      # 0.1.0 → 0.2.0
 *   corepack pnpm release:client cockpit 1.0.0      # 指定版本
 *   corepack pnpm release:client cockpit patch --commit   # 顺便提交并打 tag
 *
 * # 为什么客户端要有自己的版本线
 *
 * 根 `package.json` 的 `v0.2.0` 记的是服务端与整仓的节奏。客户端不随服务端
 * 每次上线而发版——车机与手机走各自的分发通道（当前是 TestFlight），
 * 一次服务端热修不该让车主看到一个新版本号。所以两条线从 2026-09-02 起分开：
 * **本脚本只动 `apps/<端>` 下那三个文件，永远不碰根版本号。**
 *
 * # 为什么必须有这个脚本
 *
 * 版本号散在三处（`package.json` / `tauri.conf.json` / `Cargo.toml`），
 * 手工改漏一处不会报错，只会让 About 面板与崩溃报告写着两个数字。
 * `check:versions` 会拦住这种状态，而本脚本是让它不必被拦的那条路。
 *
 * # 它不做的事
 *
 * 不接自动更新（Tauri updater 只覆盖桌面，而两个端的真实交付形态是 iPad/iOS 的
 * TestFlight）。将来要接时，分发端点已定方向：网关出只读端点 + 现有 S3/MinIO，
 * 不用 GitHub Releases——private 仓库会逼客户端揣一把 token，那与端云边界相悖。
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

import { CLIENTS, readClientVersions, checkOne, type ClientName } from "../check/check-client-versions";

const ROOT = new URL("../../../", import.meta.url);
const path = (rel: string): string => new URL(rel, ROOT).pathname;

/**
 * 一个端的"代码面"。CHANGELOG 从这些路径的提交里生成——
 * 客户端不只有 `apps/<端>`：`clients/shared/ui` 的组件、`clients/shared/rust/` 的 Rust 层
 * 同样会随安装包发出去，漏掉它们的 CHANGELOG 会是一份不诚实的清单。
 */
// ACR-020 之后只剩两条：clients/ 整棵（含另一个端——它的提交也可能改到共享层，
// 宁可多列不可漏列）与 contracts/。目录开始自己说话，清单不再需要逐个包列。
const clientPaths = (_app: ClientName): string[] => ["clients", "contracts"];

export function bump(current: string, spec: string): string {
  if (/^\d+\.\d+\.\d+$/.test(spec)) return spec;
  const [major, minor, patch] = current.split(".").map(Number);
  if (spec === "major") return `${major + 1}.0.0`;
  if (spec === "minor") return `${major}.${minor + 1}.0`;
  if (spec === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`版本参数只能是 patch / minor / major / X.Y.Z，收到 ${spec}`);
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: path("."), encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** 上一个该端的 tag（`<端>-vX.Y.Z`）。没有就回 undefined，CHANGELOG 退回"首个版本"。 */
function lastTagOf(app: ClientName): string | undefined {
  const tags = git(["tag", "--list", `${app}-v*`, "--sort=-v:refname"]).split("\n").filter(Boolean);
  return tags[0];
}

function commitsSince(app: ClientName, tag: string | undefined): string[] {
  const range = tag ? `${tag}..HEAD` : "HEAD";
  const out = git(["log", range, "--no-merges", "--format=%s", "--", ...clientPaths(app)]);
  return out ? out.split("\n").filter(Boolean) : [];
}

function writeJsonVersion(rel: string, version: string): void {
  const p = path(rel);
  const text = readFileSync(p, "utf8");
  // 只替换顶层 "version"：整份 JSON.parse + stringify 会重排字段与缩进，
  // 让 diff 变成整文件——那样谁也看不出这次发版到底改了什么。
  const next = text.replace(/^(\s*"version"\s*:\s*)"[^"]+"/m, `$1"${version}"`);
  if (next === text) throw new Error(`${rel} 里没找到顶层 version 字段`);
  writeFileSync(p, next);
}

function writeCargoVersion(rel: string, version: string): void {
  const p = path(rel);
  const text = readFileSync(p, "utf8");
  // 只改 `[package]` 段里的第一处——依赖项里也有 version=，替错了会静默换掉依赖版本。
  const pkg = /^\[package\]\s*$/m.exec(text);
  if (!pkg) throw new Error(`${rel} 里没有 [package] 段`);
  const head = text.slice(0, pkg.index + pkg[0].length);
  const rest = text.slice(pkg.index + pkg[0].length);
  const next = rest.replace(/^(\s*version\s*=\s*)"[^"]+"/m, `$1"${version}"`);
  if (next === rest) throw new Error(`${rel} 的 [package] 段里没找到 version`);
  writeFileSync(p, head + next);
}

/**
 * 首个版本的段落**不倾倒全部历史**。
 *
 * 没有上一个 tag 时，`git log HEAD -- <客户端路径>` 会吐出这个端从第一天起的
 * 全部提交（实测 197 条）。一份 197 行的"更新记录"没有任何人会读，
 * 而且它描述的不是"这一版改了什么"——那一版就是全部。所以首版只写清
 * 这条线从哪里开始，并留下查历史的命令。
 */
function firstVersionBody(app: ClientName, count: number): string {
  return (
    `- 客户端独立版本线从这一版开始。在此之前 ${app} 的版本号跟随仓库根，` +
    `而两者的发布节奏并不一致（服务端一次热修不该让车主看到新版本号）。\n` +
    `- 这一版之前的 ${count} 条客户端提交不在此逐条列出——那是这个端的全部历史，` +
    `不是"这一版的变化"。要看：\`git log -- ${clientPaths(app).join(" ")}\``
  );
}

function updateChangelog(
  app: ClientName,
  version: string,
  today: string,
  lines: string[],
  isFirst: boolean,
): string {
  const rel = `clients/${app}/CHANGELOG.md`;
  const p = path(rel);
  const header = `# ${app} 更新记录\n\n> 这个端有自己的版本线，与仓库根的版本号无关（见 \`scripts/dev/release/release-client.ts\`）。\n> 条目由发版脚本从 \`${clientPaths(app).join("\` / \`")}\` 的提交生成——\n> 客户端不只有 \`clients/${app}\`，共享的 UI 与 Rust 层同样随安装包发出去。\n`;
  const body = isFirst
    ? firstVersionBody(app, lines.length)
    : lines.length > 0
      ? lines.map((l) => `- ${l}`).join("\n")
      : "- （这一版没有落在客户端代码面上的提交）";
  const section = `\n## ${version} — ${today}\n\n${body}\n`;

  if (!existsSync(p)) {
    writeFileSync(p, header + section);
    return rel;
  }
  const text = readFileSync(p, "utf8");
  const at = text.indexOf("\n## ");
  const next = at >= 0 ? text.slice(0, at) + section + text.slice(at) : text + section;
  writeFileSync(p, next);
  return rel;
}

function main(): void {
  const [appArg, spec, ...flags] = process.argv.slice(2);
  const dryRun = flags.includes("--dry-run");
  const doCommit = flags.includes("--commit");

  if (!appArg || !spec) {
    console.error("用法：release:client <" + CLIENTS.join("|") + "> <patch|minor|major|X.Y.Z> [--commit] [--dry-run]");
    process.exit(2);
  }
  if (!CLIENTS.includes(appArg as ClientName)) {
    console.error(`未知的端 ${appArg}——受管的是 ${CLIENTS.join(" / ")}`);
    process.exit(2);
  }
  const app = appArg as ClientName;

  // 起手先自检：三处本来就不一致的话，先修一致再发版，
  // 否则这一次发版会把不一致"洗"成一致，掩盖掉之前漏改的那一处。
  const sources = readClientVersions(app);
  const issues = checkOne(app, sources);
  if (issues.length > 0) {
    console.error(`✗ ${app} 当前版本号本身就有问题，先修再发：`);
    for (const i of issues) console.error(`    ${i.detail}`);
    process.exit(1);
  }

  const current = sources[0].version!;
  const next = bump(current, spec);
  const tag = `${app}-v${next}`;
  if (git(["tag", "--list", tag])) {
    console.error(`✗ tag ${tag} 已存在——版本号一经发布不复用`);
    process.exit(1);
  }

  const lastTag = lastTagOf(app);
  const lines = commitsSince(app, lastTag);
  /*
   * **本地日期，不是 UTC**。`toISOString()` 在东八区的傍晚之后会回退一天——
   * CHANGELOG 上的日期比发版当天早一天，对不上任何人的记忆，
   * 而这种错只在特定时段出现，最难被发现。
   */
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  console.log(`${app}：${current} → ${next}（tag ${tag}）`);
  console.log(`  上一个 tag：${lastTag ?? "无——这是该端的第一个版本"}`);
  console.log(`  客户端代码面上的提交：${lines.length} 条`);

  if (dryRun) {
    console.log("\n--dry-run：不写任何文件。将写入的 CHANGELOG 段落：\n");
    console.log(`## ${next} — ${today}\n`);
    if (lastTag === undefined) {
      console.log(firstVersionBody(app, lines.length));
    } else {
      for (const l of lines.slice(0, 20)) console.log(`- ${l}`);
      if (lines.length > 20) console.log(`- …另有 ${lines.length - 20} 条`);
    }
    return;
  }

  writeJsonVersion(`clients/${app}/package.json`, next);
  writeJsonVersion(`clients/${app}/src-tauri/tauri.conf.json`, next);
  writeCargoVersion(`clients/${app}/src-tauri/Cargo.toml`, next);
  const changelog = updateChangelog(app, next, today, lines, lastTag === undefined);

  const touched = [
    `clients/${app}/package.json`,
    `clients/${app}/src-tauri/tauri.conf.json`,
    `clients/${app}/src-tauri/Cargo.toml`,
    changelog,
  ];
  console.log(`\n✓ 已写入：\n${touched.map((t) => `    ${t}`).join("\n")}`);

  /*
   * **pathspec 提交，不用裸 git commit**：这个仓库常有并发会话，
   * index 是共享的，裸 commit 会把别人 stage 的东西一起带走
   * （2026-09-01 真踩过一次，记在 ACR-018 里）。
   */
  const addCmd = `git add ${touched.join(" ")}`;
  const commitCmd = `git commit -m "chore(${app}): 发版 ${next}" -- ${touched.join(" ")}`;
  const tagCmd = `git tag ${tag}`;

  if (doCommit) {
    execFileSync("bash", ["-c", `${addCmd} && ${commitCmd} && ${tagCmd}`], {
      cwd: path("."),
      stdio: "inherit",
    });
    console.log(`\n✓ 已提交并打上 tag ${tag}`);
    return;
  }
  console.log(`\n下一步（脚本刻意不替你执行，除非加 --commit）：`);
  console.log(`    ${addCmd}`);
  console.log(`    ${commitCmd}`);
  console.log(`    ${tagCmd}`);
}

/*
 * 被单测 import 时不执行 main——否则 `import { bump }` 会顺手发一次版。
 * 判据与 `check-client-versions.ts` 同款：看进程入口是不是本文件。
 */
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith("release-client.ts");
if (invokedDirectly) main();
