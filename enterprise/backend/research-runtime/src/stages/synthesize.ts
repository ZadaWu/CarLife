/**
 * 图的 `synthesize` 节点：每个主题一张 Insight Card（施工单 M85-01）。
 *
 * # 之前这里是个桩
 *
 * `synthesize()` 这个函数 M82-06 就写完了、也有单测，但**从来没有调用方**——
 * `index.ts` 的 `synthesizeAll` 读完主题就 `return []`。于是 `research_insights`
 * 实跑产出是 0，而抽屉里五个 `Pending` 段等的全是这张卡。
 *
 * # 单张失败不拖垮整个 run
 *
 * 一次 run 有几十个主题。任何一次 schema 不匹配、限流或超时如果直接抛，
 * 整个 run 连已经写好的卡一起丢，而下一次重跑会命中同一个主题、同样失败。
 * 形状与理由照抄 `index.ts` 里 `nameTheme` 那一段。
 *
 * # `level` 由本文件写死，不从模型输出里取
 *
 * `insight.ts` 文件头："升级只能经 `review/:threadId/resume` 的人工决定，
 * 没有任何自动路径把 signal 变 candidate——ODS 高分尤其不是路径。"
 * 那句话要成立，写库的这一处就不能读模型给的 level。
 */

import type { ResearchRepository } from "@carlife/db";
import type { ConfidenceInput } from "@carlife/research";

import type { Codebook } from "../codebook/load";
import { synthesize, type SynthesizeDeps } from "../opportunity/insight";
import type { ResearchUsage } from "../llm";

/** 洞察卡的归属人。研究面没有登录态，落一个可查询的常量而不是空串。 */
const INSIGHT_OWNER = "research:unassigned";

export interface SynthesizeAllOptions {
  repo: ResearchRepository;
  book: Codebook;
  contractId: string;
  window: { from: number; to: number };
  deps: SynthesizeDeps;
  recordUsage?: (u: ResearchUsage) => Promise<void>;
  /** 复编码一致率；还没测（M82-10）就 null。 */
  agreement: number | null;
  /** 本次最多出几张卡。主题多时截断，日志明说截了几个。 */
  maxThemes?: number;
  /**
   * **这批卡基于哪份快照**（G5，施工单 M85-06）。
   *
   * 取值是 `research_lens_snapshots.inputs_hash` 的原样副本，
   * **不是卡片内容的 hash**——两者都叫 hash，混了之后 G5 的比对永远相等
   * （内容没变当然相等），守不住任何东西。
   *
   * 取不到就传 `null`，落库即 null，界面显示「口径未知」。
   * **不要在这里兜一个当前时间或内容摘要**：那等于给一张来路不明的卡盖个假章。
   */
  inputsHash?: string | null;
}

/**
 * 置信五分量。**每一项都据实算，没有的那项给 0 而不是给一个中间值。**
 *
 * 给中间值（比如 0.5）的代价是：一个从没测过一致率的主题，
 * 它的 C 会落在"看起来还行"的区间，而 `lowest` 会指向别的分量——
 * 于是"要到 Candidate 还缺什么"这一栏指错了方向。
 */
function confidenceInputOf(input: {
  memberCount: number;
  counterCount: number;
  totalTurns: number;
  vehicles: number;
  minCellVehicles: number;
  agreement: number | null;
  behaviouralPresent: boolean;
  freshness: number;
}): ConfidenceInput {
  return {
    // 覆盖：这个主题占了整窗多大一块，以及够不够台车。两者取小的那个。
    coverage: Math.min(
      input.totalTurns === 0 ? 0 : input.memberCount / input.totalTurns,
      input.minCellVehicles === 0 ? 1 : Math.min(1, input.vehicles / input.minCellVehicles),
    ),
    // 质量：反例被检索到了多少。一条反例都没有更可能意味着没去找。
    quality: input.memberCount === 0 ? 0 : Math.min(1, input.counterCount / Math.max(1, input.memberCount * 0.1)),
    // 一致率没测就是 0——不是 0.5。measurement 门同样判 fail。
    agreement: input.agreement ?? 0,
    // 三角验证：话语 + 行为两类证据齐了才算。只有话语就是 0。
    triangulation: input.behaviouralPresent ? 1 : 0,
    freshness: input.freshness,
  };
}

/**
 * 逐主题出卡。返回写进库的洞察 id。
 *
 * 主题的 `needPainCode` 为 null 是"码未知"（本列之前写下的历史行，见
 * schema 里该列的注释）——**跳过，不猜**。猜错的代价是这张卡挂到别的码上，
 * 而卡片本身看起来完全正常。
 */
