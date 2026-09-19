/**
 * [F-20-06][AC-20-2] 观察卡上那一列图标必须是**手册里那枚**（2026-09-18 用户走查）。
 *
 * 此前每一条画的都是同一个三角感叹号，只按颜色着色——于是「安全带未系」与「胎压报警」
 * 在屏幕上一模一样，而那正是车主一眼要分辨的东西。现在按 `symbolId` 取手册目录里的图
 * （`data/kb-src/icons/tesla-model3/<symbolId>.png` 缩到 96px）。
 *
 * 读源码与目录，不渲染（本包无 jsdom）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";

const LAMPS = readFileSync(new URL("../src/features/service/lamps.ts", import.meta.url), "utf8");
const GUIDED = readFileSync(new URL("../src/features/service/guided.tsx", import.meta.url), "utf8");
const DEMO = readFileSync(new URL("../src/features/service/demo.ts", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../src/features/service/diagnosis.css", import.meta.url), "utf8");
const DIR = new URL("../src/features/service/assets/lamps/", import.meta.url);
/** 手册图标目录的表：`symbol_id` 这一列就是观察层能给出的全部符号。 */
const CATALOG = readFileSync(new URL("../../../data/kb-src/icons/tesla-model3-indicators.md", import.meta.url), "utf8");
/**
 * 目录里有表、但当初抽图时漏掉的符号。
 *
 * 端上这一枚是拿评测集的合成字形抠底、换成手册那支绿补的（见 `lamps.ts` 文件头）。
 * 写在这里是为了让"补过"这件事有据可查：手册那张图补回来之后，把它从这张表里划掉。
 */
const FILLED_IN = ["fog_lamp_front"];

const onDisk = readdirSync(DIR).filter((f) => f.endsWith(".png")).map((f) => f.slice(0, -4)).sort();
const inMap = [...LAMPS.matchAll(/^ {2}([a-z0-9_]+): /gm)].map((m) => m[1]).sort();

describe("[F-20-06][AC-20-2] symbolId → 手册图标：表与文件一一对上", () => {
  /**
   * 少一边不会报错，只会让某个符号在观察卡上退回三角块——而那正是这次要修的毛病，
   * 静默复发的路必须先堵上。
   */
  it("表里的键与目录里的文件逐一相等", () => {
    assert.deepEqual(inMap, onDisk, "lamps.ts 的键与 assets/lamps 下的文件名必须完全一致");
    assert.ok(onDisk.length >= 20, `手册目录有 27 个符号，端上只带了 ${onDisk.length} 个`);
  });

  /**
   * **按目录的表对，不是按目录里的图片文件对。**
   *
   * 观察层能给出的符号来自那张表；只对文件的话，表里加了一行而图没抽出来时，
   * 端上会安静地退回三角块——那正是这次要修的毛病。
   */
  it("目录表里的每个 symbol_id 端上都有图", () => {
    const rows = [...CATALOG.matchAll(/^\|\s*`?([a-z][a-z0-9_]+)`?\s*\|/gm)].map((m) => m[1]).filter((id) => id !== "symbol_id");
    const missing = rows.filter((id) => !onDisk.includes(id));
    assert.deepEqual(missing, [], `目录里这些符号端上没图：${missing.join("、")}（切一张 sips -Z 96，或补进 FILLED_IN 并说明来源）`);
    for (const id of FILLED_IN) assert.ok(rows.includes(id), `${id} 已经不在目录表里了，端上这枚补图可以删`);
  });

  it("走查那两盏灯都在：安全带未系、胎压报警", () => {
    for (const id of ["seatbelt_unfastened", "tpms_warning"]) {
      assert.ok(onDisk.includes(id), `缺 ${id}`);
    }
  });
});

describe("接线：观察卡取图，取不到才回落", () => {
  it("LampGlyph 按 symbolId 取图，有图就画图", () => {
    assert.match(GUIDED, /const art = lampArt\(item\.symbolId\);/);
    assert.match(GUIDED, /art \? \(\s*<img className="dx-lamp__art"/);
  });

  it("取不到仍有回落，不留破图", () => {
    assert.ok(GUIDED.includes("<svg viewBox=\"0 0 24 24\">"), "回落的三角块还在");
  });

  it("图标按比例放，不拉伸——手册图标宽高比从 219×256 到 488×256 都有", () => {
    assert.match(CSS, /\.dx-lamp__art \{[^}]*object-fit: contain/);
  });

  it("演示数据也带真 symbolId：版式截图走的就是这条路", () => {
    assert.match(DEMO, /symbolId: "seatbelt_unfastened"/);
  });
});
