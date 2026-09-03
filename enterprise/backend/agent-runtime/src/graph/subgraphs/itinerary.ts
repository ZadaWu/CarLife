/**
 * 多天行程子图：四专家 fan-out + 代码汇聚 + 跨轮细化（施工单 M12-03）。
 *
 * 设计定稿：内部文档
 * 复用而不重建：分支驱动用 fanout.ts；自驾段求解用 merge.ts 的 solve()；
 * 能源事实/约束校对用 ../energy（公共层——子图之间不许互相 import，check:arch 守）。
 *
 * # 汇聚在代码里的具体含义（F-13-02 在多天场景的落法）
 *
 * LLM 分支产出**候选与事实**（去哪几个片区、有哪些酒店），代码做**装配与校验**：
 * 酒店挂到哪天、估价没带"估算"就补上、自驾分段超限就拆——这些是确定性规则，
 * 交给模型就会出现"读起来完全正常、只有真上路才发现问题"的方案（merge.ts 文件头）。
 */

import { runFanout, type BranchResult, type FanoutOptions } from "../fanout";
import { canonicalAgent } from "../../acp-client/agent-prompt";
import { clearSubmission, waitSubmission } from "../../branch-submissions";
import { currentTurnId } from "../../interrupt-bus";
import { parseTripDraft, solve, extractConstraints, MISSING_SECTION_HEADER } from "../merge";
// 续航分支的提示词与字段清单住在**公共层**（子图之间不许互相 import，check:arch 守）：
// 三种能源形态各不相同，两处各写一份必然漂移，而漂移的后果是给燃油车算续航。
import { energyBranchPrompt, energyFact, energyFields, reconcileConstraints } from "../energy";
import type { VehicleEnergyType } from "@carlife/memory";
import type { ChatStreamer, ChatStreamHooks } from "../../llm";
import type { PoiKind } from "@carlife/shared";
import type { TripPlanState, TripPlanDay } from "../state";

// ── 细化轮：改哪就只跑哪 ─────────────────────────────────────

export type ItineraryBranch = "drive" | "hotel" | "tour" | "transit";

/**
 * 细化诉求 → 要重跑的分支。规则表不是模型（F-11-10 同理），导出可断言。
 * 判不出就四个全跑——宁可多花一轮时间，不能少跑了该更新的那支。
 */
export const REFINE_TARGET_RULES: ReadonlyArray<{ re: RegExp; target: ItineraryBranch }> = [
  { re: /(酒店|住宿|住哪|住的|换.{0,3}住)/, target: "hotel" },
  { re: /(景点|玩什么|去哪玩|第.天|线路|游玩|安排松|太赶)/, target: "tour" },
  { re: /(开车|自驾|车程|路上|补能|加油|充电|服务区)/, target: "drive" },
  { re: /(高铁|火车|飞机|机票|车票|大交通|怎么去|怎么过去)/, target: "transit" },
];

export function refineTargets(userText: string): ItineraryBranch[] {
  const hit = REFINE_TARGET_RULES.filter((r) => r.re.test(userText)).map((r) => r.target);
  return hit.length > 0 ? [...new Set(hit)] : ["drive", "hotel", "tour", "transit"];
}

// ── 确认 / 取消判据（M13-02）─────────────────────────────────

/**
 * 确认指涉：有草案时这些说法= "把这份草案定下来"。规则表不是模型（F-11-10 同理），
 * 导出可断言——判错的症状只是"又白跑了一轮 fan-out"或"没确认就落库"。
 */
export const COMMIT_PATTERNS =
  /(就(这样|这么|按这个)定|定了吧|就这个了|拍板|可以预订|就订这个|没问题.{0,4}(订|定)|(行程|计划|这趟|那趟).{0,6}(确认|敲定|定了|定下来)|确认.{0,4}行程|(就|就是|好的?|OK|ok).{0,4}(定这个|定了|订这个))/;

/**
 * 取消指涉：**必须整程指涉**——「取消第二天」「第二天不去了」是细化不是取消，
 * 误判成取消会把整份行程作废掉，比多跑一轮细化严重得多。
 *
 * # 间隔为什么放到 12 个字
 *
 * 原先是 `取消.{0,4}(行程|计划)`。实测漏判了最自然的那种说法：
 * 「我取消**从上海到广州的**行程」——中间隔了 7 个字，正好越过 4 的上限。
 * 漏判的后果不是报错，而是这句话被当成**规划诉求**送进 fan-out：
 * 四个分支白跑一分钟，然后回一句"没查到"，而主页上那份行程原封不动。
 *
 * 人报路线（从 X 到 Y 的）、报目的地（广州那趟）、报天数（四天的）都要塞进这个间隔，
 * 12 个字是覆盖这些说法的下限。放宽的风险由 `PARTIAL_CANCEL` 兜——
 * 「取消第二天的行程」间隔只有 4 个字，但它先被那条护栏拦下。
 */
export const CANCEL_PATTERNS =
  /((行程|计划|整个安排|这趟|那趟).{0,8}(取消|不要了|作废|删除|删掉)|(取消|删除|删掉).{0,12}(行程|计划|之旅|出行)|(整个|全部|所有|都).{0,4}(不去了|取消|删除|删掉)|(这|那)趟.{0,6}不去了)/;

/**
 * 取消范围：说了「全部/所有/都」就是整批，不是某一份。
 *
 * 分出这一档是因为多份行程时的处理完全不同：整批可以一次弹窗批完，
 * 单份则必须先问清是哪一份。判不出范围就按单份走——宁可多问一句。
 */
export const CANCEL_ALL_PATTERNS = /(全部|所有|都|统统|一起).{0,6}(取消|删除|删掉|不要|清)/;

export function cancelAllIntent(userText: string): boolean {
  return CANCEL_ALL_PATTERNS.test(userText) && cancelIntent(userText);
}

/**
 * 对「取消哪一份」这个追问的回答（M13-12）。**只在有 `pendingCancel` 时才判**——
 * 「确认」两个字脱离上下文没有意义，拿它当取消指涉会误伤别的对话。
 *
 * 返回：`all` = 全部；数字 = 第几个（1 起）；`undefined` = 没听出来，再问一次。
 */
export function resolvePendingCancelReply(
  userText: string,
  candidates: ReadonlyArray<{ label: string }>,
): "all" | number | undefined {
  if (CANCEL_ALL_PATTERNS.test(userText) || /^(全部|所有|都要|都删|统统)/.test(userText.trim())) {
    return "all";
  }
  // 「第二个」「第2份」「2」
  const ord = userText.match(/第\s*([0-9一二三四五六七八九十]+)\s*(个|份|条|项)?/) ?? userText.match(/^\s*([0-9])\s*$/);
  if (ord) {
    const cn: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const n = cn[ord[1]!] ?? Number(ord[1]);
    if (Number.isInteger(n) && n >= 1 && n <= candidates.length) return n;
  }
  /*
   * 光说「确认」「好的」——**候选只有一个时才认**。
   * 多个候选时它没有指向，认下来就是替车主挑了一份，而挑错不报错。
   */
  if (/^(确认|确定|对|是的|好的?|嗯|可以|就这样)$/.test(userText.trim()) && candidates.length === 1) {
    return 1;
  }
  return undefined;
}

// ── 出发 / 结束导航判据（M31-01）─────────────────────────────

/**
 * 「现在动身」的说法。与 `COMMIT_PATTERNS` 的区别是**时机不是态度**：
 * commit 是「这个方案我认了」，depart 是「现在就走」。
 *
 * # 否决项比这张表本身更要紧
 *
 * 「出发」是 `route.ts` 里 trip 的强证据词（3 分），而本判据要参与**路由**
 * （不看粘性直接进 itinerary，与取消同款）。也就是说判松一点的代价不再只是
 * "多弹一次"——**「出发去广州玩三天」会被当成对旧行程的出发指令**，
 * 于是车主要规划新行程，系统开始导航一份上个月的旧行程。
 *
 * 所以 `DEPART_AS_PLAN` 要否决三类：带时间限定/疑问的（在描述计划）、
 * 带玩法或天数的、以及**点了名要去哪儿的**（`去…`）。真正的出发指令很短，
 * 它不携带任何要规划的东西——「出发」「走吧」「开始导航」都不说去哪，
 * 因为去哪已经写在那份确认过的行程里了。
 *
 * 收紧的只是**兜底路径**：`wantsDepart` 先看模型给的 `action`，
 * 模型说是 depart 就不受这张否决表约束。判据是字面的而人的说法不是——
 * 这条分工与 M13-14 一致。
 */
export const DEPART_PATTERNS =
  /(出发|动身|上路|走吧|咱走|开始导航|启动导航|导航吧|开导航|可以走了|发车)/;

/**
 * 「出发」出现在这些说法里是**计划描述或询问**，不是动身指令——否决项。
 * 「出发前 / 出发之前」是时间状语（M62-02，评测 `o-30`「冬天出发前想先暖车，定时预热怎么用」）：
 * 车主在问功能，却被整句当成动身指令直接送进行程节点、不看分数——连用车助手的双路检索一起丢掉。
 *
 * 判错方向的代价不对称：把陈述当指令，屏幕当场切进跟车模式（车主一脸茫然）；
 * 把指令当陈述，最坏只是又问一句。所以带时间限定与疑问的一律不认。
 */
const DEPART_AS_PLAN =
  /出发(前|之前|以前)|动身(前|之前)|(几点|什么时候|何时|哪天|多久|要不要|能不能|可以吗).{0,6}(出发|动身|走)|(明天|后天|大后天|今晚|下周|下个月|周[一二三四五六日天]|礼拜[一二三四五六日天]|\d{1,2}[号日]|早上|上午|中午|下午|傍晚|晚上).{0,5}(出发|动身)|出发(时间|日期|地|点)|(改|换|推迟|提前|定).{0,4}(出发|动身)|(玩|旅游|度假|规划|安排)|[0-9一二三四五六七八九十]+\s*天|几天|去[^，。！？]{1,10}/;

