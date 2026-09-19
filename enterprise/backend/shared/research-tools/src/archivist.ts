/**
 * archivist 的两个只读工具（施工单 M89-01，设计稿 §4）。
 *
 * # 这两个是"回到原件"的那一族，所以脱敏边界最紧
 *
 * `evidenceById` 是唯一一个按 id 取单条证据的工具。
 * `research_evidence_units` 整行带着 `userId`、车架号、会话与消息引用——
 * 那些字节一旦进了返回值，就会穿过 pi 的会话 jsonl 落到磁盘上，**没有任何提示**。
 * 所以本文件**拿不到整行**：投影成 `UnitView` 这件事发生在
 * `research-runtime/src/challenge/deps.ts` 的 `unitById` 里，而且是 allowlist
 * （挑字段），不是黑名单（删几个键）——后者在库里新加一列的那天就漏了。
 * `test/readonly-scan.test.ts` 扫 `src/**` 的非注释行不得出现那六个键名，守的是这条。
 *
 * # 护照是权利边界，读代码常量而不是读表
 *
 * `research_sources` 表只是 `@carlife/research` 那份常量的可查询副本
 * （`passport.ts` 文件头：表被改了也不改变行为）。`sourcePassport` 因此走
 * `passportOf()`，不走 `repo.sourcePassports.list()`——从表里读等于给
 * "临时打开看一眼"留了一个不留痕的入口。
 */

import { z } from "zod";

import { SOURCE_PASSPORTS, passportOf } from "@carlife/research";

import type { ResearchToolDeps, ResearchToolRegistration, UnitView } from "./registry";

/** 护照里能给模型看的那几项。基础授权 `basis` 与 `notes` 只在整张护照里给。 */
export interface PassportBrief {
  id: string;
  control: string;
  provenance: string;
  display: string;
  share: string;
  retentionDays: number | null;
}

export type EvidenceByIdResult =
  | { missing: true; note: string }
  | {
      unit: UnitView;
      codings: Array<{
        axis: string;
        code: string;
        confidence: number;
        uncertain: boolean;
        coder: string;
      }>;
      /** 来源未登记护照时为 null——调用方按「不可采」处理，不要默认放行。 */
      passport: PassportBrief | null;
    };

export type SourcePassportResult =
  | { missing: true; note: string }
  | {
      id: string;
      control: string;
      basis: string;
      access: string;
      collect: string;
      store: string;
      analyze: string;
      share: string;
      display: string;
      retentionDays: number | null;
      provenance: string;
      notes: string;
    }
  | {
      sources: Array<{
        id: string;
        control: string;
        provenance: string;
        collect: string;
        display: string;
        share: string;
      }>;
    };

// ── evidenceById ────────────────────────────────────────

const evidenceByIdSchema = z.object({ unitId: z.string() });

const evidenceById: ResearchToolRegistration<
  z.infer<typeof evidenceByIdSchema>,
  EvidenceByIdResult
> = {
  name: "evidenceById",
  description: "按 unitId 取一条证据单元的脱敏正文、它的编码，以及来源护照的边界。只读。",
  schema: evidenceByIdSchema,
  agents: ["archivist"],
  promptSnippet: "按 unitId 取单条证据与它的编码、来源边界（只读）",
  promptGuidelines: [
    "`evidenceById` 回的 unit 里没有任何能指认到人的字段（车架号、会话、消息引用都不给）——" +
      "**这是刻意的**，不要去别处找它们，也不要在回答里推测。",
    "`evidenceById` 的 withdrawn 为 true 表示车主已撤回授权：这条不能再进任何新的分析或引用，" +
      "如实说明它被撤回了。",
    "`evidenceById` 的 passport 为 null 表示来源未登记——按「不可采」处理，不要默认放行。",
  ],
  execute: async ({ unitId }, deps: ResearchToolDeps) => {
    const unit = await deps.unitById(unitId);
    if (!unit) return { missing: true, note: `没有 id 为 ${unitId} 的证据单元` };

    const rows = await deps.repo.codings.forUnits([unitId], deps.codebookVersion);
    const passport = passportOf(unit.sourceId);
    return {
      unit,
      // 编码只回"判成了什么、有多确定、谁判的"：rationale 与 promptHash 是内部过程。
      codings: rows.map((c) => ({
        axis: c.axis,
        code: c.code,
        confidence: c.confidence,
        uncertain: c.uncertain === true,
        coder: c.coder,
      })),
      passport: passport
        ? {
            id: passport.id,
            control: passport.control,
            provenance: passport.provenance,
            display: passport.display,
            share: passport.share,
            retentionDays: passport.retentionDays,
          }
        : null,
    };
  },
};

// ── sourcePassport ──────────────────────────────────────

const sourcePassportSchema = z.object({ sourceId: z.string().optional() });

const sourcePassport: ResearchToolRegistration<
  z.infer<typeof sourcePassportSchema>,
  SourcePassportResult
> = {
  name: "sourcePassport",
  description: "查来源护照：不带参回全部来源的边界摘要，带 sourceId 回那一张的全部字段。只读。",
  schema: sourcePassportSchema,
  agents: ["archivist"],
  promptSnippet: "查来源护照与它的六项权限边界（只读）",
  promptGuidelines: [
    "`sourcePassport` 的六项权限各自独立：`analyze` 能算不代表 `display` 能逐条显示，" +
      "`aggregate-only` 就是「只能进分母、不能露脸」。",
    "`sourcePassport` 的 provenance 为 simulated 的来源**不构成市场证据**——" +
      "引用它时必须写明这是模拟数据。",
  ],
  execute: async ({ sourceId }) => {
    if (sourceId !== undefined) {
      const found = passportOf(sourceId);
      // 未登记 = 不可采。这里如实回 missing，让模型看见"没有这张护照"。
      if (!found) return { missing: true, note: `来源 ${sourceId} 没有登记护照——按不可采处理` };
      return {
        id: found.id,
        control: found.control,
        basis: found.basis,
        access: found.access,
        collect: found.collect,
        store: found.store,
        analyze: found.analyze,
        share: found.share,
        display: found.display,
        retentionDays: found.retentionDays,
        provenance: found.provenance,
        notes: found.notes,
      };
    }

    return {
      sources: SOURCE_PASSPORTS.map((p) => ({
        id: p.id,
        control: p.control,
        provenance: p.provenance,
        collect: p.collect,
        display: p.display,
        share: p.share,
      })),
    };
  },
};

/** 按工具名索引的清单。顺序即设计稿 §4 表格里的顺序。 */
export const ARCHIVIST_TOOL_MAP = {
  evidenceById,
  sourcePassport,
};

/** 同一份东西的数组视图，给注册表用。**真相源是上面那个 map**。 */
export const ARCHIVIST_TOOLS: readonly ResearchToolRegistration[] = Object.values(ARCHIVIST_TOOL_MAP);
