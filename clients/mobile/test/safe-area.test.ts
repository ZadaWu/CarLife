/**
 * [F-01-07] 全屏页壳必须避让刘海屏的上下安全区。
 *
 * 2026-09-02 在 iPhone 16 Pro Max 上，设置 / 车辆档案 / 会话历史三个页面的标题
 * 全被压在状态栏与灵动岛底下——三个页壳都是 `position:absolute; inset:0`，
 * 而 `env(safe-area-inset-top)` 一处都没写。桌面走查里 env() 恒为 0，看不出来。
 *
 * 读文件不渲染：`clients/mobile` 没有 jsdom，要守的是"有没有写这一条"。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const FEATURES = fileURLToPath(new URL("../src/features", import.meta.url));

/** 每个 feature 目录里的 css。 */
function featureStyles(): { name: string; css: string }[] {
  return readdirSync(FEATURES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) =>
      readdirSync(join(FEATURES, d.name))
        .filter((f) => f.endsWith(".css"))
        .map((f) => ({ name: `${d.name}/${f}`, css: readFileSync(join(FEATURES, d.name, f), "utf8") })),
    );
}

/** 铺满视口的页壳：`inset: 0` 且定位脱流。 */
function isFullScreenShell(css: string): boolean {
  return /position:\s*(absolute|fixed)/.test(css) && /inset:\s*0/.test(css);
}

describe("[F-01-07] 刘海屏安全区", () => {
  for (const { name, css } of featureStyles()) {
    if (!isFullScreenShell(css)) continue;
    it(`${name} 的页壳避让了顶部安全区`, () => {
      assert.match(
        css,
        /env\(safe-area-inset-top\)/,
        `${name} 有铺满视口的页壳却没写 env(safe-area-inset-top)——标题会被状态栏/灵动岛压住`,
      );
    });
  }

  it("对话层的页壳也避让（它在 @carlife/ui，两端共用）", () => {
    const css = readFileSync(
      new URL("../../shared/ui/src/dialog/dialog.css", import.meta.url),
      "utf8",
    );
    assert.match(css, /env\(safe-area-inset-top\)/);
  });

  /*
   * 底部导航是常驻的，页壳靠固定 px 给它让位。那个数字不含 home indicator，
   * 手机上表现为最后一张卡片被导航切掉一角。
   */
  it("给底部导航让位的页壳也算上了 home indicator", () => {
    for (const { name, css } of featureStyles()) {
      const reserves = /padding[^;]*\b96px\b/.test(css);
      if (!reserves) continue;
      assert.match(
        css,
        /calc\(96px \+ env\(safe-area-inset-bottom\)\)/,
        `${name} 用 96px 给底部导航让位，但没加 env(safe-area-inset-bottom)`,
      );
    }
  });
});