/** 结束导航。**不含**「取消行程」——那是另一件事，会把整份行程作废。 */
export const NAV_END_PATTERNS =
  /((结束|退出|关闭|关掉|停止|取消|别|不).{0,4}导航|导航.{0,4}(关掉|停掉|结束|退出)|不导(了|航了)|别导了)/;

/**
 * 到站（M31-03）。**这一句通常不是车主说的**——是端上跟车层越过段尾时发上来的
 * （`已到达陈家祠堂，下一站沙面岛`）。
 *
 * # 为什么走会话而不是给端一个"念这句话"的命令
 *
 * 车机的 TTS 全在 Rust 侧，由「助手回了一句话」驱动（`tts::speak`）。
 * 开一个前端直调喇叭的命令，等于让 WebView 绕过整条应答链——
 * 与「敏感/高频逻辑在 Rust」的分工相悖，也让播报绕开了内容管线。
 *
 * # 判据只认报告式开头，不认「到了」
 *
 * 「到了」是日常口语（「到了吗」「快到了」），拿它当到站指涉会误伤一大片。
 * `已到达` 是报告式说法，人很少这么起头；真有人这么说而且正在导航，
 * 按到站处理**也正是对的**——所以这条不需要再加否决项。
 */
export const ARRIVE_PATTERNS = /^\s*已到达/;

export function arriveIntent(userText: string): boolean {
  return ARRIVE_PATTERNS.test(userText);
}

export function departIntent(userText: string): boolean {
  return DEPART_PATTERNS.test(userText) && !DEPART_AS_PLAN.test(userText);
}

export function navEndIntent(userText: string): boolean {
  return NAV_END_PATTERNS.test(userText);
}

/**
 * 处置判定（与 `wantsCommit`/`wantsCancel` 同一形态：LLM 优先、正则兜底、取或）。
 *
 * `nav_end` 优先于 `depart`：「不导航了」同时命中两张表——`导航` 在 DEPART 里，
 * 整句在 NAV_END 里。谁先判谁赢，而这里必须是结束赢。
 */
export function wantsNavEnd(userText: string, intent?: PlanActionCarrier): boolean {
  return intent?.action === "nav_end" || navEndIntent(userText);
}

export function wantsDepart(userText: string, intent?: PlanActionCarrier): boolean {
  if (wantsNavEnd(userText, intent)) return false;
  return intent?.action === "depart" || departIntent(userText);
}

/** 细化式取消（天/景点/酒店级）——出现即**不是**整程取消。 */
const PARTIAL_CANCEL = /(取消|不去|删掉|去掉).{0,6}(第.{1,3}天|景点|酒店|那天)|第.{1,3}天.{0,6}(取消|不去)/;

export function commitIntent(userText: string): boolean {
  return COMMIT_PATTERNS.test(userText) && !cancelIntent(userText);
}

export function cancelIntent(userText: string): boolean {
  // 歧义时宁可少做副作用：整程取消词与"部分取消"同现，按细化处理。
  return CANCEL_PATTERNS.test(userText) && !PARTIAL_CANCEL.test(userText);
}

/* ── 处置判定：LLM 优先，正则兜底（M13-14）───────────────────────
 *
 * 上面那三张正则表现在是**第二信号**。第一信号是意图理解里的 `action`
 * （见 `graph/intent.ts` 的 PLAN_ACTIONS）——理由写在那里：判据是字面的，
 * 而人的说法不是，「你这样安排可以的」这种句子正则永远追不完。
 *
 * 两者取**或**而不是让 LLM 独裁：意图解析会降级（模型抽风、JSON 解不出），
 * 降级时 `action` 是 undefined，那时老判据仍然管用。多认一次的代价是多弹一次
 * 确认窗（用户还能拒），少认一次的代价是行程定不下来——不对称，所以取或。
 *
 * 只有 `PARTIAL_CANCEL` 是**否决**而非信号：「取消第二天」是细化，
 * 按整程取消处理会把整份作废，这一条不交给模型判。
 */

/** 意图里跟处置有关的那一栏；用结构类型收，免得判据模块反向依赖图状态。 */
export interface PlanActionCarrier {
  action?: string;
}

export function wantsCancelAll(userText: string, intent?: PlanActionCarrier): boolean {
  if (PARTIAL_CANCEL.test(userText)) return false;
  return intent?.action === "cancel_all" || cancelAllIntent(userText);
}

export function wantsCancel(userText: string, intent?: PlanActionCarrier): boolean {
  if (PARTIAL_CANCEL.test(userText)) return false;
  return intent?.action === "cancel" || intent?.action === "cancel_all" || cancelIntent(userText);
}

export function wantsCommit(userText: string, intent?: PlanActionCarrier): boolean {
  if (wantsCancel(userText, intent)) return false;
  return intent?.action === "commit" || commitIntent(userText);
}

/**
 * 确认时补齐真实坐标（M13-06）与贴纸品类（M13-07）——**代码解析，不让 LLM 抄数字**。
 *
 * 逐点用 poi_search 后端（region=目的地、cityLimit）取 top1 坐标，并顺手按
 * 高德 type 字段分出贴纸品类（`classifyAmapPoi`，同一次调用零额外配额）；
 * 同名缓存；单点失败/查不到就不标（真实性红线：宁可地图上少一个点，
 * 不能标一个猜的位置；品类同理，缺省由 HUD 落通用景点贴纸），其它点照常。
 * 返回新对象，不改入参。
 */
export type PoiCoordSearch = (
  name: string,
  city: string,
) => Promise<
  | {
      lat: number;
      lon: number;
      poiKind?: PoiKind;
      /** 命中 POI 的名字与城市——`trustCoordHit` 的校验材料，缺省时按查询词通过。 */
      name?: string;
      cityName?: string;
    }
  | undefined
>;

/**
 * 命中的坐标可不可信（M27-04）。
 *
 * # 为什么查到了还要再问一句
 *
 * 真实事故：广州行程里混进一家**徐州**如家（酒店分支查错城市，A1 另修）。
 * 坐标回填拿全名在广州搜——搜不到，于是剥掉括号门店后缀用「如家快捷酒店」
 * 再搜，命中**广州的另一家如家**，把别家店的坐标安到了徐州店名头上。
 * 地图上它就理直气壮地站在广州的站点堆里，名字却写着徐州——
 * 数据错被坐标"修"成了看起来合理的样子，比空着难发现得多。
 *
 * 本文件的既有纪律是「不标不猜」：查不到就不填。这里把它补全：
 * **查到了一个对不上的，等于没查到。** 两条判据：
 *
 *  1. 城市证据冲突：条目自述的片区（如「徐州市中心」）里写着「X市」，
 *     而命中在别的市 → 拒绝。只看 area 不看名字——店名里的「超市」
 *     「城市广场」会被当成城市误伤。
 *  2. 剥括号才命中的：括号里是门店定位词（「徐州金鹰国际购物中心店」），
 *     命中名里找不回它就是另一家店 → 拒绝。命中名**缺失**时放行——
 *     真实搜索（高德）永远带名字，缺名字的只有测试替身与旧实现，
 *     对它们苛刻只会把「查空回退去括号」这条既有约定一并判死。
 */
export function trustCoordHit(opts: {
  /** 条目原名（含括号后缀）。 */
  original: string;
  /** 条目自述片区（hotel.area / day.area），城市冲突判据的唯一来源。 */
  area?: string;
  /** 是否靠剥掉括号后缀才命中。 */
  viaStripped: boolean;
  hitName?: string;
  hitCity?: string;
}): boolean {
  const norm = (v: string) => v.replace(/（/g, "(").replace(/）/g, ")").replace(/\s+/g, "");
  if (opts.area && opts.hitCity) {
    // 「徐州市中心」→ 徐州市；懒惰量词取最短前缀，「市中心」（市前无字）不产生候选。
    const stems = [...opts.area.matchAll(/([一-龥]{2,8}?)市/g)].map((m) => `${m[1]}市`);
    if (stems.length > 0 && !stems.some((st) => opts.hitCity!.includes(st))) {
      return false;
    }
  }
  if (opts.viaStripped) {
    const paren = [...norm(opts.original).matchAll(/\(([^()]+)\)/g)].map((m) => m[1]).join("");
    if (!paren) return true;
    if (!opts.hitName) return true; // 无名可验：只有测试替身/旧实现如此，见文件头

    const hit = norm(opts.hitName);
    return hit.includes(paren) || paren.includes(hit);
  }
  return true;
}

