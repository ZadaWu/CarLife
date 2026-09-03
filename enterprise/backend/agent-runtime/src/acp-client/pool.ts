/**
 * 按 Agent 分进程的 ACP 客户端池（F-13 主线修复）。
 *
 * # 为什么必须分进程
 *
 * 一个 `AcpClient` = 一个 `pi-acp` 子进程，而**工具表是进程级的**：
 * `.pi/extensions/carlife-tools.ts` 在扩展加载时读一次 `CARLIFE_PI_AGENT`，
 * 据此向 agent-runtime 要该 Agent 的工具清单，然后 `pi.registerTool` 注册。
 * 之后这个进程里的所有会话看到的都是那一份清单。
 *
 * 此前 `index.ts` 只建了一个客户端、`CARLIFE_PI_AGENT` 落到默认的 `supervisor`，
 * 于是**六个 Agent 共用一份 supervisor 的工具表**（只有 weather 和 cost_calc）。
 * 后果：
 *  - 出行分支手上根本没有 `calendar` 与 `map_route`——
 *    "并行 → 汇聚 → HITL → 写日历"这条演示主线的后半段**结构上不可能发生**。
 *    而模型不会说"我没有这个工具"，它会说"出发时间已写入日历"。
 *  - 用车/售后拿不到 `ragflow_retrieve`（双路能跑是因为图节点自己调，不经 pi）。
 *  - 工具日志里 `agent` 恒为 supervisor，§4.3 的能力映射事实上没有生效。
 *
 * 没有任何报错。这类缺陷只能靠"真跑一遍看工具有没有被调到"发现。
 *
 * # 为什么不是把工具表并集注册后在运行时按 Agent 拒绝
 *
 * 那样模型仍会**看到**不属于它的工具，然后调用、被 403、再道歉——
 * §4.3 的裁剪本意是"根本不给它这个选项"。看得见但用不了比看不见更糟。
 *
 * # 惰性
 *
 * 六个进程全量预热要几秒且多数会话用不到。按需建：第一次用到某个 Agent 才 spawn。
 * `supervisor` 例外——启动自检要用它，顺带把最常用的那个预热了。
 */

import { AcpClient, type AcpClientOptions, type AcpHealth, type AgentName } from "./connection";
import { canonicalAgent, thinkingLevelFor } from "./agent-prompt";
import type { ChatTurnMessage } from "../llm";

/**
 * 进程键 = 规范 Agent + 思考档位。
 *
 * 【为什么不能只用规范名】fan-out 的 `trip-task` 与直达的 `trip` 职责说明、工具表
 * 确实是同一份，本来共用一个进程没问题。但**思考档位是按进程定的**
 * （pi 的 `--model <id>:<level>` 在启动时就固定了），而这两者需要的档位相反：
 * 分支的输出被 `merge.ts` 正则解析，思考纯属浪费；应答的输出车主直接读，
 * 关掉思考会明显退化（见 `thinkingLevelFor` 与 pi-agents/README）。
 * 于是键必须带上档位，否则先建的那个进程决定了后来者的档位。
 *
 * 【为什么键不能直接当 Agent 名用】`canonicalAgent` 只剥 `-task`/`-intent`，
 * 带别的后缀的键会让 `loadAgentPrompt` 去找 `trip:off.md` 并抛错——
 * 而外部症状只是"分支失败"。所以构造 `AcpClient` 时传的仍是**规范名**，
 * 档位单独作为一个选项传下去。
 *
 * 【代价】进程数从 6 涨到最多 9（多出 `supervisor-intent` / `trip-task` /
 * `ownership-task` 三个 `off` 档进程）。进程是惰性建的，只有真用到才 spawn。
 */
function processKey(agent: AgentName | string): string {
  return `${canonicalAgent(agent)}:${thinkingLevelFor(agent)}`;
}

export class AcpClientPool {
  private clients = new Map<string, AcpClient>();
  private disposed = false;

  constructor(private opts: Omit<AcpClientOptions, "agent"> = {}) {}

  /** 取（或建）某个 Agent 的客户端。 */
  clientFor(agent: AgentName | string): AcpClient {
    const key = processKey(agent);
    let c = this.clients.get(key);
    if (!c) {
      // **传规范名，不是 key**——key 带着 `:off` 后缀，会让 prompt 加载去找 `trip:off.md`。
      c = new AcpClient({
        ...this.opts,
        agent: canonicalAgent(agent) as AgentName,
        thinkingLevel: thinkingLevelFor(agent),
      });
      this.clients.set(key, c);
    }
    return c;
  }

  async *prompt(args: {
    carlifeSessionId: string;
    agent: AgentName;
    messages: ChatTurnMessage[];
    /** 取消信号（TD-08）。整包透传——池这一层不该知道它是干什么的。 */
    signal?: AbortSignal;
  }): AsyncGenerator<string> {
    yield* this.clientFor(args.agent).prompt(args);
  }

  /**
   * pi 会话 id → CarLife 会话与 Agent。
   *
   * 逐个客户端问：会话 id 是 pi 侧生成的，池这一层没有全局索引。
   * 客户端最多六个，这个扫描不值得再建一层缓存——
   * 多一份缓存就多一处失效时机，而它解决的是一个 O(6) 的问题。
   */
  resolveSession(acpSessionId: string): { carlifeSessionId: string; agent: AgentName } | undefined {
    for (const c of this.clients.values()) {
      const hit = c.resolveSession(acpSessionId);
      if (hit) return hit;
    }
    return undefined;
  }

  /**
   * 聚合健康。
   *
   * `connected` 取**全部已建进程都连上**——只要有一个 Agent 的进程掉了，
   * 那个 Agent 的请求就会失败，报"已连接"是不实表述。
   */
  getHealth(): AcpHealth & { processes: number } {
    const all = [...this.clients.values()].map((c) => c.getHealth());
    const unmapped: Record<string, number> = {};
    for (const h of all) {
      for (const [k, v] of Object.entries(h.unmappedUpdates)) unmapped[k] = (unmapped[k] ?? 0) + v;
    }
    return {
      connected: all.length > 0 && all.every((h) => h.connected),
      restarts: all.reduce((a, h) => a + h.restarts, 0),
      unmappedUpdates: unmapped,
      processes: all.length,
    };
  }

  /** 启动自检跑在 supervisor 上——它是每一轮都会用到的那个进程。 */
  async selfCheck(describeCalls: () => number): Promise<{ ok: boolean; detail: string }> {
    return this.clientFor("supervisor").selfCheck(describeCalls);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const c of this.clients.values()) c.dispose();
    this.clients.clear();
  }
}
