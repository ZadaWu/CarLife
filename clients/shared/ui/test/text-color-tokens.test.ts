/**
 * 文字颜色必须走设计系统的 token，不许在样式里写死色值。
 *
 * 用户 2026-09-11 的原话：「总感觉文字颜色有时候和设计系统不一致」。查下来确实如此：
 * `.hud-tripmark__meta` 写着 `#5b7699`（设计系统的次要文字是 `#6C8BB0`）、
 * 四处写着 `#b26a00` / `#a35400` / `#8a4b00` 三种谁也不是的琥珀（`status/warn` 是 `#B8730F`）、
 * 对话层的错误横幅写着 `#f85149`（GitHub 的红，`status/danger` 是 `#C0392B`）。
 * 它们**各自看起来都像那么回事**，只有并排放到设计系统旁边才露馅——而且一切主题就全部原地不动。
 *
 * # 判据
 *
 * `clients/shared/ui/src` 下所有 CSS 的 `color:` 声明，值必须是 `var(--hud-…)`、`inherit`、
 * `currentColor` 或 `transparent`。写死的色值只允许出现在下面这张**点名清单**里——
 * 每一条都写着为什么允许；清单只能变短，不能变长（要加新的写死颜色，先回答"为什么没有 token"）。
 *
 * 读文件不渲染：本包没有 jsdom，守的是"写没写 token"。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/**
 * 仍写死的 `color:`（选择器 → 值），每条带理由。
 *
 * - 出发卡 `.cabin-depart-card*`：那张卡是照深色底设计的一整套取色，手机端在 app.css 里逐支覆盖过；
 *   拆成 token 是另一单（它的浅蓝 / 雾白在两套主题里都没有对应名字）。
 * - 蓝底 / 绿底 / 黑底上的白字：`--hud-badge-text` 是"琥珀底上的字"，在深色主题里是深褐，
 *   压在蓝、绿、黑上就错了；这几处的白是跟着自己的底色走的。
 * - `.audit-pill--ok #1e9e6a`：design-system.md §4.3 点名的「已确认 / 畅通」深色文字，
 *   文档说 `--hud-ok`（#2FBF9B）只能做底片与图标，这个深色版还没有 token（§8 待补）。
 */
const ALLOWED: ReadonlyArray<readonly [string, string]> = [
  [".cabin-depart-card__kicker", "#8fd8ff"],
  [".cabin-depart-card h2", "#fff"],
  [".cabin-depart-card__stops li", "#dcecff"],
  [".cabin-depart-card__energy", "#ffd9a0"],
  [".cabin-depart-card__primary", "#35240a"],
  [".cabin-depart-card__ghost", "#cfe4ff"],
  [".cabin-depart-card__hint", "#93b1d4"],
  [".cabin-depart-card__plan-strategy", "#8fd8ff"],
  [".cabin-depart-card__plan-stops", "#dcecff"],
  [".cabin-depart-card__plan-summary", "#ffd9a0"],
  [".cabin-depart-card__plan-caveats", "#93b1d4"],
  [".dlg-input--viewing button", "#fff"],
  [".dlg-newmsg", "#fff"],
  [".dlg-input button", "#fff"],
  [".dlg-att__video-placeholder", "#fff"],
  [".dlg-att__play", "#111"],
  [".dlg-att__lightbox-hint", "rgba(255, 255, 255, 0.7)"],
  [".audit-pill--ok", "#1e9e6a"],
  [".hud-highlights__rank", "#fff"],
  [".hud-tripmark__guided", "#fff"],
  [".hud-navbar__end", "#fff"],
  [".hud-statusbar__gauge-charging", "#fff"],
];

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) cssFiles(p, out);
    else if (name.endsWith(".css")) out.push(p);
  }
  return out;
}

const TOKEN_OR_KEYWORD = /^(var\(--hud-[a-z0-9-]+\)|inherit|currentColor|transparent)$/;

function hardcodedColors(): Array<{ file: string; selector: string; value: string }> {
  const out: Array<{ file: string; selector: string; value: string }> = [];
  for (const file of cssFiles(SRC)) {
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].trim().split("\n").pop()!.trim();
      for (const d of m[2].matchAll(/(?:^|;)\s*color\s*:\s*([^;]+)/g)) {
        const value = d[1].trim();
        if (!TOKEN_OR_KEYWORD.test(value)) out.push({ file: relative(SRC, file), selector, value });
      }
    }
  }
  return out;
}

describe("文字颜色走设计系统 token", () => {
  it("写死的 color: 只有点名清单里那几条", () => {
    const found = hardcodedColors();
    const allowed = new Set(ALLOWED.map(([s, v]) => `${s}|${v}`));
    const offenders = found.filter((f) => !allowed.has(`${f.selector}|${f.value}`));
    assert.deepEqual(
      offenders.map((f) => `${f.file}: ${f.selector} → ${f.value}`),
      [],
      "这些文字颜色绕过了 token（design-system.md §4）；对应关系：正文 --hud-text、次要 --hud-text-muted、" +
        "待定/缓行的深色字 --hud-warn、拥堵/读不到 --hud-danger、琥珀底上的字 --hud-badge-text",
    );
  });

  it("点名清单没有过期条目——修掉一条就从清单里删一条", () => {
    const found = new Set(hardcodedColors().map((f) => `${f.selector}|${f.value}`));
    const stale = ALLOWED.filter(([s, v]) => !found.has(`${s}|${v}`));
    assert.deepEqual(
      stale.map(([s, v]) => `${s} → ${v}`),
      [],
      "清单里这些已经不在样式表里了，删掉——留着的话清单会越来越像一份没人看的例外表",
    );
  });
});
