/**
 * mpg123 后端的协议解析 —— 用一个**假的 mpg123** 复现真机上的时序。
 *
 * # 为什么值得单独一个文件
 *
 * `media.test.ts` 跑的是静音后端，它永远不会汇报"这一曲播完了"，
 * 所以**队列自动推进这条路径它一条都覆盖不到**。而这条路径上已经踩过一次坑：
 *
 *   mpg123 自然播完会连发 `@P 3`（本曲结束）和 `@P 0`（停止）两条，
 *   它们是同一次结束的两种说法。各算一次的话，一次播完连跳两首；
 *   两首歌的队列正好绕回原点，现场表现是「第一首反复重放」——
 *   看起来像 repeat 设错了，根因却在协议解析里。
 *
 * 更阴的是**两条可能落在不同的 stdout 分片里**，中间隔着一个事件循环回合。
 * 第一版修法（进程内标志去重）在同一分片下是对的，分开就漏——所以这里的假
 * mpg123 刻意**分两次 write 并跨 tick**，把当时漏掉的那个时序钉死。
 *
 * 真机上出没出声不归这里管（那要靠 §能力上报 与人肉验）。这里只管：
 * 收到这串字节之后，队列该走到哪一格。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

const fakeBinDir = mkdtempSync(join(tmpdir(), "mock-cabin-bin-"));
const fixtureDir = mkdtempSync(join(tmpdir(), "mock-cabin-media2-"));

/**
 * 假 mpg123：只实现遥控协议里我们真正依赖的那几条。「一曲」压成 120ms。
 *
 * `MOCK_FAKE_END_LIMIT` 控制**前几次 LOAD 会自然播完**，之后的一律放着不结束。
 * 这一笔是必须的：让每一曲都循环播完的话，「跳一格」和「跳两格」在
 * repeat=all 下会走到同一个游标上，测试就分辨不出 bug 有没有回来。
 * 限死结束次数，终态才是唯一的。
 */
const FAKE = `#!/usr/bin/env node
const LIMIT = Number(process.env.MOCK_FAKE_END_LIMIT ?? "99");
let ended = 0;
process.stdout.write("@R MPG123 (fake)\\n");
let timer = null;
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  const lines = buf.split("\\n");
  buf = lines.pop();
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("LOAD ")) {
      if (timer) clearTimeout(timer);
      process.stdout.write("@P 2\\n");
      process.stdout.write("@F 1 100 0.03 0.09\\n");
      if (ended >= LIMIT) continue;
      ended += 1;
      timer = setTimeout(() => {
        // 真机实测的时序：先 @P 3，**再单独一次 write 且跨一个 tick** 发 @P 0。
        process.stdout.write("@P 3\\n");
        setImmediate(() => process.stdout.write("@P 0\\n"));
      }, 120);
    } else if (line === "STOP") {
      if (timer) clearTimeout(timer);
      process.stdout.write("@P 0\\n");
    } else if (line === "QUIT") {
      process.exit(0);
    }
  }
});
`;

process.env.MOCK_CABIN_AUDIO = "mpg123";
process.env.MOCK_CABIN_MEDIA_DIR = fixtureDir;
writeFileSync(join(fakeBinDir, "mpg123"), FAKE);
chmodSync(join(fakeBinDir, "mpg123"), 0o755);
// 探测与 spawn 都走 PATH，所以前置一个目录就能把真 mpg123 换掉。
process.env.PATH = `${fakeBinDir}:${process.env.PATH ?? ""}`;

const { createCabinServer, __resetAll, __resetPlayers } = await import("../src/index");

let server: Server;
let base = "";

