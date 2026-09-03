/**
 * `dev:upgrade` 的编排契约。
 *
 * 这类测试不启动 Docker 或 Tauri；它锁住最容易被后来维护者调换的顺序与安全边界：
 * 先安装/生成/构建，成功后才收拢旧实例；收拢过程不能带删除数据卷的参数。
 */

import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { describe, it } from "node:test";

const script = readFileSync(new URL("./dev-upgrade.sh", import.meta.url), "utf8");
const upgradeLib = readFileSync(new URL("./dev-upgrade-lib.sh", import.meta.url), "utf8");
const implementation = `${script}\n${upgradeLib}`;
const devScript = readFileSync(new URL("./dev.sh", import.meta.url), "utf8");
const bootstrap = readFileSync(new URL("./dev-bootstrap.sh", import.meta.url), "utf8");
const readiness = readFileSync(new URL("./dev-readiness.mjs", import.meta.url), "utf8");
const packageJson = readFileSync(new URL("../../package.json", import.meta.url), "utf8");

function position(fragment: string): number {
  const index = implementation.indexOf(fragment);
  assert.notEqual(index, -1, `缺少编排步骤：${fragment}`);
  return index;
}

describe("合并后升级入口", () => {
  it("根命令入口指向同一个可执行脚本", () => {
    assert.match(packageJson, /"dev:upgrade":\s*"bash infra\/scripts\/dev-upgrade\.sh"/);
    assert.match(script, /用法：corepack pnpm dev:upgrade/);
    assert.match(script, /source \"\$SCRIPT_DIR\/dev-upgrade-lib\.sh\"/);
  });

  it("先安装、生成和构建，成功后才停止旧实例并启动 bootstrap", () => {
    const install = position("corepack pnpm install --frozen-lockfile");
    const generate = position("corepack pnpm --filter @carlife/db db:generate");
    const build = position("corepack pnpm build:all");
    const composeDown = position("bash \"$ROOT/infra/scripts/down.sh\"");
    const hostStop = position("bash \"$ROOT/infra/scripts/dev.sh\" stop all");
    const bootstrap = position("run_bootstrap\n\nCURRENT_STAGE=\"检查进程监护层\"");
    const status = position("bash \"$ROOT/infra/scripts/dev.sh\" status");

    assert.ok(install < generate);
    assert.ok(generate < build);
    assert.ok(build < composeDown);
    assert.ok(composeDown < hostStop);
    assert.ok(hostStop < bootstrap);
    assert.ok(bootstrap < status);
    assert.match(implementation, /bash \"\$ROOT\/infra\/scripts\/dev-bootstrap\.sh\"/);
  });

  it("不包含删除数据卷的路径，并且脚本可执行", () => {
    assert.doesNotMatch(implementation, /^\s*(?:docker\s+volume\s+rm|.*down\s+-v).*$/m);
    assert.doesNotMatch(implementation, /^\s*(?:bash\s+.*down\.sh).*--volumes.*$/m);
    assert.ok((statSync(new URL("./dev-upgrade.sh", import.meta.url)).mode & 0o111) !== 0);
  });

  it("Docker Desktop 自动启动有明确的有限等待窗口", () => {
    assert.match(implementation, /docker desktop start --detach/);
    assert.match(implementation, /while \(\( attempt <= 30 \)\)/);
    assert.match(implementation, /本次未停止旧服务/);
  });

  it("在可用时使用独立 tmux 会话托管宿主服务，并为 bootstrap 留退出码", () => {
    assert.match(implementation, /tmux new-session -d -s \"\$DEV_SESSION\"/);
    assert.match(implementation, /BOOTSTRAP_STATUS/);
    assert.match(implementation, /bootstrap 超过 \$\{BOOTSTRAP_TIMEOUT\}s 未完成/);
    assert.match(implementation, /无法创建 tmux 会话，退回直接启动/);
  });

  it("**tmux 里跑的必须是外层刚验过的那个解释器**——非登录 shell + 显式 PATH", () => {
    // `bash -lc` 会重跑 path_helper 把 /usr/local/bin 顶到最前，fnm/nvm/mise 管的
    // node 被系统 node 盖掉：外层闸门放行 v24.20.0，pane 里却是别的版本，
    // dev-bootstrap 的 require_supported_node 在 build:all 跑完之后才判死。
    assert.doesNotMatch(implementation, /tmux new-session[\s\S]{0,200}?bash -lc/);
    assert.match(implementation, /tmux new-session[\s\S]{0,200}?bash -c '/);
    // tmux server 已在跑时新 pane 继承的是 server 的环境，PATH 必须显式压进去。
    assert.match(implementation, /tmux new-session[\s\S]{0,120}?-e PATH=\"\$PATH\"/);
  });

  it("bootstrap 等待上限可配置，且默认留得下冷机器拉镜像的时间", () => {
    assert.match(implementation, /BOOTSTRAP_TIMEOUT=\"\$\{CARLIFE_DEV_UPGRADE_BOOTSTRAP_TIMEOUT:-(\d+)\}\"/);
    const seconds = Number(/BOOTSTRAP_TIMEOUT=\"\$\{CARLIFE_DEV_UPGRADE_BOOTSTRAP_TIMEOUT:-(\d+)\}\"/.exec(implementation)![1]);
    assert.ok(seconds >= 600, `默认 ${seconds}s 不够冷机器拉 PG/Redis/MinIO 镜像`);
    assert.match(implementation, /deadline=\$\(\( \$\(date \+%s\) \+ BOOTSTRAP_TIMEOUT \)\)/);
  });

  it("不替用户改写 Git 历史", () => {
    assert.doesNotMatch(implementation, /^\s*git\s+(pull|merge|reset|checkout)\b/m);
  });

  it("默认宿主启动集合包含 worker，readiness 锁住四类任务", () => {
    assert.match(devScript, /DEFAULT_TARGETS=.*worker/);
    assert.match(bootstrap, /bash .*dev\.sh\" restart/);
    for (const job of ["usage-aggregation", "kb-sync", "memory-decay", "vehicle-reminder"]) {
      assert.match(readiness, new RegExp(`\\"${job}\\"`));
    }
    assert.match(readiness, /WORKER_HEALTH_URL/);
  });
});
