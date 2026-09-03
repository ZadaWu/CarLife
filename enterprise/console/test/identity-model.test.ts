/**
 * 「用户体系」三页的纯逻辑（施工单 M68-03；M68-04 追加）。
 *
 * 页面 import 了 css，node 载不进——所以能测的只有 `model.ts`：筛选拼装、游标栈、状态文案、表单校验。
 * 这里最容易错的一条是**空白当没筛**：一个只按了空格的搜索框不该变成一条真实的筛选条件。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reasonTooLong } from "../src/components/ConfirmAction";
import {
  FIRST_PAGE,
  currentCursor,
  deviceQuery,
  deviceStatus,
  errorText,
  fmtTime,
  grantStatus,
  identityQuery,
  popCursor,
  pushCursor,
  revokeConsequence,
  revokeResultText,
  shortId,
  validateNewAccount,
  vehicleQuery,
} from "../src/pages/identity/model";

describe("identityQuery：搜索拼装", () => {
  it("空白当没填；有值去首尾空格；extra 原样进查询串", () => {
    assert.equal(identityQuery({ q: "   " }).has("q"), false);
    assert.equal(identityQuery({}).toString(), "");
    assert.equal(identityQuery({ q: " Demo " }).get("q"), "Demo");
    const q = identityQuery({ q: "x" }, { limit: "50" });
    assert.equal(q.get("limit"), "50");
    assert.equal(q.get("q"), "x");
  });
});

describe("游标栈", () => {
  it("push 两次 pop 一次回到第二页；第一页不能再 pop；null 的 next 不入栈", () => {
    let s = FIRST_PAGE;
    assert.equal(currentCursor(s), undefined);
    s = pushCursor(s, "c1");
    s = pushCursor(s, "c2");
    assert.equal(s.length, 3);
    assert.equal(currentCursor(s), "c2");
    s = popCursor(s);
    assert.equal(currentCursor(s), "c1");
    s = popCursor(popCursor(s));
    assert.equal(s.length, 1, "第一页 pop 不动");
    assert.equal(pushCursor(s, null).length, 1);
  });
});

describe("状态文案", () => {
  it("设备：未撤销=正常；私人撤销=已撤销；车机撤销=已解绑", () => {
    assert.equal(deviceStatus({}), "正常");
    assert.equal(deviceStatus({ revokedAt: "2026-09-01T00:00:00Z" }), "已撤销");
    assert.equal(deviceStatus({ revokedAt: "2026-09-01T00:00:00Z", vehicleVin: "V1" }), "已解绑");
    assert.equal(deviceStatus({ vehicleVin: "V1" }), "正常");
  });
  it("授权：生效 / 已撤销", () => {
    assert.equal(grantStatus({}), "生效");
    assert.equal(grantStatus({ revokedAt: "x" }), "已撤销");
  });
});

describe("validateNewAccount：与服务端下限一致", () => {
  it("用户名 <3 报用户名；口令 <8 报口令；合法 null", () => {
    assert.match(validateNewAccount({ username: "ab", password: "12345678" }) ?? "", /用户名/);
    assert.match(validateNewAccount({ username: "abc", password: "1234567" }) ?? "", /口令/);
    assert.equal(validateNewAccount({ username: "abc", password: "12345678" }), null);
    assert.match(validateNewAccount({ username: "  a ", password: "12345678" }) ?? "", /用户名/);
  });
});

describe("小工具", () => {
  it("fmtTime：空给占位符，坏串原样回，不吐 Invalid Date", () => {
    assert.equal(fmtTime(null), "—");
    assert.equal(fmtTime(""), "—");
    assert.equal(fmtTime("not-a-date"), "not-a-date");
    assert.notEqual(fmtTime("2026-09-03T00:00:00Z"), "Invalid Date");
  });
  it("shortId：长 id 露前 8 位，短 id 原样", () => {
    assert.equal(shortId("0123456789abcdef"), "01234567…");
    assert.equal(shortId("abc"), "abc");
  });
  it("errorText：认识的翻译，不认识的原样（不隐藏机器名）", () => {
    assert.equal(errorText("username_taken"), "用户名已被占用");
    assert.equal(errorText("http_502"), "http_502");
  });
});

describe("M68-04：设备页筛选与撤销文案", () => {
  it("deviceQuery：空 type 不进 URL、非法 type 丢弃、非法 status 回落 active、userId/vin 去空", () => {
    const q = deviceQuery({ type: "", status: "active", userId: " u1 ", vin: "" });
    assert.equal(q.has("type"), false);
    assert.equal(q.get("status"), "active");
    assert.equal(q.get("userId"), "u1");
    assert.equal(q.has("vin"), false);
    assert.equal(deviceQuery({ type: "tv", status: "revoked", userId: "", vin: "V1" }).has("type"), false);
    assert.equal(deviceQuery({ type: "cockpit", status: "dead", userId: "", vin: "V1" }).get("status"), "active");
    assert.equal(deviceQuery({ type: "cockpit", status: "all", userId: "", vin: "V1" }).get("type"), "cockpit");
    assert.equal(deviceQuery({ type: "", status: "all", userId: "", vin: "" }, { limit: "50" }).get("limit"), "50");
  });
  it("vehicleQuery 与账号页同一条规则", () => {
    assert.equal(vehicleQuery({ q: "  " }).has("q"), false);
    assert.equal(vehicleQuery({ q: " LSJ " }).get("q"), "LSJ");
  });
  it("revokeConsequence：三种动作各说清后果", () => {
    assert.match(revokeConsequence("cockpit"), /解绑/);
    assert.match(revokeConsequence("personal"), /刷新/);
    assert.match(revokeConsequence("grant"), /下一次请求/);
  });
  it("revokeResultText：幂等如实说未做改动；车机叫解绑", () => {
    assert.equal(revokeResultText({ alreadyRevoked: true }), "已是撤销状态，未做改动");
    assert.equal(revokeResultText({ alreadyRevoked: false, kind: "cockpit" }), "已解绑");
    assert.equal(revokeResultText({ alreadyRevoked: false, kind: "personal" }), "已撤销");
  });
  it("reasonTooLong：200 字是边界，与网关 MAX_REASON_LEN 一致", () => {
    assert.equal(reasonTooLong("x".repeat(200)), false);
    assert.equal(reasonTooLong("x".repeat(201)), true);
    assert.equal(reasonTooLong("  " + "x".repeat(200) + "  "), false);
  });
});