before(async () => {
  writeFileSync(join(fixtureDir, "队列 - 第一首.mp3"), "");
  writeFileSync(join(fixtureDir, "队列 - 第二首.mp3"), "");
  server = createCabinServer();
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(() => {
  server.close();
  __resetPlayers();
  __resetAll();
  rmSync(fakeBinDir, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
});

const post = async (path: string, body: unknown) => {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const view = async (id: string) =>
  (await (await fetch(`${base}/vehicles/${id}/media/player`)).json()) as Record<string, any>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询到期望状态。**不要用固定 sleep 等它**：`node --test` 是多文件并行跑的，
 * 每个文件还各自 spawn 子进程，固定等待在并行负载下会偶发不够——
 * 而这条用例钉的是一个真 bug，它变 flaky 之后人只会去调大等待时间，
 * 下一次真的回归就被当成又一次 flaky 划过去了。
 *
 * 正确态和 bug 态都是**稳定终态**（END_LIMIT 限死了结束次数），所以等得起。
 */
async function waitUntil(
  probe: () => Promise<Record<string, any>>,
  ok: (v: Record<string, any>) => boolean,
  timeoutMs = 6_000,
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  let last = await probe();
  while (!ok(last) && Date.now() < deadline) {
    await sleep(25);
    last = await probe();
  }
  return last;
}

describe("mpg123 后端：一次播完只推进一格", () => {
  it("`@P 3` + 跨 tick 的 `@P 0` 只算一次结束（连跳两首的回归）", async () => {
    // 只让第一首自然播完，终态才唯一：跳一格停在 1，跳两格会绕回 0。
    process.env.MOCK_FAKE_END_LIMIT = "1";
    const id = (await post("/vehicles", { model: "Model Y" })).body.vehicleId as string;
    await post(`/vehicles/${id}/media/player`, { command: "select", query: "队列" });

    const start = await view(id);
    assert.equal(start.queue.length, 2);
    assert.equal(start.cursor, 0);
    assert.equal(start.backend.name, "mpg123");

    // 只有第一首会自然播完，所以正确态（停在 1）与 bug 态（绕回 0）都是稳定终态。
    const after1 = await waitUntil(() => view(id), (v) => v.cursor === 1);
    assert.equal(
      after1.cursor,
      1,
      "播完一首应当停在第 2 首；跳回 0 说明 @P 3 与 @P 0 被当成了两次结束",
    );
    // 再确认它**停住了**：bug 态里 cursor 会瞬间掠过 1 再回到 0，
    // 只看一眼可能正好看到那一瞬。
    await sleep(300);
    assert.equal((await view(id)).cursor, 1, "停在第 2 首之后不该再动——第 2 首不会自然播完");
    // 按队列里的第 2 首比，不写死曲名：曲库是按中文拼音排序的
    // （"第二首" 的 èr 排在 "第一首" 的 yī 前面），写死会挂在排序上而不是 bug 上。
    assert.equal(after1.nowPlaying.title, start.queue[1].title);
  });

  it("repeat=off 时放完最后一首就停，不回卷", async () => {
    process.env.MOCK_FAKE_END_LIMIT = "2";
    const id = (await post("/vehicles", { model: "Model Y" })).body.vehicleId as string;
    await post(`/vehicles/${id}/media/player`, { command: "mode", repeat: "off" });
    await post(`/vehicles/${id}/media/player`, { command: "select", query: "队列" });
    const v = await waitUntil(() => view(id), (x) => x.status === "stopped");
    assert.equal(v.status, "stopped");
    // 停下来了就要把媒体源关回去，别让 UI 显示还在放。
    assert.equal(v.source, "off");
  });

  it("主动 stop 的 `@P 0` 不算播完，不会顺势跳下一首", async () => {
    process.env.MOCK_FAKE_END_LIMIT = "0"; // 不让它自然结束，停下来只可能是 stop 干的
    const id = (await post("/vehicles", { model: "Model Y" })).body.vehicleId as string;
    await post(`/vehicles/${id}/media/player`, { command: "select", query: "队列" });
    await post(`/vehicles/${id}/media/player`, { command: "stop" });
    await sleep(300);
    const v = await view(id);
    assert.equal(v.status, "stopped");
    assert.equal(v.cursor, 0, "stop 不该顺手推进游标");
  });

  it("有 mpg123 时能力表报「暂停可续播 + 音量实时」", async () => {
    const r = await (await fetch(`${base}/health`)).json();
    assert.equal(r.audio.backend, "mpg123");
    assert.equal(r.audio.canPauseResume, true);
    assert.equal(r.audio.canSetVolumeLive, true);
  });
});