export async function synthesizeAll(opts: SynthesizeAllOptions): Promise<string[]> {
  const { repo, book, contractId, window } = opts;

  const themes = await repo.themes.list(book.version);
  if (themes.length === 0) {
    console.warn("[research-runtime] 没有主题，Synthesizer 跳过（缺 DASHSCOPE_API_KEY 时是预期行为）");
    return [];
  }

  const usable = themes.filter((t) => t.needPainCode !== null);
  const unknownCode = themes.length - usable.length;
  if (unknownCode > 0) {
    console.warn(
      `[research-runtime] ${unknownCode} 个主题的需求码未知（M85-01 之前写下的行），本次跳过；` +
        "下一次 run 会按确定性 id 覆盖它们并写上码",
    );
  }

  const limit = opts.maxThemes ?? usable.length;
  const picked = usable.slice(0, limit);
  if (picked.length < usable.length) {
    console.warn(`[research-runtime] 主题 ${usable.length} 个，本次只出前 ${picked.length} 张卡（其余截断）`);
  }

  const turns = await repo.units.codedTurns(window, book.version);
  const totalTurns = new Set(turns.map((t) => t.turnId ?? t.unitId)).size;
  const vinOf = new Map(turns.map((t) => [t.unitId, t.vin]));
  const occurredAt = new Map(turns.map((t) => [t.unitId, t.occurredAt]));

  const events = await repo.systemEvents.inWindow(window);
  const eventLines = events.map((e) => `${new Date(e.at).toISOString().slice(0, 10)} ${e.kind}：${e.summary}`);

  const defByCode = new Map(
    book.axes.find((a) => a.id === "need_pain")?.codes.map((c) => [c.id, c.definition]) ?? [],
  );

  const written: string[] = [];
  for (const theme of picked) {
    try {
      const id = await synthesizeOne({
        ...opts,
        theme,
        totalTurns,
        vinOf,
        occurredAt,
        eventLines,
        codeDefinition: defByCode.get(theme.needPainCode ?? "") ?? "",
      });
      if (id) written.push(id);
    } catch (err) {
      /*
       * 点名是哪个主题。不点名的话，几十个主题里失败了一个，
       * 日志上只有一句"失败"，没人知道该去复查哪一簇。
       */
      console.warn(
        `[research-runtime] Synthesizer 在主题 ${theme.id}（${theme.name}）上失败，跳过：` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(`[research-runtime] Synthesizer：${written.length}/${picked.length} 张洞察卡`);
  return written;
}

type ThemeRow = Awaited<ReturnType<ResearchRepository["themes"]["list"]>>[number];

/**
 * 一个主题一张卡。**单格触发（C1，施工单 M85-06）会复用这一个函数**——
 * 不为它另开一条写入路径，否则 `level` 写死、`InsightBoundaryError`、
 * `recordUsage` 三样迟早只在一边生效。
 */
export async function synthesizeOne(
  opts: SynthesizeAllOptions & {
    theme: ThemeRow;
    totalTurns: number;
    vinOf: Map<string, string | null>;
    occurredAt: Map<string, number>;
    eventLines: string[];
    codeDefinition: string;
  },
): Promise<string | null> {
  const { repo, theme, window } = opts;
  const needPainCode = theme.needPainCode;
  if (!needPainCode) return null;

  const texts = await repo.units.textsByIds([...theme.memberUnitIds, ...theme.counterUnitIds]);
  // 只取脱敏派生文本。取不到的成员直接不进提示词——原文一律不进。
  const examples = theme.memberUnitIds.map((id) => texts.get(id)).filter((t): t is string => !!t);
  const counterExamples = theme.counterUnitIds.map((id) => texts.get(id)).filter((t): t is string => !!t);

  if (examples.length === 0) {
    console.warn(`[research-runtime] 主题 ${theme.id} 一条脱敏代表句都没有，跳过出卡`);
    return null;
  }

  const vehicles = new Set(
    theme.memberUnitIds.map((id) => opts.vinOf.get(id)).filter((v): v is string => !!v),
  ).size;

  /*
   * 新鲜度：这个主题最近一条证据落在窗口的哪个位置。
   * 全部证据都在窗口前半段 → 接近 0（"这个主题可能已经过去了"）。
   */
  const latest = Math.max(
    0,
    ...theme.memberUnitIds.map((id) => opts.occurredAt.get(id) ?? 0),
  );
  const span = Math.max(1, window.to - window.from);
  const freshness = latest === 0 ? 0 : Math.min(1, Math.max(0, (latest - window.from) / span));

  const result = await synthesize(
    {
      themeName: theme.name,
      themeDefinition: theme.definition || opts.codeDefinition,
      needPainCode,
      examples,
      counterExamples,
      /*
       * 行为侧对证今天拼不出来：`CodedTurn` 不带行程指标，而把
       * trips 的温度—续航对照按主题聚合是另一整段工作（镜头三在做，
       * 但它的产物是整窗的，不是按主题的）。
       *
       * 所以据实传 `present: false`——`synthesize()` 里有对应分支，
       * 会在提示词里写"**没有行为侧对证**——只有话语，三角验证不成立，
       * 边界里要说出来"，并让 triangulation 分量归零。
       * **绝不编一句对照**：编出来的那句和真的长得一模一样，
       * 而它会被原样写进卡片的 evidence 栏。
       */
      behavioural: { summary: "", present: false },
      systemEvents: opts.eventLines,
      confidence: confidenceInputOf({
        memberCount: theme.memberUnitIds.length,
        counterCount: theme.counterUnitIds.length,
        totalTurns: opts.totalTurns,
        vehicles,
        minCellVehicles: 10,
        agreement: opts.agreement,
        behaviouralPresent: false,
        freshness,
      }),
    },
    opts.deps,
  );

  // `ResearchUsage` 自带 agent 与 model（`usageOf` 从模型描述符里取），原样转发即可。
  await opts.recordUsage?.(result.usage);

  const row = await repo.insights.create({
    contractId: opts.contractId,
    themeId: theme.id,
    // 写死。**不读 result 里的任何 level 字段**——见文件头。
    level: "signal",
    card: result.card,
    confidence: result.confidence,
    upgradeNeeds: result.upgradeNeeds,
    owner: INSIGHT_OWNER,
    // G5：这张卡基于哪份快照。取不到就是 null = 口径未知，不拿别的值顶。
    inputsHash: opts.inputsHash ?? null,
  });
  return row.id;
}
