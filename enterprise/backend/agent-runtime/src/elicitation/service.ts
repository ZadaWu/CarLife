/**
 * 补录询问的装配侧（施工单 M26-03，架构文档 §4.6，F-53-04/05/09、F-54-10）。
 *
 * # 为什么状态不放图状态
 *
 * §4.6 约束 4 的不变量是：**同一辆陈旧的车，在"从未被问过"与"已拒答"两种状态下，
 * 喂给各 Agent 的上下文与工具集逐字段相同。** 保证它最便宜的办法不是"小心别读"，
 * 而是**让它压根不在图状态里**——子图能读到的东西里没有它，就不存在读错的可能。
 *
 * 所以"上一轮问了什么"放在本服务的会话级 Map 里，冷却放在自己的 PG 表里，
 * 图那一侧只拿到一个字符串："这一轮要不要在回答后面追加一句话"。
 *
 * # 会话级 Map 的生命周期
 *
 * 它只承载"上一轮问了没有"，跨轮但不跨会话——与 ①Working 同一档（§7①）。
 * 丢了的后果只是少记一次拒答，不是问错人：真正需要跨重启的是**冷却**，那在 PG。
 * 上限是防内存无界，超了整体丢弃即可（同 `sessionUsers` 的处理）。
 */

import {
  DEFAULT_ELICITATION_COOLDOWN_DAYS,
  type ElicitationCooldown,
  type ElicitationKind,
  type ElicitationSlot,
} from "@carlife/shared";

import {
  elicitationQuestion,
  looksLikeDecline,
  pickElicitation,
  slotsFromFreshness,
  energySlotFor,
  type FreshnessLike,
  type PretripContext,
} from "../graph/elicitation";
import { energyAskPrompt, parseEnergyLevel } from "../graph/energy";

const DAY_MS = 86_400_000;
/** 会话上限，防内存无界。超了整体丢弃——丢的只是"上一轮问了没有"。 */
const MAX_SESSIONS = 5_000;

/** 车主口述里抽出来的 ④ 事实。抽不到的项**缺席**，不给默认值。 */
export interface ElicitedFacts {
  /** 上次保养日期（epoch ms）。 */
  lastServiceAt?: number;
  /** 保养项目原话。 */
  items?: string;
  /** 当前里程（公里），按车主口径原样记，不四舍五入。 */
  odometerKm?: number;
}

