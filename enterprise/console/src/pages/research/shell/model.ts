/**
 * 研究面五页共用的视图模型（施工单 M82-08）。**纯函数，没有 React。**
 *
 * # 前端不算比率
 *
 * `pct` / `direction` / `suppressed` / `ci` 全部来自快照，本文件**原样透出**。
 * 它只做三件事：按列归一化强度条、把方向映射成字形、把抑制格换成一个没有明细的形状。
 *
 * 让前端自己除一次的后果是"两个页面对同一件事给出两个数"，而两边各自都能自圆其说。
 * 单测里有一条断言：给定快照，输出的 `pct` 与输入逐字节相同。
 *
 * # 方向没有颜色字段
 *
 * 本页的行**全是痛点**——"语音识别错"的提及率下降是好事，染成红色会被读成变坏
 * （Brief P3）。所以视图模型里方向只有字形，连一个 `tone` 字段都不给：
 * 给了就迟早有人用它上色。
 */

/*
 * 唯一的 import：能力条要的**语义范围**类型。
 * 引子路径不引桶——桶会把 `fingerprint.ts` 一起拉进来，而它 `import node:crypto`，
 * 浏览器侧打包会在 Rollup 阶段失败（`console/test/research-capability-imports.test.ts` 守这条）。
 */
import type { SelectionScope } from "@carlife/research/capabilities";

// ── 快照的形状（与 research-runtime 的 `data` 对齐；控制台只读不算） ──

export interface Population {
  owners: number;
  vehicles: number;
  turns: number;
}

export type GateStatus = "pass" | "degraded" | "fail";

export interface GateVerdict {
  status: GateStatus;
  reason: string;
}

export type Gates = Record<"rights" | "evidence" | "measurement" | "safety", GateVerdict>;

export interface SnapshotEnvelope<D> {
  contractId: string;
  window: { from: number; to: number };
  codebookVersion: string;
  population: Population;
  gates: Gates;
  inputsHash: string;
  computedAt: string | number;
  lens: string;
  data: D;
}

export interface EvidenceCellRaw {
  scene: string;
  n: number;
  N: number;
  pct: number;
  bar: number;
  direction: "up" | "down" | "flat";
  counter: number;
  suppressed?: boolean;
  reason?: string;
}

export interface EvidenceMatrixData {
  scenes: Array<{ code: string; label: string; N: number }>;
  rows: Array<{
    code: string;
    label: string;
    total: number;
    undeliverable: boolean;
    cells: EvidenceCellRaw[];
  }>;
  denominators: { note: string; turns: number };
  suppressed: Array<{ key: string; reason: string; vehicles: number }>;
}

export interface IpaPointRaw {
  code: string;
  label: string;
  importance: number;
  performance: number;
  n: number;
  ci: { lo: number; hi: number };
  sensitivity: "stable" | "flips";
  suppressed?: boolean;
  reason?: string;
}

export interface IpaData {
  axes: { importance: string; performance: string };
  thresholds: { importance: number; performance: number };
  points: IpaPointRaw[];
  quadrantsEnabled: boolean;
}

// ── 顶栏与门条 ──────────────────────────────────────

/** 观察总体条的四组 dt/dd。分母**三个数各写各的**——它们是三个不同的分母。 */
export interface MetaBarItem {
  label: string;
  value: string;
}

const fmt = (n: number): string => n.toLocaleString("zh-CN");

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function metaBar(snap: Pick<SnapshotEnvelope<unknown>, "population" | "window" | "codebookVersion">, locked: boolean): MetaBarItem[] {
  const days = Math.round((snap.window.to - snap.window.from) / 86_400_000);
  return [
    {
      label: "观察总体",
      value: `已授权车主 ${fmt(snap.population.owners)} 人 · 车辆 ${fmt(snap.population.vehicles)} 台 · 对话 ${fmt(snap.population.turns)} 轮`,
    },
    { label: "时间窗", value: `${day(snap.window.from)} – ${day(snap.window.to)}（近 ${days} 天）` },
    { label: "codebook", value: `v${snap.codebookVersion} · ${locked ? "已锁版" : "未锁版"}` },
    { label: "分母口径", value: "去重后轮次" },
  ];
}

