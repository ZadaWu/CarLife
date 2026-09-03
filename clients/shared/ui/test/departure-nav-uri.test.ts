/**
 * 带途经点与策略的高德唤起（施工单 M66-03；2026-09-02 随 URI 逻辑与出发卡从 cockpit 上提到这里）。三个入口的能力不一样，各钉各的：
 *  - iOS 有途经点走 path、四参数个数一致、分隔符裸 `|`、名字编码；零途经点与旧串**全等**；
 *  - web 只带第一个 via、policy 由策略映射；
 *  - 降级说明说得出丢了几个。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  amapAppNavUri,
  amapNavUri,
  amapWebPolicy,
  navLaunchDegradation,
  stopsViewportHeight,
  type NavLaunch,
} from "../src/departure/amap";

const target = { lat: 30.2419, lon: 120.0987, name: "灵隐寺" };
const A = { lat: 30.741319, lon: 120.934428, name: "南湖服务区" };
const B = { lat: 30.307762, lon: 120.365516, name: "下沙服务区(沪昆高速昆明方向)" };

test("iOS：有途经点走 iosamap://path，vian 与三组 | 分隔的参数个数一致，终点是 dlat/dlon", () => {
  const uri = amapAppNavUri({ target, waypoints: [A, B] });
  assert.ok(uri.startsWith("iosamap://path?"), uri);
  assert.ok(uri.includes("&t=0"));
  assert.ok(uri.includes("vian=2"));
  assert.ok(uri.includes(`vialons=${A.lon}|${B.lon}`), "经度按序、裸 | 分隔");
  assert.ok(uri.includes(`vialats=${A.lat}|${B.lat}`));
  assert.ok(uri.includes(`vianames=${encodeURIComponent(A.name)}|${encodeURIComponent(B.name)}`), "名字编码、分隔符不编码");
  assert.ok(uri.includes(`dlat=${target.lat}&dlon=${target.lon}&dname=${encodeURIComponent(target.name)}`));
  assert.ok(!uri.includes("&m="), "iOS ≥7.7.4 不支持 m，不发");
});

test("零途经点：App 与 web 两个入口的串与旧签名逐字相同（M66 之前的行为不变）", () => {
  assert.equal(amapAppNavUri({ target }), amapAppNavUri(target));
  assert.ok(amapAppNavUri({ target }).startsWith("iosamap://navi?"));
  assert.equal(amapNavUri({ target }), amapNavUri(target));
  assert.ok(!amapNavUri({ target }).includes("via="));
});

test("web：via 只带第一个、policy 由策略映射（less_toll→2，其它→0）", () => {
  const uri = amapNavUri({ target, waypoints: [A, B], strategy: "less_toll" });
  assert.equal((uri.match(/via=/g) ?? []).length, 1);
  assert.ok(uri.includes(`&via=${A.lon},${A.lat},${encodeURIComponent(A.name)}`), "via 是 lon,lat,name 且是第一个");
  assert.ok(uri.includes("policy=2"));
  assert.ok(amapNavUri({ target, strategy: "highway" }).includes("policy=0"));
  assert.ok(amapNavUri(target).includes("policy=0"), "不给策略 = 推荐");
  assert.equal(amapWebPolicy("less_toll"), 2);
  assert.equal(amapWebPolicy(undefined), 0);
});

test("名字里的 | 被替换，不破坏 vianames 的分隔", () => {
  const uri = amapAppNavUri({ target, waypoints: [{ ...A, name: "南湖|服务区" }, B] });
  const names = /vianames=([^&]*)/.exec(uri)![1];
  assert.equal(names.split("|").length, 2);
  assert.ok(names.includes(encodeURIComponent("南湖丨服务区")));
});

test("降级说明：web 多途经点说丢了几个；app 带策略说以本地设置为准；无途经点无策略 → undefined", () => {
  const two: NavLaunch = { target, waypoints: [A, B], strategy: "less_toll" };
  assert.equal(navLaunchDegradation(two, "web"), "网页版高德只能带第一个途经点（丢弃 1 个）");
  assert.equal(navLaunchDegradation(two, "app"), "高德 App 的算路策略以其本地设置为准");
  assert.equal(navLaunchDegradation({ target, waypoints: [A] }, "web"), undefined);
  assert.equal(navLaunchDegradation({ target }, "app"), undefined);
});

test("途经点视口：三条以内不限高，超过就按 3.5 条封顶（按条目数，不按行数）", () => {
  // 装得下就不该凭空造出一条滚动边界。
  assert.equal(stopsViewportHeight([]), undefined);
  assert.equal(stopsViewportHeight([30, 30, 30]), undefined);

  // 等高四条：三条整 + 半条，露出的那半条就是"下面还有"的唯一线索。
  assert.equal(stopsViewportHeight([30, 30, 30, 30]), 105);

  /*
   * 高矮不一（长名字加理由会换行）：仍然是"前三条整高 + 第四条一半"。
   * 这条是本函数存在的理由——按行数写死的 CSS 高度在这里会露出四条半或者两条。
   */
  assert.equal(stopsViewportHeight([48, 24, 48, 24, 48, 24, 48]), 48 + 24 + 48 + 12);

  /*
   * 量到 0 不是"高度是零"，是"此刻没有布局"（隐藏标签页里视口塌成 1.9px，实测）。
   * 当成有效值写进 max-height，列表就永久塌掉再也回不来，而且零报错。
   */
  assert.equal(stopsViewportHeight([0, 0, 0, 0, 0]), undefined);
  assert.equal(stopsViewportHeight([Number.NaN, 20, 20, 20]), undefined);
});

test("途经点列表的序号不靠 list-style，overflow 裁不到它", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(path.join(here, "..", "src/departure/departure-card.css"), "utf8");
  const block = css.slice(css.indexOf(".cabin-depart-card__plan-stops {"));
  assert.ok(/list-style:\s*none/.test(block), "标记必须关掉：WebKit 在 overflow 非 visible 时会把它裁掉");
  assert.ok(block.includes("counter-increment: depart-plan-stop"), "序号改用计数器");
  assert.ok(block.includes('content: counter(depart-plan-stop)'), "序号由 ::before 渲染，属于内容，裁不到");
});

test("高度跟着布局重量，不是只量一次", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "..", "src/departure/DepartureCard.tsx"), "utf8");
  assert.ok(src.includes("new ResizeObserver(measure)"), "字体晚到 / 转屏 / 切回前台都会改行数");
  assert.ok(
    !/ro\.observe\(el\)/.test(src),
    "不能观察 ol 自己：我们写上去的 max-height 会再次触发它，绕成一个圈",
  );
});

test("出发卡把途经点全部渲染出来，不再截断", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "..", "src/departure/DepartureCard.tsx"), "utf8");
  assert.ok(
    !/waypoints\.slice\(/.test(src),
    "导航 agent 规划了几个休息点就显示几个：截断会让车主以为方案里只有那三处",
  );
  assert.ok(src.includes("navPlan.waypoints.map("), "途经点列表应当直接 map 全量");
  assert.ok(src.includes("stopsViewportHeight("), "高度要量出来（条目会换行，算不出来）");
  assert.ok(src.includes("ref={stopsRef}"), "量高度要拿到列表元素");
});
