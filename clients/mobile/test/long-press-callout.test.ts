/**
 * [F-02-01] 长按暖暖必须是「长按说话」，不能弹出 iOS 的图片预览/菜单。
 *
 * 车机端在 ACR-004 修过一次（clients/cockpit/src/styles.css），手机端没抄，
 * 2026-09-02 在 iPhone 上原样重现。修法搬进共享包的 hud.css，两端一起管；
 * 这条守的是"那几行还在共享包里、且输入框的豁免没被顺手删掉"。
 * 读文件不渲染：`clients/mobile` 没有 jsdom。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const HUD = readFileSync(new URL("../../shared/ui/src/hud/hud.css", import.meta.url), "utf8");
const DOCK = readFileSync(
  new URL("../../shared/ui/src/assistant-avatar/AssistantDock.tsx", import.meta.url),
  "utf8",
);

/**
 * 取某个选择器的**全部**声明块拼在一起。
 * 同名规则可能有好几条（`.hud-viewport {` 基础规则在前、触屏那条在后），
 * 只取第一个会撞上基础规则——第一版就是这么假红的。
 */
function block(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hits = Array.from(HUD.matchAll(new RegExp(`${esc}[^{]*\\{([^}]*)\\}`, "g")), (m) => m[1]);
  assert.ok(hits.length > 0, `hud.css 里找不到 ${selector}`);
  return hits.join("\n");
}

describe("[F-02-01] 长按暖暖不弹系统图片菜单", () => {
  it("立绘与地图标注关掉了长按菜单和拖拽", () => {
    const b = block('.hud-viewport [class*="sprite"]');
    assert.match(b, /-webkit-touch-callout:\s*none/);
    assert.match(b, /-webkit-user-drag:\s*none/);
  });

  it("视口整体也关了长按菜单（管住立绘之外的图）", () => {
    assert.match(block(".hud-viewport {"), /-webkit-touch-callout:\s*none/);
  });

  it("输入框豁免：设置页填网关 IP 靠长按粘贴", () => {
    const b = block(".hud-viewport input");
    assert.match(b, /-webkit-touch-callout:\s*default/);
    assert.match(b, /user-select:\s*text/);
  });

  it("立绘 <img> 自身也标了 draggable=false（与 CSS 双保险）", () => {
    assert.match(DOCK, /hud-assistant__sprite[^>]*draggable=\{false\}/);
  });
});
