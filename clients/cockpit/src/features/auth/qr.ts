/**
 * 最小 QR 码编码器（施工单 M49-04，F-56-07）。**零依赖，手写。**
 *
 * # 为什么手写而不是 `pnpm add qrcode`
 *
 * 本仓引入依赖要先立 ACR 变更单并经人工确认，而 M49 只批了 keyring 一个
 * （ACR-011）。
 * QR 编码是 ISO/IEC 18004 定死的确定性算法，输入还只有一种形状（32 位十六进制的 deviceId），
 * 不需要通用库的多模式/多版本/logo 那些能力。
 *
 * # 为什么非画不可
 *
 * M48-05 的车机绑定屏只显示一串裸 deviceId，注释里写着"二维码要等图形库"。
 * 那不是"体验差一点"：车主得在车里对着屏幕**手抄 32 位十六进制**再输进手机，
 * 这条流程实际走不通。
 *
 * # 范围（刻意窄）
 *
 *  - 只有 **byte 模式**（deviceId 是 hex，用 alphanumeric 能更省，但省下的位数
 *    换不来任何东西——版本一样，而 byte 模式少一套分支）；
 *  - 只有 **纠错等级 M**（约 15%，车机屏离手机一臂远，够了）；
 *  - 版本 **1~10**（v3-M 就能装 42 字节，32 字节的 deviceId 绰绰有余；
 *    留到 10 是为了将来 payload 变长时不用回来改结构）。
 *
 * 超出范围就抛，**不静默截断**——截断出来的二维码扫得出，扫出来的是半个 id。
 */

/** 纠错等级 M 的每版参数：总码字、每块纠错码字、(块数 × 每块数据码字)[]。 */
interface VersionSpec {
  totalCodewords: number;
  ecPerBlock: number;
  /** [块数, 每块数据码字] 的一到两组 */
  groups: Array<[number, number]>;
  /** 对齐图案中心坐标 */
  alignment: number[];
}

const VERSIONS: Record<number, VersionSpec> = {
  1: { totalCodewords: 26, ecPerBlock: 10, groups: [[1, 16]], alignment: [] },
  2: { totalCodewords: 44, ecPerBlock: 16, groups: [[1, 28]], alignment: [6, 18] },
  3: { totalCodewords: 70, ecPerBlock: 26, groups: [[1, 44]], alignment: [6, 22] },
  4: { totalCodewords: 100, ecPerBlock: 18, groups: [[2, 32]], alignment: [6, 26] },
  5: { totalCodewords: 134, ecPerBlock: 24, groups: [[2, 43]], alignment: [6, 30] },
  6: { totalCodewords: 172, ecPerBlock: 16, groups: [[4, 27]], alignment: [6, 34] },
  7: { totalCodewords: 196, ecPerBlock: 18, groups: [[4, 31]], alignment: [6, 22, 38] },
  8: { totalCodewords: 242, ecPerBlock: 22, groups: [[2, 38], [2, 39]], alignment: [6, 24, 42] },
  9: { totalCodewords: 292, ecPerBlock: 22, groups: [[3, 36], [2, 37]], alignment: [6, 26, 46] },
  10: { totalCodewords: 346, ecPerBlock: 26, groups: [[4, 43], [1, 44]], alignment: [6, 28, 50] },
};

/** v2~v6 的数据末尾要补 7 个 remainder bit；本范围内其余版本为 0。 */
const REMAINDER_BITS: Record<number, number> = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0 };

// ── GF(256) ────────────────────────────────────────────────
// 本原多项式 0x11d，与 QR 规范一致。

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}

const gfMul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];

/** 生成多项式 g(x) = ∏(x - α^i)，i ∈ [0, degree)。 */
function generatorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]!;
      next[j + 1] ^= gfMul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon 纠错码字。 */
export function reedSolomon(data: number[], ecLen: number): number[] {
  const gen = generatorPoly(ecLen);
  const rem = new Array<number>(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0]!;
    rem.shift();
    rem.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecLen; i += 1) rem[i] ^= gfMul(gen[i + 1]!, factor);
    }
  }
  return rem;
}