export interface ElicitationDeps {
  /**
   * 从车主这一轮的原话里抽出 ④ 事实。**由模型做，不写正则**（§4.5）。
   *
   * ⚠️ 这里没有走"让模型自己调工具"的 A 型，原因是一个实测出来的事实：
   * `ownership` 是 **B 型**子图——它自己 `invokeTool` 做双路检索，
   * 而应答那一步走的是**直连 narrator，系统提示词明写"你自己没有任何工具"**。
   * 所以模型在这条路上根本拿不到 `vehicle_profile_write`，
   * 真跑里表现为"答得很好、一个字没落库、权限门零次"（见 M26-04 验收 §5）。
   * 折中是：**理解人话仍然交给模型**（这个函数），**决定写不写交给编排层**——
   * 与该子图既有的 B 型形态一致，且一行正则都没有。
   */
  extract(userText: string): Promise<ElicitedFacts | undefined>;
  /**
   * 复述 + 一次确认。**返回的就是车主在弹窗上批没批**。
   *
   * `summary` 就是复述本身（AC-53-5）：车主看到的那一屏写的就是要落库的那几个数。
   * 走既有权限门（B 型子图自行 `guardGate.check()` 的既有形态），**不新造通路**。
   */
  /**
   * @param threadKey **中断总线按 threadId 登记**（见 `interrupt-bus.ts` 文件头）。
   *   传真会话 id 会让弹窗送不出去，而运行时只会打一句
   *   「中断没有出口（本轮的流已关闭）」——第一次真跑正是栽在这里。
   */
  confirm(input: {
    threadKey: string;
    summary: string;
    details: string[];
  }): Promise<boolean>;
  /** 确认之后落库。分两次调用（保养一次、里程一次）由本服务决定。 */
  write(input: {
    vin: string;
    op: "maintenance" | "odometer";
    odometerKm: number;
    at?: number;
    items?: string;
  }): Promise<unknown>;
  /**
   * 档案里此刻的里程。**把仓储层的「只前进」规则提前到复述之前。**
   *
   * ⚠️ 这条规则在下游是**静默**的：`advanceOdometerWithin` 在
   * `新值 <= 旧值` 时直接 `return false`，而 `vehicle_profile_write` 照样返回
   * 一份 profile——链路上没有任何一处会说"没写"。真跑里的表现是：
   * 确认弹窗上写着「当前里程 20000 公里」、审计记着 `written: ["odometerKm"]`，
   * 而档案页的里程纹丝不动。车主看到的和实际发生的是两件事。
   *
   * 所以这里先读一次：写不进去的项**不放进复述、也不发出去**，
   * 改成在同一屏上说明"这个数比档案里的小，这次不改里程"。
   *
   * 未注入时退回旧行为（离线 / 单测路径）。
   */
  odometerOf?(vin: string): Promise<number | undefined>;
  /** 体检这辆车。拿不到（未接入 / 出错）时返回 undefined —— **不问**，不是乱问。 */
  freshness(userId: string, vin?: string): Promise<FreshnessLike | undefined>;
  listCooldown(vin: string, since: number): Promise<ElicitationCooldown[]>;
  decline(input: {
    vin: string;
    ownerId: string;
    kind: ElicitationKind;
    at: number;
  }): Promise<unknown>;
  /**
   * 一次补录问答**收口**时记的冷却——不是拒答（见仓储层 `touch` 的说明）。
   *
   * 没有它的话有一整类情况会**永远问下去**：车主答了、我们也照答案写了，
   * 但写入被"只前进"规则丢掉 / 车主没点确认弹窗 / 他只答了两项里的一项——
   * 三种情况下体检结果都不变，于是下一个合适载体轮次又问同一句话。
   * 未注入时退回旧行为。
   */
  touchCooldown?(input: {
    vin: string;
    ownerId: string;
    kind: ElicitationKind;
    at: number;
  }): Promise<unknown>;
  /** 冷却天数。策略值，热配置——不硬编码。 */
  cooldownDays(): number | Promise<number>;
  /**
   * 车主报了余量之后，算这一趟的缺口（M26-07，F-54-05）。
   *
   * **余量只作为入参传进去，不落任何库**（§4.6 / AC-54-8）：它是"此刻"的值，
   * 写进 ④ 就变成一条明天就错的事实。返回的是给应答用的上下文文本。
   */
  /**
   * 组装出发前上下文（M26-07）。装配层实现——它要读 ④ 的能源类型与行程计划，
   * 而本服务不连库。
   *
   * @param markAsked 传入行程 key，返回"这一趟是不是已经问过了"。
   */
  pretrip?(
    userId: string,
    userText: string,
    markAsked: (planKey: string) => boolean,
  ): Promise<PretripContext | undefined>;
  energyGap?(input: {
    userId: string;
    vin: string;
    level: { value: number; unit: "L" | "%" };
    /** 本次里程。拿不到时缺口算不出来——那就如实说缺什么，**不编一个数**。 */
    distanceKm?: number;
  }): Promise<string | undefined>;
  /**
   * 一次补录的留痕（M26-05，F-53-12 / AC-53-12）。
   *
   * 记的是**这一次问答的五段**：问了什么 → 车主答了什么 → 复述内容 → 确认结果 →
   * 写了哪几个字段。缺任何一段，"当时为什么改了他的档案"就回答不出来。
   *
   * ⚠️ **不记用户话语之外的新增 PII**：`answer` 是他自己说的原话，
   * 不额外抽取、不额外存别的东西。未注入时静默跳过（离线/单测路径）。
   */
  audit?(entry: {
    vin: string;
    ownerId: string;
    asked: ElicitationKind;
    answer: string;
    restatement: string;
    approved: boolean;
    written: string[];
    /**
     * 车主说了、但**没有落进档案**的项。
     *
     * 与 `written` 分开记：把它并进 `written` 或干脆不记，都会让
     * "当时为什么没改他的档案"回答不出来——而这正是留痕存在的理由。
     */
    ignored?: string[];
  }): Promise<unknown>;
  now(): number;
}

