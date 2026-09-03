/**
 * [F-07-03][AC-07-2] 样式里引用的每个 CSS 变量都必须真实存在。
 *
 * 守的是一类**静默**故障：`var(--不存在的名字, fallback)` 不报错、不警告，
 * 只是永远吃 fallback。表现是"切主题时这几块原地不动"，而 fallback 又几乎总是
 * 深色优先写的，于是浅色手机上出现白描边配白卡、浅蓝横带这类怪相。
 *
 * 2026-09-02 全仓审计出 39 个这样的名字——`ownership.css` 一个文件 11 个，
 * 登录门 7 个（其中一个直接导致 iOS 把输入辅助条画成浅色，被当成"底部有空白"报上来）。
 *
 * 读文件不渲染：`clients/mobile` 没有 jsdom，要守的是 token 名对不对得上。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOTS = [
  fileURLToPath(new URL("../src", import.meta.url)),
  fileURLToPath(new URL("../../shared/ui/src", import.meta.url)),
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const FILES = ROOTS.flatMap((r) => walk(r));
const STYLES = FILES.filter((f) => f.endsWith(".css"));

/**
 * 全部定义源：CSS 声明 + JS 侧的 `setProperty("--x", …)`。
 * 少算后者会把运行时注入的变量（如贴边夹持的 --clamp-x）全部误报成缺失。
 */
const DEFINED: ReadonlySet<string> = new Set(
  FILES.filter((f) => /\.(css|tsx?|)$/.test(f)).flatMap((f) => {
    const t = readFileSync(f, "utf8");
    return [
      ...Array.from(t.matchAll(/(--[\w-]+)\s*:/g), (m) => m[1]),
      ...Array.from(t.matchAll(/["'](--[\w-]+)["']/g), (m) => m[1]),
    ];
  }),
);

function referenced(css: string): string[] {
  return [...new Set(Array.from(css.matchAll(/var\(\s*(--[\w-]+)/g), (m) => m[1]))];
}

describe("[F-07-03] CSS 变量都有定义", () => {
  for (const file of STYLES) {
    const short = file.slice(file.lastIndexOf("/src/") + 1);
    it(`${short} 引用的 token 都存在`, () => {
      const missing = referenced(readFileSync(file, "utf8")).filter((t) => !DEFINED.has(t));
      assert.deepEqual(missing, [], `全仓没有定义：${missing.join(", ")}`);
    });
  }

  /* 判据自身要有效：定义集若为空，上面每条都会假绿。 */
  it("定义集不为空（否则上面全是假绿）", () => {
    assert.ok(DEFINED.has("--hud-text"), "至少要认出主题里的 --hud-text");
    assert.ok(DEFINED.size > 50, `定义集只有 ${DEFINED.size} 个，扫描八成没跑对`);
  });
});

describe("[F-07-03] 登录门不留 fallback", () => {
  /*
   * 单独对登录门加严：它是第一屏，也是这次踩坑的原点。
   * 留着 fallback 就等于给下次拼错名字准备了藏身处——上面那条测试也会因此失效。
   */
  it("var() 一律不带 fallback", () => {
    const css = readFileSync(new URL("../src/features/auth/login.css", import.meta.url), "utf8");
    const withFallback = Array.from(css.matchAll(/var\(\s*--[\w-]+\s*,/g), (m) => m[0]);
    assert.deepEqual(withFallback, []);
  });
});
