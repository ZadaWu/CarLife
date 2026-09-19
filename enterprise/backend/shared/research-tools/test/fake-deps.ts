/**
 * 四个测试文件共用的假注入（施工单 M89-01）。
 *
 * 不是为了少写几行：`ResearchToolDeps` 有九个取数口，每个用例各拼一份的话，
 * **加一个取数口要改四处**，而漏掉的那一处不会编译红（测试不进 `tsc -p`），
 * 只会在某个用例里静默走到 undefined。这里一处给全，用例只覆盖它关心的那几个。
 */

import type { ResearchToolDeps } from "../src/index";

/** 全部回空的取数口。用例按需覆盖——覆盖了哪个，就是那个用例在测什么。 */
export function stubDeps(over: Partial<ResearchToolDeps> = {}): ResearchToolDeps {
  return {
    repo: {
      units: { byId: async (id: string) => ({ id, textRedacted: `反例 ${id}` }) },
      themes: { list: async () => [] },
      codings: { forUnits: async () => [] },
      systemEvents: { inWindow: async () => [] },
    } as never,
    codebookVersion: "0.1.0",
    themeMembers: async () => ({ memberUnitIds: [], counterUnitIds: [] }),
    thresholdSensitivity: async (code, delta) => ({ flips: false, detail: `${code} @ ${delta}` }),
    sliceBySegment: async () => [],
    lensSnapshot: async () => null,
    codebook: async () => ({ version: "0.1.0", lockedAt: null, axes: [] }),
    agreement: async () => ({ lockedAt: null, agreement: null }),
    unitsByCode: async () => [],
    unitById: async () => null,
    unitTexts: async () => new Map<string, string>(),
    ...over,
  };
}
