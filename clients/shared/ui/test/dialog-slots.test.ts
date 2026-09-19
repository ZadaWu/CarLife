/**
 * [F-20-15][AC-20-1] `DialogScreen` 的三个可选槽（施工单 M104-04）：`pinned` / `trailing` / `inputPlaceholder`。
 * 不传时标记逐字节不变（车机不传）；传了 `pinned` 在列表之前、`trailing` 在列表末尾。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DialogScreen, type DialogScreenProps } from "../src/dialog";

const render = (props: Partial<DialogScreenProps>): string =>
  renderToStaticMarkup(createElement(DialogScreen, { messages: [], streaming: null, connection: "online", ...props }));

describe("三个槽不传就不渲染", () => {
  it("不传与传 undefined 的标记逐字节相等", () => {
    assert.equal(render({}), render({ pinned: undefined, trailing: undefined, inputPlaceholder: undefined }));
  });
  it("pinned 在 dlg-list 之前，trailing 在 dlg-list 之内的末尾", () => {
    const html = render({
      pinned: createElement("div", { "data-testid": "pin" }, "P"),
      trailing: createElement("div", { "data-testid": "tail" }, "T"),
    });
    const pin = html.indexOf('data-testid="pin"');
    const list = html.indexOf('class="dlg-list"');
    const tail = html.indexOf('data-testid="tail"');
    assert.ok(pin >= 0 && list > pin, "pinned 要在列表之前");
    assert.ok(tail > list, "trailing 要在列表之内");
    // trailing 在列表的收尾之前：它后面紧跟的是 dlg-list 的 </div>
    assert.match(html.slice(tail), /^data-testid="tail">T<\/div><\/div>/);
  });
  it("inputPlaceholder 只在有输入框时生效，覆盖默认占位", () => {
    const html = render({ onSendText: async () => {}, inputPlaceholder: "基于报告继续问…" });
    assert.ok(html.includes('placeholder="基于报告继续问…"'));
    assert.ok(!html.includes("驾驶中请用语音"));
    assert.ok(render({ onSendText: async () => {} }).includes("打字输入…（驾驶中请用语音）"));
  });
});