export interface NextInput {
  sessionKey: string;
  userId: string;
  vin?: string;
  /** 本轮路由到的 Agent（规范名）。 */
  agent?: string;
  /** 本轮正常回答是否产出。 */
  answered: boolean;
  /**
   * 出发前上下文（M26-07）。`undefined` = 这一轮不是出发前。
   *
   * **规划阶段不传**：那时问了到出发也过期了（AC-54-1）。
   */
  pretrip?: PretripContext;
}

export interface ElicitationService {
  /**
   * 结算上一轮的提问。**在本轮开始时调**，输入是车主这一轮说的话。
   *
   * 三种拒答里本函数认前两种（明确说不用 / "待会儿说"）与第三种的一半
   * （**忽略后转移话题**：上一轮问了，这一轮一个数字都没有）。
   * 真正的"答案抽取"是 M26-04 的事——这里只做"显然不是在回答"的判定，
   * 宁可少记一次拒答，也不要把一次真实回答记成拒答（那会让车主再也不被问）。
   */
  /**
   * @returns 本轮要**追加给应答的上下文**（能源缺口测算结果），没有就 undefined。
   *   走的是与"编排层已完成的求解结果"同一条路：求解在代码里做完，模型只表述。
   */
  settle(
    sessionKey: string,
    threadKey: string,
    userId: string,
    userText: string,
  ): Promise<string | undefined>;
  /** 本轮要不要追加一句提问；返回文案或 undefined。 */
  next(input: NextInput): Promise<string | undefined>;
  /** 测试与运维：清掉会话级记忆。 */
  reset(): void;
  /**
   * 这一轮是不是出发前，以及这一趟的能源形态（M26-07，F-54-04）。
   *
   * `undefined` = 不是出发前 ⇒ **不问余量**。规划阶段问了到出发也过期了（AC-54-1）。
   */
  pretripOf?(userId: string, userText: string): Promise<PretripContext | undefined>;
}

/**
 * ④ 的两项**是一句话问出去的**（见 `elicitationQuestion`），所以也必须一起收口：
 * 冷却记一项、另一项照问的话，车主看到的仍然是**一模一样的那句话又来了一遍**。
 */
const PROFILE_KINDS: readonly ElicitationKind[] = ["odometer", "last_service"];

/** 一句回答里有没有可能是答案——**只看有没有数字**，别的交给 M26-04。 */
function looksLikeAnswer(text: string): boolean {
  return /[0-9０-９]|[一二三四五六七八九十万千百]/.test(text);
}

