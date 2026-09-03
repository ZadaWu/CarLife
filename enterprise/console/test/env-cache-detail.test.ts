/**
 * ⑤缓存详情弹窗的**防退化断言**（M-mem-cache-detail）。
 *
 * 用户的原话："每个条目的展示需要可读性高的文字展示，不要 json 的形式。"
 * 这里守三条：每一行都能点开；四类各有自己的渲染，不是把 JSON 打出来；
 * 估算口径的距离带"估算"字样（与车机端同一条纪律）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string): string => readFileSync(join(process.cwd(), "src/pages/memory", f), "utf8");
const LIST = read("env-cache.tsx");
const DETAIL = read("env-cache-detail.tsx");
const MAP = read("env-cache-map.tsx");
const FORMAT = read("env-cache-format.ts");

describe("每一条都能点开", () => {
  it("列表行是按钮，点了打开详情弹窗", () => {
    assert.match(LIST, /className="cache-row"/);
    assert.match(LIST, /setOpen\(e\)/);
    assert.match(LIST, /<EnvCacheDetailModal entry=\{open\}/);
  });

  it("列表行显示服务端的人话标题与摘要，JSON 预览不再上屏", () => {
    assert.match(LIST, /className="cache-title">\{e\.title \?\? e\.key\}/);
    assert.match(LIST, /className="cache-summary">\{e\.summary \?\? e\.preview\}/);
    assert.ok(!/className="cache-preview mono">\{e\.preview\}/.test(LIST), "JSON 预览还在列表行上");
  });

  it("TTL 超过一天按天说——「335 小时后过期」没人读得出是两周", () => {
    assert.match(LIST, /天 \$\{Math\.floor\(\(sec % 86_400\) \/ 3600\)\} 小时后过期/);
  });

  it("详情走单条接口，不是把列表预览放长", () => {
    assert.match(DETAIL, /\/console\/memory\/cache\/entry\?key=/);
    assert.ok(!/preview/.test(DETAIL.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), "详情不该再用列表的 200 字符预览");
  });
});

describe("四类各自的渲染，不是 JSON", () => {
  for (const ns of ["regeo", "amap-forecast", "guide-brief", "dest-highlights"]) {
    it(`命名空间 ${ns} 有专门的分支`, () => {
      assert.match(DETAIL, new RegExp(`case "${ns}":`));
    });
  }

  it("渲染层不把值 JSON.stringify 到页面上", () => {
    const code = DETAIL.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.ok(!/JSON\.stringify/.test(code), "详情里出现了 JSON.stringify——那就是把 JSON 打出来了");
  });

  it("逆地理与天气都带地图；天气的定位来自反查到的逆地理点", () => {
    assert.match(DETAIL, /function RegeoDetail[\s\S]*?<CacheMap/);
    assert.match(DETAIL, /function ForecastDetail\(\{ value, points \}: \{ value: ForecastValue; points: RegeoPoint\[\] \}\)/);
    assert.match(DETAIL, /case "amap-forecast":[\s\S]*?regeoPoints/);
    assert.match(DETAIL, /不拿城市中心点冒充/);
  });

  it("导览简报照车机端的栏目：时间轴 / 单向游玩路线 / 休息·吃饭·厕所 / 避雷提醒", () => {
    for (const t of ["游玩时间轴", "单向游玩路线", "休息 · 吃饭 · 厕所", "避雷提醒", "guideBriefToTimeline"]) {
      assert.ok(DETAIL.includes(t), `缺栏目 ${t}`);
    }
  });

  it("目的地推荐照车机端的三节：吃什么 / 打卡点 / 怎么拍，且显示出处", () => {
    for (const t of ['title="吃什么"', 'title="打卡点"', "怎么拍", "SourceLink"]) {
      assert.ok(DETAIL.includes(t), `缺 ${t}`);
    }
  });

  it("停车场到入口的距离带「估算」字样", () => {
    assert.match(DETAIL, /distanceToGateMeters[\s\S]{0,120}估算/);
  });

  it("命名空间人话表覆盖新接的两类", () => {
    assert.match(FORMAT, /"guide-brief": "景区导览简报"/);
    assert.match(FORMAT, /"dest-highlights": "目的地推荐"/);
  });
});

describe("地图退回时坐标不消失", () => {
  it("没 key / 加载失败 / 没坐标三种情况都有文字回落，且回落里列出坐标", () => {
    assert.match(MAP, /未配置高德 JS key/);
    assert.match(MAP, /地图加载失败/);
    assert.match(MAP, /没有可以定位的坐标/);
    assert.match(MAP, /cd-coord-list/);
  });

  it("控制台不 import 车主端的组件库（ACR-020：共享目录跟着受众走）", () => {
    for (const f of [LIST, DETAIL, MAP, FORMAT]) assert.ok(!/@carlife\/ui/.test(f));
  });
});
