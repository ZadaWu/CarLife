/**
 * 工具进展的人话表（FL-08 F-08-05）。
 *
 * 这里最重要的是第一条：**新增工具时红的必须是测试，不是线上的车主**。
 * 表里漏一个的表现是那次调用不发进度——不报错、不崩溃，
 * 只是车主对着空白多等了一会儿，而这正是这个功能要消灭的东西。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TOOL_REGISTRY } from "@carlife/tools";

import { toolCall } from "../src/events";
import { TOOL_DISPLAY_NAMES, toolDisplayName } from "../src/events/tool-display";

describe("工具进展的人话表", () => {
  it("**注册表里每一个工具都有人话**——漏一个就少一条进度，而且没有任何报错", () => {
    const missing = TOOL_REGISTRY.map((t) => t.name).filter((n) => !toolDisplayName(n));
    assert.deepEqual(
      missing,
      [],
      "新增工具时把人话补进 events/tool-display.ts；" +
        "不补的代价不是崩溃，是车主对着空白多等十几秒",
    );
  });

  it("表里没有注册表之外的名字——那是改名后忘了同步的形态", () => {
    const registered = new Set(TOOL_REGISTRY.map((t) => t.name));
    const stale = Object.keys(TOOL_DISPLAY_NAMES).filter((n) => !registered.has(n));
    assert.deepEqual(stale, [], "工具改名或下线后，这张表里会留下永远用不到的条目");
  });

  it("措辞一律「正在…」——它只在 started 时下发，完成时不再重复", () => {
    for (const [name, text] of Object.entries(TOOL_DISPLAY_NAMES)) {
      assert.ok(text.startsWith("正在"), `${name} 的人话不是"正在…"：${text}`);
    }
  });

  it("**不是函数名**：人话里不许出现下划线或 ASCII 标识符", () => {
    // 车主看到 `ragflow_retrieve` 比什么都不显示更糟——
    // 一个不像话的字符串会让人以为程序出错了。
    for (const [name, text] of Object.entries(TOOL_DISPLAY_NAMES)) {
      assert.doesNotMatch(text, /[A-Za-z_]/, `${name} 的人话里混进了标识符：${text}`);
    }
  });

  it("查不到就返回 undefined——**没有兜底话术**", () => {
    // 兜一句"正在查询"在什么都没发生时就是一句用户无法证伪的假话
    // （与旁路 L0 模板"匹配不到就返回 undefined"同一条纪律）。
    assert.equal(toolDisplayName("没有这个工具"), undefined);
  });

  it("事件构造带上可配对的 toolCallId", () => {
    const e = toolCall("call-1", "weather", "正在查天气", "started") as unknown as {
      type: string;
      toolCallId: string;
      toolName: string;
      displayName: string;
      status: string;
    };
    assert.equal(e.type, "tool_call");
    assert.equal(e.toolCallId, "call-1");
    assert.equal(e.status, "started");
    // **不带入参**：工具入参里有用户原文，而这条通道不走脱敏。
    assert.deepEqual(Object.keys(e).sort(), [
      "displayName",
      "status",
      "toolCallId",
      "toolName",
      "type",
    ]);
  });
});