export async function resolveTripPlanCoords(
  plan: TripPlanState,
  search: PoiCoordSearch,
  opts: { gapMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<TripPlanState> {
  const out = structuredClone(plan);
  const cache = new Map<
    string,
    (NonNullable<Awaited<ReturnType<PoiCoordSearch>>> & { viaStripped: boolean }) | undefined
  >();
  /*
   * 节流 + 失败重试一次：高德免费 key QPS=3，一份 4 天行程 ~10 个点连打必超限
   * ——实测第 2/3 天整段解析失败（10021 被吞成"查不到"），HUD 那两天就是空的。
   * 350ms 间隔 ≈ 2.8 QPS；重试隔 1s。总耗时 ~4s，发生在弹窗之前，可接受。
   */
  const gapMs = opts.gapMs ?? 350;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /*
   * 关键词变体：`|`/`｜` 是高德多关键词分隔符——「广州•诺果|NOGO城景公寓(…)」
   * 原样传必查空（实测：四家酒店唯独它没坐标）。先按清洗后的全名查；
   * 查不到（不是失败）再去掉括号门店后缀试一次——连锁店名的括号里是门店定位词，
   * 高德索引常按主名收录。
   */
  const variants = (name: string): string[] => {
    const primary = name.replace(/[|｜]/g, " ").replace(/\s+/g, " ").trim();
    const noParen = primary.replace(/[（(][^（）()]*[）)]/g, "").trim();
    return noParen && noParen !== primary ? [primary, noParen] : [primary];
  };
  let first = true;
  const searchOnce = async (kw: string) => {
    if (!first) await sleep(gapMs);
    first = false;
    try {
      return await search(kw, out.destination);
    } catch {
      await sleep(Math.max(gapMs, 1_000));
      return search(kw, out.destination); // 二次失败让它抛给上层 catch
    }
  };
  const lookup = async (name: string) => {
    if (!cache.has(name)) {
      try {
        let hit: Awaited<ReturnType<PoiCoordSearch>>;
        let viaStripped = false;
        const kws = variants(name);
        for (let i = 0; i < kws.length; i += 1) {
          hit = await searchOnce(kws[i]);
          if (hit) {
            viaStripped = i > 0;
            break;
          }
        }
        cache.set(name, hit ? { ...hit, viaStripped } : undefined);
      } catch {
        cache.set(name, undefined); // 重试仍失败：不标不猜，不阻塞其它点
      }
    }
    return cache.get(name);
  };
  for (const day of out.skeleton) {
    for (const s of day.spots) {
      // 坐标与品类都齐了才跳过——早年确认过的行程有坐标没品类，再确认时补上。
      if (s.lat !== undefined && s.lon !== undefined && s.poiKind !== undefined) continue;
      const hit = await lookup(s.name);
      if (!hit) continue;
      // 查到了一个对不上的，等于没查到（trustCoordHit 文件头有事故原型）。
      if (!trustCoordHit({ original: s.name, area: day.area, viaStripped: hit.viaStripped, hitName: hit.name, hitCity: hit.cityName })) {
        continue;
      }
      if (s.lat === undefined || s.lon === undefined) {
        s.lat = hit.lat;
        s.lon = hit.lon;
      }
      if (s.poiKind === undefined && hit.poiKind !== undefined) s.poiKind = hit.poiKind;
    }
    if (day.hotel && (day.hotel.lat === undefined || day.hotel.lon === undefined)) {
      const hit = await lookup(day.hotel.name);
      if (
        hit &&
        trustCoordHit({
          original: day.hotel.name,
          area: day.hotel.area,
          viaStripped: hit.viaStripped,
          hitName: hit.name,
          hitCity: hit.cityName,
        })
      ) {
        day.hotel.lat = hit.lat;
        day.hotel.lon = hit.lon;
      }
    }
  }
  const dropped = stripCoordOutliers(out);
  if (dropped.length > 0) {
    console.warn(`[itinerary] 坐标离群兜底：丢弃 ${dropped.join("、")} 的坐标（同名异地嫌疑）`);
  }
  return out;
}

/**
 * 目的地 → 搜索 region 的归一（同名异地事故第三课，见 内部文档）。
 *
 * # 为什么 destination 不能直接当 region 用
 *
 * 真实事故：destination=「普陀山」的行程，确认时逐点回填坐标，region 原样传
 * 「普陀山」。高德不认这个 region（它是景区不是城市），于是 `city_limit`
 * **静默失效按全国搜**（amap.ts M13-12 注的同一失效），「慧济禅寺」top1 命中
 * **泉州**的同名寺，HUD 地图为框住它缩成了半个中国。
 *
 * # 为什么用 POI 搜索归一而不是 geocode
 *
 * 实测 `geocode("普陀山")` 命中**贵州遵义的一个村庄**——地名索引按行政区划排，
 * 景区排不过同名村。POI 搜索按知名度排，「普陀山」「莫干山」「迪士尼」的
 * top1 都是那个著名的。归一失败（查不到 / 命中名对不上目的地）就退回原样——
 * 不比现状更糟。
 *
 * 命中名必须与目的地互相包含才收下：不这么卡，冷门目的地 top1 命中个不相干的
 * POI，会把**整份行程**的搜索圈错城市——那时离群兜底（stripCoordOutliers）
 * 反而拦不住，因为错的点彼此扎堆。
 */
export async function resolveDestinationRegion(
  destination: string,
  search: (keywords: string) => Promise<{ name?: string; cityName?: string } | undefined>,
): Promise<string> {
  const dest = destination.trim();
  if (!dest) return destination;
  try {
    const top = await search(dest);
    const city = top?.cityName?.trim();
    const name = top?.name?.trim();
    if (!city || !name) return destination;
    const norm = (v: string) => v.replace(/\s+/g, "");
    if (!norm(name).includes(norm(dest)) && !norm(dest).includes(norm(name))) return destination;
    return city;
  } catch {
    return destination; // 归一是增强不是门槛：失败退回 destination，与旧行为一致
  }
}

/** 球面距离（米）。行程点之间的尺度判断用，精度要求不高。 */
function haversineM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/**
 * 坐标离群兜底（同名异地事故第三课，见 内部文档）：
 * 与其它点扎堆位置差太远的坐标，按「不标不猜」红线丢掉。
 *
 * region 归一（resolveDestinationRegion）是治本，这条是它失手时的最后一道网：
 * 归一失败退回原样时、以及 trustCoordHit 两条判据都够不着时（事故里
 * area=「普陀山」提不出「X市」词干，剥括号也没发生），错点照样进得来。
 *
 * 判据是**稳健统计**不是固定圈：中位数中心 + 中位距离——错的是少数时，
 * 中位数不被它拉走。阈值 max(150km, 5×中位距离)：目的地本地行程（点距几 km）
 * 阈值落在 150km，泉州那个 700km 外的点必被丢；大环线行程（点距上百 km）
 * 阈值随之放大，不误伤。点数 < 3 不判——两个点互相指认不了谁是错的。
 *
 * 同名同坐标的重复条目（酒店逐日重复）只计一票，防它垄断中位数。
 * 只丢坐标不动 poiKind：没有坐标的点上不了地图，贴纸品类不再被消费。
 *
 * **原地改写**（调用方已 structuredClone），返回被丢弃的点名供日志。
 */
export function stripCoordOutliers(plan: TripPlanState): string[] {
  type Pt = { name: string; lat: number; lon: number; clear: () => void };
  const pts: Pt[] = [];
  for (const day of plan.skeleton) {
    for (const s of day.spots) {
      if (s.lat !== undefined && s.lon !== undefined) {
        pts.push({ name: s.name, lat: s.lat, lon: s.lon, clear: () => { delete s.lat; delete s.lon; } });
      }
    }
    const h = day.hotel;
    if (h && h.lat !== undefined && h.lon !== undefined) {
      pts.push({ name: h.name, lat: h.lat, lon: h.lon, clear: () => { delete h.lat; delete h.lon; } });
    }
  }
  const uniq = [...new Map(pts.map((p) => [`${p.name}|${p.lat}|${p.lon}`, p])).values()];
  if (uniq.length < 3) return [];
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const cLat = median(uniq.map((p) => p.lat));
  const cLon = median(uniq.map((p) => p.lon));
  const spread = median(uniq.map((p) => haversineM(p.lat, p.lon, cLat, cLon)));
  const limit = Math.max(150_000, spread * 5);
  const droppedNames = new Set<string>();
  for (const p of pts) {
    if (haversineM(p.lat, p.lon, cLat, cLon) > limit) {
      p.clear();
      droppedNames.add(p.name);
    }
  }
  return [...droppedNames];
}

/**
 * 大交通各方式在 `transit.summary` 里的识别特征。
 * 摘要是**代码拼的**（见 `mergeItinerary`），形状稳定，不是模型自由文本。
 */
const TRANSIT_MATCHERS: Record<"drive" | "train" | "flight", RegExp> = {
  drive: /自驾/,
  train: /^[DGKZTC]\d|高铁|动车|列车/,
  flight: /飞机|航班/,
};

/**
 * 自驾多久以内就该开车去（分钟）。
 *
 * 3 小时是"门到门自驾仍然明显更省事"的常识分界：再远，高铁/飞机的
 * 站点接驳与安检时间才摊得平。这个数是**判断推荐方式的依据**，不是硬约束。
 */
const DRIVE_PREFERRED_MAX_MIN = 180;

/**
 * 短于这个时长的行程**根本不该出现飞机**（分钟）。
 *
 * 实测那次：「上海静安 → 上海嘉定」的确认弹窗上写着
 * 「飞机 约2.5小时飞行，全程约4-5小时，约400-900元」——市内 40 分钟车程配一张机票。
 * 那不是模型幻觉，是 transit 分支被要求"给飞机的常识性对比建议"，
 * 它照做了，而汇聚层原样收下并让端上默认取了飞机。
 *
 * 4 小时以内的车程，飞一趟的门到门时间必然更长，列出来只会误导。
 */
const FLIGHT_ABSURD_BELOW_MIN = 240;

/**
 * 飞机建议**自己否定自己**的说法（M13-14）。
 *
 * 上面那道 `FLIGHT_ABSURD_BELOW_MIN` 只在拿得到自驾时长时才生效。
 * 实测 drive 分支没返回分段（`missing: drive 分支未返回自驾分段`）时它就落空，
 * 于是 transit 分支这段照样进了弹窗：
 *
 * > 飞机　不适用（同城短途），无需机票（估算，以实际平台为准），
 * >       静安与嘉定同属上海市，无城际火车/航班，自驾最优
 *
 * 内容是对的——模型很清楚不该坐飞机；错的是它被挂在「飞机」这个标签下，
 * 端上于是画了一枚飞机图标。**图标和文字互相矛盾时，用户信的是图标。**
 *
 * 所以这段不按飞机收，改标成自驾并直接定为推荐方式：模型说的就是自驾最优。
 */
const FLIGHT_SELF_NEGATED =
  /(不适用|不建议|无需(乘坐|乘|坐)?(机票|飞机|航班)|无(城际)?(航班|火车\/航班)|没有(直飞|航班)|同城)/;

/**
 * 替换掉那段自我否定的飞机建议。
 *
 * **不能只换标签留原话**：原话是「不适用（同城短途），无需机票……」，
 * 挂到「自驾」下面就读成了「自驾 不适用」——意思正好反过来，比原来更糟。
 * 所以这一句是代码写死的结论式表述，模型那段解释不再往弹窗上放。
 */
const DRIVE_INSTEAD_LINE = "自驾：两地间没有城际火车或航班（同城/近距离），建议自驾或打车前往";

/**
 * 拼大交通摘要，并**据实定出推荐方式**。
 *
 * 顺序即优先级：短途自驾 → 有高铁走高铁 → 才是飞机。
 * 判不出来就不设 `recommended`——不设的后果是弹窗列出全部候选（见 `selectedTransit`），
 * 那是"我说不准"，而随便挑一种是"我说错了"。
 */
export function assembleTransit(input: {
  driveLine?: string;
  driveMinutes?: number;
  trainParts: string[];
  flightPart?: string;
}): { summary: string; recommended?: "drive" | "train" | "flight" } | undefined {
  const shortDrive =
    input.driveMinutes !== undefined && input.driveMinutes <= DRIVE_PREFERRED_MAX_MIN;

  /*
   * 飞机建议自己说了"不适用"，就不按飞机收——重标成自驾（见 FLIGHT_SELF_NEGATED）。
   * 这一步在时长判据之前：那道判据要有自驾时长才成立，而这一条只看文本，
   * drive 分支挂掉时它是唯一还起作用的护栏。
   */
  const negatedFlight =
    input.flightPart !== undefined && FLIGHT_SELF_NEGATED.test(input.flightPart);
  const driveFromFlight = negatedFlight ? DRIVE_INSTEAD_LINE : undefined;

  // 短途连列都不列飞机——不是不推荐，是这条信息本身就是错的。
  const keepFlight =
    input.flightPart !== undefined &&
    !negatedFlight &&
    (input.driveMinutes === undefined || input.driveMinutes > FLIGHT_ABSURD_BELOW_MIN);

  const parts = [
    input.driveLine,
    ...input.trainParts,
    keepFlight ? input.flightPart : undefined,
    // 自驾行没别的来源时才用重标过的那句，免得同一件事说两遍。
    input.driveLine ? undefined : driveFromFlight,
  ].filter((x): x is string => Boolean(x));
  if (parts.length === 0) return undefined;

  const recommended = shortDrive && input.driveLine
    ? ("drive" as const)
    : input.trainParts.length > 0
      ? ("train" as const)
      : keepFlight
        ? ("flight" as const)
        : input.driveLine || driveFromFlight
          ? ("drive" as const)
          : undefined;

  return { summary: parts.join("；"), ...(recommended ? { recommended } : {}) };
}

/**
 * 确认弹窗要列的大交通——**只列这次要走的那一种**。
 *
 * `summary` 里并排堆着自驾/高铁/飞机，那是"给你挑"的形状；
 * 而确认弹窗是"确认这一份"，三行并排会让用户以为三种都要一起订。
 *
 * 选哪一种看 `transit.recommended`；在真正的选择步骤落地之前默认飞机。
 * **认不出来就整段照列**：少列一种是藏信息，比多列一种糟。
 */
export function selectedTransit(plan: TripPlanState): string | undefined {
  const summary = plan.transit?.summary?.trim();
  if (!summary) return undefined;
  const segments = summary
    .split(/[;；]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const mode = plan.transit?.recommended;
  /*
   * **没有推荐就整段照列**，不再默认飞机。
   *
   * 早先这里写的是 `?? "flight"`——理由是"选择步骤落地前先有个默认"，
   * 而它的实际后果是市内行程的弹窗上出现了一张机票。
   * 默认一个具体方式等于替车主做了决定，而做错时它看起来完全正常。
   */
  if (!mode) return summary;
  return segments.find((s) => TRANSIT_MATCHERS[mode].test(s)) ?? summary;
}

/**
 * 确认弹窗的明细（F-04-02：显示的是具体内容不是动作名）。
 * 逐日一行——用户在弹窗上批的就是这份清单，与落库的是同一份数据。
 */
export function commitDisclosures(plan: TripPlanState): string[] {
  const lines = plan.skeleton.map((d) => {
    const spots = d.spots.map((s) => s.name).join("、") || "（待定）";
    const hotel = d.hotel ? `；住 ${d.hotel.name}${d.hotel.estPrice ? ` ${d.hotel.estPrice}` : ""}` : "";
    return `第${d.day}天 ${d.theme}：${spots}${hotel}`;
  });
  const transit = selectedTransit(plan);
  if (transit) lines.push(`大交通：${transit}`);
  return lines;
}

/** 确认成功后给 narrator 的文本——指令不得与数据矛盾（698743e 那课），只陈述事实。 */
export function describeCommitted(plan: TripPlanState): string {
  return [
    `行程已确认并保存：${plan.destination}，共${plan.days}天` +
      `${plan.startDate ? `，${plan.startDate} 出发` : ""}。`,
    "已确认的行程会显示在座舱主页（当天的站点与提示）。",
    plan.caveats.length ? `确认时的既有声明仍然有效：${plan.caveats.join("；")}` : "",
    "告诉车主：行程已定，主页可以看到；说「行程取消掉」可以取消，继续说调整诉求仍可修改（改完需再次确认）。",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 确认被拒/超时后的文本：行程**仍是草案**，这必须说清楚——静默会让用户以为定了。 */
export function describeCommitDenied(reason: string): string {
  return [
    `行程确认未完成：${reason}。`,
    "行程仍是草案，没有保存、也不会出现在座舱主页。",
    "告诉车主：随时可以继续调整，想定下来再说一声「就这样定了」。",
  ].join("\n");
}

/** 取消被拒/失败后的文本：行程保持原样——用户以为取消了而 HUD 还挂着，比报错糟。 */
export function describeCancelDenied(reason: string): string {
  return [
    `取消未执行：${reason}。`,
    "行程保持原样，座舱主页仍会显示它。",
    "告诉车主：想取消可以再说一次「行程取消掉」。",
  ].join("\n");
}

/** 取消成功后的文本。 */
export function describeCancelled(hadCommitted: boolean): string {
  return [
    hadCommitted ? "已取消这份行程，座舱主页不再显示它。" : "已放弃这份行程草案。",
    "告诉车主：需要重新规划随时说。",
  ].join("\n");
}

/**
 * 整批取消成功后的文本。条数说清楚——"都取消了"听不出取消了几份。
 *
 * `remaining` = 这一批批完之后**库里还剩几份已确认的**（0830 走查）。
 * 这一栏不是可选的润色：车主说的是「全部」，而一次列举有上限
 * （`CANCEL_LIST_LIMIT`），超过上限时这一批只是其中一页。剩下的不说出来，
 * 车主得到的就是"已取消 N 份"外加**主页上还挂着行程**——
 * 与"取消没生效"在屏幕上完全同形，而它不报任何错。
 */
export function describeCancelledBatch(n: number, remaining = 0): string {
  if (remaining > 0) {
    return [
      `已取消 ${n} 份行程；车主名下**还剩 ${remaining} 份**已确认的行程没有取消`,
      "（一次能列举的份数有上限，这一批只是其中一部分）。",
      `告诉车主：主页上还会看到那 ${remaining} 份，想一并取消请他再说一次「全部行程都取消」。`,
    ].join("\n");
  }
  return [
    `已取消 ${n} 份行程，座舱主页不再显示它们。`,
    "告诉车主：需要重新规划随时说。",
  ].join("\n");
}

// ── 导航话术（M31-01）──────────────────────────────────────
//
// 与本文件其余 describe* 同一条纪律：**只陈述事实**，不给与数据矛盾的指令
// （698743e 那课）。四条拒绝路径各有各的说法，一条都不能含糊成"好的"——
// 车主说了「出发」而屏幕没变，是本期最容易造出来的假成功。

/** 导航已开始。第一站要念出来——车主要靠它确认"我们是不是在说同一件事"。 */
export function describeNavStarted(
  plan: { destination: string },
  day: number,
  firstStop: string | undefined,
): string {
  return [
    `导航已开始：${plan.destination} 第${day}天。`,
    firstStop ? `第一站是${firstStop}。` : "今天暂时没有排定的站点。",
    "座舱主页已切到跟车模式，会显示当前位置与下一站。",
    "告诉车主：路上想停下来说一声「结束导航」就行。",
  ].join("\n");
}

/** 行程还是草案。**不能替他确认**——那等于拿一句「出发」当成了拍板。 */
export function describeDepartNotConfirmed(): string {
  return [
    "这份行程还是草案，没有确认过，所以还不能按它导航。",
    "告诉车主：先说一声「就这样定了」把行程定下来，然后再说「出发」。",
    "**不要替他确认**。",
  ].join("\n");
}

/** 库里一份都没有。与取消路径同款诚实：主页还挂着就是我们的问题。 */
export function describeDepartNoTrip(): string {
  return [
    "库里没有已确认的行程，所以没有可以导航的行程。",
    "告诉车主：可以先说要去哪、玩几天，排好确认之后再出发。",
    "如果主页上还看得到行程，请他说一声——那说明显示与数据对不上，是我们的问题。",
  ].join("\n");
}

/** 今天不在行程期内。把日期说清楚——「不能出发」不解释等于甩锅给系统。 */
export function describeDepartOutOfRange(plan: {
  destination: string;
  days: number;
  startDate?: string;
}): string {
  return [
    `今天不在这份行程的日期范围内：${plan.destination}，共${plan.days}天` +
      `${plan.startDate ? `，${plan.startDate} 出发` : "（还没定出发日期）"}。`,
    "所以没有「今天该走哪一段」可以导航。",
    plan.startDate
      ? "告诉车主行程是哪几天的，问他要不要改期。"
      : "告诉车主这份行程还没定出发日期，问他哪天走。",
  ].join("\n");
}

/**
 * 到站播报（M31-03）。**这一句是要被念出来的**，所以只有一个要求：短。
 *
 * 车在路上，播报长了没人听得完，而且下一站可能已经到了。
 * 端上传来的那句本身就是完整事实，narrator 的活只是把它说得像人话。
 */
export function describeArrived(note: string): string {
  return [
    `跟车层报告：${note}`,
    "**用一句话播报这件事**：到了哪儿、下一站是哪儿（如果有）。",
    "不要展开介绍景点、不要给建议、不要问问题——车主正在开车。",
  ].join("\n");
}

/** 导航已结束。 */
export function describeNavEnded(): string {
  return [
    "导航已结束，座舱主页回到行程视图。",
    "告诉车主：想继续按行程走，再说一声「出发」。",
  ].join("\n");
}

/** 说了结束导航，但本来就没在导航。**不能假装刚关掉**。 */
export function describeNavNotRunning(): string {
  return [
    "当前没有在导航，所以没有可结束的。",
    "告诉车主：座舱主页现在是行程视图；说「出发」可以开始导航。",
  ].join("\n");
}

/** 导航置位失败（落库出错）。行程本身没受影响，这一点要说清楚。 */
export function describeNavFailed(reason: string, ending: boolean): string {
  return [
    `${ending ? "结束导航" : "开始导航"}没有成功：${reason}。`,
    "行程本身没有受影响，内容与状态都没变。",
    `告诉车主：可以再说一次「${ending ? "结束导航" : "出发"}」。`,
  ].join("\n");
}

/** 一份已落库行程的一句话描述——用于弹窗摘要与"要取消哪一份"的追问。 */
export function describeStoredPlan(p: {
  plan: { destination: string; days: number };
  startDate?: string;
}): string {
  return `${p.plan.destination} ${p.plan.days}天${p.startDate ? `（${p.startDate} 出发）` : ""}`;
}

/** 库里一份都没有时的文本。**不能说"取消成功"**——那正是用户投诉的那种假成功。 */
export function describeNoStoredPlan(): string {
  return [
    "库里没有已确认的行程，所以没有可取消的。",
    "告诉车主：如果主页上还看得到行程，请他说一声——那说明显示与数据对不上，是我们的问题。",
  ].join("\n");
}

/**
 * 有多份已确认行程时的追问文本。**不替用户挑**：
 * 取消错一份的代价是"他以为取消了 A，其实没了 B"，而这两件事都不会报错。
 */
export function describeAmbiguousCancel(
  plans: Array<{ plan: { destination: string; days: number }; startDate?: string }>,
): string {
  return [
    `车主名下有 ${plans.length} 份已确认的行程，无法确定要取消哪一份：`,
    ...plans.map((p, i) => `${i + 1}. ${describeStoredPlan(p)}`),
    "告诉车主这几份行程，请他说明取消哪一份（说目的地或出发日期都行）。**不要替他选。**",
  ].join("\n");
}

// ── 分支 JSON 形状（字段清单按任务分——569d7ac 教训） ─────────

interface HotelJson {
  hotels?: Array<{ name?: string; address?: string; area?: string; rating?: string; estPrice?: string; note?: string }>;
  findings?: string[];
}
interface TourJson {
  destination?: string;
  days?: Array<{
    day?: number;
    theme?: string;
    area?: string;
    spots?: Array<string | { name?: string; indoor?: boolean; estStart?: string; estEnd?: string }>;
    lodging?: { strategy?: string; note?: string };
    rainBackup?: string;
  }>;
  findings?: string[];
}

// ── 时段与住宿的语义校验（M34-01） ─────────────────────────────
//
// 提交通道的 schema 只挡得住**形状**（HH:MM 正则），且只挡提交路径——正文回落的
// JSON 什么都可能有。语义（同天单调、start<end）在这里统一校，两条路径共用一份。
// 纪律与 `parseTripDraft` 同源：**非法就丢弃、不修不猜**；丢的是时段字段，
// 不丢景点本身——一个坏时段不该废掉整份行程。

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (v: string): number => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));

export interface DayTimeSpot {
  estStart?: string;
  estEnd?: string;
}

/**
 * 校验一天的时段字段：全部合法返回 true；任一非法返回 false——
 * 调用方应**丢弃该天全部时段字段**（半天可信半天不可信的时间轴比没有更糟）。
 *
 * 合法 = 每个带时段的点两个字段齐全、HH:MM 形状、start < end，
 * 且按列出顺序 estStart 不回退（允许并列）——顺序与时段矛盾（夜游排上午）
 * 正是要挡的形态。不带时段的点不参与判定（部分覆盖是诚实状态，回退归 HUD 判）。
 */
export function dayTimesValid(spots: readonly DayTimeSpot[]): boolean {
  let prevStart = -1;
  for (const s of spots) {
    if (s.estStart === undefined && s.estEnd === undefined) continue;
    if (s.estStart === undefined || s.estEnd === undefined) return false;
    if (!HHMM_RE.test(s.estStart) || !HHMM_RE.test(s.estEnd)) return false;
    const start = toMin(s.estStart);
    if (start >= toMin(s.estEnd)) return false;
    if (start < prevStart) return false;
    prevStart = start;
  }
  return true;
}

/** lodging 只认两个枚举值；别的（含正文路径的脏值）丢弃。 */
export function sanitizeLodging(l: { strategy?: string; note?: string } | undefined):
  | { strategy: "checkin-midday" | "checkin-evening"; note?: string }
  | undefined {
  if (!l || (l.strategy !== "checkin-midday" && l.strategy !== "checkin-evening")) return undefined;
  return { strategy: l.strategy, ...(typeof l.note === "string" && l.note.trim() ? { note: l.note } : {}) };
}
interface TransitJson {
  trains?: Array<{ no?: string; durationMin?: number; costYuan?: number | null }>;
  flightAdvice?: { durationHint?: string; priceEstimate?: string; note?: string };
  findings?: string[];
}

/**
 * 枚举文本里所有**括号配平**的顶层 `{...}` 片段。
 * 扫描时跳过字符串内部的括号与转义——正则做不到这件事。
 */
function jsonCandidates(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) out.push(text.slice(start, i + 1));
    }
  }
  return out;
}

