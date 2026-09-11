/**
 * 对话层给底部导航药丸让位，必须引用 `--hud-bottom-nav-clear`，不能各写各的常数。
 *
 * 这三条（列表底部、输入条外边距、「有新消息」浮标）曾经是 82 / 84 / 150 三个手写数。
 * 2026-09-10 把药丸往下挪了 14pt，它们一个都没跟着动——**表现是输入条与药丸之间
 * 凭空多出一条空白**，而且没有任何东西会报错：三个数各自都还"看起来挺合理"。
 *
 * 变量定义在 `clients/shared/ui/src/hud/hud.css`（药丸偏移 + 底部安全区 + 栏体高），
 * 那边由 `bottom-nav-clear.test.ts` 守它与真实盒子对得上。
 *
 * 读文件不渲染：`clients/mobile` 没有 jsdom，要守的是"有没有写这一条"。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

/* 先剥注释再匹配：上面那段解释里同样写着变量名，不剥的话守的是注释还在不在。 */
const CSS = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** 取某条规则最后一次出现的声明块。 */
function body(selector: string): string {
  const hits = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
    (m) => m[1].trim().split("\n").pop()!.trim() === selector,
  );
  assert.ok(hits.length > 0, `找不到规则 ${selector}`);
  return hits[hits.length - 1][2];
}

const CLEAR = "var(--hud-bottom-nav-clear)";

describe("对话层让开底部导航：一律用 --hud-bottom-nav-clear", () => {
  for (const [selector, prop] of [
    [".dlg-list", "padding-bottom"],
    [".dlg-input", "margin-bottom"],
    [".dlg-newmsg", "bottom"],
  ] as const) {
    it(`${selector} 的 ${prop} 引用了 ${CLEAR}`, () => {
      const decls = body(selector);
      const m = decls.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`));
      assert.ok(m, `${selector} 没有声明 ${prop}`);
      assert.ok(
        m[1].includes(CLEAR),
        `${selector} 的 ${prop} 写成了 \`${m[1].trim()}\`：药丸一挪它不会跟着动，` +
          `改用 ${CLEAR} 再加上你要的那点间距`,
      );
    });
  }

  it("让位里不再第二次加底部安全区——安全区已经在 clear 里了", () => {
    for (const selector of [".dlg-list", ".dlg-input", ".dlg-newmsg"]) {
      const decls = body(selector);
      assert.ok(
        !/env\(safe-area-inset-bottom\)/.test(decls),
        `${selector} 又加了一次 env(safe-area-inset-bottom)：` +
          `真机上会与 ${CLEAR} 里的那一份叠出约 34pt 空白`,
      );
    }
  });
});
