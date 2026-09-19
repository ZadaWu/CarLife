/**
 * analyst 与 taxonomist 的五个只读工具（施工单 M89-01，设计稿 §4）。
 *
 * # 文件按"定义归属"分，不按 ACL 分
 *
 * 这里是**读已经算好的东西**的那一族：镜头快照、主题、按码取证、码表与一致率。
 * 其中三个同时挂在 taxonomist 名下（`codebookLookup` / `themeMembers` /
 * `agreementReport`），`evidenceByCode` 还挂着 archivist——
 * 一个工具属于谁只看它自己的 `agents`，不看它写在哪个文件里。
 * 逐条查证据原件的那两个在 `archivist.ts`。
 *
 * # 五个工具全部"只读已算好的数"，一个都不重算
 *
 * 镜头快照里被小单元抑制的格**没有 n / N / pct**（`@carlife/research` 的
 * `suppressCells` 把明细清空、只留一句原因）。`lensQuery` 对这类格只回
 * `suppressed: true`，**不回库里重算一遍**——抑制的是"能不能指认到人"，
 * 从工具这条路把数字捞回来，等于给它开了一扇没有任何现象的侧门。
 * 同理，`agreementReport` 在没有人工参照集时如实回 null，不拿模型的一致率顶替
 * （M82-10 纪律：`humanPercent` 与 `modelPercent` 回答的是两个不同的问题）。
 *
 * # 上界与 `challenge.ts` 同源
 *
 * `limit ≤ TOOL_LIMIT_MAX`，数值从那边取，不在这里再写一个 20。
 */

import { z } from "zod";

import {
  LENSES,
  type EvidenceMatrixData,
  type ImportancePerformanceData,
  type Lens,
} from "@carlife/research";

import { TOOL_LIMIT_MAX } from "./challenge";
import type { CodedAxis, ResearchToolDeps, ResearchToolRegistration } from "./registry";

/**
 * 镜头名的值域直接取自 `@carlife/research` 的 `LENSES`——**不在这里手抄第二份**。
 * 抄一份的代价是新增一张镜头时模型永远查不到它，而没有任何报错。
 * （`z.enum` 要一个非空元组，`LENSES` 是只读数组，这里只做形状上的转手。）
 */
const lensEnum = z.enum(LENSES as unknown as Readonly<[Lens, ...Lens[]]>);

/** 一格的投影。被抑制的格**只有坐标与 `suppressed`**，其余字段一律不出现。 */
export interface LensCellView {
  needPainCode: string;
  sceneCode?: string;
  suppressed: boolean;
  n?: number;
  N?: number;
  pct?: number;
  direction?: string;
}

export type LensQueryResult =
  | { lens: string; missing: true; note: string }
  | {
      lens: string;
      window: { from: number; to: number };
      codebookVersion: string;
      cells: LensCellView[];
      note?: string;
    };

export interface ThemeMembersResult {
  themeId: string;
  missing?: true;
  name: string | null;
  definition: string | null;
  /** 主题的纳入/排除判据。**今天取不到**——理由见 `themeMembers` 的实现注释。 */
  include: string | null;
  exclude: string | null;
  status: string | null;
  memberCount: number;
  counterCount: number;
  samples: Array<{ unitId: string; textRedacted: string }>;
}

export interface EvidenceByCodeResult {
  code: string;
  axis: CodedAxis;
  /** 本次回了几条。**受 `limit` 截断**，不是该码下的证据总量。 */
  total: number;
  items: Array<{
    unitId: string;
    kind: string;
    occurredAt: number;
    scene: string | null;
    polarity: string | null;
    resolved: boolean;
    textRedacted: string | null;
  }>;
}

export type CodebookLookupResult =
  | { missing: true; note: string }
  | {
      version: string;
      lockedAt: string | null;
      axes: Array<{ id: string; label: string; cardinality: string; codeIds: string[] }>;
    }
  | {
      axis: string;
      id: string;
      label: string;
      definition: string;
      include: string;
      exclude: string;
      examples: readonly string[];
      counterExamples: readonly string[];
    };

export interface AgreementReportResult {
  version: string;
  lockedAt: string | null;
  /** 量过没有。**未量过时其余字段一律 null**，不填 0——0 是一个测量结果。 */
  measured: boolean;
  humanPercent: number | null;
  humanAlpha: number | null;
  modelPercent: number | null;
  modelAlpha: number | null;
  n: number | null;
  at: string | null;
  source: string | null;
}