/**
 * 从分支输出抠 JSON。抽不到不猜——返回 undefined，由汇聚记 missing。
 *
 * # 为什么不能再用 `/\{[\s\S]*\}/`
 *
 * 那条正则贪婪匹配**第一个 `{` 到最后一个 `}`**，于是模型只要输出了不止一个
 * JSON 对象，抓到的就是 `{…}\n\n{…}` 这种解析不了的串，`JSON.parse` 抛错、
 * 整个分支的结果被静默丢弃——轨迹上分支还是 `status: ok`。
 *
 * 而细化轮的提示词**恰恰在诱发这件事**：开头就把整份草案 JSON 塞给模型，
 * 还写着"你只更新自己负责的部分，其余保持不变"。模型很自然地先回一遍草案、
 * 再附上要求的那个对象。两个对象一出现，这一轮的产出就全没了。
 *
 * 现在改成：配平扫描列出所有候选，**从后往前**找第一个既能解析、又带着
 * 期望字段的。从后往前是因为约定里那个对象在"回答的最后"。
 *
 * @param requiredKey 期望字段名（如 `hotels`）。给了就优先要带它的那个对象；
 *                    一个都没有时退回最后一个能解析的——形状不对由调用方判。
 */
function extractJson<T>(text: string, requiredKey?: string): T | undefined {
  const candidates = jsonCandidates(text);
  let fallback: T | undefined;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidates[i]!);
    } catch {
      continue;
    }
    if (!requiredKey) return parsed as T;
    if (parsed && typeof parsed === "object" && requiredKey in (parsed as object)) {
      return parsed as T;
    }
    fallback ??= parsed as T;
  }
  return fallback;
}

