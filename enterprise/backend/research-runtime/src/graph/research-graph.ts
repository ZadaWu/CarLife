/**
 * 研究图（施工单 M82-06）：Frame → Prepare → Model → Analyze → Synthesize → Challenge → Gate → Review。
 *
 * # 为什么这一步才引图
 *
 * M82-05 的运行是一个普通 async 函数，那时候它没有分支、没有人工中断——
 * 引图只会多一层要读的东西。本单加进来的是**人工决定**：codebook 锁版、
 * 洞察升级、售后线索放行。这些要"停在半路、等人、再从原地继续"，
 * 而那正是检查点 + `interrupt()` 唯一比手写状态机划算的地方。
 *
 * # 检查点共表，但 thread 前缀隔开
 *
 * 与 `agent-runtime` 共用 `checkpoints*` 四张表（`PostgresSaver.setup()` 幂等）。
 * `thread_id` 一律 `research:<contractId>:<runId>`——**前缀是唯一的隔离手段**，
 * 两个进程共表时靠它互不打扰。`setup()` 前后既有检查点行数不变，单测钉住。
 *
 * # 停在哪里是有讲究的
 *
 * `review` 节点只在**真的需要人**的时候停：codebook 没锁就停（口径没定死之前，
 * 后面每个数字的含义都还会变）。升级与售后放行不在图里停——它们是对**已经产出的**
 * 洞察做的决定，走 `review/:threadId/resume` 的独立端点，不占着一条图的执行。
 */

import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";

/** 图的状态。刻意只放"节点之间要传的东西"，重的数据留在库里按需读。 */
export const ResearchState = Annotation.Root({
  contractId: Annotation<string>,
  windowFrom: Annotation<number>,
  windowTo: Annotation<number>,
  /** 走到哪一步了——`GET runs/:id` 读它。 */
  stage: Annotation<string>({ reducer: (_, next) => next, default: () => "frame" }),
  turns: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  themes: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  insights: Annotation<string[]>({ reducer: (_, next) => next, default: () => [] }),
  challenges: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  /** codebook 锁了没——决定 review 节点停不停。 */
  codebookLocked: Annotation<boolean>({ reducer: (_, next) => next, default: () => false }),
  notes: Annotation<string[]>({ reducer: (prev, next) => [...prev, ...next], default: () => [] }),
});

export type ResearchStateType = typeof ResearchState.State;

/**
 * 一次运行的口径：哪份合同、哪个窗口。
 *
 * 四个回调**各自都要它**：出卡要按这个窗取代表句、挑战要按这个窗查系统变更、
 * 算门要读这个合同的快照。不逐个传的话，装配处只能在闭包里放一个可变的
 * "当前窗口"，而那个变量在两次运行并发时会串——串了不报错，
 * 只是这一次的卡是按上一次的窗写的。
 */
export interface RunContext {
  contractId: string;
  windowFrom: number;
  windowTo: number;
}

/** 图要用到的外部动作。全部注入——图本身不认识仓储，才好单测。 */
export interface GraphDeps {
  /** 快照那一整段（M82-05 的 `runResearch`）。 */
  analyze: (ctx: RunContext) => Promise<{
    turns: number;
    themes: number;
  }>;
  /** 每个主题一张卡，返回洞察 id。 */
  synthesizeAll: (ctx: RunContext) => Promise<string[]>;
  /** 每张卡一次挑战，返回写了多少条挑战记录。 */
  challengeAll: (insightIds: string[], ctx: RunContext) => Promise<number>;
  /**
   * 算门、报等级天花板、确保 level 仍是 signal。
   *
   * 返回的 `note` 直接进 `notes[]`：门的判定是"这一窗的数字能读到什么程度"，
   * 而 `GET runs/:id` 正是拿 `notes[]` 回答"这次运行发生了什么"。
   * 只让它进日志的话，那句判定在界面上就不存在。
   */
  gate: (insightIds: string[], ctx: RunContext) => Promise<{ note: string }>;
  /** codebook 当前锁没锁。 */
  isCodebookLocked: () => Promise<boolean>;
}

/** 状态 → 口径。四个回调共用一处构造，不在各节点里各拼一遍。 */
const runContextOf = (s: ResearchStateType): RunContext => ({
  contractId: s.contractId,
  windowFrom: s.windowFrom,
  windowTo: s.windowTo,
});

export function buildResearchGraph(deps: GraphDeps) {
  const graph = new StateGraph(ResearchState)
    .addNode("frame", async (s) => ({
      stage: "frame",
      notes: [`合同 ${s.contractId}，窗口 ${new Date(s.windowFrom).toISOString()} – ${new Date(s.windowTo).toISOString()}`],
    }))
    .addNode("analyze", async (s) => {
      const out = await deps.analyze(runContextOf(s));
      return { stage: "analyze", turns: out.turns, themes: out.themes, notes: [`${out.turns} 轮 / ${out.themes} 主题`] };
    })
    .addNode("synthesize", async (s) => {
      const ids = await deps.synthesizeAll(runContextOf(s));
      return { stage: "synthesize", insights: ids, notes: [`${ids.length} 张洞察卡`] };
    })
    .addNode("challenge", async (s) => {
      const n = await deps.challengeAll(s.insights, runContextOf(s));
      return { stage: "challenge", challenges: n, notes: [`${n} 条挑战记录`] };
    })
    .addNode("gate", async (s) => {
      const out = await deps.gate(s.insights, runContextOf(s));
      const locked = await deps.isCodebookLocked();
      return {
        stage: "gate",
        codebookLocked: locked,
        notes: [out.note, locked ? "codebook 已锁" : "codebook 未锁"],
      };
    })
    .addNode("review", async (s) => {
      if (!s.codebookLocked) {
        /*
         * 停在这里等人。**不是报错**：codebook 未锁是研究早期的正常状态，
         * 只是在锁之前不能把结论当成可跨窗比较的东西。
         * `interrupt` 的载荷就是控制台 review 页要显示的内容。
         */
        interrupt({
          kind: "codebook-lock",
          subject: s.contractId,
          missing: "codebook 还没锁版：锁之前每个数字的含义都还会变，跨窗比较没有意义",
          insights: s.insights.length,
        });
      }
      return { stage: "done", notes: ["走完"] };
    })
    .addEdge(START, "frame")
    .addEdge("frame", "analyze")
    .addEdge("analyze", "synthesize")
    .addEdge("synthesize", "challenge")
    .addEdge("challenge", "gate")
    .addEdge("gate", "review")
    .addEdge("review", END);

  return graph;
}

/** `thread_id` 的唯一构造处。前缀是与 `agent-runtime` 共表时的隔离手段。 */
export function researchThreadId(contractId: string, runId: string): string {
  return `research:${contractId}:${runId}`;
}
