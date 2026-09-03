/**
 * 目的地推荐的取数点（施工单 M32-02）。
 *
 * # 为什么单独一个文件，而不是塞进 `supervisor.ts`
 *
 * 行前物品（`collectPretripItems`）住在 `supervisor.ts` 里，因为它挂在**行程确认那一跳**
 * ——坐标解析之后、权限门之前。推荐**刻意不在那条链上**：它一次要十几秒
 * （M32-01 三次真跑 11.7 / 12.4 / 14.0 秒），串进确认里的表现就是
 * "用户说完确认之后卡十几秒才弹窗"。
 *
 * 它走的是**确认后的后台补算**（M32-02 的修订，用户走查定的）：行程一确认/一变更，
 * 这里在后台算一次，算完**写回那一行的快照**。确认那一跳照旧不等它——
 * 十几秒的等待挂在"说完确认之后"是不可接受的，但那不构成"不能落库"的理由，
 * 只构成"不能同步落库"。
 *
 * 落库换来的是这张卡**不再时有时无**：以前它只在带 opt-in 的那一跳才有值，
 * 于是端上每 60 秒一轮的常规轮询会把它擦掉一次（用户走查原话："有时候只能看到推荐物品"）。
 *
 * 读时补齐那条路**留着当兜底**（`/internal/trip/highlights-refresh`）：
 * 老行程与后台那次没算成的行程还得靠它，网关据此只在库里没有时才调。
 *
 * 所以这个文件与图（graph）其实没有关系，只是与 `supervisor.ts` 的
 * `collectPretripItems` 同族、放在一起好找。
 */

import { hasHighlights, tripDayIndex } from "@carlife/shared";
import type { DestinationHighlights, PhotoTipRef, TripPlanSnapshot } from "@carlife/shared";
import { invokeTool } from "@carlife/tools";

/**
 * 算一次目的地推荐。**抛错就抛出去**——调用方（端点）负责翻译成 `skipped`。
 *
 * 目的地取 `plan.destination`（用户说的那个地方，如「舟山普陀山」），
 * **不取 skeleton 里的景点名**（「普济寺」那种）——按后者搜会搜出一堆同名寺庙。
 */
export async function collectDestinationHighlights(
  plan: TripPlanSnapshot,
  sessionId = "trip-highlights",
): Promise<DestinationHighlights> {
  const destination = plan.destination?.trim();
  if (!destination) throw new Error("行程没有目的地，无从搜起");

  // `invokeTool` 回的是四件套的 `ToolResult`（`{ data, source }`），不是裸数据。
  const r = (await invokeTool(
    "destination_highlights",
    { destination, ...(plan.startDate ? { date: plan.startDate } : {}) },
    { sessionId, agent: "trip" },
  )) as { data: { foods: ToolEntry[]; spots: ToolEntry[]; photoTips: PhotoTipRef[] } };
  const data = r.data;

  return {
    destination,
    foods: data.foods.map(toEntry),
    spots: data.spots.map(toEntry),
    photoTips: data.photoTips,
    // 它不落库，没有别的时间锚——排障时"这份是什么时候的"只能问这一栏。
    computedAt: new Date().toISOString(),
  };
}

/** 工具侧的形状：出处是**嵌套对象**，有才有、没有就整个缺席。 */
interface ToolEntry {
  name: string;
  note: string;
  source?: { url: string; title?: string };
}

/**
 * 工具形状 → 端云契约形状。
 *
 * 两边刻意不同：工具那侧 `source` 是个整体（"这条有没有出处"是一个二值判断，
 * 嵌套对象让它不可能只有一半）；契约这侧摊平成 `sourceUrl`/`sourceTitle`，
 * 因为它要过 JSON、过 zod、过端上的渲染，层层嵌套只是徒增判空。
 *
 * **摊平时不许造值**：`source` 缺席 → 两个字段都不出现，而不是空串——
 * 空串在端上是"有出处但没写"，与"没有出处"是两回事。
 */
function toEntry(e: ToolEntry): DestinationHighlights["foods"][number] {
  return {
    name: e.name,
    note: e.note,
    ...(e.source ? { sourceUrl: e.source.url } : {}),
    ...(e.source?.title ? { sourceTitle: e.source.title } : {}),
  };
}


// ── 确认后的后台补算与回写（M32-02 修订）──────────────────────────

/**
 * 这份推荐是**给这一程算的**吗。
 *
 * 判据只有目的地，不含日期：推荐的内容是"这个地方吃什么、拍哪儿"，
 * 那是周级变化的东西，改出发日不会让它变成假话（改目的地会）。
 * 日期照样会触发一次重算（它进了工具的缓存键），只是重算期间旧的那份仍然可用——
 * 不留这个空窗的话，"把出发日往后挪一天"会让卡片凭空少一页十几秒。
 */
function highlightsMatchPlan(h: DestinationHighlights, plan: TripPlanSnapshot): boolean {
  return h.destination.trim() === plan.destination?.trim();
}

/** 去掉推荐这一栏（**删键**，不是写 undefined——它要过 JSON，留个空键端上还得多判一种形态）。 */
function withoutHighlights(plan: TripPlanSnapshot): TripPlanSnapshot {
  if (!plan.destinationHighlights) return plan;
  const { destinationHighlights: _drop, ...rest } = plan;
  return rest;
}