/** 估算类文本必须带"估算"字样——**代码保证，不赌模型守规矩**。 */
function markEstimate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return /估/.test(s) ? s : `${s}（估算，以实际平台为准）`;
}

const FINDINGS_RULE =
  "凡是你用工具查到的、车主问到的事实，写进 findings（一句话带依据）。" +
  "**没查过的一个字都不要写**——编造查询过程比留空严重得多。";

// ── 汇聚 ────────────────────────────────────────────────────

export interface ItineraryMergeOutput {
  plan: TripPlanState;
  violations: string[];
  missing: string[];
  findings: string[];
  solverDegraded: boolean;
  /**
   * 各分支结论走的哪条通道（M30-03/04）：submission=提交通道 / text=正文回落 /
   * missing=两者皆无。真跑统计提交率就数它（merge trace 透传）。
   */
  hotelSource: BranchSource;
  tourSource: BranchSource;
  transitSource: BranchSource;
  driveSource: BranchSource;
}

export type BranchSource = "submission" | "text" | "missing";

export interface ItineraryInput {
  goal: string;
  constraints: string[];
  /** 用户原话——细化轮判定与分支提示都要它。 */
  userText: string;
  energyType?: VehicleEnergyType;
  /** 现有草案；有 = 细化轮。 */
  plan?: TripPlanState;
  turnId: string;
}

/**
 * 行程 fan-out 的单分支硬超时。
 *
 * 从 `runFanout` 的默认 60s 提到 120s：四条腿各自要跑工具（选路 / 找店 / 找景点 / 查公共交通）
 * 再收敛成结构化提交，60s 下多天行程的 hotel 与 tour 常在最后一步被掐——
 * 分支以 `timeout` 汇聚、merge 那边只能报"分支超时"，用户看到的是一份缺腿的行程。
 *
 * 上限不能再往上抬太多：pi 侧的 `PROMPT_TIMEOUT_MS` 是 120s（`acp-client/connection.ts`），
 * 本层比它先起表（分支计时从发起就开始，prompt 的表要等 session 建好才起），
 * 所以 120s 时仍是本层先判超时并下发 cancel——这是 TD-08 那套"超时即取消"成立的前提。
 * 要再加就得先抬 `PROMPT_TIMEOUT_MS`，否则两层同时到点，僵尸调用会回来。
 */
const ITINERARY_BRANCH_TIMEOUT_MS = 120_000;