/** 门条一块。`tone` 只有降级/失败才非中性——通过的保持 `--line` 竖条（Brief §3③）。 */
export interface GateTile {
  key: string;
  name: string;
  statusText: string;
  reason: string;
  tone: "neutral" | "warn" | "err";
}

const GATE_NAMES: Record<string, string> = {
  rights: "权利 Rights",
  evidence: "证据 Evidence",
  measurement: "测量 Measurement",
  safety: "安全 Safety",
};

const GATE_TEXT: Record<GateStatus, string> = { pass: "通过", degraded: "降级", fail: "未过" };

export function gateTiles(gates: Gates): GateTile[] {
  return (["rights", "evidence", "measurement", "safety"] as const).map((key) => {
    const g = gates[key];
    return {
      key,
      name: GATE_NAMES[key],
      statusText: GATE_TEXT[g.status],
      reason: g.reason,
      tone: g.status === "pass" ? "neutral" : g.status === "degraded" ? "warn" : "err",
    };
  });
}

// ── 证据矩阵 ────────────────────────────────────────

/** 方向字形。**没有颜色**，理由见文件头。 */
export const DIRECTION_GLYPH: Record<"up" | "down" | "flat", string> = { up: "↑", down: "↓", flat: "—" };

export type MatrixCell =
  | { kind: "suppressed"; reason: string }
  | {
      kind: "value";
      n: number;
      N: number;
      /** 原样来自快照，前端不再除一次。 */
      pct: number;
      /** 按**列内**最大值归一化，0–1。 */
      bar: number;
      glyph: string;
      counter: number;
      /** 0 条反例压暗——它更可能意味着没去找（Brief 原则 2）。 */
      counterDim: boolean;
    };

export interface MatrixRow {
  /** 名次。**兜底桶没有名次**，为 `null`——它不参与排名，见 `CATCH_ALL_NEED_PAIN`。 */
  index: number | null;
  code: string;
  label: string;
  total: number;
  undeliverable: boolean;
  /** 是不是那个「其它」兜底桶。页面把它画成不占名次的脚行。 */
  catchAll: boolean;
  cells: MatrixCell[];
}

export interface MatrixView {
  scenes: Array<{ code: string; label: string; N: number }>;
  rows: MatrixRow[];
  note: string;
  turns: number;
}

/**
 * 兜底桶的码。与 research-runtime 的 `CATCH_ALL_NEED_PAIN`、
 * 以及 `trend-signal/model.ts` 的 `CATCH_ALL` 是同一个码，三处都写死 `"other"`。
 *
 * 为一个三处共用的字符串常量再建一个共享包，换来的是三个包多一条依赖边；
 * 它在 codebook 里是锁版后只增不改的码，不会漂。
 */
export const CATCH_ALL_NEED_PAIN = "other";

/** 行序。**兜底桶恒在最后**，不随方向翻上来。 */
export type MatrixSortDir = "desc" | "asc";

export interface MatrixViewOptions {
  /** 「场景列设置」里被取消勾选的场景码。列是展示取舍，不影响任何格里的数。 */
  hiddenScenes?: readonly string[];
  /** 「需求 / 痛点」表头上那个排序箭头的方向，按证据总量排。 */
  sortDir?: MatrixSortDir;
}

/**
 * 快照 → 矩阵视图。
 *
 * 强度条按**列内**最大值归一化（Brief §3⑤）——快照里的 `bar` 是按行归一的，
 * 页面要的是按列比较"这个场景里哪个需求最突出"。两者都对，但要的是列。
 * 全零列不除零。
 *
 * # 隐藏列不改归一化基准
 *
 * 归一化按整列取最大，与哪些列可见无关——不然勾掉一列会让**别的列**的条形长度变，
 * 而那些列的数字一个都没动。列的显隐是取舍，不是筛选。
 */
