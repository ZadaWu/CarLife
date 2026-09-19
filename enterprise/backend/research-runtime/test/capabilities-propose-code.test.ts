/**
 * C8「从兜底桶提码」（施工单 M85-08）。
 *
 * 断言集中在**四件不能出错的事**上：
 *  ① 只有兜底桶那一行提得了码——对一个真实码提码，产出的是"建议开一个和
 *     charging-speed 几乎一样的码"，它不报错，只在待审队列里看起来像正经提案；
 *  ② `decidedBy` 是**真实身份**，不是 `system` / 模型名；
 *  ③ **提案不写 codebook**（G3）——注入一个在任何 `codebooks` 写调用上抛错的假 repo；
 *  ④ `cannibalization` 由代码算、算得对，且**不进提示词**。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { handleCapability, type CapabilityDeps } from "../src/internal-api/capabilities";
import { createCapabilityRuns } from "../src/capabilities/runs";
import {
  CATCH_ALL_CODE,
  PROPOSAL_DECIDED,
  PROPOSAL_RAISED,
  pendingProposals,
  startProposeCode,
  type CodeProposal,
  type ProposeCodeDeps,
} from "../src/capabilities/propose-code";
import { handleResume, type ReviewDeps } from "../src/review/endpoints";

const PKG = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const CATCH_ALL_ROW = { kind: "row", needPainCode: CATCH_ALL_CODE, suppressed: false, catchAll: true } as const;

interface Raised {
  proposalId: string;
  actor: string;
  proposal: CodeProposal;
}

function fakeDeps(over: Partial<ProposeCodeDeps> = {}): { deps: ProposeCodeDeps; raised: Raised[]; named: unknown[] } {
  const raised: Raised[] = [];
  const named: unknown[] = [];
  const deps: ProposeCodeDeps = {
    catchAllThemes: async () => [
      { id: "t-other-0", name: "路上堵不堵", memberUnitIds: ["u1", "u2", "u3"], counterUnitIds: ["c1"] },
    ],
    textsByIds: async (ids) => new Map(ids.map((id) => [id, `脱敏句 ${id}`])),
    otherCodesFor: async () => [
      { code: "charging-speed", units: 2 },
      { code: "range-anxiety", units: 1 },
    ],
    nameOne: async (input) => {
      named.push(input);
      return { name: "路况与拥堵", definition: "问路上堵不堵", include: "问拥堵", exclude: "问导航绕路" };
    },
    raise: async (input) => {
      raised.push(input as Raised);
      return `dec-${raised.length}`;
    },
    ...over,
  };
  return { deps, raised, named };
}

const capsWith = (deps: ProposeCodeDeps): CapabilityDeps => ({
  redTeamInput: async () => null,
  lookup: async () => null,
  runs: createCapabilityRuns(),
  proposeCode: deps,
});

const post = (caps: CapabilityDeps, body: Record<string, unknown> = {}) =>
  handleCapability("propose-code", { scope: CATCH_ALL_ROW, contractId: "ct-1", ...body }, caps, "ct-1");

describe("[M85-08] 只有兜底桶那一行提得了码", () => {
  it("兜底桶行 → 202 + runId", async () => {
    const { deps } = fakeDeps();
    const { status, body } = await post(capsWith(deps), { actor: "admin:luo" });
    assert.equal(status, 202);
    const b = body as { tier: string; runId: string; actor: string };
    assert.equal(b.tier, "write");
    assert.match(b.runId, /^cap-/);
  });

  it("**真实需求码的那一行 → 400**，不是「提一个和它几乎一样的码」", async () => {
    const { deps, raised } = fakeDeps();
    const { status, body } = await handleCapability(
      "propose-code",
      {
        scope: { kind: "row", needPainCode: "charging-speed", suppressed: false, catchAll: true },
        contractId: "ct-1",
      },
      capsWith(deps),
      "ct-1",
    );
    assert.equal(status, 400);
    assert.equal((body as { error: string }).error, "scope_not_supported");
    assert.match(String((body as { hint: string }).hint), /兜底桶/);
    assert.equal(raised.length, 0, "被拒了却还是提了一条");
  });

  it("格（不是行）也提不了——提码的对象是一整个兜底桶", async () => {
    const { status } = await handleCapability(
      "propose-code",
      {
        scope: {
          kind: "cell", needPainCode: CATCH_ALL_CODE, sceneCode: "charging",
          suppressed: false, catchAll: true, hasDirection: false,
        },
        contractId: "ct-1",
      },
      capsWith(fakeDeps().deps),
      "ct-1",
    );
    assert.equal(status, 400);
  });

  it("被抑制的兜底桶行上仍然过不去——闸门在分发之前（G1）", async () => {
    const { status, body } = await handleCapability(
      "propose-code",
      { scope: { ...CATCH_ALL_ROW, suppressed: true }, contractId: "ct-1" },
      capsWith(fakeDeps().deps),
      "ct-1",
    );
    assert.equal(status, 400);
    assert.equal((body as { error: string }).error, "capability_not_available");
  });

  it("缺装配 → 503，不是一个假的 runId", async () => {
    const { status, body } = await post({ redTeamInput: async () => null, lookup: async () => null });
    assert.equal(status, 503);
    assert.equal((body as { error: string }).error, "proposal_not_available");
  });
});

describe("[M85-08] 提出者是真实身份，不是 system", () => {
  it("**`decidedBy` 是路由从 `?actor=` 填进来的那个人**", async () => {
    const runs = createCapabilityRuns();
    const { deps, raised } = fakeDeps();
    const { done } = startProposeCode(runs, deps, { actor: "admin:luo" });
    await done;
    assert.equal(raised.length, 1, "一条都没提成的话，下面的断言是空的");
    assert.equal(raised[0].actor, "admin:luo");
    // 模型名不该出现在这一列上——它记的是"谁决定的"，不是"谁生成的"。
    assert.ok(!/deepseek|system|pending/i.test(raised[0].actor));
  });

  it("端点默认 `unknown:unknown`，不静默填一个 system", async () => {
    /*
     * 填 `system` 的话，一条没人负责的提案在待审队列里看起来有人提过。
     * `unknown:unknown` 一眼看得出是这一跳没填上。
     */
    const { deps } = fakeDeps();
    const { body } = await post(capsWith(deps));
    assert.equal((body as { actor: string }).actor, "unknown:unknown");
  });
});