/** 追跳（M35-01 方案 C）的独立硬超时：只为缺口片区补候选，比整轮汇聚短得多。 */
const FOLLOWUP_HOTEL_TIMEOUT_MS = 25_000;

/**
 * 片区标签切词：剥括号明细、按 / 、· 空格切开，短于 2 字的碎片丢弃。
 * tour 与 hotel 是两个分支，片区词表天然不齐——真跑实测 tour 给
 * 「荔湾西关(陈家祠/永庆坊/沙面)」、hotel 给「西关」，整串双向包含匹配不上，
 * 词表差异被当成片区缺口，**纯市内行程也触发了追跳**（sess-3d4cf742）。
 */
function areaTokens(v: string): string[] {
  return v
    .replace(/[（(][^（）()]*[）)]/g, " ")
    .split(/[\/、·\s]+/)
    .filter((t) => t.length >= 2);
}

/** 片区匹配（挂载与缺口检测共用一份判据——两处各写一份迟早漂移）：整串双向包含，或任意词对双向包含。 */
function areaMatches(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const ta = areaTokens(a);
  const tb = areaTokens(b);
  return ta.some((x) => tb.some((y) => x.includes(y) || y.includes(x)));
}

/** 从一条 hotel 分支结果里取完整 JSON（提交通道优先、正文回落——与 merge 同一取法）。 */
function hotelJsonOf(res: BranchResult | undefined): HotelJson | undefined {
  if (res?.status !== "ok") return undefined;
  return res.submission ? (res.submission as HotelJson) : extractJson<HotelJson>(res.text, "hotels");
}

/** 从分支集合里取 hotel 候选列表（缺分支/失败 = 空数组，不是错误）。 */
export function hotelCandidatesOf(
  branches: readonly BranchResult[],
): NonNullable<HotelJson["hotels"]> {
  const res = branches.find((b) => b.agent.replace(/-task$/, "") === "hotel");
  return (hotelJsonOf(res)?.hotels ?? []).filter((h) => h.name);
}

/**
 * 追跳结果并回分支集合（M35-01）：两轮候选**按名字去重合并**（首轮优先、新增追加），
 * 合成一条 hotel 分支重新参与 merge——两条来源汇进同一段挂载代码（M30-03 同一纪律）。
 * 追跳失败/为空返回 undefined：调用方保留首轮 merge 结果（caveats 已在挂载段生成）。
 */
export function combineHotelBranches(
  branches: readonly BranchResult[],
  followUp: BranchResult | undefined,
): BranchResult[] | undefined {
  const followJson = hotelJsonOf(followUp);
  const followList = (followJson?.hotels ?? []).filter((h) => h.name);
  if (!followUp || followList.length === 0) return undefined;
  const first = branches.find((b) => b.agent.replace(/-task$/, "") === "hotel");
  const firstJson = hotelJsonOf(first);
  const seen = new Set((firstJson?.hotels ?? []).map((h) => h.name));
  const mergedJson: HotelJson = {
    hotels: [...(firstJson?.hotels ?? []), ...followList.filter((h) => !seen.has(h.name))],
    findings: [...(firstJson?.findings ?? []), ...(followJson?.findings ?? [])],
  };
  const synthetic: BranchResult = {
    ...(first ?? followUp),
    agent: "hotel-task",
    status: "ok",
    text: "",
    submission: mergedJson,
    endedAt: followUp.endedAt,
  };
  return [...branches.filter((b) => b.agent.replace(/-task$/, "") !== "hotel"), synthetic];
}

/**
 * 住宿片区缺口（M35-01，方案 C 的判据）：day.area 存在、与全部候选 area 都不匹配，
 * 且该天带 lodging（换酒店/到达语义）或片区与前一天不同（行程移动到了新片区）。
 * 返回缺口片区列表（去重、保持天序）。**不做地理距离计算**——area 是中文片区名，
 * 拉地理编码进来收益配不上复杂度（总览约束节的显式取舍）。
 */
export function hotelAreaGaps(
  plan: Pick<TripPlanState, "skeleton">,
  candidates: ReadonlyArray<{ area?: string }>,
): string[] {
  const gaps: string[] = [];
  let prevArea: string | undefined;
  for (const day of plan.skeleton) {
    const area = day.area;
    if (area) {
      const covered = candidates.some((h) => areaMatches(h.area, area));
      const moved = prevArea === undefined || !areaMatches(prevArea, area);
      if (!covered && (day.lodging !== undefined || moved) && !gaps.includes(area)) {
        gaps.push(area);
      }
      prevArea = area;
    }
  }
  return gaps;
}

