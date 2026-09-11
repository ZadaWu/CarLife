/**
 * 手册图 → 段落锚定（ACR-029 第 2 步）。纯函数：MinerU 的块表进，带锚定段与出处的图列表出。
 *
 * # 为什么要自己写这一步
 *
 * MinerU 的 `content_list.json` 给每张图**在哪**（页、bbox、阅读顺序、图注），不给**它讲的是哪一段**。
 * 2026-09-11 探针（Model 3 车主手册第 8~40 页，958 块 / 158 张图）量到两件事，决定了这里的规则形状：
 *
 * 1. **图注几乎没有**：158 张图只有 1 张带 `image_caption`。靠图注锚定这条路在车主手册上走不通。
 * 2. **阅读顺序按栏不按行**：指示灯那一页的块表是「七个图标 → 七段说明」，图与说明在顺序上隔着六个块。
 *    按"相邻块"锚定会把第一枚图标锚到第七段。**必须用坐标**：图标的说明在它右边、同一行。
 *
 * # 五条规则，按置信度从高到低
 *
 * - `row`  同页同栏、在图右侧、纵向重叠的文本块——指示灯 / 按钮表那种"一图一说明"的版式。
 * - `caption`  有图注且上 / 下那段呼应了图注（「下固定钩（A）是…」）——车主手册里少见，迈锐宝有。
 * - `reference`  同栏上方最近几段里有「下图 / 如图所示」的句子，那一段（连同它上面那段）就是讲这张图的。
 * - `adjacent`  同栏上方最近的一段正文；图正好开一节（上方紧挨着标题）时取下方那段；没有同行说明的小图取下方那段；栏顶 / 栏底的图接相邻栏。
 * - `previous-page`  本页本栏没有正文（整页大图）：阅读顺序上前一个文本块。
 *
 * 每张图带 `confidence`。**锚错段比没图更糟**——检索时可以按置信度过滤，评测集（`evals/figure-anchor/`）
 * 按规则分列准确率，哪条规则不到线就改哪条。
 *
 * # 不做的事
 *
 * 不调模型——"这张图讲什么"要是靠视觉模型猜，那就是把真相源从手册挪到了模型。
 * 这里只搬手册自己的版面事实：谁挨着谁、谁在谁右边、谁提到了"下图"。
 */

/** MinerU `content_list.json` 里一块。只列用到的字段；多出来的字段照单全收、不看。 */
export interface MineruBlock {
  type: string;
  bbox: number[];
  page_idx: number;
  text?: string;
  text_level?: number;
  img_path?: string;
  image_caption?: string[];
  image_footnote?: string[];
}

export type AnchorRule = "row" | "caption" | "reference" | "adjacent" | "previous-page" | "none";

export interface FigureAnchor {
  rule: AnchorRule;
  /** 0 ~ 1。row 0.9 / caption 0.85 / reference 0.8 / adjacent 0.6（跨栏 0.5）/ previous-page 0.4 / none 0。 */
  confidence: number;
  /** 锚定段在块表里的下标；`none` 时为 null。 */
  blockIndex: number | null;
  /** 锚定段原文（reference 规则可能是两段拼起来）。 */
  text: string;
  /** 命中的引用句（reference 规则）。 */
  referenceText?: string;
}

export interface ManualFigure {
  /** `${doc}#p${page}#b${blockIndex}`——同一份 PDF 重转块序不变，id 稳定。 */
  id: string;
  doc: string;
  /** 原 PDF 的页序号（1 起）。 */
  page: number;
  /** 页面上印的页码（正文里「请参阅 xx 页码 14」引用的就是它）；块表里没有就用 page。 */
  printedPage: string;
  /** 给出处用：`第 N 页`。 */
  location: string;
  blockIndex: number;
  bbox: number[];
  imgPath: string;
  /** 图片文件名里的内容哈希（MinerU 按内容命名），同一枚图标在多页出现时相同。 */
  imageKey: string;
  /** icon：小图（指示灯、按钮）；figure：插图 / 截图。按短边占页宽比例分。 */
  kind: "icon" | "figure";
  caption: string;
  footnote: string;
  /** 最近的标题链（一级 → 二级），不含文档名。 */
  headings: string[];
  /** `文档 › 章 › 节`，与切片面包屑同一形状。 */
  breadcrumb: string;
  anchor: FigureAnchor;
}