export function matrixView(data: EvidenceMatrixData, opts: MatrixViewOptions = {}): MatrixView {
  const hidden = new Set(opts.hiddenScenes ?? []);
  const colMax = data.scenes.map((_, i) =>
    Math.max(0, ...data.rows.map((r) => (r.cells[i]?.suppressed ? 0 : (r.cells[i]?.pct ?? 0)))),
  );

  const keep = data.scenes.map((s) => !hidden.has(s.code));

  // 名次在**过滤与排序之前**定：它是"按证据总量排第几"，
  // 勾掉一列不该让第 3 名变成第 2 名。
  let rank = 0;
  const rows: MatrixRow[] = data.rows.map((r) => {
    const catchAll = r.code === CATCH_ALL_NEED_PAIN;
    if (!catchAll) rank += 1;
    return {
      index: catchAll ? null : rank,
      code: r.code,
      label: r.label,
      total: r.total,
      undeliverable: r.undeliverable,
      catchAll,
      cells: r.cells.flatMap((c, ci): MatrixCell[] => {
        if (!keep[ci]) return [];
        if (c.suppressed) return [{ kind: "suppressed", reason: c.reason ?? "样本不足" }];
        const max = colMax[ci] ?? 0;
        return [
          {
            kind: "value",
            n: c.n,
            N: c.N,
            pct: c.pct,
            bar: max === 0 ? 0 : c.pct / max,
            glyph: DIRECTION_GLYPH[c.direction],
            counter: c.counter,
            counterDim: c.counter === 0,
          },
        ];
      }),
    };
  });

  // 快照给的就是降序，所以只有升序要重排；兜底桶两个方向都留在最后。
  const ordered =
    opts.sortDir === "asc"
      ? [
          ...rows.filter((r) => !r.catchAll).sort((a, b) => a.total - b.total),
          ...rows.filter((r) => r.catchAll),
        ]
      : rows;

  return {
    scenes: data.scenes.filter((_, i) => keep[i]),
    turns: data.denominators.turns,
    note: data.denominators.note,
    rows: ordered,
  };
}

/**
 * CSV 导出：**只含聚合值**。
 *
 * 表头写死在这里并有单测断言——加一列 `text` 之类的东西会让"导出"
 * 变成一条绕过所有展示层约束的原文出口。
 */
export const CSV_HEADER = ["need_pain", "scene", "n", "N", "pct", "direction", "counter"] as const;

export function matrixCsv(view: MatrixView): string {
  const lines: string[] = [CSV_HEADER.join(",")];
  for (const row of view.rows) {
    row.cells.forEach((cell, i) => {
      const scene = view.scenes[i]?.code ?? "";
      if (cell.kind === "suppressed") {
        lines.push([row.code, scene, "", "", "", "", ""].join(","));
        return;
      }
      lines.push([row.code, scene, cell.n, cell.N, cell.pct.toFixed(4), cell.glyph, cell.counter].join(","));
    });
  }
  return `${lines.join("\n")}\n`;
}

// ── 重要度 × 表现度 ──────────────────────────────────

export interface IpaView {
  /** 口径声明，原样上图。没声明时 measurement 门降级、象限底色关掉。 */
  basisText: string;
  thresholds: { importance: number; performance: number };
  quadrantsEnabled: boolean;
  points: Array<{
    code: string;
    label: string;
    importance: number;
    performance: number;
    n: number;
    ci: { lo: number; hi: number };
    flips: boolean;
  }>;
  /** 阈值附近会翻象限的点——敏感性读数那一条 banner。 */
  flipping: string[];
  /** 「高重要 · 低表现」候选表：重要度高于阈值且表现度低于阈值。 */
  candidates: Array<{ code: string; label: string; importance: number; performance: number; n: number }>;
}

const BASIS_LABEL: Record<string, string> = {
  "mention-proxy": "提及代理",
  "turn-resolved-heuristic": "该轮解决率（启发式）",
};

