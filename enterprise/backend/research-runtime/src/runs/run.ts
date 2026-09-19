/**
 * 一次研究运行（施工单 M82-05）：读库 → 分群 → 五个镜头 → 落快照。
 *
 * 本单只做**顺序执行**；图（LangGraph）在 M82-06 接管这条链。
 * 现在把它写成一个普通 async 函数是刻意的：在还没有人工中断、没有分支的阶段，
 * 引一个图只会多一层要读的东西。
 */

import { deriveSystemEvents, type ResearchSystemEvent } from "@carlife/research";
import type { ResearchRepository } from "@carlife/db";

import type { Codebook } from "../codebook/load";
import { buildAllSnapshots, type CodedTurn } from "../lenses";
import type { SegmentDraft } from "../lenses/segment-atlas";
import { buildThemeClusters } from "../ontology/themes";
import {
  SEGMENT_FEATURES,
  SEGMENT_K,
  buildVehicleFeatures,
  kmeans,
  zScore,
  type ExternalMetric,
} from "../ontology/segments";

const DAY_MS = 86_400_000;

export interface RunOptions {
  repo: ResearchRepository;
  book: Codebook;
  contractId: string;
  windowFrom: number;
  windowTo: number;
  minCellVehicles: number;
  /** 复编码一致率；还没测就 null（measurement 门会因此 fail）。 */
  agreement: number | null;
  codebookLocked: boolean;
  /** 给分群命名。不传就用"群 N"占位（M82-05 的 Namer 是可选的一跳）。 */
  nameSegment?: (input: {
    featureSummary: string;
    topNeedPains: string[];
    topJobs: string[];
    size: number;
  }) => Promise<{ name: string; task: string; constraint: string; alternative: string; value: string }>;
  /** 给主题命名。缺席时主题只落成员与质心，不落名字。 */
  nameTheme?: (input: {
    needPainCode: string;
    codeDefinition: string;
    examples: string[];
    counterExamples: string[];
  }) => Promise<{ name: string; definition: string; include: string; exclude: string }>;
  /** 单元向量。没有嵌入（缺 DASHSCOPE_API_KEY）时给空 Map，主题这一步整段跳过。 */
  embeddings?: Map<string, number[]>;
  /** 单元的脱敏文本，喂给 Namer 当代表句。 */
  texts?: Map<string, string>;
}

export interface RunResult {
  inputsHash: string;
  /** hash 命中已有快照 → 没重算。 */
  reused: boolean;
  lenses: string[];
  turns: number;
  vehicles: number;
  segments: number;
  themes: number;
}

/** 取前 N 个最常见的码。 */
function topCodes(turns: readonly CodedTurn[], pick: (t: CodedTurn) => string[], n: number): string[] {
  const count = new Map<string, number>();
  for (const t of turns) for (const c of pick(t)) if (c !== "none") count.set(c, (count.get(c) ?? 0) + 1);
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([c]) => c);
}