export interface AnchorOptions {
  /** 文档名，面包屑第一级。 */
  doc: string;
  /** 块表来自拆段转换时，本段第一页在原 PDF 里的页序号 − 1（第 1 段 0，第 2 段 180…）。 */
  pageOffset?: number;
  /** 图的长边不超过页宽的这个比例 → icon。探针：特斯拉指示灯 40~90 单位 / 页宽 ~950，迈锐宝的竖长指示灯到 153 / 页宽 998；插图 ≥ 200。 */
  iconMaxRatio?: number;
}

/** 「所示」单独不算——「显示」「如上所示」到处都是；要带着「图」字。 */
const REFERENCE_RE = /下图|如图|见图|参阅图|按图|图中|插图|图所示/;
const NOTE_RE = /^注[:：]/;
const BULLET_RE = /^([•·▪\-*]|\d{1,2}[.、)])\s*/;
const DOC_TITLE_FOOTER_RE = /用户手册|车主手册|owner'?s manual|^model\s/i;
/** 像标题的标题：至少一个汉字，或三个以上字母。`0-83%`（截图里的电量数字）被 MinerU 标成了二级标题，不能拿它判"图开了一节"。 */
const REAL_HEADING_RE = /[一-鿿]|[A-Za-z]{3,}/;
const CJK = "\\u3000-\\u303F\\u4E00-\\u9FFF\\uFF00-\\uFFEF";
const CJK_GAP_RE = new RegExp(`(?<=[${CJK}])[ \\t]+(?=[${CJK}])`, "g");