export function ipaView(data: IpaData): IpaView {
  const points = data.points
    .filter((p): p is IpaPointRaw => !p.suppressed)
    .map((p) => ({
      code: p.code,
      label: p.label,
      importance: p.importance,
      performance: p.performance,
      n: p.n,
      ci: p.ci,
      flips: p.sensitivity === "flips",
    }));

  return {
    basisText: `重要度：${BASIS_LABEL[data.axes.importance] ?? data.axes.importance} · 表现度：${
      BASIS_LABEL[data.axes.performance] ?? data.axes.performance
    }`,
    thresholds: data.thresholds,
    quadrantsEnabled: data.quadrantsEnabled,
    points,
    flipping: points.filter((p) => p.flips).map((p) => p.label),
    candidates: points
      .filter((p) => p.importance >= data.thresholds.importance && p.performance < data.thresholds.performance)
      .sort((a, b) => b.importance - a.importance)
      .map(({ code, label, importance, performance, n }) => ({ code, label, importance, performance, n })),
  };
}

// ── 置信构成 ────────────────────────────────────────

export interface ConfidenceBar {
  key: string;
  label: string;
  value: number;
  lowest: boolean;
}

const CONF_LABEL: Record<string, string> = {
  coverage: "Coverage",
  quality: "Quality",
  agreement: "Agreement",
  triangulation: "Triangulation",
  freshness: "Freshness",
};

/** 五项横条，**最低项标出来**——"当前置信 0.62"没有用，"哪一项最低"才有。 */
export function confidenceBars(c: Record<string, unknown>): ConfidenceBar[] {
  const lowest = typeof c.lowest === "string" ? c.lowest : "";
  return ["coverage", "quality", "agreement", "triangulation", "freshness"].map((key) => ({
    key,
    label: CONF_LABEL[key],
    value: typeof c[key] === "number" ? (c[key] as number) : 0,
    lowest: key === lowest,
  }));
}

// ── 503 两分型 ──────────────────────────────────────

export interface UnavailableView {
  title: string;
  detail: string;
  hint: string;
}

/**
 * 「没配」与「没起」要说成两句话。
 * 前者是配置（这个部署没启用），后者是运维（服务该起没起）——
 * 合成一句"服务不可用"的话，看的人不知道该去改配置还是去起进程。
 */
export function unavailableView(code: string): UnavailableView | null {
  if (code === "research_not_configured") {
    return {
      title: "本部署没有研究面",
      detail: "RESEARCH_RUNTIME_URL 没有配置——这个部署没有启用用户研究功能。",
      hint: "要启用：后台「配置」页填 http://localhost:8800，并 corepack pnpm dev:restart research-runtime",
    };
  }
  if (code === "research_unreachable") {
    return {
      title: "研究服务未启动",
      detail: "配置了地址但连不上——research-runtime 该起没起，或它自己起不来。",
      hint: "corepack pnpm dev:restart research-runtime；看日志 corepack pnpm dev:logs research-runtime",
    };
  }
  return null;
}

// ── 证据矩阵的选中与详情（M82-11） ──────────────────────────

/**
 * 矩阵的选中。**默认是格，不是行。**
 *
 * 这一页的主角是「某个需求码在某个场景下」这个交叉——行只是它的边缘合计。
 * 一开始做成整行选中，抽屉于是只能说"这一行在 5 个场景下共 16 条证据"，
 * 而那句话恰恰是矩阵里最没有信息量的一个数：它把场景差异抹平了，
 * 而场景差异正是这张表存在的理由。
 *
 * 整行 / 整列仍然可选，但要显式点行名或列头——那是"看边缘分布"的动作，
 * 与"看这一格"是两件事，不该共用一个点击目标。
 */
export type MatrixSelection =
  | { kind: "cell"; row: number; col: number }
  | { kind: "row"; row: number }
  | { kind: "col"; col: number };