// ── lensQuery ───────────────────────────────────────────

const lensQuerySchema = z.object({
  lens: lensEnum,
  needPainCode: z.string().optional(),
  sceneCode: z.string().optional(),
});

/**
 * 把一张镜头快照摊成"格"。
 *
 * 只有证据矩阵与重要度×表现度这两张是**按需求码组织**的，所以只有它们摊得出格；
 * 另外三张的格是任务×情绪、分群、周序列，硬塞进 `needPainCode` 这一栏
 * 只会让模型读到一组名不副实的坐标。摊不出来时回空 `cells` 并在 `note` 里说清楚，
 * 不假装查到了东西。
 */
function cellsOf(
  lens: Lens,
  data: unknown,
): { cells: LensCellView[]; suppressed: number; note?: string } {
  if (lens === "evidence-matrix") {
    const matrix = data as EvidenceMatrixData;
    const scenes = matrix.scenes ?? [];
    const cells: LensCellView[] = [];
    let suppressed = 0;
    for (const row of matrix.rows ?? []) {
      row.cells.forEach((cell, i) => {
        const sceneCode = scenes[i]?.code;
        if (cell.suppressed === true) {
          suppressed += 1;
          // 抑制格到此为止：n / N / pct 在快照里就已经被清空，这里也不回。
          cells.push({
            needPainCode: row.code,
            ...(sceneCode ? { sceneCode } : {}),
            suppressed: true,
          });
          return;
        }
        cells.push({
          needPainCode: row.code,
          ...(sceneCode ? { sceneCode } : {}),
          suppressed: false,
          n: cell.n,
          N: cell.N,
          pct: cell.pct,
          direction: cell.direction,
        });
      });
    }
    return { cells, suppressed };
  }

  if (lens === "importance-performance") {
    const ipa = data as ImportancePerformanceData;
    const cells: LensCellView[] = [];
    let suppressed = 0;
    for (const point of ipa.points ?? []) {
      // 被抑制的点在快照里连 code 都没有，摊不出坐标——只能计数，不能编一个码出来。
      if (point.suppressed === true) {
        suppressed += 1;
        continue;
      }
      cells.push({ needPainCode: point.code, suppressed: false, n: point.n });
    }
    return {
      cells,
      suppressed,
      note: "这张镜头没有场景维度，也没有 N / pct：每个码一格，只有命中轮次 n",
    };
  }

  return {
    cells: [],
    suppressed: 0,
    note: `${lens} 不是按「需求码 × 场景」组织的，本工具摊不出格——它的结论要看控制台的镜头页`,
  };
}

const lensQuery: ResearchToolRegistration<z.infer<typeof lensQuerySchema>, LensQueryResult> = {
  name: "lensQuery",
  description: "读一张镜头的最新快照，按需求码 / 场景取格（n、分母、占比、方向）。只读。",
  schema: lensQuerySchema,
  agents: ["analyst"],
  promptSnippet: "读一张镜头快照并按码 / 场景取格（只读）",
  promptGuidelines: [
    "`lensQuery` 回的是**已经算好的**快照，不是实时查询：窗口与码表版本在返回里，" +
      "解释数字时要连这两样一起说，别说成「当前」。",
    "`lensQuery` 里 `suppressed: true` 的格**没有 n / N / pct**，那是小单元抑制的结果——" +
      "它的意思是「这一格不能看」，不是「这一格是 0」，更不要换个工具把它绕出来。",
  ],
  execute: async ({ lens, needPainCode, sceneCode }, deps: ResearchToolDeps) => {
    const snap = await deps.lensSnapshot(lens);
    if (!snap) return { lens, missing: true, note: "这个合同还没算过这个镜头" };

    const { cells, suppressed, note } = cellsOf(lens, snap.data);
    const picked = cells.filter(
      (c) =>
        (needPainCode === undefined || c.needPainCode === needPainCode) &&
        (sceneCode === undefined || c.sceneCode === sceneCode),
    );
    const notes = [
      note,
      suppressed > 0 ? `有 ${suppressed} 个格因样本不足被抑制，明细不可取` : undefined,
    ].filter((x): x is string => x !== undefined);

    return {
      lens,
      window: { from: snap.windowFrom, to: snap.windowTo },
      codebookVersion: snap.codebookVersion,
      cells: picked,
      ...(notes.length > 0 ? { note: notes.join("；") } : {}),
    };
  },
};

