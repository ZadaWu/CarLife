/**
 * 研究工具的回调面（施工单 M88-04，ACR-038 步 4）。
 *
 * pi 子进程里的扩展薄代理（`pi-research/.pi/extensions/research-tools.ts`）
 * 打到这两条路径上：取工具表、转发一次执行。工具**实现**留在本进程，
 * 与车主面同一条理由——取数要 `ResearchToolDeps`（仓储、码表版本、镜头与分群），
 * 那些是用研进程里的东西，pi 子进程拿不到也不该拿到。
 *
 * # 这一层为什么必须计步
 *
 * 直连路径的上界是 AI SDK 的 `maxSteps: CHALLENGE_MAX_STEPS`（8）。
 * **pi 没有这个参数**：它自己跑工具循环，`--approve` 下每次调用都放行。
 * 于是上界只剩一个落点——按 pi 会话数 invoke 次数（ACR-038 实施陷阱 3）。
 * 漏掉它的后果不是"跑久一点"：一次挑战会一直查下去，到超时为止，
 * 而超时的表现是"这张卡没有挑战记录"，看起来像**没找到反例**。
 *
 * 三条落地纪律，每条都对应一种"零报错"的错法：
 *
 * 1. **键是 `piSessionId`，不是 Agent、不是进程。** 同一个 pi 进程会先后跑多张卡的挑战
 *    （池按 Agent × 档位分进程），按进程计步会让第二张卡一上来就"步数已用满"。
 * 2. **第 9 次回 HTTP 200 + `{ ok: false, error }`，不是 4xx。** 回 4xx pi 会把它当传输
 *    错误重试；回 200 + 文本，模型读得到并停手（与权限门 deny 的形状一致）。
 * 3. **deps 按会话键查表，查不到就明说结束。** 宁可模型少查一次，
 *    也不能拿**别的挑战**的窗去答——那种答案看起来完全正常。
 * 4. **一轮一本账：`register` 归零、`release` 销账**（M89-02）。同一个挑战键会被
 *    追问反复用（C7 走同一个键、同一个 pi 会话），计步若跨轮累加，第二轮一上来就
 *    带着上一轮的 8 步起手——表现是"追问一次就 inconclusive / 答不出"，
 *    而日志里只看得到一句"步数已用满"，看不出它是上一轮花掉的。
 *
 * 5. **工具返回过哪些 id 也记一本**（M89-03）。「问它」收口后要拿模型写的
 *    `citedUnitIds` / `citedThemeIds` 与这一本取交集——引用不能靠模型自律：
 *    它编一个 `unit-0007` 出来时，那一条读起来和真的一模一样。
 *    这本账与计步同寿命（同一行、同一次 `register` 归零、同一次 `release` 销账）：
 *    上一轮返回过的 id 不该给这一轮的引用背书。
 *
 * 一轮 = 一次 `register` 到对应的 `release`。M88-04 §6 当初写"release 刻意不清"，
 * 理由是"收口跳在挑战结束之后才读 `hitLimit`"——**这条理由不成立**：
 * 真实调用序在 `stages/challenge.ts:135-157`，`register` → `challenge()`
 * （内部 `exploreAcp` 返回时 `hitLimit` 已经读完并定下）→ `finally release`。
 * `release` 之后没有任何读者，所以清得掉。
 *
 * # 不接权限门
 *
 * 研究工具全只读、零 sensitive（设计稿 §6），这里没有门可过。
 * 车主面 `tools-endpoint.ts` 的可见域裁剪与 `guardGate` 在这条路上都不存在，
 * 别照抄过来：那是"谁在用"的问题，而本进程不认识用户（ADR-011）。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  CHALLENGE_MAX_STEPS,
  invokeTool,
  listForAgent,
  describeForPi,
  type ResearchAgentName,
  type ResearchToolDeps,
} from "@carlife/research-tools";

/**
 * 两条回调路径。**扩展与这里同源**：`pi-research/.pi/extensions/research-tools.ts`
 * 按同样的字面量拼 URL，`test/pi-research-dir.test.ts` 拿这两个常量逐字比对。
 * 拼错的症状是扩展启动即 404 —— 那还算好的；更坏的是有人把路径改在一侧，
 * 另一侧回 404 后模型手里零工具却照样编出像样的答案。
 */
export const RESEARCH_TOOLS_DESCRIBE_PATH = "/internal/research/tools/describe";
export const RESEARCH_TOOLS_INVOKE_PATH = "/internal/research/tools/invoke";

