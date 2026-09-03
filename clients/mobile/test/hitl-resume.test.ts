/**
 * [F-04-08][AC-04-1] 手机端 HITL resume 真接线（施工单 M65-02 任务 1）。
 *
 * 此前 `app/index.tsx` 的 `onApprove` 只打一行 `console.warn("… resume 通道未接线 …")`
 * 就 `setConfirmRequest(null)`——用户看到"我确认了"，服务端那笔敏感动作还挂着。
 * 这是**假成功**，不是缺功能；本文件守两件事：
 *
 *  1. 三种 resume 结果的处置（纯函数 `resumeDisposition`）：只有 `accepted` 收弹层，
 *     `not_waiting` 与 `failed` 都必须留在屏幕上改成告知态（车机 M13-12 的教训）。
 *  2. 接线本身（读源码，`clients/mobile` 没有 jsdom）：Rust 命令注册了、桥接订阅了、
 *     假成功那两行**全文消失**。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import {
  NOTICE_FAILED,
  NOTICE_NOT_WAITING,
  resumeDisposition,
} from "../src/features/confirm/decide";

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");
const APP = read("../src/app/index.tsx");
const BRIDGE = read("../src/bridge/index.ts");
const CONFIRM = read("../src/features/confirm/index.tsx");
const CHAT_RS = read("../src-tauri/src/commands/chat.rs");
const LIB_RS = read("../src-tauri/src/lib.rs");

describe("[F-04-08][AC-04-1] resume 结果的处置：两种失败都不能收弹层", () => {
  it("accepted → 收起，且没有告知文案", () => {
    assert.deepEqual(resumeDisposition({ kind: "accepted" }), { close: true });
  });

  it("not_waiting（resumed:false）→ 不收，告知说清「动作没有执行」", () => {
    const d = resumeDisposition({ kind: "not_waiting" });
    assert.equal(d.close, false);
    assert.equal(d.notice, NOTICE_NOT_WAITING);
    assert.match(d.notice ?? "", /动作没有执行/);
  });

  it("failed（网络 / 服务异常）→ 不收，告知说清「没能送达」", () => {
    const d = resumeDisposition({ kind: "failed" });
    assert.equal(d.close, false);
    assert.equal(d.notice, NOTICE_FAILED);
    assert.match(d.notice ?? "", /没能送达/);
  });

  it("两种失败的文案不同——超时与断网是两种事，用户要能分得开", () => {
    assert.notEqual(NOTICE_NOT_WAITING, NOTICE_FAILED);
  });
});

describe("[F-04-08] 接线：命令 / 桥接 / 假成功路径", () => {
  it("Rust 侧有 `resume_interrupt` 命令且注册进装配", () => {
    assert.match(CHAT_RS, /pub async fn resume_interrupt\(/);
    assert.match(CHAT_RS, /\.post_resume\(&session_id, &interrupt_id, approved\)/);
    assert.match(LIB_RS, /commands::chat::resume_interrupt,/);
  });

  it("桥接层订阅 `dialog:permission`——Rust 早就在 emit，缺的就是这一行", () => {
    assert.match(BRIDGE, /onPermission\?: \(request: PermissionRequest\) => void/);
    assert.match(BRIDGE, /BRIDGE_EVENTS\.dialogPermission, handlers\.onPermission/);
    assert.match(APP, /onPermission: \(p\) => setPermission\(p\)/);
  });

  it("App 层 decide 走真 invoke，并按 resumeDisposition 处置", () => {
    assert.match(APP, /invoke<boolean>\("resume_interrupt", \{/);
    assert.match(APP, /resumeDisposition\(\{ kind: accepted \? "accepted" : "not_waiting" \}\)/);
    assert.match(APP, /resumeDisposition\(\{ kind: "failed" \}\)/);
    assert.match(APP, /if \(!disposition\.close\) \{\s*setPermissionNotice\(disposition\.notice\);\s*return;/);
  });

  it("**假成功那两行全文消失**", () => {
    assert.ok(!APP.includes("resume 通道未接线"), "approve/reject 只打 warn 就收窗的路径必须删掉");
    assert.ok(!/setConfirmRequest\(null\)/.test(APP));
  });

  it("助手回复到达时收起弹窗——服务端已收敛，按下去也只会 not_waiting", () => {
    const appendMessage = APP.slice(APP.indexOf("const appendMessage"), APP.indexOf("const decidePermission"));
    assert.match(appendMessage, /setPermission\(null\)/);
  });

  it("弹窗吃契约 `PermissionRequest`，不再自定义 ConfirmRequest；有 notice 时只剩「知道了」", () => {
    assert.match(CONFIRM, /import type \{ PermissionRequest \} from "@carlife\/shared"/);
    assert.ok(!/interface ConfirmRequest/.test(CONFIRM));
    assert.match(CONFIRM, /notice \? \(/);
    assert.match(CONFIRM, /知道了/);
    assert.match(CONFIRM, /request\.scope &&/, "影响范围为 null 时不摆一行空的");
  });

  it("演示态（?hitl=demo）没有真实中断点：按下去只收起，不 invoke", () => {
    assert.match(APP, /onDecide=\{permission \? decidePermission : \(\) => setDemoPermission\(false\)\}/);
    assert.match(APP, /request=\{permission \?\? DEMO_CONFIRM\}/, "真实中断优先于演示样例");
  });
});