// ── 数据编码 ───────────────────────────────────────────────

/** byte 模式下各版本（ECC=M）能装几个字节。 */
function capacityBytes(version: number): number {
  const spec = VERSIONS[version]!;
  const dataCodewords = spec.groups.reduce((n, [blocks, per]) => n + blocks * per, 0);
  // 4 位模式指示 + 8 位长度（v1~v9）/ 16 位（v10+）
  const headerBits = 4 + (version >= 10 ? 16 : 8);
  return dataCodewords - Math.ceil(headerBits / 8);
}

function pickVersion(byteLen: number): number {
  for (let v = 1; v <= 10; v += 1) if (capacityBytes(v) >= byteLen) return v;
  throw new Error(`QR：${byteLen} 字节超出本编码器支持的范围（最大 ${capacityBytes(10)}）`);
}

class BitWriter {
  readonly bits: number[] = [];
  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >> i) & 1);
  }
}

function encodeData(bytes: number[], version: number): number[] {
  const spec = VERSIONS[version]!;
  const dataCodewords = spec.groups.reduce((n, [blocks, per]) => n + blocks * per, 0);
  const w = new BitWriter();
  w.push(0b0100, 4); // byte 模式
  w.push(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) w.push(b, 8);

  // 终止符最多 4 位，装不下就少写几位
  const capacityBits = dataCodewords * 8;
  const terminator = Math.min(4, capacityBits - w.bits.length);
  w.push(0, terminator);
  while (w.bits.length % 8 !== 0) w.bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < w.bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j += 1) v = (v << 1) | w.bits[i + j]!;
    codewords.push(v);
  }
  // 填充码字交替 0xEC / 0x11（规范固定值）
  const pad = [0xec, 0x11];
  let k = 0;
  while (codewords.length < dataCodewords) {
    codewords.push(pad[k % 2]!);
    k += 1;
  }
  return codewords;
}

/** 分块 → 各块算 RS → 按规范交错。 */
function interleave(dataCodewords: number[], version: number): number[] {
  const spec = VERSIONS[version]!;
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (const [blocks, per] of spec.groups) {
    for (let i = 0; i < blocks; i += 1) {
      const block = dataCodewords.slice(offset, offset + per);
      offset += per;
      dataBlocks.push(block);
      ecBlocks.push(reedSolomon(block, spec.ecPerBlock));
    }
  }
  const out: number[] = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const b of dataBlocks) if (i < b.length) out.push(b[i]!);
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const b of ecBlocks) out.push(b[i]!);
  }
  return out;
}

// ── 矩阵 ───────────────────────────────────────────────────

/** -1 = 尚未填；0/1 = 模块值。`reserved` 标记功能区（不参与数据填充与掩码）。 */
interface Canvas {
  size: number;
  cells: Int8Array;
  reserved: Uint8Array;
}

const idx = (c: Canvas, x: number, y: number): number => y * c.size + x;

function setCell(c: Canvas, x: number, y: number, v: number, reserve = true): void {
  c.cells[idx(c, x, y)] = v;
  if (reserve) c.reserved[idx(c, x, y)] = 1;
}

function placeFinder(c: Canvas, ox: number, oy: number): void {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const x = ox + dx;
      const y = oy + dy;
      if (x < 0 || y < 0 || x >= c.size || y >= c.size) continue;
      const inRing = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      const isDark =
        inRing &&
        ((dx === 0 || dx === 6 || dy === 0 || dy === 6) ||
          (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      setCell(c, x, y, isDark ? 1 : 0);
    }
  }
}

function placeAlignment(c: Canvas, version: number): void {
  const centers = VERSIONS[version]!.alignment;
  for (const cy of centers) {
    for (const cx of centers) {
      // 与三个定位图案重叠的位置不放
      const nearFinder =
        (cx <= 8 && cy <= 8) || (cx <= 8 && cy >= c.size - 9) || (cx >= c.size - 9 && cy <= 8);
      if (nearFinder) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const ring = Math.max(Math.abs(dx), Math.abs(dy));
          setCell(c, cx + dx, cy + dy, ring === 1 ? 0 : 1);
        }
      }
    }
  }
}

