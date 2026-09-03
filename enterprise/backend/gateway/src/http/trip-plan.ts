/**
 * 座舱 HUD 的只读状态端点（施工单 M13-03，M13-10 扩展）。
 *
 * `GET /v1/trip-plan/current` —— 座舱 HUD 轮询的唯一入口。
 *
 * 返回两样：
 *   - `plan`：已确认行程，没有就是 `null`；
 *   - `home`：车主常住地，**没有行程时 HUD 的地图落点**。
 *
 * # 为什么常住地挂在这条路由上而不是另起一条
 *
 * 端上的网络在 Rust（§2.2 C2），加一条路由就要加一个 Tauri 命令、一条
 * `GatewayClient` 方法、一份 capability，以及第二个 60 秒轮询。而这两样
 * 回答的是同一个问题——**HUD 现在该显示什么**：有行程画行程，没有就画家。
 * 路由名留着不改，改名会打断已在跑的 Rust 客户端。
 *
 * 网关红线不变：只做 鉴权 → 查仓储 → 原样返回。**不判过期、不做 HUD 映射**——
 * 那些是确定性规则，落在端上的 shared 映射函数里（M13-04），
 * 网关掺一半会出现"两处各判一半、谁都不全"的形态。
 *
 * 无行程返回 `200 {plan: null, home}` 而不是 404：轮询端把 404 当异常会反复告警，
 * 而"还没确认过行程"是常态不是异常。
 */

import { Router, json } from "express";
import type { Response } from "express";

import type { NavPlan, NavPlanOrigin, NavPlanRequest, NavPlanResponse } from "@carlife/shared";
import type { OwnerProfileRepository, TripPlanRepository } from "@carlife/db";

import type { AuthedRequest } from "../auth";

/**
 * 打开 App 时的**读时重算**（M20-06）。
 *
 * 行前物品与天气是确认那一刻算的；出发前几天天气变了，卡上还是那天的推荐。
 * 端上在打开（与从后台切回前台）的那一次带 `?refreshPretrip=1`，
 * 网关据此让 runtime 用最新天气重算一遍。
 *
 * **网关这一侧只做字段级组装**：算天气要工具、要 registry，那是 runtime 的事
 * （本文件顶部的红线：只做 鉴权 → 查仓储 → 原样返回）。
 * **重算不落库**：库里那份是用户批准过的行程，环境数据不该悄悄改写它。
 */
