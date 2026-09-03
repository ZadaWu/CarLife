/**
 * 落盘：车、id、设置、流水都要活得比进程长。
 *
 * 这组用例**真的开子进程**（`restart-driver.ts`），因为"重启后还在"是这次改动
 * 的全部价值，而同进程里重新 import 会命中模块缓存，测出来的绿是假的。
 *
 * 盯四件事：
 *  1. 车本身要在——只存流水不存车的话，上游 `withVehicle()` 会当成 vehicle_not_found
 *     重新造一辆、拿到新 id，旧流水就成了没有车的孤儿。
 *  2. 发号器不能倒流——重号会让第二辆车顶掉第一辆车的历史。
 *  3. 快照坏掉不能让服务起不来——车机起不来在演示里等同于"这功能是假的"。
 *  4. `CABIN_PERSIST=off` 时一个字节都不许写——测试与仓库都不该被污染。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DRIVER = join(HERE, "restart-driver.ts");
const PKG = join(HERE, "..");

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mock-cabin-persist-"));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * 跑一次「进程」，取出驱动打的结果行。
 *
 * 不能直接 JSON.parse 整个 stdout：服务启动时会打一行"已从 … 恢复 N 辆车"，
 * 那是它该有的日志。CABIN_PERSIST 显式置空——包脚本把它设成了 off。
 */
function boot(file: string, args: string[], extraEnv: Record<string, string> = {}): any {
  const out = execFileSync(process.execPath, ["--import", "tsx", DRIVER, ...args], {
    cwd: PKG,
    encoding: "utf8",
    env: { ...process.env, CABIN_PERSIST: "", CABIN_DATA_FILE: file, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const line = out.split("\n").find((l) => l.startsWith("__RESULT__"));
  assert.ok(line, `驱动没有输出结果行；stdout=${out}`);
  return JSON.parse(line.slice("__RESULT__".length));
}

describe("重启之后", () => {
  it("同一辆车、同一个 id、同一段流水都还在", () => {
    const file = join(freshDir(), "state.json");

    const first = boot(file, ["write"]) as { id: string; changes: number };
    assert.equal(first.id, "VEH-000001");
    assert.ok(first.changes > 0, "第一程应该产生变更流水");
    assert.ok(existsSync(file), "退出时应该已经把快照写到磁盘");

    const second = boot(file, ["read", first.id]) as Record<string, any>;
    assert.equal(second.found, true, "重启后这辆车必须还在——否则上游会另造一辆，旧流水成孤儿");
    assert.equal(second.model, "Model Y");
    assert.equal(second.tempC, 25, "设置值要原样回来，不是回到出厂默认 22");
    assert.deepEqual(second.media, { source: "kids", volume: 20, volumeLimit: 35, contentTag: "儿歌" });
    assert.equal(second.changes, first.changes, "流水条数不能变");
  });

  it("发号器不倒流：下一辆车不会顶掉上一辆的 id", () => {
    const file = join(freshDir(), "state.json");
    const first = boot(file, ["write"]) as { id: string };
    const second = boot(file, ["read", first.id]) as { nextVehicleId: string; maxSeq: number };
    assert.equal(second.nextVehicleId, "VEH-000002", "重启后重新从 000001 发号就会覆盖已有的车");
    assert.ok(second.maxSeq > 0, "changeSeq 也要接着走，不然后台时间线的排序会错乱");
  });

  it("快照坏了照常启动，并把坏文件留证", () => {
    const dir = freshDir();
    const file = join(dir, "state.json");
    writeFileSync(file, "{ 这不是 JSON", "utf8");

    const out = boot(file, ["write"]) as { id: string };
    assert.equal(out.id, "VEH-000001", "坏快照应当被跳过并从空白开始，而不是让进程崩掉");

    const broken = readFileSync(file, "utf8");
    assert.doesNotThrow(() => JSON.parse(broken), "坏文件应已被改名让位，正名重新写成合法快照");
  });

  it("CABIN_PERSIST=off 时不写任何文件", () => {
    const file = join(freshDir(), "state.json");
    boot(file, ["write"], { CABIN_PERSIST: "off" });
    assert.equal(existsSync(file), false, "关掉落盘还写盘的话，测试之间会互相污染");
  });
});