export function mergeItinerary(
  branches: readonly BranchResult[],
  input: ItineraryInput,
  ranBranches: readonly ItineraryBranch[],
): ItineraryMergeOutput {
  const violations: string[] = [];
  const missing: string[] = [];
  const findings: string[] = [];

  // 细化轮从旧草案出发做**局部覆盖**：没重跑的分支字段原样保留。
  const prev = input.plan;
  const plan: TripPlanState = prev
    ? structuredClone(prev)
    : {
        status: "skeleton",
        destination: "",
        days: 0,
        skeleton: [],
        caveats: [],
        updatedTurnId: input.turnId,
      };
  plan.status = prev ? "refining" : "skeleton";
  plan.updatedTurnId = input.turnId;

  const byAgent = new Map(branches.map((b) => [b.agent.replace(/-task$/, ""), b]));
  const failed: string[] = [];
  for (const b of branches) {
    if (b.status !== "ok") failed.push(`${b.agent} 分支${b.status === "timeout" ? "超时" : "失败"}`);
  }
  missing.push(...failed);

  // tour：逐天骨架的主干。提交通道优先，正文回落（M30-04，与 hotel 段同构）。
  const tourRes = byAgent.get("tour");
  let tourSource: BranchSource = "missing";
  if (tourRes?.status === "ok") {
    const tour = tourRes.submission
      ? (tourRes.submission as TourJson)
      : extractJson<TourJson>(tourRes.text, "days");
    tourSource = tourRes.submission ? "submission" : tour !== undefined ? "text" : "missing";
    if (tour?.days?.length) {
      if (tour.destination) plan.destination = tour.destination;
      /*
       * **住宿要从旧草案接过来**（M13-14）。
       *
       * 酒店挂在 day 上，而这里是整段重建 skeleton——tour 分支的 JSON 里没有
       * 酒店字段，重建一次就把四天的酒店全抹了，且**过程零报错**。
       * 实测：车主说「一天只有一个公园太少了」（turn-8bdf0923），tour 重排了
       * 逐天骨架，酒店随之消失；下一轮他问「酒店给我找一个呗每天都要订的呀」
       * （turn-e721b3ef），拿到的还是空。
       *
       * 「局部覆盖、没重跑的分支字段原样保留」这条纪律，此前只在**分支**这一层
       * 成立：tour 跑了就整段换掉，连它不负责的字段一起。按天号接回来才算数。
       */
      const prevHotels = new Map(
        (prev?.skeleton ?? []).filter((d) => d.hotel).map((d) => [d.day, d.hotel!]),
      );
      plan.skeleton = tour.days.map((d, i): TripPlanDay => {
        const day = d.day ?? i + 1;
        const carried = prevHotels.get(day);
        // 时段语义校验（M34-01）：整天一票制——任一非法就丢该天全部时段，不修不猜。
        const objSpots = (d.spots ?? []).map((s) => (typeof s === "string" ? { name: s } : s));
        const timesOk = dayTimesValid(objSpots);
        if (!timesOk && objSpots.some((s) => s.estStart !== undefined || s.estEnd !== undefined)) {
          console.warn(`[itinerary] 第${day}天时段字段非法，整天丢弃（HUD 回退端上排时）`);
        }
        const lodging = sanitizeLodging(d.lodging);
        return {
          day,
          theme: d.theme ?? "",
          area: d.area,
          spots: objSpots.map((s) => ({
            name: s.name ?? "",
            indoor: s.indoor,
            ...(timesOk && s.estStart && s.estEnd ? { estStart: s.estStart, estEnd: s.estEnd } : {}),
          })),
          ...(lodging ? { lodging } : {}),
          ...(d.rainBackup ? { notes: [`雨天备选：${d.rainBackup}`] } : {}),
          ...(carried ? { hotel: carried } : {}),
        };
      });
      plan.days = plan.skeleton.length;
      findings.push(...(tour.findings ?? []));
    } else if (ranBranches.includes("tour")) {
      missing.push("tour 分支未返回逐天骨架");
    }
  }

  // hotel：挂到 day——片区匹配优先，匹配不上给没酒店的 day 兜底第一候选。
  const hotelRes = byAgent.get("hotel");
  let hotelSource: ItineraryMergeOutput["hotelSource"] = "missing";
  if (hotelRes?.status === "ok") {
    /*
     * **暂存区优先，正文回落**（M30-03）。提交通道来的数据已过 schema
     * （invokeTool 层 safeParse），直接当 HotelJson 用；没提交才去解析正文——
     * 事故原型 turn-29c4d1d9（一个字符手滑废掉 6 家候选）走的就是正文路径。
     * 两条来源汇进**同一段**挂 day 代码：估算标注、片区匹配只此一份，
     * 复制一份的话两条路径迟早漂移。
     * 模型"提交了、又在正文重复一份"时以提交为准——正文那份被忽略，不双读。
     */
    const hotel = hotelRes.submission
      ? (hotelRes.submission as HotelJson)
      : extractJson<HotelJson>(hotelRes.text, "hotels");
    hotelSource = hotelRes.submission ? "submission" : hotel !== undefined ? "text" : "missing";
    const list = (hotel?.hotels ?? []).filter((h) => h.name);
    if (list.length > 0) {
      /*
       * 逐天挂载（M35-01 改造）：片区匹配优先；无匹配**沿用前一天的酒店**
       * （连住语义），不再 `list[0]` 铺满——那正是 sess-81d1a48a 的病灶：
       * D3 在番禺，候选只有珠江新城，四晚被静默塞成同一家、零提示。
       * 现在矛盾走 caveats 明示（F-13-05 同源），表述层会念出来，
       * 用户一句"第三天住番禺附近"就能触发细化轮。
       */
      let prevPick: (typeof list)[number] | undefined;
      let prevName: string | undefined;
      for (const day of plan.skeleton) {
        const match = list.find((h) => areaMatches(h.area, day.area));
        const pick = match ?? prevPick ?? list[0];
        day.hotel = {
          name: pick.name!,
          // 地址必须随名字走：字段清单里没有它的那版实测（用户反馈）——
          // poi_search 查到了完整地址，分支 JSON 装不下，播报只剩一个含糊的名字。
          address: pick.address,
          area: pick.area,
          rating: pick.rating,
          // 估算标注由代码保证：模型漏写"估算"两个字时在这里补上。
          estPrice: markEstimate(pick.estPrice),
        };
        if (!match && day.area && !areaMatches(pick.area, day.area)) {
          plan.caveats.push(
            `第${day.day}天位于「${day.area}」，本轮未找到该片区住宿候选——住宿沿用「${pick.name}」`,
          );
        } else if (day.lodging && prevName !== undefined && pick.name === prevName) {
          // 换酒店日却没换成：策略是 tour 给的，候选是 hotel 给的，两边没对上要说出来。
          plan.caveats.push(`第${day.day}天计划换住宿，但候选未覆盖新片区——仍为「${pick.name}」`);
        }
        prevPick = pick;
        prevName = pick.name;
      }
      findings.push(...(hotel?.findings ?? []));
    } else if (ranBranches.includes("hotel")) {
      // 「没查到」只有在**草案里真的没有酒店**时才能说（实测 turn-fff8bf33）：
      // 细化轮分支没解析出新候选，但局部覆盖保留了上一轮的酒店——此时无条件
      // 写"必须说没查到"，表述 prompt 里上面四行全是酒店、最后一行命令说没查到，
      // 模型听了命令。矛盾指令比缺口更糟。
      if (plan.skeleton.some((d) => !d.hotel)) {
        /*
         * 归因写进 missing（M13-14）。从前只有一句"未返回酒店候选"，
         * 而它盖住了三种完全不同的成因：分支一个 JSON 都没输出、输出了但没有
         * hotels 这一栏、有栏但每条都缺 name。排查时 `[branch] ok` 配
         * `[merge] 未返回` 是自相矛盾的两条记录，只能靠猜。
         */
        const why =
          hotel === undefined
            ? "分支输出里没有可解析的 JSON"
            : hotel.hotels === undefined
              ? "分支 JSON 里没有 hotels 字段"
              : "hotels 里没有一条带 name";
        missing.push(`hotel 分支未返回酒店候选（${why}）——住宿一栏必须如实说「这次没查到」`);
      } else {
        plan.caveats.push("本轮未查到新的酒店候选，住宿沿用草案中已有的酒店——不要说「没查到酒店」");
      }
    }
  }

  /*
   * transit：**先解析不拼装**。
   *
   * 推荐哪种出行方式要看自驾时长，而那个数在下面的 drive 段才算出来——
   * 在这里拼死摘要，就只能像早先那样"三种并排列出、由端上默认取飞机"，
   * 于是「上海静安 → 上海嘉定」的确认弹窗上写着"飞机 约2.5小时，约400-900元"。
   * 市内 40 分钟车程配一张机票，不是排版问题，是**给了车主一个错的方案**。
   */
  const transitRes = byAgent.get("transit");
  const trainParts: string[] = [];
  let flightPart: string | undefined;
  let transitSource: BranchSource = "missing";
  if (transitRes?.status === "ok") {
    const tr = transitRes.submission
      ? (transitRes.submission as TransitJson)
      : extractJson<TransitJson>(transitRes.text);
    transitSource = transitRes.submission ? "submission" : tr !== undefined ? "text" : "missing";
    for (const t of (tr?.trains ?? []).slice(0, 2)) {
      if (!t.no) continue;
      const h = t.durationMin ? `${Math.floor(t.durationMin / 60)}小时${t.durationMin % 60}分` : "";
      trainParts.push(`${t.no} ${h}${t.costYuan ? ` 约${t.costYuan}元` : ""}`.trim());
    }
    if (tr?.flightAdvice) {
      const fa = tr.flightAdvice;
      const flight = [fa.durationHint, markEstimate(fa.priceEstimate), fa.note].filter(Boolean).join("，");
      if (flight) flightPart = `飞机：${flight}`;
    }
    if (trainParts.length === 0 && !flightPart && ranBranches.includes("transit")) {
      missing.push("transit 分支未返回大交通方案");
    }
    findings.push(...(tr?.findings ?? []));
  }

  // drive：自驾段走既有约束求解——分段超限由 solve() 强制拆，不是文案里提一句。
  let driveLine: string | undefined;
  let driveMinutes: number | undefined;
  const driveRes = byAgent.get("drive");
  let driveSource: BranchSource = "missing";
  if (driveRes?.status === "ok") {
    /*
     * drive 是唯一喂求解器的分支（M30-04）：提交来的数据已过 schema，
     * 形状与 parseTripDraft 的输出对齐——同一份 TripDraft 局部，solve 的输入
     * 不因通道不同而漂移（有同输入对照用例钉住）。
     */
    const parsed = driveRes.submission
      ? (driveRes.submission as Partial<import("../merge").TripDraft>)
      : parseTripDraft(driveRes.text);
    driveSource = driveRes.submission ? "submission" : "text";
    if (parsed.legMinutes?.length) {
      const { kept } = reconcileConstraints(input.constraints, input.energyType);
      const solved = solve(
        { legMinutes: parsed.legMinutes, stops: parsed.stops ?? [], energyStops: parsed.energyStops },
        extractConstraints(kept),
      );
      violations.push(...solved.violations);
      // 补能点穿透（M13-02）：HUD 的 charge 锚位靠它。此前它被汇聚丢掉——
      // 字段清单没有的传不下去（cc16d12 同款教训），solve 完就写进 plan。
      if (solved.draft.energyStops?.length) {
        plan.energyStops = solved.draft.energyStops;
      }
      const totalMin = solved.draft.legMinutes.reduce((a, x) => a + x, 0);
      driveMinutes = totalMin;
      driveLine = `自驾约${Math.floor(totalMin / 60)}小时${Math.round(totalMin % 60)}分，分${solved.draft.legMinutes.length}段`;
      findings.push(...(parsed.findings ?? []));
    } else if (ranBranches.includes("drive")) {
      missing.push("drive 分支未返回自驾分段");
    }
  }

  // 自驾时长齐了，现在才拼大交通并定推荐方式（见上面 transit 段的说明）。
  const transit = assembleTransit({ driveLine, driveMinutes, trainParts, flightPart });
  if (transit) plan.transit = transit;

  // caveats：估算声明恒在（骨架里有任何 estPrice / 飞机建议时下游必须念出来）。
  const caveats = new Set(plan.caveats);
  caveats.add("酒店价格与机票为经验估算，须以实际预订平台为准");
  plan.caveats = [...caveats];

  return {
    plan,
    violations,
    missing,
    findings,
    solverDegraded: failed.length > 0,
    hotelSource,
    tourSource,
    transitSource,
    driveSource,
  };
}

// ── 驱动 ────────────────────────────────────────────────────

function schemaHint(fields: string): string {
  return `在回答的最后附一个 JSON 对象（不要代码块标记），字段：\n${fields}\n没有把握的字段直接省略，**不要编造数值**。`;
}

function branchPrompt(branch: ItineraryBranch, input: ItineraryInput, constraintText: string): string {
  const refineCtx = input.plan
    ? [
        "当前行程草案（JSON，你只更新自己负责的部分，其余保持不变）：",
        JSON.stringify(input.plan),
        `车主现在的要求：${input.userText}`,
      ].join("\n")
    : `请为这次多天出行做你负责的部分：${input.goal}`;
  // 四条分支全部以提交收尾（M30-03/04）：参数即结论，正文只留一句确认。
  const jobs: Record<ItineraryBranch, string> = {
    drive:
      "规划往返大交通的自驾方案（去程分段、休息停靠、补能点）。" +
      "**一次 map_route 的分段结果就够**——不要为每一段单独再查路线（真跑实测：" +
      "逐段验路让分支从 17s 涨到 22s，而分段数据第一次调用就全有了）。" +
      "算完**必须以一次 `submit_drive_draft` 工具调用收尾**提交 legMinutes/stops/energyStops" +
      "（数字取自那次 map_route，禁止编造）；算不出就提交空 legMinutes 并在 findings 说明。",
    hotel:
      "给出住宿候选（先用 poi_search 查真实酒店，按片区给 2-3 个，**每条必须标 area 片区名**）。" +
      // M35-01 B 层：远郊全天园区在请求里点了名，就别只给市区候选——
      // sess-81d1a48a 实测 hotel 只回珠江新城，长隆日被静默塞了市区酒店。
      "请求或约束里出现远郊全天园区（长隆、野生动物园、迪士尼这类）时，" +
      "**为该园区所在片区单独给 2-3 个候选**（如「番禺/长隆附近」），市区片区照旧。" +
      "查完**必须以一次 `submit_hotels` 工具调用收尾**把候选提交（name 逐字取自 poi_search，" +
      "含括号门店名；地址一并带上）；没查到就提交空 hotels 并在 findings 说明。" +
      "提交后不要再把候选写进正文。",
    tour:
      "把目的地的玩法排成逐天骨架（先用 poi_search 查真实景点，每天配雨天备选）。" +
      // M34-01：时段与住宿写进任务指令本身——只写在系统提示词/工具纪律里时，
      // 实测模型全数漏填（sess-6c0ff8df 与 sess-65f29863 两轮均 0 个点带时段）。
      "**每个景点都要给 estStart/estEnd**（HH:MM 预计口径）：非全天日铺满上午+下午" +
      "（下午空半天不是能照着走的行程），夜游/演出落晚间；" +
      "换酒店日与到达日带 lodging（strategy 二选一 + note 写清行李处置）。" +
      "排完**必须以一次 `submit_tour_days` 工具调用收尾**提交逐天骨架；" +
      "排不出就提交空 days 并在 findings 说明。",
    transit:
      "查高铁真实方案（transit_route），并给飞机的常识性对比建议（禁止编航班号）。" +
      "查完**必须以一次 `submit_transit` 工具调用收尾**提交（车次逐字取自 transit_route）；" +
      "没查到就提交空 trains 并在 findings 说明。",
  };
  /*
   * 四条分支已全部切提交通道（M30-03/04）：不再下发"正文末尾附 JSON"的 schemaHint——
   * 两条收尾指令同时在场，模型会两头都做或各做一半。
   * 正文 JSON 的解析链保留为回落路径，但**不主动引导**模型走它。
   * （energy 分支不在此列，仍走 schemaHint——它由 runItineraryFanout 单独拼。）
   */
  return [refineCtx, jobs[branch], constraintText, FINDINGS_RULE].join("\n\n");
}

