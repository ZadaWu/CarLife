/**
 * [ACR-048] SSE 解析的判别逻辑。
 *
 * 这几条钉的是两个**真跑时踩过、且症状离根因很远**的错法：
 * 在信封第一层取 `kind`（`turn_end` 永远等不到，看起来像"不收口"），
 * 以及把增量字段当成 `delta`（回答 0 字而事件计数正常）。
 */

import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

import { deltaText, isTurnEnd, parseFrame, permissionRequest, splitFrames } from "../src/sse.ts";
import { AUTH_HEADER } from "../src/api.ts";
import { branchProgress, fillerText, toolProgress } from "../src/sse.ts";
import { paragraphs, splitBold } from "../src/rich.ts";
import { laneLabel, permissionTitle } from "../src/App.tsx";

const envelope = (event: unknown) =>
  JSON.stringify({ eventId: "e1", sessionId: "sess-1", ts: 1789000000000, event });

describe("splitFrames：按空行切帧，尾巴留着下次拼", () => {
  it("粘包里切出完整帧", () => {
    const r = splitFrames("data: {\"a\":1}\n\ndata: {\"b\":2}\n\ndata: {\"c\"");
    assert.equal(r.frames.length, 2);
    assert.equal(r.rest, "data: {\"c\"");
  });
  it("没有完整帧时一帧都不给", () => {
    const r = splitFrames("data: {\"a\"");
    assert.deepEqual(r.frames, []);
    assert.equal(r.rest, "data: {\"a\"");
  });
});

describe("parseFrame", () => {
  it("只取 data: 行，忽略 id/retry 之类", () => {
    const env = parseFrame("id: 7\ndata: " + envelope({ type: "update", kind: "delta", turnId: "t1", text: "嗯" }));
    assert.equal(env?.eventId, "e1");
  });
  it("坏 JSON 返回 null 而不是抛——一帧坏掉不该把整条流带走", () => {
    assert.equal(parseFrame("data: {not json"), null);
    assert.equal(parseFrame("event: ping"), null);
  });
});

describe("两层判别：type 在外，kind 在里", () => {
  it("增量取的是 text 不是 delta", () => {
    const env = parseFrame("data: " + envelope({ type: "update", kind: "delta", turnId: "t1", text: "续航" }))!;
    assert.equal(deltaText(env), "续航");
  });
  it("turn_end 判在第二层——判在第一层会永远等不到它", () => {
    const end = parseFrame("data: " + envelope({ type: "update", kind: "turn_end", turnId: "t1", messageId: "m1" }))!;
    assert.equal(isTurnEnd(end), true);
    const delta = parseFrame("data: " + envelope({ type: "update", kind: "delta", turnId: "t1", text: "x" }))!;
    assert.equal(isTurnEnd(delta), false);
  });
  it("非 update 的事件不会被当成增量", () => {
    const prompt = parseFrame("data: " + envelope({ type: "prompt", turnId: "t1" }))!;
    assert.equal(deltaText(prompt), null);
    assert.equal(isTurnEnd(prompt), false);
  });
});

describe("HITL 确认：个人信息必须与动作明细分开", () => {
  const env = parseFrame("data: " + envelope({
    type: "permission",
    interruptId: "int-1",
    action: "appointment",
    title: "预约保养",
    details: [{ label: "门店", value: "静安店" }, { label: "时间", value: "周六 10:00" }],
    scope: "写入门店工单系统",
    disclosure: [{ label: "手机号", value: "139****5613" }],
  }))!;

  it("details 与 disclosure 分别落在各自字段，不混成一堆", () => {
    const p = permissionRequest(env)!;
    assert.equal(p.interruptId, "int-1");
    assert.deepEqual(p.details.map((d) => d.label), ["门店", "时间"]);
    assert.deepEqual(p.disclosure.map((d) => d.label), ["手机号"]);
    assert.equal(p.scope, "写入门店工单系统");
  });
  it("disclosure 缺省为空数组：旧版本事件不该让页面炸", () => {
    const old = parseFrame("data: " + envelope({
      type: "permission", interruptId: "i", action: "a", title: "t", details: [],
    }))!;
    const p = permissionRequest(old)!;
    assert.deepEqual(p.disclosure, []);
    assert.equal(p.scope, null);
  });
  it("非 permission 事件返回 null", () => {
    const delta = parseFrame("data: " + envelope({ type: "update", kind: "delta", turnId: "t", text: "x" }))!;
    assert.equal(permissionRequest(delta), null);
  });
});