/** 抽屉里「话语 × 行为」那一节的话语侧。行为侧要等快照补字段。 */
export interface DiscourseFacts {
  n: number;
  N: number;
  pct: number;
  /**
   * `n/N` 能不能当**比例**读。
   *
   * 单格可以：分子是该码在该场景的证据数，分母是该场景去重轮次。
   * 整行 / 整列**不行**——一轮可同时归入多个场景、也可同时挂多个需求码，
   * 所以把各格的 n 相加会重复计数，和 N 相除得到的数可以超过 100%
   * （实测保养维修列 270/273 = 99%，再多一个码就破百）。
   * 那个百分号会被读成"99% 的保养维修轮次在说这件事"，而那句话是错的。
   * 所以这里为 false 时**只出两个绝对数，不出百分比**。
   */
  rateMeaningful: boolean;
  /** 方向字形，与格内同一个来源。 */
  glyph: string;
  counter: number;
}

export interface MatrixDetail {
  selection: MatrixSelection;
  /** 抽屉标题。格选 = 需求码；列选 = 场景名。 */
  title: string;
  /** 标题下那行小字：这次选的是什么口径。 */
  scope: string;
  /** 被抑制的格：只说抑制，不给任何明细。 */
  suppressedReason: string | null;
  /** 话语侧事实。整列选中时是该列的合计，整行选中时是跨场景合计。 */
  facts: DiscourseFacts | null;
  /** 整行 / 整列选中时的逐项分解（格选为空数组）。 */
  breakdown: Array<{ label: string; n: number; N: number; pct: number; suppressed: boolean }>;
  /** 是否落在硬禁范畴。 */
  undeliverable: boolean;
  /**
   * 选中的是兜底桶。抽屉要把它说破：这一格不是一件具体的事，
   * 它是「归不上现有码」的合计——照着它派活会派出一个没有对象的需求。
   */
  catchAll: boolean;
}

const pctOf = (n: number, N: number): number => (N === 0 ? 0 : n / N);

/**
 * 选中 → 抽屉视图模型。**纯函数，不碰 DOM、不发请求。**
 *
 * 越界的选中回 null 而不是抛：选中态存在组件里，而行数会随人群筛选变，
 * 变短之后旧下标就越界了——那种时候应当什么都不显示，不是白屏。
 */
