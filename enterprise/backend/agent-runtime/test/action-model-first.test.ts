/**
 * [F-11-10][AC-11-7] 处置判定：模型说了算，正则只在它没表态时兜底。
 *
 * 真跑 turn-bdb074dd：车主说「帮我订一下从上海到广州的七日行程，我大概从上海坐飞机**出发**，
 * 然后也是从那边坐飞机回来」。意图理解判得一字不差（`action: "none"`，
 * goal 是"规划一份从上海到广州的七日往返行程"），而正则命中「出发」二字，
 * 取或之后翻盘成 depart——屏幕当场切进跟车模式，开始导航一份旧的普陀山行程。
 *
 * 本该拦住它的三个否决项全部擦肩而过：天数那条只认「N 天 / 几天」，他说的是「七**日**」；
 * 点名去哪那条只认「**去**某地」，他说的是「**到**广州」；玩法词那条没有「订」。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  wantsCancel,
  wantsCancelAll,
  wantsCommit,
  wantsDepart,
  wantsNavEnd,
} from "../src/graph/subgraphs/itinerary";

/** 真跑那一句，一字不改。 */
const REAL = "帮我订一下从嗯上海到广州的七日行程我大概从上海坐飞机出发然后也是从那边坐飞机回来";

describe("[F-11-10] 模型表了态，正则不许翻盘", () => {
  it("真跑那一句：模型判 none，就不能因为「出发」二字去导航", () => {
    assert.equal(wantsDepart(REAL, { action: "none" }), false);
  });

  it("这三个词本来就该被否决，但词表都漏了——所以不能靠它们兜底", () => {
    // 没有模型表态时，字面判据确实拦不住：这是保留降级路径的代价，如实钉住
    assert.equal(wantsDepart(REAL, undefined), true, "降级时仍会误判——所以模型表态时必须以它为准");
    // 词表能认的那几种写法（对照组）
    assert.equal(wantsDepart("帮我规划去广州玩七天", undefined), false, "「去…」「玩」「七天」都在否决表里");
  });

  it("模型判 none 时，四个正面信号一个都不许自作主张", () => {
    const none = { action: "none" };
    assert.equal(wantsCommit("就这样定了吧", none), false);
    assert.equal(wantsCancel("那就取消了", none), false);
    assert.equal(wantsCancelAll("全部都不要了", none), false);
    assert.equal(wantsNavEnd("结束导航", none), false);
  });

  it("模型判对时照常生效", () => {
    assert.equal(wantsCommit("嗯", { action: "commit" }), true, "正则认不出的说法，靠模型认");
    assert.equal(wantsDepart("我们走吧", { action: "depart" }), true);
    assert.equal(wantsNavEnd("别导了", { action: "nav_end" }), true);
  });
});

describe("[F-11-10] 模型没表态时，字面判据原样接手", () => {
  it("action 缺席 / 空串都算没表态——降级路径是取或当初真正要保住的东西", () => {
    assert.equal(wantsCommit("就这样定了", undefined), true);
    assert.equal(wantsCommit("就这样定了", {}), true);
    assert.equal(wantsCommit("就这样定了", { action: "" }), true, "模型偶尔给空串");
    assert.equal(wantsDepart("出发", undefined), true);
    assert.equal(wantsCancel("行程取消掉", undefined), true);
  });
});

describe("[F-11-10] 安全否决仍走字面，方向相反的词在场就保守", () => {
  it("有取消词就不落库，哪怕模型说 commit——落错了要他自己去取消", () => {
    assert.equal(wantsCommit("行程取消掉", { action: "commit" }), false);
  });

  it("有结束导航词就不出发，哪怕模型说 depart——判错就当场切屏", () => {
    assert.equal(wantsDepart("不导航了", { action: "depart" }), false);
    assert.equal(wantsDepart("结束导航吧", { action: "depart" }), false);
  });

  it("「取消第二天」是细化，两个取消信号都否决——按整程取消会把整份作废", () => {
    assert.equal(wantsCancel("取消第二天的行程", { action: "cancel" }), false);
    assert.equal(wantsCancelAll("取消第二天的行程", { action: "cancel_all" }), false);
  });

  it("cancel_all 同时也是 cancel——单份取消那条路要接得住", () => {
    assert.equal(wantsCancel("都不要了", { action: "cancel_all" }), true);
  });
});