/** 与 `cleanMineruMarkdown` 同两条规则：剥上下标标签、压掉汉字间的空格。块文本不含图片引用，其余不需要。 */
export function cleanBlockText(text: string): string {
  return text.replace(/<\/?(sub|sup)>/g, "").replace(CJK_GAP_RE, "").replace(/\s+/g, " ").trim();
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const box = (b: MineruBlock): Box => ({ x0: b.bbox[0], y0: b.bbox[1], x1: b.bbox[2], y1: b.bbox[3] });
const isText = (b: MineruBlock): boolean => b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0;
const isHeading = (b: MineruBlock): boolean => isText(b) && typeof b.text_level === "number" && b.text_level >= 1;
const isBody = (b: MineruBlock): boolean => isText(b) && !isHeading(b);
const isRealHeading = (b: MineruBlock): boolean => isHeading(b) && REAL_HEADING_RE.test(b.text!);
const textOf = (b: MineruBlock): string => cleanBlockText(b.text ?? "");

/**
 * 一页分几栏。文本块左边界排序后，**每一个**超过页宽 15% 的空当都是栏界（分界在空当中点）；
 * 空当两侧各要有至少两块。探针：特斯拉两栏页的空当是页宽的 35~45%，迈锐宝三栏页两个空当各 ~29%，
 * 单栏页里最大的空当不到 5%；栏内的缩进（列表项、居中的「警告」框标题）不超过 12%——中间留得够宽，不用调参。
 * 返回栏界列表（空 = 单栏）。
 */
export function columnSplits(pageBlocks: readonly MineruBlock[], pageWidth: number): number[] {
  const all = pageBlocks.filter(isText).map((b) => b.bbox[0]);
  const xs = [...new Set(all)].sort((a, b) => a - b);
  if (all.length < 4) return [];
  const out: number[] = [];
  for (let i = 1; i < xs.length; i += 1) {
    const gap = xs[i] - xs[i - 1];
    // 两侧各要有至少两**块**（不是两个不同的左边界）：一栏里几段都顶着同一个 x 起笔是常态（迈锐宝第 2-29 页右栏三段都在 710）
    const left = all.filter((x) => x < xs[i]).length;
    const right = all.length - left;
    // 空当特别宽（≥ 25% 页宽，只可能是栏界）时一侧只有一块也算：迈锐宝第 2-29 页右栏整栏就一段字、其余是图
    const wide = gap >= pageWidth * 0.25 && left >= 1 && right >= 1;
    if ((gap >= pageWidth * 0.15 && left >= 2 && right >= 2) || wide) out.push((xs[i] + xs[i - 1]) / 2);
  }
  return out;
}

const overlapY = (a: Box, b: Box): number => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
const centerY = (a: Box): number => (a.y0 + a.y1) / 2;

/** 主入口。块表按原顺序传入；返回每张图一条，顺序同块表。 */
export function anchorFigures(blocks: readonly MineruBlock[], opts: AnchorOptions): ManualFigure[] {
  const pageOffset = opts.pageOffset ?? 0;
  const iconMaxRatio = opts.iconMaxRatio ?? 0.16;
  const pageWidth = Math.max(1, ...blocks.map((b) => b.bbox?.[2] ?? 0));

  // 按页分组（保留块表下标）
  const pages = new Map<number, number[]>();
  blocks.forEach((b, i) => {
    if (!Array.isArray(b.bbox) || b.bbox.length < 4) return;
    const list = pages.get(b.page_idx) ?? [];
    list.push(i);
    pages.set(b.page_idx, list);
  });

  const splitsOf = new Map<number, number[]>();
  for (const [p, idx] of pages) splitsOf.set(p, columnSplits(idx.map((i) => blocks[i]), pageWidth));
  const colOf = (b: MineruBlock): number => {
    const splits = splitsOf.get(b.page_idx) ?? [];
    // 图按中心判栏（指示灯常贴在栏的左沿，左边界会落在空当里）；文本按左边界。
    const x = b.type === "image" ? (b.bbox[0] + b.bbox[2]) / 2 : b.bbox[0];
    return splits.filter((sp) => x >= sp).length;
  };

  const printedPageOf = (p: number): string | undefined => {
    for (const i of pages.get(p) ?? []) {
      const b = blocks[i];
      if (b.type === "page_number" && b.text && /^\d{1,4}$/.test(b.text.trim())) return b.text.trim();
    }
    return undefined;
  };

  /** 章名：本页或之前最近一页的页脚里、不是文档名的那一个（车主手册章名只印在单数页页脚）。 */
  const chapterOf = (p: number): string | undefined => {
    for (let q = p; q >= 0; q -= 1) {
      for (const i of pages.get(q) ?? []) {
        const b = blocks[i];
        const t = b.text?.trim() ?? "";
        if (b.type === "footer" && t.length >= 2 && t.length <= 20 && !DOC_TITLE_FOOTER_RE.test(t)) return t;
      }
    }
    return undefined;
  };

  /** 从某个块往前找最近的二级、再往前找一级标题。 */
  const headingsBefore = (from: number): string[] => {
    let h2: string | undefined;
    let h1: string | undefined;
    for (let i = from; i >= 0; i -= 1) {
      const b = blocks[i];
      if (!isHeading(b)) continue;
      const t = textOf(b);
      if (t.length > 40 || t.length < 2) continue;
      // 页眉里的文档名（「MODEL 3 2024+ 用户手册」）和被标成标题的列表项（「1. 按下右滚轮按钮。」）都不是节名
      if (DOC_TITLE_FOOTER_RE.test(t) || BULLET_RE.test(t)) continue;
      if (b.text_level === 1) {
        h1 = t;
        break;
      }
      if (!h2) h2 = t;
    }
    return [h1, h2].filter((x): x is string => Boolean(x));
  };

  const out: ManualFigure[] = [];
  blocks.forEach((b, i) => {
    if (b.type !== "image" || !Array.isArray(b.bbox) || b.bbox.length < 4) return;
    const I = box(b);
    const w = I.x1 - I.x0;
    const h = I.y1 - I.y0;
    const kind: ManualFigure["kind"] = Math.max(w, h) <= pageWidth * iconMaxRatio ? "icon" : "figure";
    const col = colOf(b);
    const samePage = (pages.get(b.page_idx) ?? []).filter((j) => j !== i);
    const sameCol = samePage.filter((j) => colOf(blocks[j]) === col);

    let anchor: FigureAnchor = { rule: "none", confidence: 0, blockIndex: null, text: "" };

    // ── row：右侧同行 ──────────────────────────────────────────
    if (kind === "icon" || w <= pageWidth * 0.35) {
      const tol = h * 0.3;
      let best: { j: number; ov: number; dc: number } | undefined;
      for (const j of sameCol) {
        const t = blocks[j];
        if (!isBody(t)) continue;
        const T = box(t);
        if (T.x0 < I.x1 - pageWidth * 0.01) continue; // 要在图右边
        if (T.x0 - I.x1 > pageWidth * 0.12) continue; // 且挨着（隔着一栏的不算）
        const ov = overlapY(I, T);
        if (ov < -tol) continue;
        const dc = Math.abs(centerY(I) - centerY(T));
        if (!best || ov > best.ov || (ov === best.ov && dc < best.dc)) best = { j, ov, dc };
      }
      if (best) {
        anchor = { rule: "row", confidence: best.ov >= h * 0.5 ? 0.9 : 0.7, blockIndex: best.j, text: textOf(blocks[best.j]) };
      }
    }

    // ── reference / adjacent：同栏上下的正文 ────────────────────
    if (anchor.rule === "none") {
      const above = sameCol
        .filter((j) => isBody(blocks[j]) && blocks[j].bbox[3] <= I.y0 + h * 0.1)
        .sort((a, c) => blocks[c].bbox[3] - blocks[a].bbox[3]); // 最近的在前
      const below = sameCol
        .filter((j) => isBody(blocks[j]) && blocks[j].bbox[1] >= I.y1 - h * 0.1)
        .sort((a, c) => blocks[a].bbox[1] - blocks[c].bbox[1]);
      // 阅读顺序上的前一个正文块（可能在左栏底部，也可能在上一页）
      let prevInOrder = -1;
      for (let j = i - 1; j >= 0; j -= 1) {
        if (isBody(blocks[j])) {
          prevInOrder = j;
          break;
        }
      }

      // 阅读顺序上的下一个正文块（栏底的图接下一栏开头那段）
      let nextInOrder = -1;
      for (let j = i + 1; j < blocks.length; j += 1) {
        if (isBody(blocks[j])) {
          nextInOrder = j;
          break;
        }
      }
      const nextSamePage = nextInOrder >= 0 && blocks[nextInOrder].page_idx === b.page_idx ? nextInOrder : -1;
      const prevSamePage = prevInOrder >= 0 && blocks[prevInOrder].page_idx === b.page_idx ? prevInOrder : -1;

      const ref = above.slice(0, 3).find((j) => REFERENCE_RE.test(blocks[j].text!));
      const refBelow = below.slice(0, 2).find((j) => /上图|上面的图/.test(blocks[j].text!));
      // 图注被上下哪段呼应（「下固定钩」这张图的图注是「下固定钩」，下面那段以「下固定钩（A）是…」开头）
      const captionKey = (b.image_caption ?? []).map((c) => cleanBlockText(c).replace(/[\d\s()（）]/g, "")).find((c) => c.length >= 2);
      const echo = captionKey ? [below[0], above[0]].find((j) => j !== undefined && textOf(blocks[j]).includes(captionKey)) : undefined;
      if (echo !== undefined) {
        anchor = { rule: "caption", confidence: 0.85, blockIndex: echo, text: textOf(blocks[echo]) };
      } else if (ref !== undefined) {
        const refText = textOf(blocks[ref]);
        // 「注：下图仅作示范…」这种句子本身不讲图，讲图的是它上面那段——两段一起当锚段。
        // 上面那段是列表项时再往上找引出列表的那句（「您还可以通过下列任何方法…」），列表项单拎出来不成句。
        let text = refText;
        if (NOTE_RE.test(refText)) {
          const rest = above.slice(above.indexOf(ref) + 1);
          const intro = rest.find((j) => !BULLET_RE.test(blocks[j].text!.trim())) ?? rest[0];
          if (intro !== undefined) text = `${textOf(blocks[intro])}\n${refText}`;
        }
        anchor = { rule: "reference", confidence: 0.8, blockIndex: ref, text, referenceText: refText };
      } else if (refBelow !== undefined) {
        anchor = { rule: "reference", confidence: 0.8, blockIndex: refBelow, text: textOf(blocks[refBelow]), referenceText: textOf(blocks[refBelow]) };
      } else if (above.length || below.length || prevInOrder >= 0) {
        // 图正好开一节：上方紧挨着的是标题而不是正文 → 讲它的是下面那段
        const nearestHeadingAbove = sameCol
          .filter((j) => isRealHeading(blocks[j]) && blocks[j].bbox[3] <= I.y0 + h * 0.1)
          .sort((a, c) => blocks[c].bbox[3] - blocks[a].bbox[3])[0];
        const opensSection = nearestHeadingAbove !== undefined && (above.length === 0 || blocks[nearestHeadingAbove].bbox[3] > blocks[above[0]].bbox[3]);
        let pick: number;
        let confidence = 0.6;
        let rule: AnchorRule = "adjacent";
        if (kind === "icon") {
          /*
           * 没有同行说明的小图（迈锐宝那种「标题 → 居中的指示灯图标 → 说明」版式，2026-09-11 第 4-17 页）：
           * 讲它的是下面那段；栏底没有下面就接下一栏开头（第 2-27 页「下固定钩符号」）；都没有才取上面那段。
           */
          if (below.length) pick = below[0];
          else if (nextSamePage >= 0) {
            pick = nextSamePage;
            confidence = 0.5;
          } else if (above.length) pick = above[0];
          else if (prevSamePage >= 0) {
            pick = prevSamePage;
            confidence = 0.5;
          } else {
            pick = prevInOrder;
            rule = "previous-page";
            confidence = 0.4;
          }
        } else if (opensSection && below.length) pick = below[0];
        else if (above.length) pick = above[0];
        else if (below.length && !NOTE_RE.test(blocks[below[0]].text!.trim())) {
          // 图在一栏的最顶上、上方没有标题：下面紧跟的是正文就是讲它的（迈锐宝第 2-2 页头枕按钮插图）；
          // 下面是「注：…」才接上一栏末尾那段（特斯拉第 24 页「从车内打开车门」的插图）
          pick = below[0];
          confidence = 0.55;
        } else if (prevSamePage >= 0) {
          pick = prevSamePage;
          confidence = 0.5;
        } else if (below.length) pick = below[0];
        else {
          pick = prevInOrder;
          rule = "previous-page";
          confidence = 0.4;
        }
        anchor = { rule, confidence, blockIndex: pick, text: textOf(blocks[pick]) };
      }
    }

    const page = pageOffset + b.page_idx + 1;
    const printedPage = printedPageOf(b.page_idx) ?? String(page);
    const headings = headingsBefore(anchor.blockIndex ?? i);
    const chapter = chapterOf(b.page_idx);
    const crumbs = [opts.doc, chapter, ...headings].filter((x, k, arr): x is string => Boolean(x) && arr.indexOf(x) === k).slice(0, 4);
    const imgPath = b.img_path ?? "";
    out.push({
      id: `${opts.doc}#p${page}#b${i}`,
      doc: opts.doc,
      page,
      printedPage,
      location: `第 ${printedPage} 页`,
      blockIndex: i,
      bbox: [...b.bbox],
      imgPath,
      imageKey: imgPath.replace(/^.*\//, "").replace(/\.[a-z0-9]+$/i, ""),
      kind,
      caption: (b.image_caption ?? []).join(" ").trim(),
      footnote: (b.image_footnote ?? []).join(" ").trim(),
      headings,
      breadcrumb: crumbs.join(" › "),
      anchor,
    });
  });
  return out;
}

/** 给文本向量与上下文用的一段：面包屑 + 图注 + 锚段。上限 400 字——向量接口对长文不敏感，上下文里要短。 */
export function figureText(f: ManualFigure, maxChars = 400): string {
  const parts = [f.breadcrumb, f.caption, f.footnote, f.anchor.text].filter(Boolean);
  const s = parts.join("\n");
  return s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s;
}

/** 按规则分列计数——评测与 `kb:figures` 的打印共用。 */
export function anchorStats(figs: readonly ManualFigure[]): Record<AnchorRule, number> & { icons: number; figures: number } {
  const s = { row: 0, caption: 0, reference: 0, adjacent: 0, "previous-page": 0, none: 0, icons: 0, figures: 0 };
  for (const f of figs) {
    s[f.anchor.rule] += 1;
    if (f.kind === "icon") s.icons += 1;
    else s.figures += 1;
  }
  return s;
}
