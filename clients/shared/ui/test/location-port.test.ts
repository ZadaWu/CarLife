/**
 * 定位端口（localStorage 版）的行为。
 *
 * 这一版**不是走查用的空壳**：浏览器里它就是真端口，Tauri 侧适配器注入失败时
 * 它还是兜底。所以它必须与 Rust 侧 `carlife_core::location` 逐条对齐——
 * 两份实现走岔的表现是"同一个开关在浏览器上关得掉、装到车上关不掉"。
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  createBrowserLocationPort,
  publishLocationState,
  subscribeLocationState,
} from "../src/location/port";

/** node 里没有 localStorage（要 --experimental-webstorage），给一个最小实现。 */
function installFakeStorage(): void {
  const map = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

describe("定位端口（浏览器版）", () => {
  beforeEach(installFakeStorage);

  it("默认关、默认模糊——没授权之前一个坐标都不该有", async () => {
    const port = createBrowserLocationPort();
    const s = await port.getState();
    assert.equal(s.consent.enabled, false);
    assert.equal(s.consent.precision, "coarse");
    assert.equal(s.lastFix, null);
  });

  it("未授权时 recordFix 必须 reject——这道门在端口里，不在调用方", async () => {
    const port = createBrowserLocationPort();
    await assert.rejects(
      () => port.recordFix({ lat: 22.5, lon: 114, accuracyM: 10, source: "gps" }),
      /停用/,
    );
  });

  it("模糊授权下存进去的就是取整过的坐标", async () => {
    const port = createBrowserLocationPort();
    await port.setEnabled(true);
    const fix = await port.recordFix({ lat: 22.543123, lon: 114.057912, accuracyM: 8, source: "gps" });
    assert.equal(fix.lat, 22.54, "模糊定位交出了精确坐标——这种坏法没有任何症状");
    assert.ok(fix.accuracyM >= 1100);
    assert.equal((await port.getState()).lastFix?.lat, 22.54);
  });

  it("精确授权下原样保留；改回模糊时**已存的那个也要降级**", async () => {
    const port = createBrowserLocationPort();
    await port.setEnabled(true);
    await port.setPrecision("precise");
    const fix = await port.recordFix({ lat: 22.543123, lon: 114.057912, accuracyM: 8, source: "gps" });
    assert.equal(fix.lat, 22.543123);

    const after = await port.setPrecision("coarse");
    assert.equal(after.lastFix?.lat, 22.54, "改成模糊之后，存储里还躺着刚才那个米级坐标");
  });

  it("**关掉定位清坐标，但不清地图视图**", async () => {
    const port = createBrowserLocationPort();
    await port.setEnabled(true);
    await port.recordFix({ lat: 31.23, lon: 121.47, accuracyM: 20, source: "gps" });
    await port.saveViewport({ lat: 31.23, lon: 121.47, zoom: 15 });

    const off = await port.setEnabled(false);
    assert.equal(off.lastFix, null, "关掉定位 = 别再知道我在哪");
    assert.equal(
      off.viewport?.zoom,
      15,
      "地图视图是用户自己拖出来的，与定位无关——清掉它 = 每次开图都回深圳",
    );
    // 关着的时候照样能记住构图：地图本来就还能用。
    await port.saveViewport({ lat: 39.9, lon: 116.4, zoom: 12 });
    assert.equal((await port.getViewport())?.lat, 39.9);
  });

  it("脏视图不进存储，越界缩放夹回区间", async () => {
    const port = createBrowserLocationPort();
    await port.saveViewport({ lat: 31.2, lon: 121.5, zoom: 14 });
    await port.saveViewport({ lat: Number.NaN, lon: 121.5, zoom: 14 });
    assert.equal((await port.getViewport())?.zoom, 14, "脏值应当被丢弃而不是覆盖掉好值");

    await port.saveViewport({ lat: 31.2, lon: 121.5, zoom: 999 });
    assert.equal((await port.getViewport())?.zoom, 20);
  });

  it("状态变更要广播——两个 useLocation 实例同时挂着是常态", () => {
    // 车机端切到设置页时 HUD 仍然挂着（display:none）。没有广播的话，
    // 用户在设置里刚打开定位，切回主页点定位按钮会被告知"定位已停用"。
    const seen: string[] = [];
    const stop = subscribeLocationState((s) => seen.push(s.consent.enabled ? "on" : "off"));
    publishLocationState({
      consent: { enabled: true, precision: "coarse" },
      viewport: null,
      lastFix: null,
    });
    stop();
    publishLocationState({
      consent: { enabled: false, precision: "coarse" },
      viewport: null,
      lastFix: null,
    });
    assert.deepEqual(seen, ["on"], "取消订阅之后还在收 = 卸载的组件里 setState");
  });

  it("存储损坏按没配过处理，不抛给页面", async () => {
    installFakeStorage();
    globalThis.localStorage.setItem("carlife.location.v1", "{ 这不是 JSON");
    const port = createBrowserLocationPort();
    const s = await port.getState();
    assert.equal(s.consent.enabled, false);
    assert.equal(s.viewport, null);
  });
});
