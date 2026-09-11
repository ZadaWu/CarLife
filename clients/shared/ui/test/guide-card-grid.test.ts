/**
 * 导览页的四张卡是**一张 2×2 网格**：上行（时间轴 / 路线）与下行（休憩 / 避雷）
 * 必须用同一套列宽，四条竖边逐像素对齐。
 *
 * # 为什么要守
 *
 * 这两行原来各写各的：`.guide-screen__body` 是 `1.25fr 1fr`、`.guide-screen__comfort`
 * 是 `1fr 1fr`。四张卡于是没有一条竖边对得上，而**每一行自己看都很正常**——
 * 只有把上下两张卡放在一起看才露馅（用户 2026-09-11 反馈"四个卡片的宽度是不一样的"）。
 * 这类错最容易在下次"顺手调一下左栏宽一点"时复发，因为改一行不会让另一行报错。
 *
 * 另外钉住方向：定稿 `guide-spot-v1.png` 实测左 803 / 右 1027（2048 基准），
 * **右边的路线卡更宽**。实现一度是反的（左 1.25 : 右 1）。
 *
 * 本包没有 jsdom，渲染不了组件：读 CSS 源码，守的是"两行共用同一个变量"。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("../src/guide/guide.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** 所有规则 → [选择器, 声明块]（选择器取最后一行，与本包其它守卫同一读法）。 */
const RULES: Array<[string, string]> = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [
  m[1].trim().split("\n").pop()!.trim(),
  m[2],
]);

function declsFor(cls: string, prop: string): string[] {
  const out: string[] = [];
  /*
   * ⚠️ 类名要**整词**匹配。标定这条时踩过一次假红：`includes("guide-screen__comfort")`
   * 把 `.guide-screen__comfort-block` 也算了进来，于是卡片自己的 padding-gap
   * 被当成了这一行的列间距。
   */
  const hit = new RegExp(`\\.${cls}(?![\\w-])`);
  for (const [sel, body] of RULES) {
    if (!hit.test(sel)) continue;
    for (const d of body.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "g"))) {
      out.push(d[1].trim());
    }
  }
  return out;
}

describe("导览页四张卡共用一套列宽", () => {
  it("两行的 grid-template-columns 都只写 var(--guide-cols)", () => {
    for (const cls of ["guide-screen__body", "guide-screen__comfort"]) {
      const cols = declsFor(cls, "grid-template-columns");
      assert.ok(cols.length > 0, `${cls} 没有列宽声明？`);
      assert.deepEqual(
        [...new Set(cols)],
        ["var(--guide-cols)"],
        `${cls} 自己写死了列宽——两行各写各的，四张卡的竖边就对不上了`,
      );
    }
  });

  it("两行的列间距也只走 var(--guide-gap)", () => {
    for (const cls of ["guide-screen__body", "guide-screen__comfort"]) {
      const gaps = declsFor(cls, "gap");
      assert.deepEqual(
        [...new Set(gaps)],
        ["var(--guide-gap)"],
        `${cls} 单独设了 gap：上下两行间距不同，列宽对齐也就白对了`,
      );
    }
  });

  it("默认列宽照定稿：右边的路线卡比左边的时间轴宽", () => {
    const def = declsFor("guide-screen", "--guide-cols")[0];
    assert.ok(def, "找不到 --guide-cols 的缺省值");
    const nums = [...def.matchAll(/(\d+(?:\.\d+)?)fr/g)].map((m) => Number(m[1]));
    assert.equal(nums.length, 2, `--guide-cols 应该是两列：${def}`);
    assert.ok(
      nums[1] > nums[0],
      `定稿 guide-spot-v1.png 实测左 803 / 右 1027，右栏更宽；现在是 ${def}`,
    );
    const ratio = nums[0] / nums[1];
    assert.ok(
      Math.abs(ratio - 803 / 1027) < 0.03,
      `列宽比偏离定稿（应 ≈ ${(803 / 1027).toFixed(3)}，现在 ${ratio.toFixed(3)}）`,
    );
  });
});
