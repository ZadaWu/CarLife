/**
 * [F-18-15][AC-18-11] 胶囊上的工具菜单的接线（施工单 M83-02）。
 *
 * 与 `hud-two-states.test.ts` 同一条教训：`HudScreen.tsx` 有两处悬浮层渲染，
 * 日期条只能写一处、用两处——菜单的四个 prop 若在两处各写一遍，改一处漏一处不会报错。
 * 读源码断言，不渲染。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/hud/HudScreen.tsx", import.meta.url), "utf8");
const APP = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const count = (src: string, needle: string) => src.split(needle).length - 1;

describe("工具菜单的接线", () => {
  it("四个 prop 只写一处（日期条本身也只写一处）", () => {
    assert.equal(count(SRC, "<TripDateBanner"), 1);
    assert.equal(count(SRC, "showTools"), 1);
    assert.equal(count(SRC, "menuOpen={trips.detailMenuOpen"), 1);
    assert.equal(count(SRC, "onToggleMenu={trips.onToggleDetailMenu}"), 1);
    assert.equal(count(SRC, "onOpenDetail={trips.onOpenDetail}"), 1);
  });

  it("车机传 showTools，手机端那侧不传（组件缺省 false）", () => {
    assert.match(SRC, /showTools\s/, "HudScreen 显式传 showTools");
    const mobileHud = readFileSync(
      new URL("../../mobile/src/features/hud/index.tsx", import.meta.url),
      "utf8",
    );
    assert.ok(!mobileHud.includes("showTools"), "竖屏不渲染工具按钮");
  });

  it("菜单状态在 App，且换一程 / 取消选中都收起它", () => {
    assert.match(APP, /const \[detailMenuOpen, setDetailMenuOpen\] = useState\(false\)/);
    const onSelect = /onSelectTrip = useCallback\(\s*\(planId: string\) => \{([\s\S]*?)\},\s*\[source\],/.exec(APP)?.[1];
    assert.ok(onSelect, "找不到 onSelectTrip");
    assert.match(onSelect, /setDetailMenuOpen\(false\)/, "换一程要收起菜单——不然点下去操作的是另一程");
    const onClear = /onClearTripSelection = useCallback\(\(\) => \{([\s\S]*?)\}, \[source\]\);/.exec(APP)?.[1];
    assert.ok(onClear, "找不到 onClearTripSelection");
    assert.match(onClear, /setDetailMenuOpen\(false\)/);
  });

  it("三个回调都传进 trips", () => {
    assert.match(APP, /detailMenuOpen,\s*onToggleDetailMenu,\s*onOpenDetail,/);
  });
});
