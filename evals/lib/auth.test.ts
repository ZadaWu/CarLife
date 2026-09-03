/**
 * 评测令牌与网关鉴权的同源守护（施工单 M51-01）。
 *
 * # 这条测试防的是什么
 *
 * M48-02 删掉 `Bearer demo-token` 之后，三套 `eval:*` runner 静默失效了——
 * 每条 case 收到 401，而现象是"评测很慢"（SSE 那一路抛错，主流程卡在超时上）。
 * **没有任何一条测试会红**：`eval:*` 不进 `check:all`，样本集的单测只测判定内核。
 *
 * 所以这里反过来验：本目录 `auth.ts` 签的 token 必须能过**网关自己那份** `verifyToken`。
 * 故意跨过 infra/services 的目录界限去 import 那个模块——本测试的全部价值就在
 * "两边真的是同一套规则"，用一份复制品验只会两边一起漂。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";

import { verifyToken } from "../../enterprise/backend/gateway/src/auth/jwt";
import { DEV_JWT_SECRET, EVAL_USER_ID, issueEvalToken } from "./auth";

const ORIGINAL = process.env.CARLIFE_JWT_SECRET;
after(() => {
  if (ORIGINAL === undefined) delete process.env.CARLIFE_JWT_SECRET;
  else process.env.CARLIFE_JWT_SECRET = ORIGINAL;
});

describe("评测令牌能过网关的校验", () => {
  it("开发默认密钥下：claims 形状与网关期望一致", () => {
    delete process.env.CARLIFE_JWT_SECRET;
    const claims = verifyToken(issueEvalToken());
    assert.ok(claims, "网关拒了评测 token——两边的签名或 claims 形状漂了");
    assert.equal(claims.sub, EVAL_USER_ID);
    assert.equal(claims.kind, "user");
    // `use` 必须是 access：`resolveIdentity` 对 refresh 直接返回 null，
    // 而那会以 401 的形态出现，与"密钥不对"分不开。
    assert.equal(claims.use, "access");
  });

  it("配了 CARLIFE_JWT_SECRET 时用它——否则 source .env 就全 401、不 source 才正常", () => {
    process.env.CARLIFE_JWT_SECRET = "a-configured-secret-long-enough-32chars";
    assert.ok(verifyToken(issueEvalToken()), "配置密钥下网关拒了评测 token");
  });

  it("密钥不匹配时网关必须拒——防这条断言变成永远为真", () => {
    process.env.CARLIFE_JWT_SECRET = "secret-used-at-signing-time-0123456789";
    const token = issueEvalToken();
    process.env.CARLIFE_JWT_SECRET = "a-totally-different-secret-0123456789";
    assert.equal(verifyToken(token), null);
  });

  it("有效期够一次 real 档全量跑：至少 1 小时", () => {
    delete process.env.CARLIFE_JWT_SECRET;
    const claims = verifyToken(issueEvalToken())!;
    // 网关默认 15 分钟。真实 LLM 全量要跑一个多小时，用默认值的表现是
    // **后半段全部 401**——一张与被测系统无关的"通过率断崖"。
    assert.ok(claims.exp - claims.iat >= 3600, `有效期只有 ${claims.exp - claims.iat}s`);
  });
});

describe("抄来的常量没有漂", () => {
  it("DEV_JWT_SECRET 与 enterprise/backend/shared/db 的定义逐字一致", () => {
    // 抄一份常量的代价就是它会漂。漂的表现是**签出来的 token 网关不认**，
    // 而那与"密钥没配"在现象上一模一样（都是 401）。所以直接读那个文件对一眼。
    const src = readFileSync(new URL("../../enterprise/backend/shared/db/src/config/registry.ts", import.meta.url), "utf8");
    const m = src.match(/export const DEV_JWT_SECRET = "([^"]+)"/);
    assert.ok(m, "enterprise/backend/shared/db 里找不到 DEV_JWT_SECRET 的定义——改名了就来这里同步");
    assert.equal(DEV_JWT_SECRET, m![1]);
  });
});