/**
 * 扩展没自报 Agent、也反解不出来时的缺省。
 *
 * 取 `challenger` 是因为它是唯一一条**不由研究员发起**的路（批量挑战），
 * 落错缺省的代价是 ACL 裁到另一个 Agent 的表上——那会表现为 403，看得见。
 * M89-02 之后 `ResearchAgentName` 有四个取值，这里仍只能有一个缺省。
 */
const DEFAULT_AGENT: ResearchAgentName = "challenger";

/** 扩展拿不到 pi 会话 id 时发的占位值（与扩展侧逐字一致）。 */
const UNKNOWN_SESSION = "unknown";

/**
 * pi 会话 → 挑战会话与 Agent 的反解。由装配层注入（M88-05 起池之后就是
 * `AcpClientPool.resolveSession`，签名逐字相同）。
 *
 * `carlifeSessionId` 在用研面就是**挑战键** `challenge:<insightId>:<runId ?? "batch">`，
 * 也就是 `registerChallengeSession` 的那个 key。名字保持与底座一致，
 * 是为了让 M88-05 能把池的方法直接塞进来，不必在中间加一层适配。
 */
export type ResearchSessionResolver = (
  acpSessionId: string,
) => { carlifeSessionId: string; agent: string } | undefined;

export interface ResearchToolsEndpointOptions {
  resolveSession?: ResearchSessionResolver;
  /** 一次挑战最多几步工具循环。缺省取工具表里的那个数，**不在本文件里再写一个**。 */
  maxSteps?: number;
}

/** 计步表里一行。`hitLimit` 留给 M88-05 的收口跳读：超限就把 `holds` 强制成 `inconclusive`。 */
export interface StepState {
  steps: number;
  hitLimit: boolean;
}

/**
 * 表里真正存的那一行：计步 + 本轮工具返回过的 id（M89-03）。
 *
 * **对外仍然只投影 `StepState`**：`stepsOf` / `stepsForKey` 的返回形状一个字段都没加，
 * 既有用例的 `deepEqual(stepsOf(…), { steps, hitLimit })` 因此一字未动。
 * id 那一本走 `seenIdsOf` / `seenIdsForKey` 单独问——两笔账各有各的读者，
 * 混进一个返回值里会让"探查跳有没有撞上界"这个判据多带一个几十项的集合。
 */
interface StepRow extends StepState {
  seenIds: Set<string>;
}

/** 从返回 JSON 里收 id 的键名。只认这三个——别的键上的字符串不是研究实体 id。 */
const ID_KEYS = new Set(["unitId", "themeId", "id"]);

/** 遍历深度上界。工具返回是几层的普通对象，给足余量即可，防的是环与畸形数据。 */
const ID_SCAN_MAX_DEPTH = 8;

/**
 * 把一份工具返回里出现过的研究实体 id 收进集合。
 *
 * **宁可收多也不收少**：这本账是引用核对的**白名单**，多收一个的代价是
 * 一条本该被剥掉的引用被留下（它本来就在返回里出现过），
 * 少收一个的代价是把模型如实引用的那一条剥掉——后者才是不可接受的那一侧。
 * 所以 `id` 这个宽键也收（`themeMembers` 回的主题、`codebookLookup` 回的码都用它）。
 */
function collectIds(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > ID_SCAN_MAX_DEPTH || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) collectIds(v, into, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") {
      if (ID_KEYS.has(k) && v) into.add(v);
    } else {
      collectIds(v, into, depth + 1);
    }
  }
}

export interface ResearchToolsEndpointStats {
  /** 扩展加载时会拉一次工具表——它是**扩展确实被 pi 加载**的唯一证据（M88-00 判定 5）。 */
  describeCalls: number;
  /** 过了 ACL 与步数上界、进到执行这一步的调用次数。 */
  invokeCalls: number;
  /** 被 ACL 拒掉的次数。 */
  denied: number;
  /** 回过"步数已用满"的次数。 */
  limitHits: number;
  /** 当前挂着的挑战会话数。挑战结束没 release 的话它只增不减，一眼看得出。 */
  activeSessions: number;
  /**
   * 当前留着计步行的 pi 会话数（M89-02）。
   *
   * 与 `activeSessions` 是两笔账：会话表按挑战键、计步表按 pi 会话。
   * 两个数都该随 `release` 落回去，`trackedSteps` 只增不减就是漏了销账——
   * 那是个慢性泄漏，不暴露出来只能等进程内存变大时才发现。
   */
  trackedSteps: number;
}