export function createElicitationService(deps: ElicitationDeps): ElicitationService {
  /**
   * sessionKey → 上一轮问了什么、问的是哪辆车。
   *
   * **vin 必须一起记**：冷却按 (vin, kind) 记，而提问时用的常是"这位车主的默认车"。
   * 到结算那一轮再查一次默认车可能已经换了（多车切换），冷却就记到别的车头上——
   * 表现是"说了不用还一直问"。
   */
  const asked = new Map<string, { kind: ElicitationKind; vin: string }>();
  /**
   * 问能源余量时的那一份出发前上下文。
   *
   * **单位与里程都要留到结算那一轮**：单位不留就得再猜一次（可能猜成另一种），
   * 里程不留就得再解析一次车主上一句话——而那句话已经过去了。
   */
  const lastAsk = new Map<string, { energyType?: "bev" | "phev" | "icev"; distanceKm?: number }>();
  /**
   * 已经问过余量的行程。**按行程而不是按会话**——同一次行程只问一次（AC-54-1），
   * 而车主可能分好几次会话聊同一趟。改期/重规划会换 key，于是自动重置。
   */
  const askedTrips = new Set<string>();
  /**
   * sessionKey → 这一轮刚被回答、且补录仍在「确认 → 落库」路上的槽位。
   *
   * # 它挡住的是一个必然发生的重复
   *
   * `settle()` 在轮首消费掉"上一轮问了什么"，随后把确认弹窗**脱手**发出去
   * （等车主点是 10 分钟量级的事，见 `tryFill` 的说明）。而 `next()` 在**同一轮的末尾**
   * 重新体检一次——那时写入当然还没发生，体检结果一个字没变，于是
   * **在车主刚回答完的那一轮里，把同一句话又问了一遍**。真跑复现如此。
   *
   * 所以从"发出确认"到"这条链收口"为止，这些 kind 一律不再进候选。
   * 与 `asked` 同一档：跨轮不跨会话，丢了的代价只是可能多问一次。
   */
  const filling = new Map<string, Set<ElicitationKind>>();

  /**
   * 一次补录问答收口：给 ④ 的两项各记一次冷却（**不是拒答**）。
   *
   * 三种"答了但档案没变"的情况都靠它收口，否则会永远问下去：
   *  1. 报的里程不大于档案里的值 ⇒ 仓储层「只前进」丢弃，`odometerAt` 永远是 null，
   *     体检永远判 `unknown`；
   *  2. 车主没点确认弹窗（超时收敛成拒绝）；
   *  3. 只答了两项里的一项。
   */
  async function markAsked(vin: string, ownerId: string): Promise<void> {
    if (!deps.touchCooldown) return;
    for (const kind of PROFILE_KINDS) {
      try {
        await deps.touchCooldown({ vin, ownerId, kind, at: deps.now() });
      } catch (err) {
        // 记不上只是下次可能再问一遍，不该让这条脱手的链炸掉（fail-open）。
        console.error(
          `[elicitation] 冷却登记失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const cooldownSet = async (vin: string | undefined): Promise<Set<ElicitationKind>> => {
    if (!vin) return new Set();
    const days = (await deps.cooldownDays()) || DEFAULT_ELICITATION_COOLDOWN_DAYS;
    const rows = await deps.listCooldown(vin, deps.now() - days * DAY_MS);
    return new Set(rows.map((r) => r.kind));
  };

  /**
   * 试着把车主这一轮的话变成一次补录。返回 true 表示"这是一次回答"（不论最终写没写）。
   *
   * **未确认前一个字段都不写**（AC-53-5）。车主在弹窗上否掉时同样返回 true——
   * 他确实是在回答，只是不认那几个数；那不是拒答，不该进冷却。
   */
  async function tryFill(
    sessionKey: string,
    threadKey: string,
    vin: string,
    ownerId: string,
    asked: ElicitationKind,
    userText: string,
  ): Promise<boolean> {
    let facts: ElicitedFacts | undefined;
    try {
      facts = await deps.extract(userText);
    } catch (err) {
      console.error(
        `[elicitation] 抽取失败，本次不落库：${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
    const stated = facts?.odometerKm;
    const at = facts?.lastServiceAt;
    if (stated === undefined && at === undefined) return false;

    /*
     * 「里程只前进」这条规则在仓储层（`advanceOdometerWithin`），而它在下游是
     * **静默**的：值不大于档案里的就直接不 update，写工具照样返回一份 profile。
     * 于是弹窗上写着「当前里程 20000 公里」、审计记着已写入，档案却纹丝不动。
     *
     * 把判定提前到这里，两件事一起解决：**不写的项不出现在复述里**（AC-53-5
     * 的"车主看到的那一屏写的就是要落库的那几个数"），以及**留痕据实**。
     */
    let km = stated;
    let ignoredOdometer: number | undefined;
    if (stated !== undefined && deps.odometerOf) {
      try {
        const current = await deps.odometerOf(vin);
        if (current !== undefined && stated <= current) {
          ignoredOdometer = current;
          km = undefined;
        }
      } catch (err) {
        // 读不到就按旧行为走：宁可多一次静默丢弃，也不要因此整条补录不做。
        console.error(
          `[elicitation] 读当前里程失败，按原样提交：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 一个字都写不进去时**不弹窗**——"请确认写入：无"是纯粹的打扰。
    // 但它确实是一次回答：返回 true，由调用方按"答过了"收口（记冷却、不记拒答）。
    if (at === undefined && km === undefined) {
      const why = `里程 ${stated} 公里比档案里已经记着的 ${ignoredOdometer} 公里小，没有采纳`;
      await deps
        .audit?.({
          vin,
          ownerId,
          asked,
          answer: userText,
          restatement: why,
          approved: false,
          written: [],
          ignored: ["odometerKm"],
        })
        .catch(() => undefined);
      await markAsked(vin, ownerId);
      return true;
    }

    // 复述：车主要能一眼看出哪个数记错了，所以日期与里程都回显。
    const parts: string[] = [];
    if (at !== undefined) {
      parts.push(`${new Date(at).toLocaleDateString("zh-CN")} 做过保养${facts?.items ? `（${facts.items}）` : ""}`);
    }
    if (km !== undefined) parts.push(`当前里程 ${km} 公里`);
    // 没采纳的那一项也写在同一屏上：车主点"同意"之后什么变了、什么没变，
    // 必须在他点之前就看得见（否则就是"点了确认但什么都没发生"）。
    const notes =
      ignoredOdometer === undefined
        ? []
        : [`您说的 ${stated} 公里比档案里记着的 ${ignoredOdometer} 公里小，这次不改里程`];
    const summary = `把下面这些记进车辆档案：${[...parts, ...notes].join("；")}`;

    /*
     * 确认与落库**故意不 await**，但 `confirm` 本身要在这里同步发起。
     *
     * 两件事必须分开看：
     *  - **弹窗事件的发出**是同步的（`check()` 一进去就 `onInterrupt`），
     *    必须发生在**这一轮的流还开着**的时候——否则运行时会打出
     *    「中断没有出口（本轮的流已关闭）——用户不会看到确认弹窗」，
     *    这正是第一次真跑踩到的（M26-04 验收 §5）；
     *  - **等用户点**是异步的，权限门的确认超时是 10 分钟。
     *    await 它等于"车主不点弹窗，他这一轮的回答就永远不来"——
     *    而补录是搭便车的顺带动作，凭什么挡住正事。
     *
     * 所以：调用方 await 到这里（抽取完成、弹窗已发出）就返回，
     * 批准之后的落库由这条脱手的链自己完成。
     */
    // 从"确认已发出"到"这条链收口"为止，④ 的两项不再进候选——
    // 否则本轮末尾的 `next()` 会拿一份还没变的体检结果，把同一句话再问一遍。
    filling.set(sessionKey, new Set(PROFILE_KINDS));
    if (filling.size > MAX_SESSIONS) filling.clear();

    void deps
      .confirm({ threadKey, summary, details: [...parts, ...notes] })
      .then(async (approved) => {
        const written: string[] = [];
        // 留痕在**最后**统一记一次：批没批、写了哪几个字段，都要在同一条里说清。
        const trail = async () =>
          deps.audit?.({
            vin,
            ownerId,
            asked,
            answer: userText,
            restatement: summary,
            approved,
            written,
            ...(ignoredOdometer === undefined ? {} : { ignored: ["odometerKm"] }),
          });
        if (!approved) {
          // 没批也要留痕——"他看到了复述并且否了"与"根本没弹过窗"是两件事。
          await trail();
          return; // 是回答，只是没批——不写、也不记拒答
        }
        /*
         * 保养与里程分两次写：`appendMaintenance` 会顺带推进里程，
         * 但车主可能只说了里程。只写能写的那一项——
         * **答一半是常态，不追问另一半**（AC-53-8）。
         *
         * ⚠️ **里程必须先写**，顺序不能反。
         *
         * `appendMaintenance` 会顺带推进里程，但它推的那一次**不带来源**。
         * 先写保养的话，等轮到 `op: "odometer"` 时里程已经等于目标值，
         * `advanceOdometerWithin` 判"没前进"直接跳过——`odometer_source` 于是永远是 null。
         * 真跑里就是这么发现的：档案里里程对了、保养记录 source 也对了，
         * 唯独里程的来源是空的（M26-04 验收 §5）。
         */
        if (km !== undefined) {
          await deps.write({ vin, op: "odometer", odometerKm: km });
          written.push("odometerKm");
        }
        if (at !== undefined) {
          await deps.write({
            vin,
            op: "maintenance",
            at,
            // 里程取**车主说的那个数**，哪怕它没被采纳成"当前里程"：
            // 这条记录的来源本就是 `owner-stated`，写 0 会变成"0 公里时保养过"。
            odometerKm: km ?? stated ?? 0,
            items: facts?.items?.trim() || "车主自述的一次保养",
          });
          written.push("maintenance");
        }
        await trail();
      })
      .catch((err: unknown) => {
        console.error(
          `[elicitation] 确认或落库失败：${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(async () => {
        // **冷却先落、再放行**：反过来的话，两者之间的一轮又会问同一句话。
        await markAsked(vin, ownerId);
        filling.delete(sessionKey);
      });
    return true;
  }

  return {
    async settle(sessionKey, threadKey, userId, userText) {
      const last = asked.get(sessionKey);
      if (!last) return undefined;
      asked.delete(sessionKey);

      /*
       * 能源余量单独一条路：它**不落库**，所以不走 tryFill 那套复述 + 确认。
       *
       * 没有副作用就不该有确认弹窗——车主说"还有 45 升"，我们拿它算一次缺口，
       * 算完就随会话过期消失（§4.6：瞬时事实不进档案）。为它弹一次窗是纯粹的打扰。
       */
      if (last.kind === "energy_level") {
        const prev = lastAsk.get(sessionKey);
        const ask = energyAskPrompt(prev?.energyType);
        const level = ask ? parseEnergyLevel(userText, ask.unit) : undefined;
        if (level && !looksLikeDecline(userText)) {
          lastAsk.delete(sessionKey);
          try {
            return await deps.energyGap?.({
              userId,
              vin: last.vin,
              level,
              distanceKm: prev?.distanceKm,
            });
          } catch (err) {
            // 算不出来就不算，**不编一个数**。这一轮照常回答（fail-open）。
            console.error(
              `[elicitation] 缺口测算失败：${err instanceof Error ? err.message : String(err)}`,
            );
            return undefined;
          }
        }
        lastAsk.delete(sessionKey);
        // 没报出余量 ⇒ 当成拒答走下面的冷却，回答侧按"不答"降级（AC-54-7）。
      }
      /*
       * 明确拒绝压倒一切——哪怕句子里有数字（"先不用了，我 5 分钟后到"）。
       */
      if (!looksLikeDecline(userText)) {
        // 不像拒绝，就先试着当成回答来抽。抽到了 ⇒ 复述 → 一次确认 → 落库。
        if (await tryFill(sessionKey, threadKey, last.vin, userId, last.kind, userText)) return;
        // 抽不到、但看起来像在说数字（可能在聊别的）⇒ 不记拒答也不写，安全地什么都不做。
        if (looksLikeAnswer(userText)) return;
      }
      try {
        await deps.decline({ vin: last.vin, ownerId: userId, kind: last.kind, at: deps.now() });
      } catch (err) {
        // 记不上冷却只是下次可能再问一遍，不该让这一轮问答失败（fail-open）。
        console.error(
          `[elicitation] 拒答留痕失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    async next({ sessionKey, userId, vin, agent, answered, pretrip }) {
      // 先看载体与回答状态，**不满足就不查库**——这一步在每一轮都会跑，
      // 而绝大多数轮次都不是合适载体。
      // 明说要出发的那一轮不看路由（见 pickElicitation 的 `departing`）。
      const departing = pretrip !== undefined;
      if (!answered || (!agent && !departing)) return undefined;
      const picked = await resolve();
      if (!picked) return undefined;
      asked.set(sessionKey, { kind: picked.slot.kind, vin: picked.vin });
      if (asked.size > MAX_SESSIONS) asked.clear();
      /*
       * 能源余量的问句**按能源类型分支**（F-54-03）：燃油问升、纯电问百分比。
       * 走 `energyAskPrompt` 而不是 `elicitationQuestion` 的兜底文案——
       * 问错单位（对燃油车问"还剩百分之多少"）比不问更糟。
       */
      if (picked.slot.kind === "energy_level") {
        const ask = energyAskPrompt(pretrip?.energyType);
        if (ask) {
          // 记下问的是哪种单位：结算时按同一种解析，**不在那边再猜一次**。
          lastAsk.set(sessionKey, {
            energyType: pretrip?.energyType,
            distanceKm: pretrip?.distanceKm,
          });
          return ask.ask;
        }
      }
      return elicitationQuestion(picked.slot.kind);

      async function resolve(): Promise<{ slot: ElicitationSlot; vin: string } | undefined> {
        // 先用一次不查库的预筛：载体不对就直接 undefined。
        if (!pickElicitation({ slots: [PROBE], agent, answered, cooldown: new Set(), departing })) {
          return undefined;
        }
        let report: FreshnessLike | undefined;
        try {
          report = await deps.freshness(userId, vin);
        } catch (err) {
          // 体检失败就不问。**不问是安全的默认**——乱问一句才是打扰。
          console.error(
            `[elicitation] 体检失败，本轮不问：${err instanceof Error ? err.message : String(err)}`,
          );
          return undefined;
        }
        /*
         * 体检报的是哪辆车，冷却就按哪辆车记。
         *
         * 提问时传的 vin 常常是 undefined（"这位车主的默认车"），到结算那一轮再查一次
         * 默认车可能已经换了（多车切换）——那样冷却会记到另一辆车头上，
         * 表现是"说了不用还一直问"。所以把体检回来的 vin 一路带到 asked 里。
         * 报不出 vin（未建档）就不问。
         */
        const askedVin = report?.vin ?? undefined;
        if (!askedVin) return undefined;
        /*
         * ④ 的缺口与出发前的能源槽位**进同一个 `pickElicitation`**（AC-54-10）。
         *
         * 不是各问一句：那个函数返回至多一个。`energy_level` 是 `perishable`，
         * 所以出发前它天然压过 ④ 的两项——出发之后再问"你出发时有多少油"没有意义。
         */
        const energySlot = energySlotFor(pretrip);
        const slots = [
          ...slotsFromFreshness(report),
          ...(energySlot ? [energySlot] : []),
        ];
        if (slots.length === 0) return undefined;
        // 冷却 = 库里仍在冷却期的项 ∪ 本会话里补录仍在途的项。
        // 后者只活在内存里（跨轮不跨会话），它挡的是"同一轮里再问一遍"。
        const cooldown = await cooldownSet(askedVin);
        for (const kind of filling.get(sessionKey) ?? []) cooldown.add(kind);
        const slot = pickElicitation({
          slots,
          agent,
          answered,
          cooldown,
          departing,
        });
        return slot ? { slot, vin: askedVin } : undefined;
      }
    },

    reset() {
      asked.clear();
      lastAsk.clear();
      askedTrips.clear();
      filling.clear();
    },

    async pretripOf(userId, userText) {
      if (!deps.pretrip) return undefined;
      return deps.pretrip(userId, userText, (planKey) => {
        // 同一次行程只问一次（AC-54-1）。改期/重规划换 planKey ⇒ 自动重置。
        if (askedTrips.has(planKey)) return true;
        askedTrips.add(planKey);
        if (askedTrips.size > MAX_SESSIONS) askedTrips.clear();
        return false;
      });
    },
  };
}

/**
 * 预筛用的哑槽位：只为了让 `pickElicitation` 判一次"这一轮是不是合适载体"，
 * 免得在明显不该问的轮次上白查一次库。它**不会**被返回给调用方。
 */
const PROBE: ElicitationSlot = {
  kind: "odometer",
  reason: "",
  weight: 0,
  timeliness: "deferrable",
  state: "pending",
};