export interface ItineraryFanoutOutput extends ItineraryMergeOutput {
  branches: BranchResult[];
  ranBranches: ItineraryBranch[];
}

export async function runItineraryFanout(
  streamer: ChatStreamer,
  input: ItineraryInput,
  hooks: Pick<ChatStreamHooks, "threadId" | "onUsage" | "signal"> & Pick<FanoutOptions, "onBranchEvent"> = {},
): Promise<ItineraryFanoutOutput> {
  const { kept, dropped } = reconcileConstraints(input.constraints, input.energyType);
  const constraintText = [
    kept.length ? `必须满足的硬约束：\n${kept.map((c) => `- ${c}`).join("\n")}` : "（本次没有显式硬约束）",
    energyFact(input.energyType),
  ].join("\n\n");
  void dropped; // 剔除项的埋点由节点层负责（与 tripNode 同一分工）

  // 骨架轮四个全跑；细化轮只跑诉求指到的分支。
  const targets: ItineraryBranch[] = input.plan ? refineTargets(input.userText) : ["drive", "hotel", "tour", "transit"];

  /*
   * 续航/补能评估**并进来**（M13-13）。
   *
   * 路由层不再区分单程与多天之后，"去嘉定怎么走"这类请求也走这条链路——
   * 而续航评估原先只在单程 fan-out 里有（`subgraphs/trip.ts` 的第二条分支）。
   * 不带过来的话，并链路的代价就是纯电车主再也拿不到"到得了吗、哪儿补能"。
   *
   * 与 tripFanout 同一条纪律：这是**用车助手的活**（§4.3②），由编排层并行驱动，
   * 不是让出行 Agent 去问它；提示词按能源类型三分（含"不知道"那一档），
   * 复用同一个函数——两处各写一份的话，燃油车被要求算续航那次教训会重演。
   *
   * 只在骨架轮跑：细化轮（改酒店/换景点）与续航无关，再跑一次是白花时间。
   */
  const energyBranch = input.plan
    ? []
    : [
        {
          agent: "ownership-task",
          prompt: [
            energyBranchPrompt(input.energyType, input.userText || "这次出行"),
            constraintText,
            schemaHint(energyFields(input.energyType)),
          ].join("\n\n"),
        },
      ];

  const branches = await runFanout(
    streamer,
    [
      ...targets.map((t) => ({ agent: `${t}-task`, prompt: branchPrompt(t, input, constraintText) })),
      ...energyBranch,
    ],
    {
      threadId: hooks.threadId,
      onUsage: hooks.onUsage,
      onBranchEvent: hooks.onBranchEvent,
      timeoutMs: ITINERARY_BRANCH_TIMEOUT_MS,
      // 上游取消要能穿过 fan-out（M33-01）：不接的话打断之后四条分支
      // 还会各自跑到分支超时（120s）——TD-08 那个僵尸调用，换了个触发原因。
      signal: hooks.signal,
      /*
       * 提交即收工（M30-02）：只有行程 fanout 接——supervisor.ts 的单分支调用点不传，
       * 走旧路径（总览边界）。键三件套：threadId 即工具侧反解出的会话键，
       * turnId 用 currentTurnId 从同一个键空间取（tools-endpoint:198 同源）；
       * 分支名剥 -task 后缀才是提交时记录的规范名（tools-endpoint 的 canonicalAgent 同源）。
       * turnId 取不到（图外直调、测试）就不给通道——分支照旧走正文，不是错误。
       */
      submissionOf: (agent) => {
        const sessionId = hooks.threadId;
        if (!sessionId) return undefined;
        const turnId = currentTurnId(sessionId);
        if (!turnId) return undefined;
        return waitSubmission(sessionId, turnId, canonicalAgent(agent));
      },
    },
  );

  let merged = mergeItinerary(branches, { ...input, constraints: kept }, targets);

  /*
   * M35-01 方案 C：住宿片区缺口的条件式二跳。
   *
   * 并行 fanout 里 hotel 看不到 tour 的产出（结构性事实），所以第一轮候选可能
   * 缺行程真正途经的片区（真实病例 sess-81d1a48a：lodging 说番禺、候选全在
   * 珠江新城）。这里对账：有缺口才对 hotel 分支**同会话**追发一条补缺 prompt
   * （零缺口的市内行程不付这一跳），只追一轮、独立硬超时；失败/仍缺就保留
   * 首轮结果——挂载段的 caveats 已把矛盾明示。**细化轮不追跳**：那是用户
   * 点名改什么跑什么的靶向轮，自动追跳会抢方向盘。
   */
  if (!input.plan && targets.includes("hotel")) {
    const gaps = hotelAreaGaps(merged.plan, hotelCandidatesOf(branches));
    if (gaps.length > 0) {
      console.log(`[itinerary] hotel 追跳：缺口=${gaps.join("、")}`);
      const areasLine = merged.plan.skeleton
        .map((d) => `第${d.day}天「${d.area ?? d.theme}」${d.lodging ? "（换住宿日）" : ""}`)
        .join("、");
      const followPrompt = [
        `行程逐天片区已定：${areasLine}。`,
        `你此前的候选没有覆盖这些片区：${gaps.map((g) => `「${g}」`).join("、")}。`,
        "请为**每个缺口片区**用 poi_search 补 2-3 个真实酒店候选" +
          "（name 逐字取自 poi_search、address 带上、**area 必填**且填该片区名），" +
          "然后以一次 `submit_hotels` 调用收尾，只提交本轮新查的候选；" +
          "查不到也要提交空 hotels 并在 findings 说明。",
        constraintText,
      ].join("\n\n");
      // 槽里还躺着首轮的提交，不清掉的话 submissionOf 立刻拿旧值兑现，
      // 追跳分支根本不会被真正等待（branch-submissions.ts clearSubmission 的存在理由）。
      if (hooks.threadId) {
        const turnId = currentTurnId(hooks.threadId);
        if (turnId) clearSubmission(hooks.threadId, turnId, "hotel");
      }
      const follow = await runFanout(
        streamer,
        [{ agent: "hotel-task", prompt: followPrompt }],
        {
          threadId: hooks.threadId,
          onUsage: hooks.onUsage,
          onBranchEvent: hooks.onBranchEvent,
          signal: hooks.signal,
          timeoutMs: FOLLOWUP_HOTEL_TIMEOUT_MS,
          submissionOf: (agent) => {
            const sessionId = hooks.threadId;
            if (!sessionId) return undefined;
            const turnId = currentTurnId(sessionId);
            if (!turnId) return undefined;
            return waitSubmission(sessionId, turnId, canonicalAgent(agent));
          },
        },
      );
      const combined = combineHotelBranches(branches, follow[0]);
      if (combined) merged = mergeItinerary(combined, { ...input, constraints: kept }, targets);
    }
  }

  return { ...merged, branches, ranBranches: targets };
}

// ── 表述 ────────────────────────────────────────────────────

/**
 * 给应答节点（narrator）的文本。与 describeMerged 同一角色：
 * **求解已经做完了**，这里只是让模型把骨架说成人话；缺口与估算声明必须显式在场。
 */
export function describeItineraryPlan(out: ItineraryMergeOutput): string {
  const { plan } = out;
  const lines: string[] = [];
  lines.push(
    `多天行程${plan.status === "skeleton" ? "骨架（草案）" : "已按要求更新"}：` +
      `${plan.destination || "目的地待定"}，共${plan.days || plan.skeleton.length}天`,
  );
  for (const d of plan.skeleton) {
    const spots = d.spots.map((s) => s.name + (s.indoor ? "（室内）" : "")).join("、") || "（待定）";
    const hotel = d.hotel
      ? `住：${d.hotel.name}${d.hotel.address ? `（${d.hotel.address}）` : ""}${d.hotel.rating ? `（评分${d.hotel.rating}）` : ""}${d.hotel.estPrice ? ` ${d.hotel.estPrice}` : ""}`
      : "";
    const notes = d.notes?.length ? ` ${d.notes.join("；")}` : "";
    lines.push(`第${d.day}天 ${d.theme}：${spots}${hotel ? `。${hotel}` : ""}${notes}`);
  }
  if (plan.transit?.summary) lines.push(`大交通：${plan.transit.summary}`);
  if (out.findings.length) {
    lines.push(`分支查到的事实（可以直接讲给车主，来源是工具查询）：\n${out.findings.map((f) => `- ${f}`).join("\n")}`);
  }
  if (plan.caveats.length) lines.push(`必须一并说明：${plan.caveats.join("；")}`);
  if (out.violations.length) lines.push(`未能满足的约束（必须如实告知用户）：${out.violations.join("；")}`);
  if (out.missing.length) lines.push(`${MISSING_SECTION_HEADER}${out.missing.join("；")}`);
  lines.push("最后提醒车主：说「第X天再细化」或「换个酒店」可以继续调整。");
  return lines.join("\n");
}