function placeTiming(c: Canvas): void {
  for (let i = 8; i < c.size - 8; i += 1) {
    const v = i % 2 === 0 ? 1 : 0;
    setCell(c, i, 6, v);
    setCell(c, 6, i, v);
  }
}

/** 格式信息占位（真值在选完掩码后写）。 */
function reserveFormat(c: Canvas): void {
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      setCell(c, i, 8, 0);
      setCell(c, 8, i, 0);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    setCell(c, c.size - 1 - i, 8, 0);
    setCell(c, 8, c.size - 1 - i, 0);
  }
  // 固定的深色模块
  setCell(c, 8, c.size - 8, 1);
}

function reserveVersion(c: Canvas, version: number): void {
  if (version < 7) return;
  for (let i = 0; i < 18; i += 1) {
    const a = Math.floor(i / 3);
    const b = (i % 3) + c.size - 11;
    setCell(c, a, b, 0);
    setCell(c, b, a, 0);
  }
}

/** BCH(15,5)，纠错等级 M = 0b00。 */
function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

/** Golay(18,6)。 */
function versionBits(version: number): number {
  let rem = version << 12;
  for (let i = 17; i >= 12; i -= 1) {
    if ((rem >> i) & 1) rem ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | rem;
}

function writeFormat(c: Canvas, mask: number): void {
  const bits = formatBits(mask);
  const get = (i: number): number => (bits >> i) & 1;
  // 左上：竖排 + 横排
  for (let i = 0; i <= 5; i += 1) setCell(c, 8, i, get(i));
  setCell(c, 8, 7, get(6));
  setCell(c, 8, 8, get(7));
  setCell(c, 7, 8, get(8));
  for (let i = 9; i <= 14; i += 1) setCell(c, 14 - i, 8, get(i));
  // 右上 / 左下
  for (let i = 0; i <= 7; i += 1) setCell(c, c.size - 1 - i, 8, get(i));
  for (let i = 8; i <= 14; i += 1) setCell(c, 8, c.size - 15 + i, get(i));
  setCell(c, 8, c.size - 8, 1);
}

function writeVersion(c: Canvas, version: number): void {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const bit = (bits >> i) & 1;
    const a = Math.floor(i / 3);
    const b = (i % 3) + c.size - 11;
    setCell(c, a, b, bit);
    setCell(c, b, a, bit);
  }
}

const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function placeData(c: Canvas, codewords: number[], remainderBits: number): void {
  const bits: number[] = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i -= 1) bits.push((cw >> i) & 1);
  for (let i = 0; i < remainderBits; i += 1) bits.push(0);

  let bi = 0;
  let upward = true;
  for (let right = c.size - 1; right >= 0; right -= 2) {
    const col = right === 6 ? 5 : right; // 跳过竖向 timing 所在列
    if (col < 0) break;
    for (let step = 0; step < c.size; step += 1) {
      const y = upward ? c.size - 1 - step : step;
      for (const x of [col, col - 1]) {
        if (x < 0) continue;
        if (c.reserved[idx(c, x, y)]) continue;
        c.cells[idx(c, x, y)] = bi < bits.length ? bits[bi]! : 0;
        bi += 1;
      }
    }
    upward = !upward;
    if (right === 6) right -= 1; // 6 与 5 已在本轮一起处理
  }
}

function applyMask(c: Canvas, mask: number): Canvas {
  const out: Canvas = {
    size: c.size,
    cells: Int8Array.from(c.cells),
    reserved: Uint8Array.from(c.reserved),
  };
  const fn = MASKS[mask]!;
  for (let y = 0; y < c.size; y += 1) {
    for (let x = 0; x < c.size; x += 1) {
      if (out.reserved[idx(out, x, y)]) continue;
      if (fn(x, y)) out.cells[idx(out, x, y)] ^= 1;
    }
  }
  return out;
}

