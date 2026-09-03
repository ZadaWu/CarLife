/**
 * 手写 QR 编码器的用例（施工单 M49-04，[F-56-07][AC-56-2]）。
 *
 * # 判据不是"画出来了"，是"解码器会认"
 *
 * 一个结构对、纠错码算错的二维码在肉眼下与正确的**完全一样**，
 * 而它扫不出来——这正是 ADR-002 那类"看起来做完了"的失败。
 * 所以这里的核心用例是 **RS 校验子为零**：拿解码器的算法去验编码器。
 * 只要纠错码字错一位，校验子就非零。
 *
 * 真扫码枪那一关是走查 W6 的人工判据，用例代替不了；
 * 但用例能保证送到人面前的不是一个必然扫不出的东西。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeQr, qrSvg, reedSolomon } from "../src/features/auth/qr";

// ── GF(256)，与被测实现同一本原多项式；独立写一遍，不 import 它的内部 ──
const EXP: number[] = [];
const LOG: number[] = new Array(256).fill(0);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]!;
}
const mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

/** 把码字当多项式，在 α^0..α^(ecLen-1) 处求值。全零 = 无错。 */
function syndromes(codewords: number[], ecLen: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < ecLen; i += 1) {
    let acc = 0;
    for (const c of codewords) acc = mul(acc, EXP[i]!) ^ c;
    out.push(acc);
  }
  return out;
}

const DEVICE_ID = "9f2c4a7b1d8e0356af41b90c7d2e5681";

describe("[F-56-07][AC-56-2] QR 编码器", () => {
  it("Reed-Solomon：数据 + 纠错拼起来后校验子全零（解码器视角）", () => {
    const data = Array.from({ length: 44 }, (_v, i) => (i * 7 + 3) & 0xff);
    const ec = reedSolomon(data, 26);
    assert.equal(ec.length, 26);
    assert.deepEqual(
      syndromes([...data, ...ec], 26),
      new Array(26).fill(0),
      "校验子非零 = 纠错码字算错了，而这种码肉眼看不出来、扫码枪一定拒",
    );
  });

  it("Reed-Solomon：篡改一个字节，校验子立刻非零（证明上一条不是恒真）", () => {
    const data = Array.from({ length: 44 }, (_v, i) => (i * 7 + 3) & 0xff);
    const ec = reedSolomon(data, 26);
    const tampered = [...data, ...ec];
    tampered[10] = (tampered[10]! ^ 0x01) & 0xff;
    assert.ok(
      syndromes(tampered, 26).some((s) => s !== 0),
      "改了一位却仍然全零，说明校验子这条检查本身是假的",
    );
  });

  it("32 位 hex 的 deviceId 落在 v3（29×29）", () => {
    const m = encodeQr(DEVICE_ID);
    assert.equal(m.length, 29, "v3 = 17 + 3*4");
    assert.equal(m[0]!.length, 29, "必须是正方形");
  });

  it("三个定位图案在位（7×7 回字）", () => {
    const m = encodeQr(DEVICE_ID);
    const n = m.length;
    for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]] as const) {
      assert.equal(m[oy]![ox], true, "外环左上角是深色");
      assert.equal(m[oy + 1]![ox + 1], false, "第二环是浅色");
      assert.equal(m[oy + 3]![ox + 3], true, "3×3 芯是深色");
      assert.equal(m[oy + 6]![ox + 6], true, "外环右下角是深色");
    }
  });

  it("定位图案外侧有分隔带（整圈浅色）", () => {
    const m = encodeQr(DEVICE_ID);
    for (let i = 0; i <= 7; i += 1) {
      assert.equal(m[7]![i], false, `(${i},7) 应是分隔带`);
      assert.equal(m[i]![7], false, `(7,${i}) 应是分隔带`);
    }
  });

  it("timing 图案是严格的深浅交替", () => {
    const m = encodeQr(DEVICE_ID);
    for (let i = 8; i < m.length - 8; i += 1) {
      assert.equal(m[6]![i], i % 2 === 0, `横向 timing 在 x=${i} 错了`);
      assert.equal(m[i]![6], i % 2 === 0, `纵向 timing 在 y=${i} 错了`);
    }
  });

  it("v3 的对齐图案在 (22,22)，5×5 且中心深色", () => {
    const m = encodeQr(DEVICE_ID);
    assert.equal(m[22]![22], true, "中心");
    assert.equal(m[21]![22], false, "中心外一环是浅色");
    assert.equal(m[20]![22], true, "最外环是深色");
  });

  it("固定深色模块在 (8, size-8)", () => {
    const m = encodeQr(DEVICE_ID);
    assert.equal(m[m.length - 8]![8], true);
  });

  it("确定性：同一输入两次产出完全一致", () => {
    assert.deepEqual(encodeQr(DEVICE_ID), encodeQr(DEVICE_ID));
  });

  it("不同输入产出不同矩阵（不是把内容丢了画个固定图案）", () => {
    const a = encodeQr(DEVICE_ID);
    const b = encodeQr(DEVICE_ID.slice(0, 31) + "0");
    assert.notDeepEqual(a, b, "改一个字符矩阵却没变 = 内容根本没进去");
  });

  it("深色占比落在合理区间（掩码选对了才会）", () => {
    const m = encodeQr(DEVICE_ID);
    const dark = m.flat().filter(Boolean).length;
    const pct = (dark * 100) / (m.length * m.length);
    assert.ok(pct > 35 && pct < 65, `深色占比 ${pct.toFixed(1)}% 偏离太多`);
  });

  it("超长输入**抛错**，不静默截断", () => {
    assert.throws(() => encodeQr("x".repeat(400)), /超出本编码器支持的范围/);
  });

  it("SVG 自包含：无外部资源、无脚本，且带 4 模块静区", () => {
    const svg = qrSvg(DEVICE_ID);
    assert.match(svg, /^<svg /);
    assert.ok(!svg.includes("<script"), "不许有脚本");
    // 只有 xmlns 那一处 http（命名空间不是网络请求），此外不得有任何外链形态。
    for (const forbidden of ["<image", "href=", "url(", "@import"]) {
      assert.ok(!svg.includes(forbidden), `不许出现 ${forbidden}——车机可能没有网`);
    }
    assert.equal(svg.match(/https?:\/\//g)?.length, 1, "只应有 xmlns 那一处 URL");
    // 29 模块 + 两侧各 4 = 37
    assert.match(svg, /viewBox="0 0 37 37"/, "静区少了的话现象是'这个码是坏的'");
  });
});
