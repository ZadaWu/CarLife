/**
 * [F-01-04][AC-01-5] 手机 HUD 两类卡的分流与两处 AssistantDock（M65-01，照车机同名用例）。
 * 读源码不渲染：`clients/mobile` 没有 jsdom，而要守的是接线。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/features/hud/index.tsx", import.meta.url), "utf8");
const count = (needle: string) => SRC.split(needle).length - 1;

describe("[F-01-04] 两类卡的分流只写一处、用两处", () => {
  it("`<TipsCard` 与 `<HighlightsCard` 各只出现一次——分流不许复制", () => {
    assert.equal(count("<TipsCard"), 1);
    assert.equal(count("<HighlightsCard"), 1);
  });
  it("`{windowCard}` 出现两次——真实地图分支与默认分支都要挂上", () => {
    assert.equal(count("{windowCard}"), 2, "漏一处的表现是「有地图时能看到推荐卡、没地图时看不到」");
  });
  it("分流走共享守卫 `isHighlightsPage`", () => {
    assert.ok(SRC.includes("isHighlightsPage(page)"));
    assert.equal(SRC.includes('"highlights" in page'), false);
  });
});

describe("[F-01-10] 与车机同一份组件、同一份判据", () => {
  it("精灵按 kind 语义取（spriteFor），不再按 anchor 直取", () => {
    assert.ok(count("spriteFor(sprites,") >= 2);
    assert.equal(SRC.includes("sprites.poi[node.anchor]"), false);
    assert.equal(SRC.includes("sprites.poi[trip.origin.anchor]"), false);
  });
  it("行程地图入参吃共享的 HudTripMapProps；跟车顶栏与住宿横幅都接上", () => {
    assert.ok(SRC.includes("type HudTripMapProps"));
    assert.ok(SRC.includes("<AmapTripLayer"));
    assert.ok(SRC.includes("<NavBar nav={tripMap.nav}"));
    assert.ok(SRC.includes("LODGING_LABEL[l.strategy]"));
  });
  it("暖暖有休息/办公与「退下」——两个布局分支共用同一个节点", () => {
    assert.ok(SRC.includes("mode={assistantMode}"));
    assert.ok(SRC.includes("onDismiss={onAssistantDismiss}"));
    assert.equal(count("{assistantNode}"), 2);
  });
  it("HUD 层无输入框（AC-01-1）", () => {
    assert.equal(SRC.includes("<input"), false);
    assert.equal(SRC.includes("<textarea"), false);
  });
});
