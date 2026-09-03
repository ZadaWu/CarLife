/**
 * pi 侧工具允许清单（施工单 M23-01）。
 *
 * 守两件事：
 * 1. `toolListFor` 与 `listForAgent` 同源——ACL 的第四份手写清单永远不许出现。
 * 2. 包装脚本 `bin/pi-approved.sh` 把三个 env 正确转成 CLI 参数，尤其是
 *    **空清单不得变成 `--tools ""`**（"允许零个工具"= 整个 Agent 无声哑掉）。
 *
 * 脚本用假 pi 替身验 argv，不真起 pi——这里测的是拼参数，不是 pi 的行为
 * （pi 对 `-nbt`/`--tools` 的行为已于 2026-08-25 实测，见工单 M23-01 约束 1）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { listForAgent } from "@carlife/tools";

import { toolListFor } from "../src/acp-client/connection";
import { loadAgentPrompt } from "../src/acp-client/agent-prompt";

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = resolve(HERE, "../../pi-agents/bin/pi-approved.sh");

describe("toolListFor：与 listForAgent 同源", () => {
  it("drive 的清单逐字等于 listForAgent（含 78c4db3 补的五个）", () => {
    assert.equal(toolListFor("drive"), listForAgent("drive").map((t) => t.name).join(","));
    for (const n of ["map_route", "weather", "refuel", "charging", "transit_route"]) {
      assert.ok(toolListFor("drive").split(",").includes(n), `drive 清单缺 ${n}`);
    }
  });

  it("会话后缀走规范名：trip-task ≡ trip", () => {
    assert.equal(toolListFor("trip-task"), toolListFor("trip"));
    assert.ok(toolListFor("trip").length > 0);
  });

  it("全部十一个 Agent 的清单非空且无空项", () => {
    for (const a of [
      "supervisor", "buying", "ownership", "trip", "cabin", "service",
      "test-drive", "drive", "hotel", "tour", "transit",
    ]) {
      const list = toolListFor(a);
      assert.ok(list.length > 0, `${a} 清单为空——包装脚本会因此退到扩展工具全量`);
      assert.ok(!list.split(",").some((n) => !n.trim()), `${a} 清单含空项：${list}`);
    }
  });
});

describe("pi-approved.sh：env → argv", () => {
  /** 用假 pi 捕获 argv。返回按行拆开的参数数组。 */
  function argvWith(env: Record<string, string>): string[] {
    const dir = mkdtempSync(join(tmpdir(), "pi-argv-"));
    const out = join(dir, "argv.txt");
    const fixtureRoot = join(dir, "pi-agents");
    const fixtureBin = join(fixtureRoot, "bin");
    const fixtureNodeBin = join(fixtureRoot, "node_modules/.bin");
    mkdirSync(fixtureBin, { recursive: true });
    mkdirSync(fixtureNodeBin, { recursive: true });

    // 复制真实 wrapper，并在它相邻的 node_modules/.bin 放假 pi；这样测试守的是
    // 「wrapper 必须走项目本地入口」这个契约，而不是旧的 PATH 假设。
    const fixtureWrapper = join(fixtureBin, "pi-approved.sh");
    copyFileSync(WRAPPER, fixtureWrapper);
    chmodSync(fixtureWrapper, 0o755);

    // PATH 里的另一个假 pi 代表使用者的全局安装。若 wrapper 错误回退到 PATH，
    // 它会以失败码退出，测试也就明确暴露隔离被破坏。
    const globalPi = join(dir, "pi");
    writeFileSync(globalPi, "#!/bin/sh\nexit 99\n");
    chmodSync(globalPi, 0o755);

    // 本地假 pi：把收到的参数以 NUL 分隔写盘后退出——prompt 是多行文本，
    // 换行分隔会把一个参数拆成多个（这个测试自己先踩了一遍）。
    const localPi = join(fixtureNodeBin, "pi");
    writeFileSync(localPi, `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a" >> "${out}"; done\n`);
    chmodSync(localPi, 0o755);
    execFileSync("sh", [fixtureWrapper, "--mode", "rpc"], {
      env: { ...process.env, ...env, PATH: `${dir}:${process.env.PATH ?? ""}` },
    });
    return readFileSync(out, "utf8").split("\0").filter(Boolean);
  }

  it("--no-builtin-tools 无条件在场", () => {
    assert.ok(argvWith({}).includes("--no-builtin-tools"));
    assert.ok(argvWith({ CARLIFE_PI_TOOLS: "weather" }).includes("--no-builtin-tools"));
  });

  it("项目运行时关闭 pi 启动版本检查，不依赖全局设置", () => {
    const wrapper = readFileSync(WRAPPER, "utf8");
    assert.match(
      wrapper,
      /export PI_SKIP_VERSION_CHECK=1/,
      "项目 wrapper 必须显式关闭 pi.dev 启动版本检查",
    );
    assert.match(
      wrapper,
      /export PI_OFFLINE=1/,
      "项目 wrapper 必须关闭 pi 的其它启动联网动作",
    );
  });

  it("pi-acp 旁路的裸版本探针不应拿到版本", () => {
    const shim = resolve(HERE, "../../pi-agents/bin/pi");
    const result = execFileSync("sh", [shim, "--version"], { encoding: "utf8" });
    assert.equal(result, "");
  });

  it("清单非空 → --tools <清单>，值逐字到达", () => {
    const argv = argvWith({ CARLIFE_PI_TOOLS: "weather,map_route" });
    const i = argv.indexOf("--tools");
    assert.ok(i >= 0);
    assert.equal(argv[i + 1], "weather,map_route");
  });

  it("**空清单不加 --tools**（未设与空串两种形态）", () => {
    for (const env of [{}, { CARLIFE_PI_TOOLS: "" }]) {
      const argv = argvWith(env);
      assert.ok(!argv.includes("--tools"), `env=${JSON.stringify(env)} 时出现了 --tools`);
    }
  });

  it("CARLIFE_PI_APPEND_PROMPT → --append-system-prompt，真实 prompt 文件逐字到达（M23-02）", () => {
    // 用 trip.md 的真实内容当载荷：它含反引号、中文引号、表格竖线——正是最容易
    // 在 sh 链路里被二次展开或截断的那类字符。逐字相等 = 约束 2 的机械化版本。
    const prompt = loadAgentPrompt("trip");
    const argv = argvWith({ CARLIFE_PI_APPEND_PROMPT: prompt });
    const i = argv.indexOf("--append-system-prompt");
    assert.ok(i >= 0);
    assert.equal(argv[i + 1], prompt, "prompt 未逐字到达 argv");
  });

  it("CARLIFE_PI_APPEND_PROMPT 为空 → 不加参数（回退形态 = pi 默认系统提示词）", () => {
    for (const env of [{}, { CARLIFE_PI_APPEND_PROMPT: "" }]) {
      assert.ok(!argvWith(env).includes("--append-system-prompt"));
    }
  });

  it("与 --model 组合：各参数成对、pi-acp 的透传参数殿后", () => {
    const argv = argvWith({ CARLIFE_PI_TOOLS: "weather", CARLIFE_PI_MODEL: "deepseek/x:off" });
    assert.deepEqual(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2), ["--model", "deepseek/x:off"]);
    assert.deepEqual(argv.slice(-2), ["--mode", "rpc"], "pi-acp 追加的参数必须留在末尾");
    assert.ok(argv.includes("--approve"));
  });
});
