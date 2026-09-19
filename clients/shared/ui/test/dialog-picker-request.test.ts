/**
 * [F-20-15][AC-20-1] `DialogScreen.pickerRequest`（施工单 M103-02）：主页「拍照问诊」卡拉起一次系统选择器。
 *
 * 守两条：它**不渲染任何节点**（不传时标记逐字节不变，传了也不变——它只在 effect 里点 input）；
 * 源码里它只出现在 props 注释、解构与一个 useEffect 里，JSX 里不出现。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DialogScreen, type DialogScreenProps } from "../src/dialog";

const SRC = readFileSync(new URL("../src/dialog/DialogScreen.tsx", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const render = (props: Partial<DialogScreenProps>): string =>
  renderToStaticMarkup(createElement(DialogScreen, { messages: [], streaming: null, connection: "online", ...props }));

describe("[F-20-15][AC-20-1] emptyHint：缺省是车机那句，手机端传自己的", () => {
  it("不传时空态文案逐字不变；传了就用传的", () => {
    assert.match(render({}), /还没有对话。回到主页长按助手说话试试。/);
    assert.match(render({ emptyHint: "还没有对话。回到主页点一下暖暖，或拍一张照片试试。" }), /点一下暖暖/);
    assert.equal(/长按/.test(render({ emptyHint: "x" })), false);
  });
});

describe("[F-20-15][AC-20-1] pickerRequest 不渲染任何节点", () => {
  it("传与不传，标记逐字节相等（有 upload 端口时也一样）", () => {
    const attachments = { load: async () => new Blob(), upload: async () => ({ attachmentId: "h", kind: "image" as const, bytes: 1 }) as never };
    assert.equal(render({ onSendText: async () => {} }), render({ onSendText: async () => {}, pickerRequest: 3 }));
    assert.equal(render({ onSendText: async () => {}, attachments }), render({ onSendText: async () => {}, attachments, pickerRequest: 1 }));
  });

  it("源码里只在解构与一个 useEffect 里用到；JSX 里不出现", () => {
    const uses = SRC.match(/pickerRequest/g) ?? [];
    // 接口声明 1 + 解构 1 + effect 里判空 1 + 依赖数组 1
    assert.equal(uses.length, 4, `pickerRequest 出现 ${uses.length} 次，多出来的那处大概进了 JSX`);
    assert.match(SRC, /useEffect\(\(\) => \{\s*if \(!pickerRequest \|\| !attachments\?\.upload\) return;\s*fileInputRef\.current\?\.click\(\);/);
    assert.equal(/<[^>]*pickerRequest/.test(SRC), false);
  });
});