describe("[M85-08] 提案不改任何既成事实（G3）", () => {
  it("**装配面上根本没有能写 codebook 的口子**", async () => {
    /*
     * 这是 G3 的运行时证明，与源码扫描互补：扫描只看得见字面量。
     * `ProposeCodeDeps` 一共就五个回调，其中唯一会写库的是 `raise`
     * （往 `research_decisions` **追加**一条）。想写 codebook 的话，
     * 得先在这个接口上加一个回调——而那一改会让下面这条断言直接变红。
     */
    const { deps } = fakeDeps();
    assert.deepEqual(Object.keys(deps).sort(), [
      "catchAllThemes", "nameOne", "otherCodesFor", "raise", "textsByIds",
    ]);

    // 真跑一遍，证明它在这五个口子下确实跑得通（否则上面那条只是在断言一个死对象）。
    const runs = createCapabilityRuns();
    const { runId, done } = startProposeCode(runs, deps, { actor: "admin:luo" });
    await done;
    assert.equal(runs.state(runId)!.error, undefined);
  });

  it("源码扫描：C8 的实现里不出现 codebook 的写操作", () => {
    /*
     * **先剥注释再扫**：这个文件的文件头正在解释"为什么不写 `research_codebooks`"，
     * 按整段文本扫的话它会被自己的说明卡住——而那会逼着下一个人把说明删掉。
     */
    const code = readFileSync(join(PKG, "src", "capabilities", "propose-code.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const w of ["codebooks", "lockCodebook", "themes\\.upsert", "codings\\.insertMany", "insights\\.setLevel"]) {
      assert.ok(!new RegExp(w).test(code), `C8 里出现了 ${w}——提案不得改任何既成事实`);
    }
    // 剥注释之后还得剩下代码，否则这条扫描是在扫一个空字符串。
    assert.ok(code.includes("export function startProposeCode"), "剥注释剥过头了，这条扫描变成恒真");
  });

  it("[M85-02] G3 的源码扫描覆盖到 src/capabilities/ 全目录", () => {
    // 新增文件落在同一个目录里，所以那条既有扫描自动覆盖到它——这条只钉住"目录没空"。
    const files = readdirSync(join(PKG, "src", "capabilities")).filter((f) => f.endsWith(".ts"));
    assert.ok(files.includes("propose-code.ts"), "C8 的实现不在被扫描的目录里");
  });
});

describe("[M85-08] cannibalization 由代码算，且不进提示词", () => {
  it("**算出来的数字不出现在喂给模型的入参里**", async () => {
    const runs = createCapabilityRuns();
    const { deps, named } = fakeDeps();
    const { done } = startProposeCode(runs, deps, { actor: "admin:luo" });
    await done;

    assert.equal(named.length, 1, "模型一次都没被调到，下面的断言是空的");
    const seen = JSON.stringify(named[0]);
    assert.ok(!seen.includes("charging-speed"), `重叠码名进了提示词：${seen}`);
    assert.ok(!seen.includes("cannibal"), "重叠这一栏进了提示词");
    // 模型拿到的只有代表句与反例句——它的活儿是起名，不是数数。
    assert.deepEqual(Object.keys(named[0] as object).sort(), ["counterExamples", "examples", "runId", "themeId"]);
  });

  it("算完的表与合计一起出，空数组时合计是 0 而不是缺失", async () => {
    const runs = createCapabilityRuns();
    const { deps, raised } = fakeDeps({ otherCodesFor: async () => [] });
    const { done } = startProposeCode(runs, deps, { actor: "a" });
    await done;
    const p = raised[0].proposal;
    assert.deepEqual(p.cannibalization, []);
    assert.equal(p.cannibalizedTotal, 0, "空数组时合计缺失，读的人分不清「没有重叠」和「没算」");
    assert.equal(p.candidateUnits, 3, "分母没带出来，那张表就只有绝对数");
  });

  it("有重叠时合计是逐项相加", async () => {
    const runs = createCapabilityRuns();
    const { deps, raised } = fakeDeps();
    const { done } = startProposeCode(runs, deps, { actor: "a" });
    await done;
    assert.equal(raised[0].proposal.cannibalizedTotal, 3);
  });

  it("**算它是在起名之后**——顺序反过来，那个数字就有机会进提示词", () => {
    const src = readFileSync(join(PKG, "src", "capabilities", "propose-code.ts"), "utf8");
    const body = src.slice(src.indexOf("async function buildOne"));
    assert.ok(
      body.indexOf("deps.nameOne(") < body.indexOf("deps.otherCodesFor("),
      "otherCodesFor 排到了 nameOne 前面",
    );
  });
});

describe("[M85-08] 编排：进度与终态", () => {
  it("完成时说清「codebook 一行未动」", async () => {
    const runs = createCapabilityRuns();
    const { deps } = fakeDeps();
    const { runId, done } = startProposeCode(runs, deps, { actor: "a" });
    await done;
    const st = runs.state(runId)!;
    assert.equal(st.stage, "done");
    assert.ok(st.notes.some((n) => /codebook 一行未动/.test(n)), `没说 codebook 没动：${st.notes.join(" | ")}`);
    assert.ok(st.notes.some((n) => /重叠/.test(n)), "进度里没说重叠算出来是多少");
  });

  it("兜底桶下没有主题 → fail，话说得出是哪一种失败", async () => {
    const runs = createCapabilityRuns();
    const { deps } = fakeDeps({ catchAllThemes: async () => [] });
    const { runId, done } = startProposeCode(runs, deps, { actor: "a" });
    await done;
    assert.match(runs.state(runId)!.error ?? "", /先跑一次 run/);
  });

  it("一条脱敏代表句都没有 → 那个主题被跳过并说出来", async () => {
    const runs = createCapabilityRuns();
    const { deps } = fakeDeps({ textsByIds: async () => new Map() });
    const { runId, done } = startProposeCode(runs, deps, { actor: "a" });
    await done;
    // 唯一的主题都没出成 → 整次 fail，而不是"完成 0 条"。
    assert.match(runs.state(runId)!.error ?? "", /一条提案都没提成/);
  });
});

describe("[M85-08] 待审 = 还没被决定", () => {
  const raised = (id: string) => ({ kind: PROPOSAL_RAISED, subjectId: id });
  const decided = (id: string) => ({ kind: PROPOSAL_DECIDED, subjectId: id });

  it("有对应 decided 行的不算待审", () => {
    const rows = [raised("p1"), raised("p2"), decided("p1")];
    assert.deepEqual(pendingProposals(rows).map((r) => r.subjectId), ["p2"]);
  });

  it("**判据不是提案自己的状态字段**——这张表只追加，没有能被改成「已处理」的列", () => {
    // 一条 raised 行从写下去那一刻起就再也不变，所以"处理过没有"只能由第二条回答。
    assert.deepEqual(pendingProposals([raised("p1")]).map((r) => r.subjectId), ["p1"]);
    assert.deepEqual(pendingProposals([raised("p1"), decided("p1")]), []);
  });
});

describe("[M85-08] 采纳 / 驳回写第二条，旧那条一行不改", () => {
  function reviewDeps(rows: Array<{ kind: string }>): {
    deps: ReviewDeps;
    written: Array<{ kind: string; subjectId: string; decidedBy: string; rationale: string; payload: unknown }>;
  } {
    const written: Array<{ kind: string; subjectId: string; decidedBy: string; rationale: string; payload: unknown }> = [];
    const deps = {
      repo: {
        decisions: {
          forSubject: async () => rows,
          record: async (input: { kind: string; subjectId: string; decidedBy: string; rationale: string; payload: unknown }) => {
            written.push(input);
            return { id: `dec-${written.length}` };
          },
          byKinds: async () => [],
        },
        // 这三样一被调到就说明有人在这条路上改了既成事实。
        codebooks: {
          lock: () => {
            throw new Error("不该被调到：codebooks.lock");
          },
          upsert: () => {
            throw new Error("不该被调到：codebooks.upsert");
          },
        },
        insights: {
          setLevel: () => {
            throw new Error("不该被调到：insights.setLevel");
          },
        },
      },
      codebookVersion: "0.1.0",
      lockCodebook: () => {
        throw new Error("不该被调到：lockCodebook");
      },
      pendingInterrupts: async () => [],
      resumeThread: async () => undefined,
    } as unknown as ReviewDeps;
    return { deps, written };
  }

  const body = (over: Record<string, unknown> = {}) => ({
    kind: "code-proposal-decided" as const,
    rationale: "兜底桶里这一簇确实在问一件现有码答不了的事",
    payload: { proposalId: "p1", decision: "accept", ...over },
  });

  it("**采纳写一条 decided，且 codebook 一行没被碰**", async () => {
    const { deps, written } = reviewDeps([{ kind: PROPOSAL_RAISED }]);
    const res = await handleResume("p1", body(), "admin:luo", deps);
    assert.equal(res.status, 200);
    assert.equal(written.length, 1);
    assert.equal(written[0].kind, PROPOSAL_DECIDED);
    assert.equal(written[0].subjectId, "p1");
    assert.equal(written[0].decidedBy, "admin:luo");
    assert.deepEqual(written[0].payload, { decision: "accept" });
    // 假 repo 上 codebooks 的两个方法都会抛；跑到这里就意味着一个都没被调到。
  });

  it("**回给界面的话里说全了「codebook 一行未动」**", async () => {
    const { deps } = reviewDeps([{ kind: PROPOSAL_RAISED }]);
    const res = await handleResume("p1", body(), "admin:luo", deps);
    const note = (res.body as { note: string }).note;
    assert.match(note, /codebook 一行未动/);
    assert.match(note, /单独的人工动作/);
  });

  it("驳回也写一条，且话里说清提案留在台账里", async () => {
    const { deps, written } = reviewDeps([{ kind: PROPOSAL_RAISED }]);
    const res = await handleResume("p1", body({ decision: "reject" }), "admin:luo", deps);
    assert.equal(res.status, 200);
    assert.deepEqual(written[0].payload, { decision: "reject" });
    assert.match((res.body as { note: string }).note, /被驳回的提案证明了这件事被考虑过/);
  });

  it("**理由为空 → 拒绝**，一条都不写", async () => {
    const { deps, written } = reviewDeps([{ kind: PROPOSAL_RAISED }]);
    const res = await handleResume("p1", { ...body(), rationale: "  " }, "admin:luo", deps);
    assert.equal(res.status, 400);
    assert.equal((res.body as { error: string }).error, "rationale_required");
    assert.equal(written.length, 0);
  });

  it("提案不存在 → 404，不凭空写一条决定", async () => {
    const { deps, written } = reviewDeps([]);
    const res = await handleResume("p1", body(), "admin:luo", deps);
    assert.equal(res.status, 404);
    assert.equal(written.length, 0);
  });

  it("**已经决定过 → 400**，不写第二条互相矛盾的记录", async () => {
    /*
     * 这张表只追加、没有谁覆盖谁。允许重复 POST 的话，同一条提案下会躺着
     * 一条采纳、一条驳回，而半年后读的人答不出"这条到底采纳了没有"。
     */
    const { deps, written } = reviewDeps([{ kind: PROPOSAL_RAISED }, { kind: PROPOSAL_DECIDED }]);
    const res = await handleResume("p1", body(), "admin:luo", deps);
    assert.equal(res.status, 400);
    assert.equal((res.body as { error: string }).error, "proposal_already_decided");
    assert.equal(written.length, 0);
  });

  it("decision 只有 accept / reject 两种，不设第三种", async () => {
    const { deps, written } = reviewDeps([{ kind: PROPOSAL_RAISED }]);
    for (const d of ["maybe", "", "ACCEPT"]) {
      const res = await handleResume("p1", body({ decision: d }), "admin:luo", deps);
      assert.equal(res.status, 400, `${d} 被放行了`);
    }
    assert.equal(written.length, 0);
  });
});
