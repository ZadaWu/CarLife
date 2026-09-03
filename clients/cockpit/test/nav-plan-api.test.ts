/**
 * 出发导航规划的端上请求封装（施工单 M66-03）：任何异常都收敛成 failed，起点拿不到就 undefined。
 * node:test 里没有 Tauri 也没有浏览器 fetch 的网关——测的是"不抛"与形状归一。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { LocationSnapshot } from "@carlife/ui";

import { currentOriginForNav, requestNavPlan } from "../src/features/cabin/nav-plan-api";

const port = (getState: () => Promise<LocationSnapshot>) => ({ getState });

test("浏览器形态下网关不可达 → {status:'failed'}，不抛", async () => {
  const r = await requestNavPlan({ origin: { lat: 31.2, lon: 121.4 } });
  assert.equal(r.status, "failed");
  assert.equal(r.plan, undefined);
});

test("起点：端口有 lastFix → 带 at；没有 → undefined；端口抛 → undefined", async () => {
  const withFix = port(async () => ({
    consent: { enabled: true, precision: "precise" },
    viewport: null,
    lastFix: { lat: 31.23, lon: 121.47, accuracyM: 30, precision: "precise", source: "gps", at: "2026-09-02T08:00:00.000Z" },
  }));
  assert.deepEqual(await currentOriginForNav(withFix), { lat: 31.23, lon: 121.47, at: "2026-09-02T08:00:00.000Z" });
  const noFix = port(async () => ({ consent: { enabled: false, precision: "coarse" }, viewport: null, lastFix: null }));
  assert.equal(await currentOriginForNav(noFix), undefined);
  const broken = port(async () => {
    throw new Error("no port");
  });
  assert.equal(await currentOriginForNav(broken), undefined);
});
