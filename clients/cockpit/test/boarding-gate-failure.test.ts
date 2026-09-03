/**
 * [F-56-07][AC-56-7] 上车声明门在**取不到成员名单**时的行为（施工单 M54-02）。
 *
 * # 为什么读源码
 *
 * 守的是错误分支的**形状**，而这一类缺陷的共同点是：它不报错、不留日志、
 * 也没有任何断言能从行为上抓到——门只是不见了。
 *
 * 2026-08-31 走查：换了随身 Wi-Fi 之后，车机上存的网关地址失效，
 * `vehicle_members` 这一次 HTTP 调用抛错，与"不在 Tauri 里（浏览器走查）"
 * 共用同一个 catch，相位落到 `skip`，组件返回 `null`——
 * 用户点「用作车机」，三个身份连同整道门一起消失，看起来像功能没做。
 *
 * 所以这里钉的三条都是"合并回去也编得过、跑得起来"的约束。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/features/auth/BoardingGate.tsx", import.meta.url), "utf8");

/** 去掉注释：断言的对象必须是会真的跑起来的代码，不是解释它的那段话。 */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const CODE = stripComments(SRC);

/** 取 `marker` 之后第一个 `} catch (…) {` 的整个块（按花括号配对），找不到返回 null。 */
function catchBlockAfter(code: string, marker: string): string | null {
  const at = code.indexOf(marker);
  if (at < 0) return null;
  const m = /\} catch \([^)]*\) \{/.exec(code.slice(at));
  if (!m) return null;
  let i = at + m.index + m[0].length;
  let depth = 1;
  const start = i;
  while (i < code.length && depth > 0) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") depth -= 1;
    i += 1;
  }
  return depth === 0 ? code.slice(start, i - 1) : null;
}

describe("[F-56-07][AC-56-7] 上车声明门的失败分支", () => {
  it("取名单失败有**自己的相位**，不与 skip 合流", () => {
    assert.match(CODE, /kind: "blocked"/, "blocked 相位没了？那失败又会落回 skip");
    /*
     * 断言的是 catch 块的**结局**，不是文本相邻（TD-19，2026-09-03）：
     * 第一版要求 `catch (err) {` 后面紧跟 `setPhase({ kind: "blocked"`，d7c49788 在中间插了一段
     * `resync_bound_vin` 重试，行为没变（两条路都以 blocked 收尾）却把 check:all 卡红了三天。
     * 所以这里把 probe 里 `loadMembers(vin)` 那个 catch 块整段切出来，看它**只**落到 blocked。
     */
    const block = catchBlockAfter(CODE, "await loadMembers(vin);");
    assert.ok(block, "probe 里 loadMembers(vin) 的 catch 块找不到了");
    const blocked = block.match(/setPhase\(\{ kind: "blocked"/g) ?? [];
    assert.ok(blocked.length >= 1, "loadMembers 的 catch 必须落到 blocked——落到 skip 就是整道门消失");
    assert.ok(!/kind: "skip"/.test(block), "取名单失败的分支里不许出现 skip——那正是 2026-08-31 走查里门消失的原因");
    // 重试路径（resync 后再 loadMembers）同样只能以 blocked 收尾
    if (block.includes("loadMembers(fresh)")) {
      assert.ok(blocked.length >= 2, "resync 后重试的那条路也得以 blocked 收尾，不能静默 return");
    }
  });

  it("**只有 `device_role` 抛错才算不在 Tauri 里**", () => {
    /*
     * 判据是"探测被拆成了两段"：第一段只包 device_role。
     * 把 loadMembers 收回同一个 try 里，这条会红。
     */
    const first = CODE.match(/try \{\s*role = await invoke<string>\("device_role"\);\s*\} catch \{/);
    assert.ok(first, "device_role 必须单独一个 try——它是唯一能判定『没有 Tauri』的调用");
    /*
     * 判据用"两者之间必须已经有一个 `} catch`"，不用负向正则跨段匹配：
     * 第一版写的是 `try {…device_role…loadMembers…} catch` 取反，而 `[\s\S]`
     * 会径直越过中间那个 `} catch`，从第一个 try 匹配到第二个——**恒为真**，
     * 于是这条断言在正确的代码上也报红。断言的形状本身也会有 bug。
     */
    const between = CODE.slice(
      CODE.indexOf('invoke<string>("device_role")'),
      CODE.indexOf("loadMembers(vin)"),
    );
    assert.match(
      between,
      /\} catch/,
      "device_role 与 loadMembers 又回到同一个 try 了——这正是本用例要防的合并",
    );
  });

  it("blocked 相位**渲染得出东西**，不是返回 null", () => {
    // 早退守卫里不许出现 blocked，否则等于换个名字继续消失
    const guard = CODE.match(/if \(phase\.kind === [^)]*\) return null;/g) ?? [];
    for (const g of guard) {
      assert.ok(!g.includes("blocked"), `blocked 混进了返回 null 的守卫：${g}`);
    }
    assert.match(CODE, /连不上网关/, "要把原因摆在脸上");
    assert.match(CODE, /\{phase\.reason\}/, "**原始错误必须显示出来**，否则又回到『说不出为什么』");
  });

  it("留着进设置的出路——遮罩是全屏的，没出路就改不了网关地址", () => {
    assert.match(CODE, /先进入设置改地址/);
    assert.match(
      CODE,
      /onClick=\{\(\) => setPhase\(\{ kind: "skip" \}\)\}/,
      "这个按钮必须能真的把门放下，否则用户被永久挡在设置页外",
    );
  });

  it("[M54-10] 已声明 → 自动续用不重选；续用失败清声明回选择屏", () => {
    assert.match(CODE, /invoke<string>\("boarding_declared"\)/, "不读保存的声明就永远回到选择屏");
    assert.match(CODE, /saved\.declared/, "外层「声明过没有」必须参与判断");
    assert.match(CODE, /invoke\("boarding_reset"\)/, "续用失败必须清掉声明，否则每次启动都撞同一个 400");
  });

  it("重试不是刷新整页——刷新会把用户刚填的网关地址丢掉", () => {
    assert.match(CODE, /void probe\(\);/);
    assert.ok(!/window\.location\.reload/.test(CODE), "这一屏不许用整页刷新做重试");
  });
});
