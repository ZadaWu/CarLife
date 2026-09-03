/**
 * 定位相关的两个组件在"端上状态还没读回来"时**必须什么都不渲染**。
 *
 * 服务端渲染（本测试）与首帧是同一种情形：effect 还没跑，状态是空的。
 * 那时如果渲染，用户会看到开关从"关"跳到"开"，或者点一个显示为停用的按钮
 * 得到"其实是开着的"提示——两种都是在告诉用户一件没发生的事。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LocateButton } from "../src/location/LocateButton";
import { LocationSettings } from "../src/location/LocationSettings";

describe("定位组件的首帧", () => {
  it("设置组：状态未就绪 → 不渲染开关", () => {
    const html = renderToStaticMarkup(createElement(LocationSettings, {}));
    assert.equal(html, "", "首帧渲染出来的开关显示的是默认值，不是这台设备的真实状态");
  });

  it("定位按钮：状态未就绪 → 不渲染", () => {
    const html = renderToStaticMarkup(createElement(LocateButton, {}));
    assert.equal(html, "");
  });
});
