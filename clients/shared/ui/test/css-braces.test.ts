/**
 * 每张样式表的大括号必须配平，且任何位置都不能出现多余的 `}`。
 *
 * 2026-09-11 真机踩到：hud.css 里 `@media` 块尾多了一个 `}`，样式表**照样加载、零报错**，
 * 只是紧跟在后面的 `.hud-statusbar { position: fixed … }` 被解析器连同那个多余的 `}` 一起
 * 吞掉——底部状态栏于是失去定位，掉进普通文档流，表现是「底部工具栏消失了、东西都跑到顶上去了」，
 * 离根因非常远。这种错在走查截图里只有一块区域不对，很容易当成别的问题去追。
 *
 * 判据只看括号，不做完整解析：先剥注释与字符串（`content: "}"` 这种合法写法不算），
 * 再逐字数深度——深度落到负数就是多了 `}`，收尾不为 0 就是少了。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...cssFiles(p));
    else if (name.endsWith(".css")) out.push(p);
  }
  return out;
}

/** 剥掉注释与引号内的内容，剩下的括号才是结构。 */
function structural(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
}

describe("样式表大括号配平", () => {
  for (const file of cssFiles(SRC)) {
    const rel = file.slice(SRC.length);
    it(`${rel}：没有多余的 }，也没有少的`, () => {
      const text = structural(readFileSync(file, "utf8"));
      let depth = 0;
      let line = 1;
      for (const ch of text) {
        if (ch === "\n") line += 1;
        else if (ch === "{") depth += 1;
        else if (ch === "}") {
          depth -= 1;
          assert.ok(depth >= 0, `${rel} 第 ${line} 行附近多了一个 }：它会把紧跟着的那条规则一起吞掉`);
        }
      }
      assert.equal(depth, 0, `${rel} 收尾时还有 ${depth} 个 { 没关上`);
    });
  }
});
