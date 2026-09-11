/**
 * 对话输入条能不能用，靠三条排版约束撑着（真机 2026-09-10 暴露）。
 *
 * 现象：手机端（440pt）「发送」被裁在右边缘外，📎 长成了一枚和「发送」一模一样的橙色渐变键。
 * 两个毛病同源——都出在「这一行里有几枚 button」这件事上：
 *
 *  1. `.dlg-input input` 是 flex 子项，而**表单控件的自动最小尺寸来自默认字符宽度**
 *     （约 20 个字符）。`flex: 1` 压不过这个地板，两侧再各站一枚定宽按钮时整行顶破视口。
 *     所以它必须显式写 `min-width: 0`。
 *  2. `[data-surface=…] .dlg-input button` 的特指度压得过 `.dlg-attach` 自己那条，
 *     于是给「发送」写的尺寸与渐变会一并套到 📎 上。发送键的规则必须排除 `.dlg-attach`。
 *  3. `.dlg-main` 少写一句 `min-height: 0`，对话一长主栏就按内容撑高、把自己顶出视口，
 *     列表不再滚动、输入条被推到底部导航底下——**判据是内容量不是屏幕**，短对话怎么看都正常。
 *
 * 为什么用读 CSS 的方式守：`clients/shared/ui` 没有 jsdom，量不到真实盒子；
 * 而这两条**在桌面宽屏上都看不出来**——1920 的车机端有的是横向余量，
 * 输入框压不压得动、📎 多宽都不影响观感，只有窄屏才把它们逼出来。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

/*
 * ⚠️ **先把注释剥掉再匹配**。这一条是标定这个守卫时踩出来的：`.dlg-input input` 的声明上方
 * 就写着一段解释 `min-width: 0` 为什么必须在的注释，注释里当然也有 "min-width: 0" 这几个字。
 * 不剥的话，把声明删掉这个测试照样绿——它守的其实是那段注释还在不在。
 */
const CSS = readFileSync(new URL("../src/dialog/dialog.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** 拆成 `{选择器, 声明块}`，只做一层——本表里没有嵌套规则。 */
function rules(): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1].trim().split("\n").pop()!.trim(), body: m[2] });
  }
  return out;
}

/**
 * 一条选择器的特指度 `(id, 类/属性/伪类, 元素)`。`:not(…)` 记它参数的特指度（CSS 规范如此）。
 * 够用就好：本表里没有 id，也没有 `:is()` / `:where()`。
 */
function specificity(sel: string): [number, number, number] {
  const inner = [...sel.matchAll(/:not\(([^)]*)\)/g)].map((m) => m[1]).join(" ");
  const bare = sel.replace(/:not\([^)]*\)/g, " ");
  const count = (s: string): [number, number, number] => [
    (s.match(/#[\w-]+/g) ?? []).length,
    (s.match(/\.[\w-]+|\[[^\]]*\]|:[a-z-]+(?!\()/g) ?? []).length,
    (s.match(/(?:^|[\s>+~])([a-z][\w-]*)/g) ?? []).length,
  ];
  const a = count(bare);
  const b = inner ? count(inner) : [0, 0, 0];
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/**
 * 这条选择器命不命中输入条里的 📎（`form.dlg-input > button.dlg-attach`）。
 * 只看最后一个复合选择器：带 `.dlg-attach` 的命中；只写 `button` 的也命中，
 * 除非它自己 `:not(.dlg-attach)` 排除掉了。带状态伪类（`:disabled` 等）的不算。
 */
function hitsAttach(sel: string): boolean {
  const last = sel.split(/[\s>]+/).pop() ?? "";
  if (/:(disabled|hover|focus|active)/.test(last)) return false;
  if (/:not\(\.dlg-attach\)/.test(last)) return false;
  if (last.includes(".dlg-attach")) return true;
  return /^button/.test(last) && sel.includes(".dlg-input");
}

/** 按特指度（同分取靠后那条）算出某个属性在 📎 上最终生效的声明。 */
function winningDecl(prop: string): { selector: string; value: string } | undefined {
  let best: { selector: string; value: string; spec: [number, number, number] } | undefined;
  for (const r of rules()) {
    if (!hitsAttach(r.selector)) continue;
    const m = [...r.body.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "g"))].pop();
    if (!m) continue;
    const spec = specificity(r.selector);
    if (!best || spec[0] > best.spec[0] || (spec[0] === best.spec[0] && (spec[1] > best.spec[1] || (spec[1] === best.spec[1] && spec[2] >= best.spec[2])))) {
      best = { selector: r.selector, value: m[1].trim(), spec };
    }
  }
  return best && { selector: best.selector, value: best.value };
}

