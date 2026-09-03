/**
 * 长按说话遇到 `onPointerLeave` 时要不要取消（2026-09-03 iPad 长按断触）。
 *
 * 复现序列来自 iPad Pro 11 模拟器上的埋点（`useAssistantInteraction.ts` 的
 * `leaveShouldCancel` 文档里有完整叙述）：`setPointerCapture` 在第一次
 * `pointermove` 才生效，WebKit 换目标时补发的 `pointerout` 让 React 在 hero 上
 * 合成了一次假 `onPointerLeave`；松手后又补一次。两次都不该动手势状态。
 *
 * 没有 DOM 环境，所以判据抽成纯函数来锁——它就是 hook 里那个 `if`。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { leaveShouldCancel } from "../src/hooks/useAssistantInteraction";

describe("leaveShouldCancel", () => {
  it("捕获还在手上：录音中挪了 1 个点的假 leave 不取消（用户说的「只录进两个字」）", () => {
    assert.equal(leaveShouldCancel({ captured: true, timerPending: false, longPress: true }), false);
  });

  it("捕获还在手上：350ms 之前的假 leave 不清计时器（整次长按等于没按）", () => {
    assert.equal(leaveShouldCancel({ captured: true, timerPending: true, longPress: false }), false);
  });

  it("松手之后补来的 leave 什么都不做——否则刚设上的「正在准备…」当场被清掉", () => {
    assert.equal(leaveShouldCancel({ captured: false, timerPending: false, longPress: false }), false);
  });

  it("捕获已丢、录音中：真的移出 / pointercancel，要停", () => {
    assert.equal(leaveShouldCancel({ captured: false, timerPending: false, longPress: true }), true);
  });

  it("捕获已丢、计时中：真的移出，要清计时器", () => {
    assert.equal(leaveShouldCancel({ captured: false, timerPending: true, longPress: false }), true);
  });
});