async function refreshPretrip(
  runtimeUrl: string,
  plan: unknown,
  timeoutMs = 6_000,
): Promise<{ pretripItems?: unknown; weather?: unknown } | undefined> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${runtimeUrl}/internal/trip/pretrip-refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan }),
      signal: ac.signal,
    });
    if (!r.ok) return undefined;
    const body = (await r.json()) as { pretripItems?: unknown; weather?: unknown; skipped?: string };
    // `skipped`（行程过期 / 重算失败）不是错误，只是这次没有新值可用。
    if (!body.pretripItems) return undefined;
    return { pretripItems: body.pretripItems, weather: body.weather };
  } catch {
    // 超时、runtime 没起、网络抖动——一律当"这次没算成"，绝不把 HUD 变成一次报错。
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 目的地推荐的读时补齐（M32-02）。
 *
 * ⚠️ **它现在是兜底，不是主路**（M32-02 修订）：推荐已改为行程确认/变更后由 runtime
 * 在后台算好、**写回库里那份快照**。所以库里有值时这一跳根本不发——
 * 每开一次 App 就烧一次联网搜索没有任何收益，而库里那份就是它算出来的同一份。
 * 留着它是为了两种行程：修订之前确认的老行程，以及后台那次没算成的。
 *
 * 与上面 `refreshPretrip` **同族同形状**，两处不同：
 *
 *  - **超时 25 秒**而不是 6 秒。天气那条的 6 秒是按天气接口的耗时定的；
 *    推荐要经一次联网搜索，M32-01 三次真跑是 11.7 / 12.4 / 14.0 秒（工具侧超时 30 秒）。
 *    拿 6 秒去等它 = 这个功能从来不会成功。
 *  - `skipped` 有三种（`expired` / `empty` / `failed`），对端上都是同一件事：
 *    这次没有推荐，卡上就少一页。
 *
 * ⚠️ 两条重算**必须并发**（见调用处）：串起来最坏 31 秒，端上首帧会明显卡住。
 */
async function refreshHighlights(
  runtimeUrl: string,
  plan: unknown,
  timeoutMs = 25_000,
): Promise<unknown | undefined> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${runtimeUrl}/internal/trip/highlights-refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan }),
      signal: ac.signal,
    });
    if (!r.ok) return undefined;
    const body = (await r.json()) as { destinationHighlights?: unknown; skipped?: string };
    return body.destinationHighlights;
  } catch {
    // 超时、runtime 没起、网络抖动——一律当"这次没算成"，端上照常拿到没有推荐的行程。
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 出发导航规划的网关挂等预算（M66-03）。分配：runtime 分支 55 s → 网关 60 s → Rust 65 s → 端上 60 s 硬顶。
 * 端上的顶比这里短是刻意的：端上的判据是"用户等了多久"，服务端晚到的结果按序号丢弃。
 */
export const NAV_PLAN_TIMEOUT_MS = 60_000;

/**
 * 出发导航规划的转发（M66-03）。与 `refreshPretrip` 同族：AbortController 挂等、非 200 与 `skipped` 都当"这次没算成"。
 * 返回 undefined = 没有方案；调用方回 `status:"failed"`，**绝不 5xx**——端上据此按今天的直连走。
 */
async function requestNavPlan(
  runtimeUrl: string,
  body: { userId: string; plan: unknown; origin: NavPlanOrigin; vin?: string },
  timeoutMs: number,
): Promise<{ plan: NavPlan; elapsedMs?: number } | undefined> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${runtimeUrl}/internal/trip/nav-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!r.ok) return undefined;
    const upstream = (await r.json()) as { plan?: NavPlan; elapsedMs?: number; skipped?: string };
    if (!upstream.plan) return undefined;
    return { plan: upstream.plan, ...(upstream.elapsedMs !== undefined ? { elapsedMs: upstream.elapsedMs } : {}) };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** 端上定位的新鲜度（分钟）：由 `origin.at` 算，算不出就不给——runtime 只在有值时写 caveat。 */
export function originAgeMinutes(at: unknown, now = Date.now()): number | undefined {
  if (typeof at !== "string") return undefined;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.round((now - t) / 60_000));
}