export async function runResearch(opts: RunOptions): Promise<RunResult> {
  const { repo, book } = opts;
  const window = { from: opts.windowFrom, to: opts.windowTo };

  const excluded = await repo.sources.excludedUserIds();
  const [turns, trips, changes] = await Promise.all([
    repo.units.codedTurns(window, book.version),
    repo.sources.trips(window, excluded),
    repo.sources.systemChanges(window),
  ]);

  // ── 分群：先行为，后语义 ──────────────────────────────
  const memberCounts: Record<string, number> = {};
  for (const t of trips) {
    if (!t.vin) continue;
    memberCounts[t.vin] ??= 0;
  }
  const driversByVin = new Map<string, Set<string>>();
  for (const t of trips) {
    if (!t.vin || !t.driverMemberId) continue;
    const s = driversByVin.get(t.vin) ?? new Set<string>();
    s.add(t.driverMemberId);
    driversByVin.set(t.vin, s);
  }
  for (const [vin, s] of driversByVin) memberCounts[vin] = s.size;

  const features = buildVehicleFeatures(
    trips.map((t) => ({
      vin: t.vin,
      distanceKm: t.distanceKm,
      roadType: t.roadType,
      ambientTempC: t.ambientTempC,
      observedRangeKm: t.observedRangeKm,
      socDelta:
        t.chargeStartSoc !== null && t.chargeEndSoc !== null ? t.chargeEndSoc - t.chargeStartSoc : null,
    })),
    // 语音占比：`CodedTurn` 不带 source（镜头不需要），这里用空集——
    // 该维度方差为 0，z-score 后不参与聚类。已入账（验收 §7）。
    [],
    memberCounts,
    Math.max(1, Math.round((opts.windowTo - opts.windowFrom) / DAY_MS)),
  );

  const clustered = kmeans(zScore(features), SEGMENT_K);
  const turnsByVin = new Map<string, CodedTurn[]>();
  for (const t of turns) {
    if (!t.vin) continue;
    const list = turnsByVin.get(t.vin) ?? [];
    list.push(t);
    turnsByVin.set(t.vin, list);
  }

  const drafts: SegmentDraft[] = [];
  for (let j = 0; j < clustered.centroids.length; j += 1) {
    const vins = features.filter((_, i) => clustered.assignments[i] === j).map((f) => f.vin);
    if (vins.length === 0) continue;
    const memberTurns = vins.flatMap((v) => turnsByVin.get(v) ?? []);
    const topPains = topCodes(memberTurns, (t) => t.needPains, 3);
    const topJobs = topCodes(memberTurns, (t) => (t.job ? [t.job] : []), 2);

    const centroid = clustered.centroids[j];
    const summary = SEGMENT_FEATURES.map((f, i) => `${f}=${centroid[i].toFixed(2)}`).join(" ");
    const named = opts.nameSegment
      ? await opts.nameSegment({ featureSummary: summary, topNeedPains: topPains, topJobs, size: vins.length })
      : {
          name: `群 ${j + 1}`,
          task: topJobs[0] ?? "未命名",
          constraint: topPains[0] ?? "未命名",
          alternative: "未知",
          value: "未知",
        };

    /*
     * 外部验证：用**没参与聚类**的变量。这里用"这群车的轮次里解决率"作代理——
     * `vehicle_reminders` 的接受率要读提醒表，而研究仓储没有那条读（M82-06 补）。
     * 代理变量也是外部变量（它没进八维特征），但可辩护性弱一档，
     * 所以 metric 名字里如实写着 `resolved-rate-proxy`。
     */
    const resolved = memberTurns.filter((t) => t.resolved).length;
    const overallResolved = turns.length === 0 ? 0 : turns.filter((t) => t.resolved).length / turns.length;
    const external: ExternalMetric | null =
      memberTurns.length === 0
        ? null
        : {
            metric: "resolved-rate-proxy",
            value: resolved / memberTurns.length,
            overall: overallResolved,
            n: vins.length,
          };

    drafts.push({
      id: `seg-${j + 1}`,
      name: named.name,
      vins,
      centroid,
      rows: {
        task: named.task,
        constraint: named.constraint,
        alternative: named.alternative,
        value: named.value,
        behavior: summary,
        // 可触达性：没有推送回执，只能是 estimated——两者在快照里分开标。
        reach: { value: 0, kind: "estimated" },
      },
      external,
      tags: topPains,
    });
  }

  /*
   * ── 主题聚类 ──────────────────────────────────────
   *
   * **没有向量就整段跳过**，不退化成"按码分组当主题"：那样每个需求码恰好
   * 一个主题，图上看起来主题体系齐全，实际上一个都没聚出来——
   * 而"看起来齐全"比"明显缺失"难发现得多。
   */
  let themeCount = 0;
  const embeddings = opts.embeddings ?? new Map<string, number[]>();
  if (embeddings.size > 0) {
    const texts = opts.texts ?? new Map<string, string>();
    const candidates = turns.flatMap((t) => {
      const vec = embeddings.get(t.unitId);
      if (!vec) return [];
      // 一轮多码时每个码各进一次分组——聚类是在码内做的。
      return t.needPains
        .filter((c) => c !== "none")
        .map((code) => ({
          unitId: t.unitId,
          needPainCode: code,
          isCounter: t.polarity === "counter-example",
          text: texts.get(t.unitId) ?? "",
          embedding: vec,
        }));
    });

    const clusters = buildThemeClusters(candidates);
    const defByCode = new Map(
      book.axes.find((a) => a.id === "need_pain")?.codes.map((c) => [c.id, c.definition]) ?? [],
    );
    for (const c of clusters) {
      const named = opts.nameTheme
        ? await opts.nameTheme({
            needPainCode: c.needPainCode,
            codeDefinition: defByCode.get(c.needPainCode) ?? "",
            examples: c.examples,
            counterExamples: c.counterExamples,
          })
        : { name: `${c.needPainCode}#${c.index + 1}`, definition: "", include: "", exclude: "" };

      await repo.themes.upsert({
        /*
         * 确定性 id：同一个码下的第 j 簇，跨 run 是同一行。
         *
         * 不给 id 的话每次 run 都 `create` 一遍，两次 run 后同一簇会以两个略有
         * 不同的名字各存一行（Namer 的措辞不完全稳定），下游每张图都双算。
         * 能这么定 id 是因为 `kmeans` 是确定性的（等距抽样取初始质心，无随机）。
         */
        id: `theme-${book.version}-${c.needPainCode}-${c.index}`,
        codebookVersion: book.version,
        /*
         * 码**单独存一列**，不要从上面那个 id 再解析回来：码与版本号都带连字符
         * （`theme-v1-charging-speed-2`），切不出唯一解，而切错不报错，
         * 只会让下游的洞察卡挂到别的码上。这里手里就有它。
         */
        needPainCode: c.needPainCode,
        name: named.name,
        definition: named.definition,
        include: named.include,
        exclude: named.exclude,
        memberUnitIds: c.memberUnitIds,
        // 反例成员单独一列——主题必须保留反例，否则在任何一张图上都看起来证据充分。
        counterUnitIds: c.counterUnitIds,
        status: "draft",
      });
      themeCount += 1;
    }
  } else {
    console.warn("[research-runtime] 没有单元向量，主题聚类跳过（缺 DASHSCOPE_API_KEY 时是预期行为）");
  }

  // ── 系统变更事件 ────────────────────────────────────
  const events: ResearchSystemEvent[] = deriveSystemEvents({
    configRevisions: changes.configRevisions,
    guardRevisions: changes.guardRevisions,
    kbSyncRuns: changes.kbSyncRuns,
  });
  if (events.length > 0) await repo.systemEvents.upsertMany(events);
  const stored = await repo.systemEvents.inWindow(window);

  // ── 基线：前 90 天的同码提及率 ────────────────────────
  const span = opts.windowTo - opts.windowFrom;
  const priorTurns = await repo.units.codedTurns(
    { from: opts.windowFrom - span, to: opts.windowFrom },
    book.version,
  );
  const baseline: Record<string, number> = {};
  if (priorTurns.length > 0) {
    const count = new Map<string, number>();
    for (const t of priorTurns) for (const c of t.needPains) if (c !== "none") count.set(c, (count.get(c) ?? 0) + 1);
    for (const [c, n] of count) baseline[c] = n / priorTurns.length;
  }

  const codingRows = turns.reduce(
    (n, t) => n + t.needPains.length + [t.scene, t.job, t.emotion, t.polarity, t.deliverability].filter(Boolean).length,
    0,
  );

  const built = buildAllSnapshots({
    contractId: opts.contractId,
    windowFrom: opts.windowFrom,
    windowTo: opts.windowTo,
    book,
    turns,
    codingRows,
    segments: drafts,
    totalVehicles: features.length,
    events: stored.map((e) => ({
      kind: e.kind as ResearchSystemEvent["kind"],
      at: e.at,
      // 仓储侧 `key` 是可选的，事件类型要求显式 null——"没有键"与"没这个字段"是两回事。
      key: e.key ?? null,
      summary: e.summary,
      sourceRef: e.sourceRef,
    })),
    baseline,
    minCellVehicles: opts.minCellVehicles,
    gateInput: {
      sourceIds: ["messages", "trips", "trace_events"],
      denominatorVisible: true,
      // 反例已检索：证据矩阵每格都带 `counter` 计数，主题保留反例成员。
      counterEvidenceSearched: true,
      codebookLocked: opts.codebookLocked,
      agreement: opts.agreement,
      undeliverable: turns.some((t) => t.deliverability === "undeliverable-hard-ban"),
    },
  });

  // 同 hash 已有快照就不重算——"我改了口径但图没变"由此变成可诊断的现象。
  const existing = await repo.snapshots.latest(opts.contractId, "evidence-matrix");
  const reused = (existing as { inputsHash?: string } | null)?.inputsHash === built.inputsHash;

  if (!reused) {
    for (const { lens, snapshot } of built.snapshots) {
      await repo.snapshots.upsert({
        contractId: opts.contractId,
        lens,
        windowFrom: opts.windowFrom,
        windowTo: opts.windowTo,
        codebookVersion: book.version,
        inputsHash: built.inputsHash,
        population: snapshot.population,
        gates: snapshot.gates,
        data: snapshot.data,
      });
    }
  }

  return {
    inputsHash: built.inputsHash,
    reused,
    lenses: built.snapshots.map((s) => s.lens),
    turns: turns.length,
    vehicles: features.length,
    segments: drafts.length,
    themes: themeCount,
  };
}
