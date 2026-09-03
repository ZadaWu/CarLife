/**
 * 底部导航的第四项（施工单 M33-05，F-01-06）。
 *
 * 这组测试盯的**不是"设置能不能点"**，而是那条最容易被下一个人破坏的不变量：
 * **`BottomNav` 是 cockpit 与 mobile 共用的**（`clients/mobile/src/app/index.tsx:235`）。
 * 「设置」必须由调用方显式打开，默认关——加成默认开的话，
 * 手机端会长出一个点进去是空白的 tab，而那一屏不报任何错。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BottomNav } from "../src/hud/BottomNav";

const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(BottomNav, {
      active: "hud",
      onSelect: () => {},
      profileDisabled: false,
      ...props,
    } as never),
  );

describe("底部导航", () => {
  it("**缺省三项**——手机端不传即维持原样，一行不用改", () => {
    const html = render({});
    assert.ok(html.includes("主页"));
    assert.ok(html.includes("对话"));
    assert.ok(html.includes("档案"));
    assert.equal(html.includes("设置"), false, "默认长出第四项 = 手机端多一个空白 tab");
  });

  it("showSettings 打开第四项，且排在档案后面", () => {
    const html = render({ showSettings: true });
    assert.ok(html.includes("设置"));
    assert.ok(
      html.indexOf("档案") < html.indexOf("设置"),
      "顺序是产品定的：主页 / 对话 / 档案 / 设置",
    );
  });

  it("选中设置时 aria-current 落在它身上", () => {
    const html = render({ showSettings: true, active: "settings" });
    // 四个按钮里只有一个带 aria-current
    assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
    const idx = html.indexOf("设置");
    const before = html.slice(0, idx);
    assert.ok(
      before.lastIndexOf('aria-current="page"') > before.lastIndexOf("档案"),
      "选中态标在设置那一项上",
    );
  });

  it("档案占位仍然可禁用，且不影响设置项", () => {
    const html = render({ showSettings: true, profileDisabled: true });
    assert.equal((html.match(/disabled=""/g) ?? []).length, 1, "只有档案被禁用");
    assert.ok(html.includes("设置"));
  });

  it("四项的热区尺寸由样式给，组件不写死尺寸（FL-06 驾驶态）", () => {
    const html = render({ showSettings: true });
    assert.equal(html.includes("style="), false, "写死内联尺寸就绕过了主题 token");
  });
});