export interface ResearchToolsEndpoint {
  /** 返回 true 表示本请求已被处理（形状照车主面的 `handleToolsRequest`）。 */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** 一次挑战开始前登记它的取数；key = 挑战键。 */
  registerChallengeSession(key: string, deps: ResearchToolDeps): void;
  /** 挑战结束后摘掉。摘掉之后再来的 invoke 一律回"挑战会话已结束"。 */
  release(key: string): void;
  /** 这个 pi 会话走了几步、有没有撞上界。没来过就是 `undefined`。 */
  stepsOf(piSessionId: string): StepState | undefined;
  /**
   * 同上，但按**挑战键**问（M88-05）。
   *
   * 探查跳结束后要读 `hitLimit`，而它手里只有会话键——pi 会话 id 是 pi 侧生成的，
   * 调用方拿不到。反解表在底座（`AcpClientPool.resolveSession`）里且是**单向**的，
   * 于是这一层在第一次 invoke 时顺手记下反过来的那一半。
   * 一个挑战键对一个 pi 会话：会话键含 insightId（+ runId），不会串。
   */
  stepsForKey(key: string): StepState | undefined;
  /**
   * 这个 pi 会话**本轮**的工具返回里出现过哪些研究实体 id（M89-03）。
   *
   * 「问它」的收口跳拿它与模型写的引用取交集。没来过（或已 release）就是 `undefined`
   * ——调用方必须把它读成"这一轮工具一条 id 都没返回过"，于是所有引用都会被剥掉；
   * 读成"不核对"的话，一次工具全失灵的探查会产出一份满是编造引用的笔记。
   */
  seenIdsOf(piSessionId: string): ReadonlySet<string> | undefined;
  /** 同上，但按会话键问（探查跳手里只有键，见 `stepsForKey`）。 */
  seenIdsForKey(key: string): ReadonlySet<string> | undefined;
  stats(): ResearchToolsEndpointStats;
}

