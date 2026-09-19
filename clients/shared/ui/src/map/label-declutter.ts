/**
 * 名字标签的**碰撞消隐**（2026-09-16 走查第五轮：「很多沿途服务的地点集中在一个区域」）。
 *
 * 沿途服务是按停靠点周边搜来的，密集是常态而不是意外：一条商业街上十几家餐饮挨着，
 * 放出名字就是几块白药丸互相压着，每一块都只露出半行——**十个名字叠在一起的信息量
 * 低于一个名字**，因为一个都读不全（走查截图里「相邻里酸菜鱼饭」压在「…手撕面」上，
 * 两家店名都没读全）。
 *
 * 地图通行的解法是 label decluttering：名字按优先级逐块摆，**摆不下的不摆**，
 * 用户推近一档、点位散开，被挤掉的自己就回来了。这里照做，两条与本仓已有纪律一致的取舍：
 *
 * - **只藏名字，不藏图标。** 图标回答的是"这附近有几个"，藏掉就是在谎报密度；
 *   名字回答"具体是哪家"，读不全的那块本来就没在回答。
 * - **优先级取加入顺序**，不取"离屏幕中心近"。后者每拖动一下就换一批幸存者，
 *   在车机上是满屏闪烁；加入顺序是稳定的（各类目里离停靠点近的在前），
 *   同一批点位不论怎么平移，留下的都是同一批。
 *
 * 独立成纯函数的理由同 `fit-avoid.ts`：真实几何要浏览器里的 AMap，而"该留哪几块"
 * 这件事本身是纯算术，能被逐条验算。
 */

/** 一块标签在视口坐标系里占的矩形（`getBoundingClientRect` 的子集）。 */
export interface LabelBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DeclutterOptions {
  /** 两块标签之间至少要留出的空隙（CSS 像素）；贴着算压上。 */
  gap: number;
  /** 最多同时显示几块——碰撞判定之外的第二道闸，防的是"散开但铺满一屏"。 */
  max: number;
}

/** 名字摆在图标的哪一边。`null` = 两边都摆不下，这一块不摆。 */
export type LabelSlot = "below" | "above";

/** 先试下方（默认位），下方被占再试上方。两边都不行才不摆。 */
const SLOTS: readonly LabelSlot[] = ["below", "above"];

export interface LabelCandidate {
  below: LabelBox | null;
  above: LabelBox | null;
}

export interface LabelScene {
  /** 每个点的两个候选位；下标与 `icons` 严格对齐。 */
  cands: ReadonlyArray<LabelCandidate>;
  /**
   * 每个点**自己**那枚图标。名字要绕开**别人的**图标——
   * 走查第六轮的两张图都是这个：名字压在旁边那个点的叉子上，图标认不出是哪一类了。
   * 判定时按下标排除自己那一枚（名字本来就贴在自己图标下面）。
   */
  icons: ReadonlyArray<LabelBox | null>;
  /**
   * 不属于这一层、但名字必须绕开的东西：行程胶囊。
   * 服务点的**图标**可以盖在胶囊上（M93-05 有意为之，否则全程视野下一个点都露不出来），
   * 但**文字盖文字**是另一回事——两行字叠在一起，两行都读不成。
   */
  blockers: ReadonlyArray<LabelBox | null>;
  /** 可见区（右边界已减掉抽屉）。 */
  bounds: LabelBox;
}

/** 两块矩形是否压在一起（含 `gap` 的余量）。 */
function hits(a: LabelBox, b: LabelBox, gap: number): boolean {
  return (
    a.left - gap < b.right && b.left - gap < a.right && a.top - gap < b.bottom && b.top - gap < a.bottom
  );
}

/** 整块都在可见区内才算数：半块露在外面的名字读不全，占着名额不如让给完整的那块。 */
function inside(box: LabelBox, bounds: LabelBox): boolean {
  return (
    box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom
  );
}

/** 量不到尺寸的（还没上图、被祖先 `display:none`）当"没有这块"。 */
function sized(box: LabelBox | null): box is LabelBox {
  return box !== null && box.right > box.left && box.bottom > box.top;
}

/**
 * 逐块判定：这一块名字摆哪边、还是不摆。返回与 `scene.cands` **等长**的数组（下标对齐）。
 *
 * 一块名字要摆下去，得同时满足四条：整块在可见区内、不压别人的图标、不压行程胶囊、
 * 不压已经摆好的名字。先试下方，下方不行试上方——**给它第二个位置**是这里唯一的
 * "努力"：点位挤成一团时，只有一个候选位的话几乎每块都摆不下，屏幕上一个名字都没有
 * 同样不是用户要的。
 */
export function placeLabels(scene: LabelScene, opts: DeclutterOptions): Array<LabelSlot | null> {
  const { cands, icons, blockers, bounds } = scene;
  const out: Array<LabelSlot | null> = cands.map(() => null);
  const placed: LabelBox[] = [];
  for (let i = 0; i < cands.length; i += 1) {
    if (placed.length >= opts.max) break;
    for (const slot of SLOTS) {
      const box = cands[i]?.[slot] ?? null;
      if (!sized(box)) continue;
      if (!inside(box, bounds)) continue;
      if (blockers.some((b) => sized(b) && hits(b, box, opts.gap))) continue;
      // 排除自己那一枚：名字本来就贴着自己的图标，压的只可能是别人的。
      if (icons.some((ic, j) => j !== i && sized(ic) && hits(ic, box, opts.gap))) continue;
      if (placed.some((p) => hits(p, box, opts.gap))) continue;
      out[i] = slot;
      placed.push(box);
      break;
    }
  }
  return out;
}