/**
 * 行程变更时决定推荐这一栏的去留（新的那份算好之前，屏幕上放什么）。
 *
 * 三条，按顺序：
 *  1. 新快照自带、且对得上新目的地 → 用它；
 *  2. 库里那份对得上新目的地 → **沿用**，等后台算完再覆盖；
 *  3. 其余（改了目的地 / 自带的是上一程的）→ **立刻清掉**。
 *
 * 第 3 条是这次修订的要害：把广州的馆子挂在一趟杭州的行程上，
 * 比"这一栏暂时空着"糟得多——它不是过期，是错。
 */
export function carryOverHighlights(
  prev: TripPlanSnapshot | undefined,
  next: TripPlanSnapshot,
): TripPlanSnapshot {
  const own = next.destinationHighlights;
  if (own && highlightsMatchPlan(own, next)) return next;
  const inherited = prev?.destinationHighlights;
  if (inherited && highlightsMatchPlan(inherited, next)) {
    return { ...next, destinationHighlights: inherited };
  }
  return withoutHighlights(next);
}

/** 补算要用到的仓储面。**只声明这两个方法**——不 import `@carlife/db`，单测给个假的即可。 */
export interface HighlightsPlanStore {
  currentForUser(
    userId: string,
  ): Promise<{ planId: string; sessionId: string; plan: TripPlanSnapshot } | null>;
  update(
    userId: string,
    planId: string,
    sessionId: string,
    plan: TripPlanSnapshot,
  ): Promise<unknown>;
}

export interface HighlightsBackfillTarget {
  userId: string;
  planId: string;
  sessionId: string;
  plan: TripPlanSnapshot;
}

export interface HighlightsBackfill {
  /** 确认/变更之后调。**不返回 Promise**：主动作绝不等它。 */
  schedule(target: HighlightsBackfillTarget): void;
  /** 等当前在跑的补算全部结束（测试与优雅退出用）。 */
  idle(): Promise<void>;
}

export interface HighlightsBackfillOptions {
  /** 取推荐（测试注入）。 */
  collect?: (plan: TripPlanSnapshot) => Promise<DestinationHighlights>;
  /** 今天（YYYY-MM-DD，测试注入）。 */
  today?: () => string;
}

/**
 * 行程确认/变更 → 后台算一次目的地推荐 → 写回那一行。
 *
 * 三条刻意的取舍：
 *
 *  1. **fire-and-forget**。它要十几秒（M32-01 真跑 11.7 / 12.4 / 14.0 秒），
 *     串进确认那一跳就是"说完确认之后卡十几秒才弹窗"。失败只记一行日志——
 *     确认行程是主动作，不能被一个环境数据的副作用拖垮。
 *  2. **写回前重读**。算的这十几秒里用户完全可能又改了一次行程；
 *     拿手里这份旧快照去 `update` 会把用户刚改的东西覆盖掉。所以以库里最新那份为底，
 *     只加推荐这一栏；期间换了行程或换了目的地就**整个丢弃**这次的结果。
 *  3. **同一程只跑一个**。连着改三次行程会排三个十几秒的任务；
 *     在跑就记一个"再跑一次"，跑完补一轮，中间那几次自然合并掉。
 */
export function createHighlightsBackfill(
  store: HighlightsPlanStore,
  opts: HighlightsBackfillOptions = {},
): HighlightsBackfill {
  const collect = opts.collect ?? ((plan: TripPlanSnapshot) => collectDestinationHighlights(plan));
  const today = opts.today ?? (() => new Date().toISOString().slice(0, 10));
  /** planId → 是否有"跑完再来一次"的请求。键在表里 = 正在跑。 */
  const running = new Map<string, boolean>();
  const waiters: Array<Promise<void>> = [];

  const once = async (t: HighlightsBackfillTarget): Promise<void> => {
    // 已经结束的行程不值得烧一次联网搜索——它连卡都不会上（tripPlanToHud 返回 null）。
    if (tripDayIndex(t.plan, today()) === null) return;
    const highlights = await collect(t.plan);
    // 三段全空 = 这次什么都没搜到。**不写**——写进去等于把"没有"存成了一个空对象。
    if (!hasHighlights(highlights)) return;

    const cur = await store.currentForUser(t.userId);
    if (!cur || cur.planId !== t.planId) return; // 期间换了行程 / 被取消
    if (!highlightsMatchPlan(highlights, cur.plan)) return; // 期间改了目的地，这份属于旧版本
    await store.update(t.userId, cur.planId, cur.sessionId, {
      ...cur.plan,
      destinationHighlights: highlights,
    });
  };

  const loop = async (t: HighlightsBackfillTarget): Promise<void> => {
    try {
      do {
        running.set(t.planId, false);
        try {
          await once(t);
        } catch (err) {
          console.warn("[highlights] 后台补算失败（这一程这次就没有推荐页）", err);
        }
      } while (running.get(t.planId));
    } finally {
      running.delete(t.planId);
    }
  };

  return {
    schedule(t) {
      if (running.has(t.planId)) {
        running.set(t.planId, true); // 在跑 → 记一次重跑，不再排一个新任务
        return;
      }
      const p = loop(t);
      waiters.push(p);
      void p.finally(() => {
        const i = waiters.indexOf(p);
        if (i >= 0) waiters.splice(i, 1);
      });
    },
    async idle() {
      while (waiters.length > 0) await Promise.all([...waiters]);
    },
  };
}
