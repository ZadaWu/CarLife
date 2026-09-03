/**
 * 物品贴纸与契约表的对账（施工单 M20-02）。
 *
 * # 为什么读源码与文件系统，而不是 import SPRITES
 *
 * `sprites.ts` 里是 `import x from "*.png"`——那是 Vite 的能力，
 * 本包的测试跑在 `node --import tsx` 下，一 import 就炸。
 * 而这里要守的三条恰好都不需要真的加载图片：
 *   ① 注册了却没有文件（打包时才炸，改完贴纸最容易漏的一步）；
 *   ② 有文件却没注册（图白出了，卡上永远看不到）；
 *   ③ 注册的 key 不在 `PRETRIP_ITEMS` 里（有图没名字，卡上是个无名格子）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { PRETRIP_ITEMS, WEATHER_KINDS } from "@carlife/shared";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "src");
const ASSETS = path.join(SRC, "assets-hud");

const spritesSrc = readFileSync(path.join(SRC, "hud", "sprites.ts"), "utf8");

/** 从 `import xxx from "../assets-hud/<theme>/item-<key>.png"` 里取出 key → 相对路径。 */
function importedItemSprites(): Map<string, string> {
  const out = new Map<string, string>();
  const re = /import\s+\w+\s+from\s+"(\.\.\/assets-hud\/[^"]*item-([a-z-]+)\.png)"/g;
  for (const m of spritesSrc.matchAll(re)) out.set(m[2], m[1]);
  return out;
}

test("注册的每个物品贴纸都真的有文件，且 light / dark 两份都在", () => {
  const imported = importedItemSprites();
  assert.ok(imported.size >= 8, `sprites.ts 只 import 了 ${imported.size} 个物品贴纸`);

  for (const [key, rel] of imported) {
    const abs = path.join(SRC, "hud", rel);
    assert.ok(existsSync(abs), `item-${key}.png 注册了但文件不在：${rel}`);
    for (const theme of ["light", "dark"]) {
      assert.ok(
        existsSync(path.join(ASSETS, theme, `item-${key}.png`)),
        `item-${key}.png 缺 ${theme} 主题的一份——两端共用同一批文件，缺一份就是打包报错`,
      );
    }
  }
});

test("有文件就要注册；注册的 key 必须在契约表里有名字", () => {
  const imported = importedItemSprites();

  const onDisk = readdirSync(path.join(ASSETS, "light"))
    .filter((f) => f.startsWith("item-") && f.endsWith(".png"))
    .map((f) => f.slice("item-".length, -".png".length));

  for (const key of onDisk) {
    assert.ok(imported.has(key), `assets-hud/light/item-${key}.png 没有被 sprites.ts 注册——图白出了`);
  }

  for (const key of imported.keys()) {
    // 有图没名字 = 卡上一个无名格子；名字的唯一来源是 @carlife/shared 的契约表。
    assert.ok(key in PRETRIP_ITEMS, `贴纸 item-${key} 不在 PRETRIP_ITEMS 里，没有名字可显示`);
  }
});

test("**每个天气种类都有图**（缺一个就是那种天气永远显示太阳，且不报错）", () => {
  /*
   * 断言的是**注册表的键**，不是文件名——`sunny` 的图叫 `icon-sun.png`
   * （定稿截取的历史资产，红线不改名）。按文件名断言会逼着去改那张图。
   */
  const registered = new Set<string>();
  const shared = /const WEATHER_SPRITES_SHARED = \{([^}]*)\}/.exec(spritesSrc);
  assert.ok(shared, "sprites.ts 里找不到 WEATHER_SPRITES_SHARED");
  for (const m of shared![1].matchAll(/^\s*([a-z]+):/gm)) registered.add(m[1]);
  for (const m of spritesSrc.matchAll(/weather: \{\s*([a-z]+):/g)) registered.add(m[1]);

  for (const kind of WEATHER_KINDS) {
    assert.ok(registered.has(kind), `WeatherKind「${kind}」没有注册天气图标`);
  }

  // 注册了就要有文件，两个主题各一份（打包时才炸的那类漏改）。
  const re = /import\s+\w+\s+from\s+"\.\.\/assets-hud\/[^"]*\/(icon-[a-z-]+)\.png"/g;
  const files = new Set([...spritesSrc.matchAll(re)].map((m) => m[1]));
  assert.equal(files.size, WEATHER_KINDS.length, `天气图标应有 ${WEATHER_KINDS.length} 张`);
  for (const f of files) {
    for (const theme of ["light", "dark"]) {
      assert.ok(existsSync(path.join(ASSETS, theme, `${f}.png`)), `${f}.png 缺 ${theme} 一份`);
    }
  }
});