export function matrixDetail(view: MatrixView, sel: MatrixSelection): MatrixDetail | null {
  if (sel.kind === "col") {
    const scene = view.scenes[sel.col];
    if (!scene) return null;
    const rows = view.rows.map((r) => ({ row: r, cell: r.cells[sel.col] }));
    // 列合计不能把被抑制的格算进去——它们的明细在快照里就已经清空了，
    // 当成 0 会让这一列看起来比实际小，而那是个说不清来源的数。
    const visible = rows.filter((x) => x.cell?.kind === "value");
    const n = visible.reduce((a, x) => a + (x.cell as { n: number }).n, 0);
    const counter = visible.reduce((a, x) => a + (x.cell as { counter: number }).counter, 0);
    return {
      selection: sel,
      title: scene.label,
      scope: `整列 · 该场景下 ${view.rows.length} 个需求码，其中 ${rows.length - visible.length} 个因样本不足被抑制`,
      suppressedReason: null,
      // 码次之和，不是去重轮次——所以 rateMeaningful = false
      facts: { n, N: scene.N, pct: pctOf(n, scene.N), rateMeaningful: false, glyph: "—", counter },
      breakdown: rows.map((x) => ({
        label: x.row.label,
        n: x.cell?.kind === "value" ? x.cell.n : 0,
        N: scene.N,
        pct: x.cell?.kind === "value" ? x.cell.pct : 0,
        suppressed: x.cell?.kind !== "value",
      })),
      undeliverable: false,
      catchAll: false,
    };
  }

  const row = view.rows[sel.row];
  if (!row) return null;

  if (sel.kind === "row") {
    const visible = row.cells.filter((c) => c.kind === "value") as Array<
      Extract<MatrixCell, { kind: "value" }>
    >;
    const n = visible.reduce((a, c) => a + c.n, 0);
    const N = visible.reduce((a, c) => a + c.N, 0);
    return {
      selection: sel,
      title: row.label,
      scope:
        `整行 · ${view.scenes.length} 个场景合计。一轮可同时归入多个场景，` +
        `所以这里的分子分母都是各列相加、**不是去重值**，两者相除不是提及率`,
      suppressedReason: null,
      facts: {
        n,
        N,
        pct: pctOf(n, N),
        rateMeaningful: false,
        glyph: "—",
        counter: visible.reduce((a, c) => a + c.counter, 0),
      },
      breakdown: row.cells.map((c, i) => ({
        label: view.scenes[i]?.label ?? `列 ${i + 1}`,
        n: c.kind === "value" ? c.n : 0,
        N: c.kind === "value" ? c.N : (view.scenes[i]?.N ?? 0),
        pct: c.kind === "value" ? c.pct : 0,
        suppressed: c.kind !== "value",
      })),
      undeliverable: row.undeliverable,
      catchAll: row.catchAll,
    };
  }

  const scene = view.scenes[sel.col];
  const cell = row.cells[sel.col];
  if (!scene || !cell) return null;

  if (cell.kind === "suppressed") {
    return {
      selection: sel,
      title: row.label,
      scope: `${scene.label} · 这一格`,
      suppressedReason: cell.reason,
      facts: null,
      breakdown: [],
      undeliverable: row.undeliverable,
      catchAll: row.catchAll,
    };
  }

  return {
    selection: sel,
    title: row.label,
    scope: `${scene.label} · 这一格`,
    suppressedReason: null,
    // 单格是唯一一处 n/N 真的是比例的地方：分母就是该场景的去重轮次
    facts: { n: cell.n, N: cell.N, pct: cell.pct, rateMeaningful: true, glyph: cell.glyph, counter: cell.counter },
    breakdown: [],
    undeliverable: row.undeliverable,
    catchAll: row.catchAll,
  };
}

/**
 * 选中下标 → **语义范围**（施工单 M85-04）。
 *
 * # 为什么必须在这里翻一次
 *
 * `MatrixSelection` 是 `{row: 2, col: 0}` 这样的下标，只在某一次渲染里有意义：
 * 行序会随人群筛选变，变完之后同一个 `row: 2` 指的是另一个需求码。
 * 把下标发给后端等于发一个**会过期的引用**，而过期之后它照样能解析成某一行
 * ——于是能力跑在了别的码上，一句报错都没有。所以后端只认码。
 *
 * 越界回 `null` 而不是抛，与 `matrixDetail` 同一条取舍（那时该什么都不显示，不是白屏）。
 */
export function selectionScope(view: MatrixView, sel: MatrixSelection): SelectionScope | null {
  if (sel.kind === "col") {
    const scene = view.scenes[sel.col];
    return scene ? { kind: "col", sceneCode: scene.code } : null;
  }

  const row = view.rows[sel.row];
  if (!row) return null;

  if (sel.kind === "row") {
    /*
     * 整行的"被抑制"是**每一格都被抑制**，不是有一格被抑制。
     * 只要还剩一格有明细，这一行上的能力就有东西可读；
     * 反过来一格都不剩时，行级能力拿到的会是一个全空的行——
     * 而那正是 G1 要挡的那种输入。
     */
    const suppressed = row.cells.length > 0 && row.cells.every((c) => c.kind === "suppressed");
    return { kind: "row", needPainCode: row.code, catchAll: row.catchAll, suppressed };
  }

  const scene = view.scenes[sel.col];
  const cell = row.cells[sel.col];
  if (!scene || !cell) return null;

  return {
    kind: "cell",
    needPainCode: row.code,
    sceneCode: scene.code,
    suppressed: cell.kind === "suppressed",
    catchAll: row.catchAll,
    // 方向字形是唯一来源；`—` 是持平，持平不算"有方向"。
    hasDirection: cell.kind === "value" && cell.glyph !== DIRECTION_GLYPH.flat,
  };
}