describe("[ACR-048] 鉴权头不能用平台保留的名字", () => {
  it("api.ts 不出现 authorization 作为请求头——魔搭把它保留给平台自己了", () => {
    const src = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
    // 只看"设置请求头"的写法，注释里提到这个词是可以的
    const offenders = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("*") && !l.trimStart().startsWith("//"))
      .filter((l) => /\bauthorization\s*:/i.test(l) && !/AUTH_HEADER/.test(l));
    assert.deepEqual(offenders, [], "带 Authorization 的请求到不了容器，平台直接回 403");
  });
  it("用的是 x-carlife-auth", () => {
    assert.equal(AUTH_HEADER, "x-carlife-auth");
  });
  it("公共代理片段把合成变量发给网关，否则网关收不到鉴权", () => {
    const common = readFileSync(new URL("../../../infra/modelscope/proxy-common.conf.template", import.meta.url), "utf8");
    assert.match(common, /proxy_set_header\s+Authorization\s+\$carlife_auth;/);
  });
  it("entrypoint 里两条通道都有 map：头优先、cookie 兜底，cookie 侧要补 Bearer 前缀", () => {
    const sh = readFileSync(new URL("../../../infra/modelscope/entrypoint.sh", import.meta.url), "utf8");
    // 头优先：$carlife_auth 的空值分支落到 cookie 那个变量上
    assert.match(sh, /map .*http_x_carlife_auth .*carlife_auth \{.*carlife_auth_from_cookie/);
    // cookie 里存的是裸 token（带空格的 "Bearer " 在 cookie 值里非法），前缀在这儿补
    assert.match(sh, /carlife_auth_from_cookie \{.*Bearer /);
  });
  it("cookie 里不做 URL 编码——编码后 nginx 取到的是编码串，拼出来的头是坏的（实测 401）", () => {
    const src = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
    const cookieLine = src.split("\n").find((l) => l.includes("document.cookie"))!;
    assert.ok(cookieLine, "没找到设置 cookie 的那一行");
    assert.equal(/encodeURIComponent/.test(cookieLine), false);
    assert.equal(/Bearer/.test(cookieLine), false, "前缀由 nginx 补，不写进 cookie");
  });
});

describe("[ACR-048] 进展类事件：不显示它们，那一两分钟就只是空白等待", () => {
  it("tool_call 用服务端给的人话，不是函数名", () => {
    const env = parseFrame("data: " + envelope({
      type: "tool_call", toolCallId: "t1", toolName: "poi_search", displayName: "在找附近的维修站", status: "started",
    }))!;
    const t = toolProgress(env)!;
    assert.equal(t.label, "在找附近的维修站");
    assert.equal(t.status, "started");
  });
  it("displayName 为空时退回函数名，不显示空白", () => {
    const env = parseFrame("data: " + envelope({
      type: "tool_call", toolCallId: "t1", toolName: "poi_search", displayName: "", status: "started",
    }))!;
    assert.equal(toolProgress(env)!.label, "poi_search");
  });
  it("branch 带进展与耗时", () => {
    const env = parseFrame("data: " + envelope({
      type: "update", kind: "branch", turnId: "x", agent: "side:service", status: "ok", durationMs: 8200, note: "保养站已选好",
    }))!;
    const b = branchProgress(env)!;
    assert.equal(b.agent, "side:service");
    assert.equal(b.note, "保养站已选好");
    assert.equal(b.durationMs, 8200);
  });
  it("filler 是整句，不是增量——不能并进正文", () => {
    const env = parseFrame("data: " + envelope({
      type: "update", kind: "filler", turnId: "x", text: "我查一下啊", source: "L0", interruptible: true,
    }))!;
    assert.equal(fillerText(env), "我查一下啊");
    assert.equal(deltaText(env), null);
  });
});

describe("[ACR-048] lane 显示名", () => {
  it("primary/side 前缀分别处理", () => {
    assert.equal(laneLabel("primary:itinerary"), "出行规划（主任务）");
    assert.equal(laneLabel("side:service"), "售后保养");
    assert.equal(laneLabel("side:testDrive"), "试驾预约");
  });
  it("行程 fan-out 的四条腿", () => {
    assert.equal(laneLabel("drive-task"), "自驾路线");
    assert.equal(laneLabel("hotel-task"), "住宿");
  });
  it("真跑里出现过的 lane 都要有名字（tour-plan-task 漏过一次，界面上露了内部名）", () => {
    for (const a of ["tour-plan-task", "trip-review-task", "service-task", "buying-task", "transit-task"]) {
      assert.notEqual(laneLabel(a), a, a + " 没有显示名");
    }
  });
  it("表里没有的原样显示——宁可露出内部名，也不要把一条线吞掉", () => {
    assert.equal(laneLabel("brand-new-task"), "brand-new-task");
    assert.equal(laneLabel("side:unknown"), "unknown");
  });
});

describe("[ACR-048] 回答正文的加粗渲染", () => {
  it("不渲染的话正文里满是裸星号，看起来像出故障", () => {
    assert.deepEqual(splitBold("跑了 **41280 公里**，正常"), [
      { text: "跑了 ", bold: false },
      { text: "41280 公里", bold: true },
      { text: "，正常", bold: false },
    ]);
  });
  it("流式途中只到一半的 ** 原样留着，等下一个 delta 补齐", () => {
    assert.deepEqual(splitBold("常温实测续航 **435"), [{ text: "常温实测续航 **435", bold: false }]);
  });
  it("空行分段、单换行保留", () => {
    const ps = paragraphs("第一段\n第二行\n\n第二段");
    assert.equal(ps.length, 2);
    assert.equal(ps[0].length, 2);
    assert.equal(ps[1].length, 1);
  });
});

describe("[ACR-048] 发消息单独限流", () => {
  const sh = readFileSync(new URL("../../../infra/modelscope/entrypoint.sh", import.meta.url), "utf8");
  const conf = readFileSync(new URL("../../../infra/modelscope/nginx.conf.template", import.meta.url), "utf8");
  it("发消息走自己的 zone，代价与读接口差一个量级", () => {
    assert.match(sh, /zone=turn:10m rate=\$\{DEMO_TURN_RATE\}/);
    assert.match(conf, /location ~ \^\/v1\/session\/\[\^\/\]\+\/messages\$/);
    assert.match(conf, /limit_req zone=turn/);
  });
  it("envsubst 要替换的变量都得先 export——漏一个就是 nginx 启动即 emerg", () => {
    const exported = /export ([A-Z_ ]+)/.exec(sh)![1].split(/\s+/).filter(Boolean);
    for (const v of ["DEMO_UPSTREAM", "DEMO_RATE_BURST", "DEMO_TURN_BURST", "DEMO_MAX_CONN"]) {
      assert.ok(exported.includes(v), v + " 没 export");
    }
  });
  it("两个 location 都 include 公共片段，SSE 那三行不会只在一条路上漂掉", () => {
    const includes = conf.match(/include \/etc\/nginx\/snippets\/proxy-common\.conf;/g) ?? [];
    assert.equal(includes.length, 2);
    const common = readFileSync(new URL("../../../infra/modelscope/proxy-common.conf.template", import.meta.url), "utf8");
    assert.match(common, /proxy_buffering off;/);
    assert.match(common, /chunked_transfer_encoding on;/);
    assert.match(common, /proxy_read_timeout 300s;/);
  });
});

describe("[ACR-048] 确认卡标题不给访客看函数名", () => {
  const view = (action: string, title: string) => ({
    interruptId: "i", action, title, details: [], scope: null, disclosure: [],
  });
  it("认识的动作换成人话", () => {
    assert.equal(permissionTitle(view("cabin_child_mode", "需要你确认：cabin_child_mode")), "要为你打开儿童模式");
  });
  it("不认识的动作也不该露出函数名", () => {
    assert.equal(permissionTitle(view("brand_new_tool", "需要你确认：brand_new_tool")), "需要你确认");
  });
  it("本来就是人话的标题原样保留", () => {
    assert.equal(permissionTitle(view("appointment", "预约保养")), "要为你预约");
    assert.equal(permissionTitle(view("x", "把这次行程定下来")), "把这次行程定下来");
  });
});