export function createResearchToolsEndpoint(
  opts: ResearchToolsEndpointOptions = {},
): ResearchToolsEndpoint {
  const maxSteps = opts.maxSteps ?? CHALLENGE_MAX_STEPS;
  /** 挑战键 → 这一次挑战的取数。**一次挑战一份**，不是进程级一份。 */
  const sessions = new Map<string, ResearchToolDeps>();
  /**
   * pi 会话 id → 计步。**一行只记当前这一轮**（M89-02）。
   *
   * 上界是"一轮最多查几步"，不是"这个 pi 会话一辈子最多查几步"：
   * 池按 `carlifeSessionId` 复用会话，追问与批量挑战都落回同一个 pi 会话，
   * 跨轮累加的话第二轮起手即满。所以 `register` 归零、`release` 销账。
   *
   * 清得掉的前提是**没有跨过 release 的读者**：`hitLimit` 由 `exploreAcp` 在
   * `challenge()` 内部读完（`stages/challenge.ts:135-157` 的调用序），
   * `release` 排在那之后的 `finally` 里。M88-04 §6 当初担心的正是这一点，
   * 但调用序落定后那条担心不成立——详见文件头第 4 条。
   *
   * 行里还带**本轮工具返回过的 id**（M89-03，文件头第 5 条）：同寿命、同一次归零。
   */
  const steps = new Map<string, StepRow>();
  /**
   * 挑战键 → pi 会话 id（M88-05）。
   *
   * **它不跟着 release 清**，与 `steps` 相反：下一轮同一个键还要靶到同一个 pi 会话
   * 才归得了零，而归零要在第一次 invoke **之前**做（那时本轮还没人来记这张表）。
   * 丢了它，第二轮的 `register` 就不知道该清哪一行，于是退化回跨轮累加。
   * 一个挑战键对一个 pi 会话：会话复用时覆盖是幂等的。
   */
  const piSessionOfKey = new Map<string, string>();
  const stats: ResearchToolsEndpointStats = {
    describeCalls: 0,
    invokeCalls: 0,
    denied: 0,
    limitHits: 0,
    activeSessions: 0,
    trackedSteps: 0,
  };

  /**
   * 挑战键 → 取数。
   *
   * 注入了反解就**只信反解**：它是权威的那一份，反解不出来说明这个 pi 会话
   * 不属于任何一次挑战，此时回落到"库里唯一那个会话"等于拿别人的窗去答。
   *
   * 没注入反解时（M88-05 接池之前的形态）允许一条**确定性**的回落：
   * 当且仅当此刻恰好挂着**一个**挑战会话，就是它。0 个或 ≥2 个一律按结束处理——
   * "挑一个最近的"那种回落在并发两张卡时会静默串台。
   */
  const keyFor = (piSessionId: string): string | undefined => {
    if (opts.resolveSession) return opts.resolveSession(piSessionId)?.carlifeSessionId;
    if (sessions.size !== 1) return undefined;
    return [...sessions.keys()][0];
  };

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  const readJson = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  };

  return {
    async handle(req, res) {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;

      if (req.method === "GET" && path === RESEARCH_TOOLS_DESCRIBE_PATH) {
        const agent = (url.searchParams.get("agent") ?? DEFAULT_AGENT) as ResearchAgentName;
        stats.describeCalls += 1;
        // 未知 Agent 回空表（ACL 的语义就是"这个 Agent 什么都拿不到"），不 404：
        // 扩展那边 HTTP 非 2xx 会直接抛，而"名字写错了"该表现为工具数 0 而不是起不来。
        json(res, 200, { agent, tools: describeForPi(agent) });
        return true;
      }

      if (req.method !== "POST" || path !== RESEARCH_TOOLS_INVOKE_PATH) return false;

      let body: { name?: string; args?: unknown; agent?: string; piSessionId?: string };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        json(res, 400, { error: "invalid_json" });
        return true;
      }
      if (!body.name) {
        json(res, 400, { error: "missing_tool_name" });
        return true;
      }

      const rawSessionId = body.piSessionId ?? UNKNOWN_SESSION;
      // 反解优先于 pi 进程自报的身份：进程只知道自己是哪个 Agent 的，
      // 而一个进程里会先后跑多个会话。
      const resolved = opts.resolveSession?.(rawSessionId);
      const agent = (resolved?.agent ?? body.agent ?? DEFAULT_AGENT) as ResearchAgentName;

      // ACL（唯一读法是 `listForAgent`）：pi 侧发来不属于它的工具名也要拒。
      if (!listForAgent(agent).some((t) => t.name === body.name)) {
        stats.denied += 1;
        json(res, 403, { error: "tool_not_allowed_for_agent", agent, tool: body.name });
        return true;
      }

      /*
       * 计步。**拿不到会话 id 时不计步、但打警告**——不静默放行也不静默拒绝：
       * 静默放行等于这次挑战没有上界，静默拒绝等于工具突然不工作了，
       * 两种都只能靠事后翻记录才发现。打出来，冒烟就看得见（M88-00 关键约束 1）。
       */
      if (rawSessionId === UNKNOWN_SESSION) {
        console.warn(
          `[research-tools] invoke ${body.name} 没带 piSessionId——本次不计步，` +
            `这次挑战的 ${maxSteps} 步上界在这条路上不生效`,
        );
      } else {
        const st = steps.get(rawSessionId) ?? { steps: 0, hitLimit: false, seenIds: new Set<string>() };
        if (st.steps >= maxSteps) {
          st.hitLimit = true;
          steps.set(rawSessionId, st);
          stats.trackedSteps = steps.size;
          stats.limitHits += 1;
          // HTTP 200 + 文本：模型读得到并停手；回 4xx 的话 pi 当传输错误重试。
          json(res, 200, { ok: false, error: limitMessage(maxSteps) });
          return true;
        }
        st.steps += 1;
        steps.set(rawSessionId, st);
        stats.trackedSteps = steps.size;
      }

      stats.invokeCalls += 1;

      const sessionKey = keyFor(rawSessionId);
      // 反过来的那一半（M88-05）：探查跳结束后按挑战键读 `hitLimit`，而它拿不到 pi 会话 id。
      if (sessionKey !== undefined && rawSessionId !== UNKNOWN_SESSION) {
        piSessionOfKey.set(sessionKey, rawSessionId);
      }
      const deps = sessionKey === undefined ? undefined : sessions.get(sessionKey);
      if (!deps) {
        // 宁可模型少查一次，也不能拿别的挑战的窗去答。
        json(res, 200, { ok: false, error: "挑战会话已结束" });
        return true;
      }

      const startedAt = Date.now();
      try {
        const out = await invokeTool(body.name, body.args, deps);
        /*
         * 引用核对的那本账（M89-03）。**只在成功时收**：`ok: false` 的返回里
         * 没有数据，只有一句错误文本，收它等于给一堆不存在的 id 背书。
         * 拿不到 piSessionId 时这一轮没有行可记——与计步同一个口径。
         */
        if (out.ok) {
          const row = steps.get(rawSessionId);
          if (row) collectIds(out.data, row.seenIds);
        }
        console.log(
          `[research-tools] ${body.name} agent=${agent} session=${rawSessionId} ` +
            `${out.ok ? "ok" : "rejected"} ${Date.now() - startedAt}ms`,
        );
        /*
         * 成功回 `{ ok: true, result }`——扩展读的是 `body.result`。
         * 注册表那边的字段名是 `data`，两个名字在这一跳对上；对不上的症状是
         * 模型每次都收到 `undefined`，而它会照着 `undefined` 继续编。
         */
        json(res, 200, out.ok ? { ok: true, result: out.data } : { ok: false, error: out.error });
      } catch (err) {
        // 取数炸了也回 200 + 文本：这是"工具坏了"，模型该看见并改道，
        // 而不是收到一个传输错误然后重试同一件事。
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[research-tools] ${body.name} agent=${agent} session=${rawSessionId} failed ` +
            `${Date.now() - startedAt}ms：${message}`,
        );
        json(res, 200, { ok: false, error: message });
      }
      return true;
    },

    /**
     * 一轮开始：登记取数，并把这个键上一轮留下的步数**归零**（M89-02）。
     *
     * 第一轮时 `piSessionOfKey` 里还没有这个键（它在第一次 invoke 才记下），
     * 此时无事可做——正确：本来就没有上一轮。
     * 第二轮起，池复用同一个 pi 会话，`piSessionOfKey` 指的就是那一行，清它。
     */
    registerChallengeSession(key, deps) {
      sessions.set(key, deps);
      stats.activeSessions = sessions.size;

      const piSessionId = piSessionOfKey.get(key);
      if (piSessionId !== undefined) {
        // id 那本账跟着一起归零：上一轮返回过的 id 不该给这一轮的引用背书。
        steps.set(piSessionId, { steps: 0, hitLimit: false, seenIds: new Set<string>() });
        stats.trackedSteps = steps.size;
      }
    },

    /**
     * 一轮结束：摘掉取数，并把计步行销账。
     *
     * `piSessionOfKey` **保留**——下一轮同一个键要靠它找到该归零的那一行。
     * 销账的时机安全，因为 `hitLimit` 的唯一读者（收口跳）在 `release` 之前
     * 就读完了（文件头第 4 条记的调用序）。
     */
    release(key) {
      sessions.delete(key);
      stats.activeSessions = sessions.size;

      const piSessionId = piSessionOfKey.get(key);
      if (piSessionId !== undefined) {
        steps.delete(piSessionId);
        stats.trackedSteps = steps.size;
      }
    },

    /*
     * 对外只投影 `{ steps, hitLimit }`：直接把内部那一行回出去的话，
     * `seenIds` 会被带到每一个读计步的地方，而它是另一笔账的东西。
     */
    stepsOf: (piSessionId) => projectSteps(steps.get(piSessionId)),

    stepsForKey(key) {
      const piSessionId = piSessionOfKey.get(key);
      return piSessionId === undefined ? undefined : projectSteps(steps.get(piSessionId));
    },

    seenIdsOf: (piSessionId) => steps.get(piSessionId)?.seenIds,

    seenIdsForKey(key) {
      const piSessionId = piSessionOfKey.get(key);
      return piSessionId === undefined ? undefined : steps.get(piSessionId)?.seenIds;
    },

    stats: () => ({ ...stats }),
  };
}

/** 内部那一行 → 对外的 `StepState`。没有行就是 `undefined`（"这个会话没来过"）。 */
function projectSteps(row: StepRow | undefined): StepState | undefined {
  return row === undefined ? undefined : { steps: row.steps, hitLimit: row.hitLimit };
}

/**
 * 步数用满时给模型的那句话。
 *
 * **必须把"该判什么"一并说了**：只说"用满了"的话，模型会把"没查清楚"写成
 * `holds`——Challenger 的提示词从头到尾在防的就是这一种误判。
 * 步数从参数来，本文件里不另写一个 8（真相源是 `CHALLENGE_MAX_STEPS`）。
 */
function limitMessage(maxSteps: number): string {
  return `工具步数已用满（${maxSteps} 步）——没查清楚的条目请判 inconclusive，不要判 holds`;
}