// ── themeMembers ────────────────────────────────────────

const themeMembersSchema = z.object({
  themeId: z.string(),
  limit: z.number().int().min(1).max(TOOL_LIMIT_MAX).default(10),
});

const themeMembers: ResearchToolRegistration<
  z.infer<typeof themeMembersSchema>,
  ThemeMembersResult
> = {
  name: "themeMembers",
  description: "取一个主题的定义、成员数与前若干条成员的脱敏文本。只读。",
  schema: themeMembersSchema,
  agents: ["analyst", "taxonomist"],
  promptSnippet: "取一个主题的定义与成员例句（只读）",
  promptGuidelines: [
    "`themeMembers` 回的 samples 是**成员里的前几条**，不是随机抽样——" +
      "拿它说「大多数用户」是站不住的，要谈占比去看 `lensQuery`。",
    "`themeMembers` 的 memberCount 与 counterCount 一起看：反例为 0 的主题边界很可能太宽，" +
      "这正是 taxonomist 要报的那类漂移。",
  ],
  execute: async ({ themeId, limit }, deps: ResearchToolDeps) => {
    const found = (await deps.repo.themes.list(deps.codebookVersion)).find((t) => t.id === themeId);
    if (!found) {
      return {
        themeId,
        missing: true,
        name: null,
        definition: null,
        include: null,
        exclude: null,
        status: null,
        memberCount: 0,
        counterCount: 0,
        samples: [],
      };
    }

    const picked = found.memberUnitIds.slice(0, limit);
    const texts = await deps.unitTexts(picked);
    return {
      themeId,
      name: found.name,
      definition: found.definition,
      /*
       * 纳入/排除判据今天取不到：`themes.list` 的投影里没有这两列
       * （写入侧的 `themes.upsert` 有）。回 null 而不是省掉这两个键——
       * 省掉的话模型看不出是"这个主题没写判据"还是"这里查不到"，
       * 而前者正是 taxonomist 该报的问题。
       */
      include: null,
      exclude: null,
      status: found.status,
      memberCount: found.memberUnitIds.length,
      counterCount: found.counterUnitIds.length,
      // 取不到脱敏文本的成员不占位：未脱敏的原文这一层根本拿不到。
      samples: picked
        .filter((id) => texts.has(id))
        .map((id) => ({ unitId: id, textRedacted: texts.get(id)! })),
    };
  },
};

// ── evidenceByCode ──────────────────────────────────────

const evidenceByCodeSchema = z.object({
  code: z.string(),
  axis: z.enum(["needPain", "scene", "job", "emotion", "polarity"]).default("needPain"),
  polarity: z.string().optional(),
  limit: z.number().int().min(1).max(TOOL_LIMIT_MAX).default(10),
});

const evidenceByCode: ResearchToolRegistration<
  z.infer<typeof evidenceByCodeSchema>,
  EvidenceByCodeResult
> = {
  name: "evidenceByCode",
  description: "按某一轴的某个码取证据轮次（带脱敏文本、场景、极性、是否算解决）。只读。",
  schema: evidenceByCodeSchema,
  agents: ["analyst", "archivist"],
  promptSnippet: "按某个码取证据轮次与脱敏文本（只读）",
  promptGuidelines: [
    "`evidenceByCode` 的 total 是**本次回的条数**（最多 20），不是该码下的证据总量——" +
      "要总量去看镜头快照的 n。",
    "`evidenceByCode` 回的 textRedacted 是脱敏派生文本，原文这一层拿不到；" +
      "引用它时连 unitId 一起给，**不要编 id**。",
  ],
  execute: async ({ code, axis, polarity, limit }, deps: ResearchToolDeps) => {
    const rows = await deps.unitsByCode({ code, axis, polarity: polarity ?? null, limit });
    const texts = await deps.unitTexts(rows.map((r) => r.unitId));
    return {
      code,
      axis,
      total: rows.length,
      items: rows.map((r) => ({
        unitId: r.unitId,
        kind: r.kind,
        occurredAt: r.occurredAt,
        scene: r.scene,
        polarity: r.polarity,
        resolved: r.resolved,
        textRedacted: texts.get(r.unitId) ?? null,
      })),
    };
  },
};