/** 规范的四条罚分规则。分数越低越好。 */
function penalty(c: Canvas): number {
  const n = c.size;
  const at = (x: number, y: number): number => c.cells[idx(c, x, y)]!;
  let score = 0;

  // 规则 1：同色连续 ≥5
  for (let y = 0; y < n; y += 1) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let i = 1; i < n; i += 1) {
        const cur = horizontal ? at(i, y) : at(y, i);
        const prev = horizontal ? at(i - 1, y) : at(y, i - 1);
        if (cur === prev) run += 1;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
    }
  }

  // 规则 2：2×2 同色
  for (let y = 0; y < n - 1; y += 1) {
    for (let x = 0; x < n - 1; x += 1) {
      const v = at(x, y);
      if (v === at(x + 1, y) && v === at(x, y + 1) && v === at(x + 1, y + 1)) score += 3;
    }
  }

  // 规则 3：1:1:3:1:1 图样（两个方向，前后各留 4 个浅色）
  const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x + 11 <= n; x += 1) {
      for (const pat of [P1, P2]) {
        let h = true;
        let v = true;
        for (let i = 0; i < 11; i += 1) {
          if (at(x + i, y) !== pat[i]) h = false;
          if (at(y, x + i) !== pat[i]) v = false;
        }
        if (h) score += 40;
        if (v) score += 40;
      }
    }
  }

  // 规则 4：深色比例偏离 50%
  let dark = 0;
  for (let i = 0; i < c.cells.length; i += 1) dark += c.cells[i]!;
  const pct = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

/**
 * 编码成布尔矩阵（`true` = 深色）。**不含静区**——静区由渲染层给，
 * 因为它的宽度取决于展示尺寸，而扫不出来最常见的原因就是静区被裁掉了。
 */
export function encodeQr(text: string): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = pickVersion(bytes.length);
  const spec = VERSIONS[version]!;
  const codewords = interleave(encodeData(bytes, version), version);

  const size = 17 + version * 4;
  const base: Canvas = {
    size,
    cells: new Int8Array(size * size).fill(0),
    reserved: new Uint8Array(size * size),
  };
  placeFinder(base, 0, 0);
  placeFinder(base, size - 7, 0);
  placeFinder(base, 0, size - 7);
  placeAlignment(base, version);
  placeTiming(base);
  reserveFormat(base);
  reserveVersion(base, version);
  placeData(base, codewords, REMAINDER_BITS[version] ?? 0);

  let best: Canvas | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestMask = 0;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = applyMask(base, mask);
    writeFormat(candidate, mask);
    writeVersion(candidate, version);
    const s = penalty(candidate);
    if (s < bestScore) {
      bestScore = s;
      best = candidate;
      bestMask = mask;
    }
  }
  const chosen = best!;
  writeFormat(chosen, bestMask);
  writeVersion(chosen, version);

  const out: boolean[][] = [];
  for (let y = 0; y < size; y += 1) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x += 1) row.push(chosen.cells[idx(chosen, x, y)] === 1);
    out.push(row);
  }
  // 用不到 spec 的其余字段，留个引用免得 lint 抱怨
  void spec.totalCodewords;
  return out;
}

/**
 * 渲染成一段自包含 SVG（无外部资源、无脚本）。
 *
 * `quietZone` 默认 4 模块——规范的最小值。**别为了省地方调小它**：
 * 扫不出来最常见的原因就是静区被裁掉，而那个现象看起来像"这个码是坏的"。
 */
export function qrSvg(text: string, opts: { size?: number; quietZone?: number } = {}): string {
  const matrix = encodeQr(text);
  const quiet = opts.quietZone ?? 4;
  const modules = matrix.length + quiet * 2;
  const px = opts.size ?? 320;
  const rects: string[] = [];
  for (let y = 0; y < matrix.length; y += 1) {
    for (let x = 0; x < matrix.length; x += 1) {
      if (matrix[y]![x]) rects.push(`<rect x="${x + quiet}" y="${y + quiet}" width="1" height="1"/>`);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" ` +
    `viewBox="0 0 ${modules} ${modules}" shape-rendering="crispEdges" role="img" ` +
    `aria-label="设备绑定二维码">` +
    `<rect width="${modules}" height="${modules}" fill="#fff"/>` +
    `<g fill="#000">${rects.join("")}</g></svg>`
  );
}