describe("对话输入条：放得下、也顶不出去", () => {
  it("主栏写了 min-height: 0——不写的话对话一长它就按内容撑高，输入条被顶到导航底下", () => {
    const rule = rules().find((r) => r.selector === ".dlg-main");
    assert.ok(rule, "找不到 .dlg-main 这条规则");
    assert.match(
      rule.body,
      /min-height:\s*0/,
      "`.dlg-main` 缺 `min-height: 0`：flex 子项的自动最小尺寸是内容的最小尺寸而不是 0，" +
        "主栏会按内容撑出视口，`.dlg-list` 于是不再滚动、输入条被推到看不见的地方",
    );
  });

  it("输入框显式写了 min-width: 0——不写的话 flex 压不动它，整行顶破视口", () => {
    const rule = rules().find((r) => r.selector === ".dlg-input input");
    assert.ok(rule, "找不到 .dlg-input input 这条基础规则");
    assert.match(
      rule.body,
      /min-width:\s*0/,
      "`.dlg-input input` 缺 `min-width: 0`：表单控件的自动最小尺寸约 20 个字符宽，`flex: 1` 压不过它",
    );
  });

  /*
   * 第四条：📎 身上**最终生效**的 padding 必须是 0。
   *
   * `.dlg-attach` 那条里原本就写着 `padding: 0`，但它（0,1,0）压不过 `.dlg-input button`
   * （0,1,1），从来没生效过——border-box 下 50px 的方钮里 44px 是内边距，内容盒只剩 6px，
   * 字形整个溢到右边，看起来就是"图标没水平居中"（2026-09-11 手机实拍）。
   * 所以这条不看"有没有写 padding: 0"，看的是**按特指度算下来谁赢**。
   */
  it("📎 身上最终生效的 padding 是 0，不是发送键那份 12px 22px", () => {
    const winner = winningDecl("padding");
    assert.ok(winner, "没有任何规则给 📎 设 padding？");
    assert.match(
      winner.value,
      /^0(px)?$/,
      `📎 的 padding 由 \`${winner.selector}\` 决定，值是 ${winner.value}——` +
        "它是一枚定宽方钮，任何内边距都会把字形挤出内容盒；" +
        "要压过 `.dlg-input button`，选择器至少得是 `.dlg-input .dlg-attach`",
    );
  });

  it("📎 的居中不靠内边距对称，靠 flex——下次谁再改这行的 button 也压不歪", () => {
    for (const prop of ["display", "align-items", "justify-content"] as const) {
      const w = winningDecl(prop);
      assert.ok(w, `📎 没有 ${prop} 声明`);
      assert.match(
        w.value,
        prop === "display" ? /flex/ : /center/,
        `📎 的 ${prop} 由 \`${w.selector}\` 决定，值是 ${w.value}`,
      );
    }
  });

  it("发送键的规则都排除了 .dlg-attach——否则 📎 会长成第二枚主行动", () => {
    // 命中「某个端 + 输入条里的 button」这一形状，`.dlg-attach` 自己那条不在内。
    const suspects = rules().filter(
      (r) => /\[data-surface=.+\]\s+\.dlg-input\s+button/.test(r.selector) && !r.selector.includes(".dlg-attach {"),
    );
    assert.ok(suspects.length >= 2, "两端各该有一条发送键规则，实际找到 " + suspects.length + " 条");
    for (const r of suspects) {
      assert.ok(
        r.selector.includes(":not(.dlg-attach)"),
        `选择器 \`${r.selector}\` 会连 📎 一起套上发送键的尺寸与渐变；按「发送键」写，别按「这行里的 button」写`,
      );
    }
  });
});