export function createTripPlanRouter(
  repo: TripPlanRepository,
  ownerProfiles?: OwnerProfileRepository,
  /** runtime 内部地址；不传 = 不提供重算能力（单挂测试与旧装配点照常工作）。 */
  runtimeUrl?: string,
  /** 出发导航规划的挂等预算；测试注入小值，生产不传。 */
  navPlanTimeoutMs = NAV_PLAN_TIMEOUT_MS,
): Router {
  const router = Router();

  /*
   * 出发导航规划（M66-03）：点「开始行程」的唯一入口。网关红线不变：
   * 鉴权 → 按鉴权身份查行程（**不接受 body 里的 plan**，接受了就是让端上替别人规划）→ 补起点
   * （body 有 → fix；无 → 常住地 home；都无 → failed/no_origin，不打 runtime）→ 转发 → 原样透传 plan。
   * 失败一律 200 + `status:"failed"`（trip-plan / guide 同款取舍）：端上据此走今天的直连，5xx 会把降级渲染成报错。
   */
  router.post("/v1/trip-plan/nav-plan", json(), async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const startedAt = Date.now();
    const body = (req.body ?? {}) as NavPlanRequest;
    const current = await repo.currentForUser(req.userId).catch(() => null);
    if (!current) {
      res.json({ status: "failed", reason: "no_plan" } satisfies NavPlanResponse);
      return;
    }
    let origin: NavPlanOrigin | undefined;
    const o = body.origin;
    if (o && typeof o.lat === "number" && typeof o.lon === "number" && Number.isFinite(o.lat) && Number.isFinite(o.lon)) {
      const age = originAgeMinutes(o.at);
      origin = { lat: o.lat, lon: o.lon, source: "fix", ...(age !== undefined ? { ageMinutes: age } : {}) };
    } else {
      const owner = await ownerProfiles?.currentForUser(req.userId).catch(() => undefined);
      if (owner?.home) origin = { lat: owner.home.lat, lon: owner.home.lon, source: "home" };
    }
    if (!origin) {
      res.json({ status: "failed", reason: "no_origin" } satisfies NavPlanResponse);
      return;
    }
    if (!runtimeUrl) {
      res.json({ status: "failed", reason: "failed" } satisfies NavPlanResponse);
      return;
    }
    const reply = await requestNavPlan(
      runtimeUrl,
      {
        userId: req.userId,
        plan: current.plan,
        origin,
        ...(typeof body.vin === "string" && body.vin.trim() ? { vin: body.vin.trim() } : {}),
      },
      navPlanTimeoutMs,
    );
    if (!reply) {
      res.json({
        status: "failed",
        reason: Date.now() - startedAt >= navPlanTimeoutMs ? "timeout" : "failed",
        elapsedMs: Date.now() - startedAt,
      } satisfies NavPlanResponse);
      return;
    }
    // plan **原样透传**（网关红线）：字段增减由 shared 契约管，这里不挑不拣。
    res.json({ status: "ready", plan: reply.plan, elapsedMs: Date.now() - startedAt } satisfies NavPlanResponse);
  });

  router.get("/v1/trip-plan/current", async (req: AuthedRequest, res: Response) => {
    // demoAuth 之后 userId 恒在；防御性判空是为了单独挂载测试时不静默查错人。
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    /*
     * 常住地拿不到不阻塞行程：HUD 没有落点只是退回写死的默认中心，
     * 而拿不到行程是"主功能没了"。未注入仓储（单挂测试）时同理。
     */
    const [current, owner] = await Promise.all([
      repo.currentForUser(req.userId),
      ownerProfiles?.currentForUser(req.userId).catch((e) => {
        console.warn("[trip-plan] 常住地读取失败（HUD 退回默认中心）", e);
        return undefined;
      }),
    ]);
    const home = owner?.home;
    if (!current) {
      res.json({ plan: null, ...(home ? { home } : {}) });
      return;
    }
    /*
     * opt-in 重算（M20-06）：只有端上明确要求这一次才算。
     * 默认路径一字不变——Rust 客户端已经在按 60 秒轮它，不能因为这条改了行为。
     */
    const wantRefresh = req.query.refreshPretrip === "1" && runtimeUrl !== undefined;
    /*
     * 两条重算**并发**，不串行（M32-02）。
     *
     * 串起来最坏 6 + 25 = 31 秒，而这是端上打开 App 的首帧那一跳——
     * 用户会看着一张空 HUD 等半分钟。并发之后最坏就是慢的那一条（25 秒），
     * 且**任一条失败不影响另一条**：天气挂了照样能出推荐，反之亦然。
     *
     * 一个 query 参数管两件事是刻意的：端上"打开时刷一次环境数据"是一件事，
     * 拆两个开关只会出现"刷了一半"这种没人想要的状态。
     */
    /*
     * 推荐**只在库里没有时才现算**（M32-02 修订）。
     *
     * 它已经在确认/变更那一刻由 runtime 后台算好并落库，库里那份就是权威；
     * 再打一次只是拿同一份结果去烧一次按次计费的联网搜索。
     * 判空看的是快照本身，不看 `wantRefresh`——两者是不同的问题
     * （"要不要重算天气" vs "这一程有没有推荐"）。
     */
    const storedHighlights = (current.plan as { destinationHighlights?: unknown })
      .destinationHighlights;
    const [fresh, highlights] = wantRefresh
      ? await Promise.all([
          refreshPretrip(runtimeUrl, current.plan),
          storedHighlights ? undefined : refreshHighlights(runtimeUrl, current.plan),
        ])
      : [undefined, undefined];
    const plan = {
      ...current.plan,
      ...(fresh ?? {}),
      ...(highlights ? { destinationHighlights: highlights } : {}),
    };

    res.json({
      plan,
      committedAt: current.committedAt.toISOString(),
      // 让端上与排障能分辨"这次是新算的还是库里的"——两者看起来一模一样。
      ...(wantRefresh
        ? {
            pretripRefreshed: fresh !== undefined,
            // 库里已有 = 这一跳没现算，但端上照样拿得到推荐——两件事分开报，
            // 否则排障时"没刷"会被读成"没有"。
            highlightsRefreshed: highlights !== undefined,
            highlightsFromStore: storedHighlights !== undefined,
          }
        : {}),
      ...(home ? { home } : {}),
    });
  });

  return router;
}