// ── codebookLookup ──────────────────────────────────────

const codebookLookupSchema = z.object({
  code: z.string().optional(),
  axis: z.string().optional(),
});

const codebookLookup: ResearchToolRegistration<
  z.infer<typeof codebookLookupSchema>,
  CodebookLookupResult
> = {
  name: "codebookLookup",
  description: "查码表：不带参回轴与码 id 清单，带 code 回这个码的完整定义。只读。",
  schema: codebookLookupSchema,
  agents: ["analyst", "taxonomist"],
  promptSnippet: "查码表的轴清单或某个码的完整定义（只读）",
  promptGuidelines: [
    "`codebookLookup` 回的 definition / include / exclude 是**判据本身**：" +
      "说某条证据属于某个码之前，先用它对一遍，别按码的名字望文生义。",
    "`codebookLookup` 的 lockedAt 非空表示码表已锁版——锁过的码表只增不改，" +
      "要改概念只能提下一版的提案。",
  ],
  execute: async ({ code, axis }, deps: ResearchToolDeps) => {
    const book = await deps.codebook();
    const axes = book.axes.filter((a) => axis === undefined || a.id === axis);

    if (code !== undefined) {
      for (const a of axes) {
        const found = a.codes.find((c) => c.id === code);
        if (found) {
          return {
            axis: a.id,
            id: found.id,
            label: found.label,
            definition: found.definition,
            include: found.include,
            exclude: found.exclude,
            examples: found.examples,
            counterExamples: found.counterExamples,
          };
        }
      }
      return { missing: true, note: `码表 ${book.version} 里没有 ${code} 这个码` };
    }

    return {
      version: book.version,
      lockedAt: book.lockedAt,
      axes: axes.map((a) => ({
        id: a.id,
        label: a.label,
        cardinality: a.cardinality,
        codeIds: a.codes.map((c) => c.id),
      })),
    };
  },
};

// ── agreementReport ─────────────────────────────────────

const agreementReportSchema = z.object({});

const agreementReport: ResearchToolRegistration<
  z.infer<typeof agreementReportSchema>,
  AgreementReportResult
> = {
  name: "agreementReport",
  description: "报当前码表的复编码一致率（人 vs 人、模型 vs 仲裁），未测量时如实说未测。只读。",
  schema: agreementReportSchema,
  agents: ["taxonomist"],
  promptSnippet: "报当前码表的复编码一致率（只读）",
  promptGuidelines: [
    "`agreementReport` 的 humanPercent 为 null 表示**没有人工参照集**，" +
      "这时不能用 modelPercent 代替它说「码表说得清」——两者回答的是不同的问题。",
    "`agreementReport` 的 measured 为 false 时，一致率这件事就是没量过；" +
      "如实写「未测量」，不要推断一个数。",
  ],
  execute: async (_args, deps: ResearchToolDeps) => {
    const { lockedAt, agreement } = await deps.agreement();
    if (!agreement) {
      return {
        version: deps.codebookVersion,
        lockedAt,
        measured: false,
        humanPercent: null,
        humanAlpha: null,
        modelPercent: null,
        modelAlpha: null,
        n: null,
        at: null,
        source: null,
      };
    }
    return {
      version: deps.codebookVersion,
      lockedAt,
      measured: true,
      humanPercent: agreement.humanPercent,
      humanAlpha: agreement.humanAlpha,
      modelPercent: agreement.modelPercent,
      modelAlpha: agreement.modelAlpha,
      n: agreement.n,
      at: agreement.at,
      source: agreement.source,
    };
  },
};

/**
 * 按工具名索引的清单。顺序即 `describeForPi` 的顺序，也是提示词里
 * `Available tools` 节的顺序——按设计稿 §4 的表格排，别打乱。
 */
export const ANALYST_TOOL_MAP = {
  lensQuery,
  themeMembers,
  evidenceByCode,
  codebookLookup,
  agreementReport,
};

/** 同一份东西的数组视图，给注册表用。**真相源是上面那个 map**。 */
export const ANALYST_TOOLS: readonly ResearchToolRegistration[] = Object.values(ANALYST_TOOL_MAP);
