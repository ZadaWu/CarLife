/**
 * 检测框进描述之前先合并：**同一类别、彼此相邻或重叠的框，是同一个符号被劈开了**。
 *
 * # 起因（2026-09-18 真机走查，turn-2db10f67）
 *
 * Tesla 屏上的驻车灯画成 `≡D D≡`——两盏灯背靠背、各带三道光线，中间有一道细缝。
 * 端上 YOLO（ACR-045）把它框成了左右两半：`[64,430,84,448]` 与 `[89,430,112,448]`，
 * 都标 `parking_lights`，置信 43% / 38%。每一半单独裁出来放大，三道光线像一个 E、
 * 中间是个 D，于是第二遍把它们如实写成「文字 含字 D」「文字 含字 DE」，目录当然对不上。
 * 一分钟前同一盏灯只框了一次、整个符号进去，描述是「符号 直线」，一路对到成对核验 same。
 *
 * 描述模型没有看错，它看到的确实是半个符号。**错在把半个符号送了进去。**
 *
 * # 判据
 *
 * 只合并**带 `symbolHint` 且 hint 相同**的项：hint 是检测器的类别名，两个相邻框同一个类别，
 * 是"同一符号被劈开"远比"两个一样的灯并排"常见——仪表上同类灯并排的情形目录里就没有
 * （左右转向是两个不同的 symbol_id）。VLM 整图检测出来的项没有 hint，不动。
 *
 * "相邻"= 各自按短边的一半外扩后相交。劈开的两半各自的高与整符号相同、宽约一半，
 * 中间那道缝远小于半个短边；而真正分开的两盏灯之间至少隔一个符号宽。
 * 迭代到没有可合并的为止（三段劈开的也能收成一个）。
 *
 * # 合并成什么
 *
 * 框取并集；置信取最高；描述子字段（shape / color / …）取置信更高那一项的。
 * 每次合并记一条 note，trace 里看得见"这一轮合并过"。
 */

import type { BBox, DetectedItem } from "./schema";

/** 外扩系数：按短边的这个比例向四周扩。0.5 = 半个短边（见文件头「判据」）。 */
export const MERGE_MARGIN_RATIO = 0.5;

function expanded(b: BBox, ratio: number): BBox {
  const m = Math.min(b[2] - b[0], b[3] - b[1]) * ratio;
  return [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
}

function intersects(a: BBox, b: BBox): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

function union(a: BBox, b: BBox): BBox {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

const fmt = (b: BBox) => `[${b.map((v) => Math.round(v)).join(",")}]`;

/**
 * 合并相邻同类框。纯函数：不改入参，返回新数组（顺序按原来第一次出现的位置）。
 * `notes` 传进来就把每次合并写一条进去。
 */
export function mergeAdjacentSameClass(items: readonly DetectedItem[], notes?: string[], ratio = MERGE_MARGIN_RATIO): DetectedItem[] {
  const out: DetectedItem[] = items.map((it) => ({ ...it, bbox: [...it.bbox] as BBox }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < out.length; i++) {
      const a = out[i];
      if (!a.symbolHint || a.category !== "warning_light") continue;
      for (let j = i + 1; j < out.length; j++) {
        const b = out[j];
        if (b.symbolHint !== a.symbolHint || b.category !== "warning_light") continue;
        if (!intersects(expanded(a.bbox, ratio), expanded(b.bbox, ratio))) continue;
        const keep = a.confidence >= b.confidence ? a : b;
        const joined: DetectedItem = { ...keep, bbox: union(a.bbox, b.bbox), confidence: Math.max(a.confidence, b.confidence) };
        notes?.push(`bbox ${fmt(a.bbox)} 与 ${fmt(b.bbox)} 同为 ${a.symbolHint} 且相邻，合并为 ${fmt(joined.bbox)}`);
        out.splice(j, 1);
        out[i] = joined;
        merged = true;
        break outer;
      }
    }
  }
  return out;
}
