/**
 * 探针：LangGraph v1 的 `invoke` 认不认 `RunnableConfig.signal`（施工单 M33-01 关键落地约束 1）。
 *
 * **这不是一条普通单测，它是选型判据**：认 → M33-01 走主方案（把 turn 级 AbortSignal
 * 交给框架）；不认 → 走降级方案（只在事件队列侧掐 + 把 signal 送进 ACP 那一路）。
 * 结论会直接写进验收，所以这个文件要留在仓库里——将来升 LangGraph 版本时它是回归。
 *
 * 断言的是**行为**不是异常类型：不同版本抛的错不一样（AbortError / Error / DOMException），
 * 而我们真正在乎的只有一件事——**第二个节点有没有跑**。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

const Probe = Annotation.Root({
  hits: Annotation<string[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
});

describe("[M33-01] LangGraph 取消探针", () => {
  it("abort 之后后续节点不再执行", async () => {
    const controller = new AbortController();
    const ran: string[] = [];

    const graph = new StateGraph(Probe)
      .addNode("first", async () => {
        ran.push("first");
        controller.abort();
        return { hits: ["first"] };
      })
      .addNode("second", async () => {
        ran.push("second");
        return { hits: ["second"] };
      })
      .addEdge(START, "first")
      .addEdge("first", "second")
      .addEdge("second", END)
      .compile();

    let threw = false;
    try {
      await graph.invoke({ hits: [] }, { signal: controller.signal });
    } catch {
      threw = true;
    }

    // 判据只有这一条：第一个节点跑过，第二个没跑。
    assert.deepEqual(ran, ["first"], `第二个节点不该执行（threw=${threw}）`);
  });

  it("没有 abort 时两个节点都跑（对照组——防止上面那条因为别的原因过）", async () => {
    const ran: string[] = [];
    const controller = new AbortController();

    const graph = new StateGraph(Probe)
      .addNode("first", async () => {
        ran.push("first");
        return { hits: ["first"] };
      })
      .addNode("second", async () => {
        ran.push("second");
        return { hits: ["second"] };
      })
      .addEdge(START, "first")
      .addEdge("first", "second")
      .addEdge("second", END)
      .compile();

    await graph.invoke({ hits: [] }, { signal: controller.signal });
    assert.deepEqual(ran, ["first", "second"]);
  });

  it("入图之前就已 abort：一个节点都不跑", async () => {
    const controller = new AbortController();
    controller.abort();
    const ran: string[] = [];

    const graph = new StateGraph(Probe)
      .addNode("first", async () => {
        ran.push("first");
        return { hits: ["first"] };
      })
      .addEdge(START, "first")
      .addEdge("first", END)
      .compile();

    try {
      await graph.invoke({ hits: [] }, { signal: controller.signal });
    } catch {
      /* 抛不抛无所谓，看 ran */
    }
    assert.deepEqual(ran, []);
  });
});
