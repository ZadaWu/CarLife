/**
 * 底座的三处"第二个应用接上才会发作"的耦合（施工单 M88-01，变更单 ACR-038 步 1）。
 *
 * 三处的共同形状是**零报错**：用研面加载了车主面的扩展、扩展回调到了车主面的
 * 工具端点、用量行记成了车主面的模型名——跑起来一切正常，只是模型手里全是
 * 别人的东西。所以判据只能钉在"解析出来的目录/变量到底是哪个"上，
 * 而不能指望某一步抛错。
 *
 * 这里全部直测纯函数：`resolvePiCommands` 不碰文件系统（存在性检查留在
 * `connect()` 里），`spawnEnvFor` 不 spawn，于是不需要真的把 pi 起起来。
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, beforeEach } from "node:test";

import type { AcpApp, AcpTracer } from "../src/app";
import {
  piDefaultModel,
  resetPiModelCacheForTests,
  resolvePiCommands,
  spawnEnvFor,
} from "../src/connection";

const PI_ACP = process.platform === "win32" ? "pi-acp.cmd" : "pi-acp";

const noopTracer: AcpTracer = {
  span: (_t, _n, fn) => fn(),
  recordSpan: () => {},
  recordPrompt: () => {},
  cancelled: (m) => new Error(m),
};

/** 最小可用的描述符；每条用例只改自己关心的那一两项。 */
function fakeApp(over: Partial<AcpApp> = {}): AcpApp {
  return {
    id: "research",
    piDir: "/repo/enterprise/backend/pi-research",
    promptsDir: "/repo/enterprise/backend/pi-research/prompts",
    agents: ["challenger"],
    toolsEndpoint: "http://localhost:8800",
    promptFor: async () => "（业务提示词）",
    thinkingFor: () => "off",
    toolNamesFor: () => ["findCounterEvidence"],
    tracer: noopTracer,
    ...over,
  };
}

/** 写一份只有 defaultModel 的 `.pi/settings.json`，返回它的 piDir。 */
function tempPiDir(defaultModel: string): string {
  const dir = mkdtempSync(join(tmpdir(), "carlife-acp-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ defaultModel }));
  return dir;
}

describe("resolvePiCommands：项目目录与二进制目录是两件事", () => {
  it("**不传 binDir 时二进制在 piDir 下**——车主面走的就是这一支，逐字等于从前", () => {
    const app = fakeApp({ piDir: "/repo/enterprise/backend/pi-agents", binDir: undefined });
    const c = resolvePiCommands(app);

    assert.equal(c.binDir, app.piDir, "缺省必须回落到 piDir，否则车主面当场起不来");
    assert.equal(c.piDir, app.piDir);
    assert.equal(c.piAcpCommand, resolve(app.piDir, "node_modules/.bin", PI_ACP));
    assert.equal(c.piCommand, resolve(app.piDir, "bin/pi-approved.sh"));
  });

  it("**传了 binDir：二进制借那一份，cwd 仍是自己的 piDir**（ACR-038 关键决策）", () => {
    const app = fakeApp({
      piDir: "/repo/enterprise/backend/pi-research",
      binDir: "/repo/enterprise/backend/pi-agents",
    });
    const c = resolvePiCommands(app);

    // 借的是安装：pi-acp 与 pi-approved.sh 都在 pi-agents 下。
    assert.equal(c.piAcpCommand, "/repo/enterprise/backend/pi-agents/node_modules/.bin/" + PI_ACP);
    assert.equal(c.piCommand, "/repo/enterprise/backend/pi-agents/bin/pi-approved.sh");
    assert.equal(c.localBin, "/repo/enterprise/backend/pi-agents/node_modules/.bin");
    assert.equal(c.adapterBin, "/repo/enterprise/backend/pi-agents/bin");

    // 不借的是项目：cwd 一旦跟着 binDir 走，用研面加载的就是车主面的
    // `.pi/extensions` 与 prompts——而那不报错。
    assert.equal(c.piDir, "/repo/enterprise/backend/pi-research");
  });

  it("piAgentsDir（旧的覆盖入口）语义不变：两者都用它", () => {
    const app = fakeApp({ piDir: "/repo/pi-research", binDir: "/repo/pi-agents" });
    const c = resolvePiCommands(app, { piAgentsDir: "/tmp/fixture" });

    assert.equal(c.piDir, "/tmp/fixture");
    assert.equal(c.binDir, "/tmp/fixture");
  });
});

describe("spawnEnvFor：扩展回调地址", () => {
  it("**注入 CARLIFE_TOOLS_ENDPOINT，且 AGENT_RUNTIME_URL 一字不动**", () => {
    const app = fakeApp({ toolsEndpoint: "http://localhost:8800" });
    const env = spawnEnvFor(app, { agent: "challenger" });

    assert.equal(env.CARLIFE_TOOLS_ENDPOINT, app.toolsEndpoint);
    // 车主面扩展 carlife-tools.ts 读的是这一个键，新增不是替换：
    // 它没了的话车主面的工具表回调无处可去。
    assert.ok("AGENT_RUNTIME_URL" in env, "AGENT_RUNTIME_URL 必须仍在");
    assert.ok((env.AGENT_RUNTIME_URL ?? "").length > 0);
    assert.equal(env.CARLIFE_PI_AGENT, "challenger");
  });

  it("**空串照传**——让扩展在启动时明确报错，而不是悄悄回落到另一个进程", () => {
    const env = spawnEnvFor(fakeApp({ toolsEndpoint: "" }));

    assert.equal(env.CARLIFE_TOOLS_ENDPOINT, "");
    assert.ok("CARLIFE_TOOLS_ENDPOINT" in env, "键必须在，不能因为空串就整项消失");
  });

  it("PATH 前置的是 binDir 下的两个目录，PI_ACP_PI_COMMAND 指借来的包装脚本", () => {
    const env = spawnEnvFor(
      fakeApp({ piDir: "/repo/pi-research", binDir: "/repo/pi-agents" }),
    );

    assert.ok(env.PATH?.startsWith("/repo/pi-agents/bin:/repo/pi-agents/node_modules/.bin:"));
    assert.equal(env.PI_ACP_PI_COMMAND, "/repo/pi-agents/bin/pi-approved.sh");
  });
});

describe("piDefaultModel：缓存按 piDir 分键", () => {
  beforeEach(() => resetPiModelCacheForTests());

  it("**两个目录各读各的**——模块级缓存时第二个会拿到第一个的模型名", () => {
    const first = tempPiDir("deepseek-flash");
    const second = tempPiDir("qwen-max");

    assert.equal(piDefaultModel(first), "deepseek-flash");
    assert.equal(piDefaultModel(second), "qwen-max", "串台时这里会是 deepseek-flash");
    // 反向再读一次：缓存命中路径也必须分键。
    assert.equal(piDefaultModel(first), "deepseek-flash");
  });

  it("读不到仍返回 undefined，且只失败一次（调用方回落到会话名）", () => {
    const missing = join(tmpdir(), "carlife-acp-not-here-" + Date.now());

    assert.equal(piDefaultModel(missing), undefined);
    assert.equal(piDefaultModel(missing), undefined);
    // 读不到的目录不该污染别人。
    assert.equal(piDefaultModel(tempPiDir("deepseek-flash")), "deepseek-flash");
  });
});
