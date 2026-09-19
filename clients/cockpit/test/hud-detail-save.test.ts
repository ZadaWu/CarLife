/**
 * [F-18-15][AC-18-11] 「保存调整」把变更发进会话（施工单 M83-05）。
 *
 * 这一条的价值在于**失败路径**：发不出去时抽屉必须留在编辑态、变更集不清、屏上说出原因。
 * 静默丢弃的话，车主看到的是"抽屉关了、改动没了、暖暖也没说话"——他会以为保存成功了。
 * 读源码断言（渲染不出真实的 Tauri 通道）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

const saveBody = /onSaveDetailEdits = useCallback\(\s*\(next: readonly TripStructureEdit\[\]\) => \{([\s\S]*?)\n    \},\s*\[/.exec(APP)?.[1];

describe("保存调整的接线", () => {
  it("话由 contracts 的 adjustStructurePrompt 拼，端上不另写一份", () => {
    assert.ok(saveBody, "找不到 onSaveDetailEdits");
    assert.match(saveBody, /adjustStructurePrompt\(planId, entry\.plan, next\)/);
    assert.ok(!/`调整行程/.test(APP), "端上不许再拼一份开头——那是协议，只能有一份");
  });

  it("走 sendText 进会话，然后切到对话页——与「让暖暖调整」同一条路", () => {
    assert.match(saveBody!, /sendText\(prompt\)/);
    assert.match(saveBody!, /setNav\("dialog"\)/);
  });

  it("成功才关抽屉、清变更集", () => {
    const then = /\.then\(\(\) => \{([\s\S]*?)\}\)/.exec(saveBody!)?.[1];
    assert.ok(then, "找不到成功分支");
    assert.match(then, /setDetailEdits\(\[\]\)/);
    assert.match(then, /setDetailOpen\(false\)/);
  });

  it("失败留在编辑态、不清变更集、把原因说出来", () => {
    const cat = /\.catch\(\(err\) => \{([\s\S]*?)\}\)/.exec(saveBody!)?.[1];
    assert.ok(cat, "找不到失败分支");
    assert.ok(!cat.includes("setDetailEdits([])"), "失败不许丢掉车主改了半天的东西");
    assert.ok(!cat.includes("setDetailOpen(false)"), "失败不许关抽屉");
    assert.match(cat, /setTripHint\(/, "要把原因说出来");
    assert.match(cat, /setDetailSaving\(false\)/, "按钮要能再点一次");
  });

  it("空变更集与没有选中的行程都直接返回，不发空话", () => {
    assert.match(saveBody!, /if \(!planId \|\| next\.length === 0\) return;/);
  });

  it("浏览器走查不发送：planId 是演示的，发出去只会被告知没找到", () => {
    assert.match(APP, /detailSaveDisabledReason: isTauriEnv\(\) \? undefined : "浏览器走查不发送"/);
  });

  it("抽屉不直接写库、不绕 HITL——保存只产生一句话", () => {
    assert.ok(!saveBody!.includes("trip_plan_update"), "改库是确认弹窗之后的事");
    assert.ok(!saveBody!.includes("invoke("), "抽屉不自己发 Tauri 命令，走 sendText 那条既有路");
  });
});
