/**
 * 顶栏刷新按钮：踢全三路数据，但一个操作状态都不碰（2026-09-12 用户走查）。
 *
 * # 为什么这条要单独守
 *
 * 用户点名了它：「点击后主页所有的数据重新请求与更新渲染和页面更新，**操作的状态不要去改变**：
 * 比如说现在已经选择了某个行程，页面的选择的状态是不去改变的」。
 *
 * 而"刷新顺手把状态归零"是刷新按钮最常见的坏法，且**坏了不报错**——屏幕只是悄悄跳回
 * 列表首条 / 跳回全程 / 把档案页切走的那辆车换回默认车。下一个人往这个函数里补一句
 * `setSelectedPlanId(null)`（看起来完全合理："刷新嘛，回到初始视图"）就复发了。
 *
 * # 判据为什么是读源码
 *
 * 真要跑出来得把整个 `App.tsx` 渲染起来，而 cockpit 包没有 jsdom，也不该为这一条引。
 * 所以这里读的是 `refreshHome` 的**函数体本身**（按括号配平切出来，不是正则糊一片），
 * 断言它里面没有那几个 setter。行为那一半（选中的行程经 refresh 之后还在）
 * 在 `clients/shared/ui/test/topbar-link-refresh.test.ts` 里是真跑的。
 *
 * ⚠️ 先剥注释再匹配：本仓踩过两次"守卫其实守着注释"（见 dialog-input-row.test.ts 文件头）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

/** 从 `const <name> = useCallback(` 起按括号配平切出整个函数体。 */
function callbackBody(name: string): string {
  const head = APP.indexOf(`const ${name} = useCallback(`);
  assert.notEqual(head, -1, `找不到 ${name} —— 它被改名或删了，这个守卫也就失效了`);
  let depth = 0;
  for (let i = APP.indexOf("(", head); i < APP.length; i += 1) {
    if (APP[i] === "(") depth += 1;
    else if (APP[i] === ")") {
      depth -= 1;
      if (depth === 0) return APP.slice(head, i + 1);
    }
  }
  assert.fail(`${name} 的括号没配平`);
}

describe("顶栏刷新：换数据，不换操作状态", () => {
  const body = callbackBody("refreshHome");

  /*
   * 这几个 state 各自记着用户**做过的一个动作**。刷新去改任何一个，
   * 都是把"重新取一遍数"做成了"退回初始视图"。
   */
  const OPERATION_STATE = [
    ["setSelectedPlanId", "选中的那一程——用户明说了它不能变"],
    ["setDayMode", "逐日页签选在第几天"],
    ["setReviewPlanId", "正开着的行程摘要弹层"],
    ["setNav", "当前在哪一页"],
    ["setActiveVin", "档案页切过去的那辆车"],
    ["setActiveModel", "同上"],
    ["setDemoPlan", "演示开关"],
    ["setDemoNav", "演示开关"],
    ["setGuide", "正开着的导览页"],
  ] as const;

  for (const [setter, what] of OPERATION_STATE) {
    it(`不碰 ${setter}（${what}）`, () => {
      assert.ok(
        !body.includes(setter),
        `refreshHome 里调了 ${setter}：刷新只该换数据。${what}是用户的操作，不是数据。`,
      );
    });
  }

  it("不重新解析默认车——那会把档案页切走的那辆换回来", () => {
    assert.ok(
      !body.includes("loadVehicles"),
      "refreshHome 重新解析了默认车。能量按当前 vin 重读就够了；" +
        "重解析会把车主在档案页切过去的那辆换回列表首位，正是「操作状态被改掉」。",
    );
  });

  it("三路都踢到了——少一路就会出现「刷了但那张卡没动」", () => {
    for (const [what, needle] of [
      ["行程（含列表与常住地）", ".refresh({ pretrip: true })"],
      ["能量", "energyPollerRef.current.refresh()"],
      ["导览任务", "refreshGuideJobs()"],
    ] as const) {
      assert.ok(body.includes(needle), `refreshHome 没有踢 ${what} 那一路（找不到 \`${needle}\`）`);
    }
  });

  it("带 pretrip 重算——这是它与 60 秒轮询唯一的语义差别", () => {
    assert.match(
      body,
      /refresh\(\{\s*pretrip:\s*true\s*\}\)/,
      "用户按下按钮＝「我现在就要最新的」，等同于又打开了一次 App，该带上按最新天气重算的 opt-in",
    );
  });

  it("连点不叠发", () => {
    assert.match(body, /if \(refreshingRef\.current\) return/, "缺连点闸门：一次点三下就是九个请求");
  });
});

describe("指示灯不许把「没连上」显示成「正常」", () => {
  /** `const topBarLink: TopBarLink = …;` 那条三元链。 */
  function linkExpr(): string {
    const head = APP.indexOf("const topBarLink: TopBarLink =");
    assert.notEqual(head, -1, "找不到 topBarLink——指示灯的取值逻辑被改名或删了");
    return APP.slice(head, APP.indexOf(";", head));
  }

  it("绿灯的前提是真的收到过数据，不是「还没出错」", () => {
    assert.ok(
      linkExpr().includes("linkSeen"),
      "topBarLink 没看 linkSeen：`stale` 的初值 false 同时是「开机头两秒」和「一切正常」，" +
        "只凭它点灯的话，网关根本没起来时开机那几秒也是绿的——而那正是用户会盯着看的几秒",
    );
  });

  it("浏览器走 mock 源，必须显式说成演示数据", () => {
    assert.ok(
      linkExpr().includes('"demo"'),
      "浏览器里 mock 源永远「成功」，绿灯会把「我压根没在跟网关说话」显示成「连得好好的」",
    );
  });

  /*
   * 2026-09-12 的真实误导：网关 3 ms 回 401（车机没上车声明），屏上写「未连接」，
   * 用户照着去查 Docker 和端口，查到的全是好的。
   * 原话：「我的 mock 服务我自己在 docker 上运行了，但是点刷新按钮没用，依旧是断的」。
   */
  it("401 走「未上车」，且排在「未连接」前面——它是更具体的那一种失败", () => {
    const expr = linkExpr();
    assert.ok(expr.includes('"noidentity"'), "topBarLink 没有未上车这一档，401 又会被说成未连接");
    assert.ok(
      expr.indexOf('"noidentity"') < expr.indexOf('"offline"'),
      "未上车必须排在未连接前面：401 时服务是通的，说「未连接」会把人支去查网络",
    );
  });

  it("只有真连不上才置 stale——否则状态栏四格会写第二遍同样的误导", () => {
    const head = APP.indexOf("source.subscribe(");
    assert.notEqual(head, -1, "找不到 source.subscribe——订阅那段被改写了");
    const seg = APP.slice(head, head + 1600);
    assert.match(
      seg,
      /setStale\(kind === "unreachable"\)/,
      "取数失败时无条件置了 stale：401 那一档服务是好的，状态栏再写「服务暂不可用」" +
        "就是第二处同样的误导——那时它们只是没有数据，写「暂无」才是实话",
    );
  });

  it("未上车这一档带着能修好的那一下——刷新按钮治不了它", () => {
    const head = APP.indexOf("const topBarLinkAction");
    assert.notEqual(head, -1, "没有 topBarLinkAction：那枚灯只会报告问题，不给出路");
    const expr = APP.slice(head, APP.indexOf(";", head));
    assert.ok(expr.includes("onNeedBoarding"), "补救动作应是重新挂出上车声明（onNeedBoarding）");
    assert.ok(
      expr.includes('"noidentity"'),
      "补救动作必须只挂在未上车那一档：别的失败点它不会有任何效果",
    );
  });
});
