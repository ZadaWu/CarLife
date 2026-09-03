/**
 * 开发默认值与生产守卫（施工单 M49-01，F-07-01 / AC-07-1）。
 *
 * 这组用例守的是一条**不对称**：同一个缺失，在开发是"给个默认值继续跑"，
 * 在生产是"立刻退出"。写错方向的后果不对称得更厉害——
 * 开发侧写错只是起不来（当场可见），生产侧写错是拿仓库里的密钥在跑鉴权（永远不可见）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectStartupReport,
  collectStartupIssues,
  isProductionEnv,
} from "../src/config/startup";
import { CONFIG_REGISTRY, DEV_JWT_SECRET } from "../src/config/registry";

/**
 * 造一份"除了被测项之外全都齐活"的 env。
 *
 * 不用 `process.env`：`collectStartupReport` 会**写回**传入的对象（这是它的设计），
 * 拿真 env 跑会污染同进程里的其它用例。
 */
function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const def of CONFIG_REGISTRY) {
    if (def.storage !== "env-only" || !def.required) continue;
    // 32 字符，过得了所有"至少 16 字符"的 validate
    env[def.envFallback] = "test-value-0123456789abcdef-0123";
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

describe("[F-07-01][AC-07-1] CARLIFE_JWT_SECRET 的开发默认值", () => {
  it("注册表里挂着 devDefault，且只有它挂（主密钥不许有）", () => {
    const jwt = CONFIG_REGISTRY.find((d) => d.key === "CARLIFE_JWT_SECRET");
    assert.ok(jwt);
    assert.equal(jwt.devDefault, DEV_JWT_SECRET);

    /*
     * 谁可以有 devDefault 是一份**白名单**，不是"多了就改断言"。
     *
     * 判据：它的默认值泄漏出去，最坏是什么？
     *   - JWT 签名密钥 / 后台角色 token：能冒充身份，但**生产恒缺失即退出**
     *     （`isProductionEnv` 那条），所以泄漏面只到开发机。
     *   - 落盘加密主密钥：仓库里的钥匙能解开任何一台机器上**已经落盘的库**，
     *     这个后果不随环境收敛。它永远不许有。
     *
     * 2026-09-01 加进来的两项是后台角色 token：改之前它们没有 devDefault，
     * 兜底写在 `auth/console.ts` 里，而那份兜底**生产也生效**——公开仓库里的
     * 全权后台凭证。搬进注册表就是为了让生产那条退出规则管住它们。
     */
    const withDevDefault = CONFIG_REGISTRY.filter((d) => d.devDefault !== undefined)
      .map((d) => d.key)
      .sort();
    assert.deepEqual(
      withDevDefault,
      ["CARLIFE_ADMIN_TOKEN", "CARLIFE_JWT_SECRET", "CARLIFE_OPS_TOKEN"],
      "落盘加密主密钥不得有开发默认值——仓库里的钥匙能解开任何一台机器上的库",
    );

    // 三项都必须是 required：没有 required，生产那条"缺失即退出"根本不会触发，
    // devDefault 就成了一个静默生效的公开默认值。
    for (const key of withDevDefault) {
      const def = CONFIG_REGISTRY.find((d) => d.key === key);
      assert.equal(def?.required, true, `${key} 有 devDefault 就必须 required`);
    }
  });

  it("默认值本身过得了它自己的 validate（≥16 字符）", () => {
    const jwt = CONFIG_REGISTRY.find((d) => d.key === "CARLIFE_JWT_SECRET");
    assert.equal(jwt?.validate?.(DEV_JWT_SECRET), null);
  });

  it("默认值命中密钥扫描的放行词，否则 check:secrets 会把它报出来", () => {
    assert.match(DEV_JWT_SECRET, /changeme/);
    assert.match(DEV_JWT_SECRET, /insecure/, "名字要在代码审查里刺眼");
  });

  it("非生产 + 缺失 → 不是 issue，是 warning，且值被写回 env", () => {
    const env = baseEnv({ CARLIFE_JWT_SECRET: undefined, NODE_ENV: "development" });
    const { issues, warnings } = collectStartupReport(env);

    assert.equal(
      issues.find((i) => i.key === "CARLIFE_JWT_SECRET"),
      undefined,
      "开发环境不该被这一项挡住",
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.key, "CARLIFE_JWT_SECRET");
    assert.equal(
      env.CARLIFE_JWT_SECRET,
      DEV_JWT_SECRET,
      "写回是故意的：后续读 env 的代码由此拿到同一个值，不用各自再兜一次底",
    );
  });

  it("生产 + 缺失 → issue，进程该退出", () => {
    const env = baseEnv({ CARLIFE_JWT_SECRET: undefined, NODE_ENV: "production" });
    const { issues, warnings } = collectStartupReport(env);

    const hit = issues.find((i) => i.key === "CARLIFE_JWT_SECRET");
    assert.ok(hit, "生产环境必须被挡住");
    assert.match(hit.reason, /必填项缺失/);
    assert.equal(warnings.length, 0, "生产不该有'我给你垫了个默认值'这种事");
    assert.equal(env.CARLIFE_JWT_SECRET, undefined, "生产环境下一个字节都不许写回");
  });

  it("生产 + 显式配好 → 既无 issue 也无 warning", () => {
    const env = baseEnv({ NODE_ENV: "production" });
    const { issues, warnings } = collectStartupReport(env);
    assert.equal(issues.find((i) => i.key === "CARLIFE_JWT_SECRET"), undefined);
    assert.equal(warnings.length, 0);
  });

  it("非生产 + 显式配好 → 不打告警（别烦已经配好的人）", () => {
    const env = baseEnv({ NODE_ENV: "development" });
    assert.equal(collectStartupReport(env).warnings.length, 0);
  });

  it("非生产 + 配了个过短的值 → 仍然是 issue，**不被默认值悄悄顶替**", () => {
    const env = baseEnv({ CARLIFE_JWT_SECRET: "abc", NODE_ENV: "development" });
    const { issues } = collectStartupReport(env);

    const hit = issues.find((i) => i.key === "CARLIFE_JWT_SECRET");
    assert.ok(hit, "配错了比没配更需要被指出来");
    assert.match(hit.reason, /至少 16 字符/);
    assert.equal(env.CARLIFE_JWT_SECRET, "abc", "不许把用户写的值改掉");
  });

  it("空字符串按'没配'算（.env.example 里就是空的）", () => {
    const env = baseEnv({ CARLIFE_JWT_SECRET: "", NODE_ENV: "development" });
    assert.equal(collectStartupReport(env).warnings.length, 1);
    assert.equal(env.CARLIFE_JWT_SECRET, DEV_JWT_SECRET);
  });

  it("旧签名 collectStartupIssues 仍只返回 issues", () => {
    const env = baseEnv({ CARLIFE_JWT_SECRET: undefined, NODE_ENV: "development" });
    assert.equal(collectStartupIssues(env).find((i) => i.key === "CARLIFE_JWT_SECRET"), undefined);
  });
});

describe("[F-07-01][AC-07-1] 生产判定", () => {
  it("只认 NODE_ENV=production，不认别的写法", () => {
    assert.equal(isProductionEnv({ NODE_ENV: "production" }), true);
    assert.equal(isProductionEnv({ NODE_ENV: "prod" }), false);
    assert.equal(isProductionEnv({ NODE_ENV: "Production" }), false);
    assert.equal(isProductionEnv({}), false);
    // 不新造第二个环境判定变量——多一个就多一处"两边不一致时听谁的"
    assert.equal(isProductionEnv({ CARLIFE_ENV: "production" } as NodeJS.ProcessEnv), false);
  });
});
