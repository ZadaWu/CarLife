/**
 * 试驾预约子图（施工单 M19-03 起，M19-04 补全多步引导与下单）。
 *
 * # 为什么指代解析在代码里，不在模型手里
 *
 * 与购车候选收敛的关键区别：那边是我们替车主筛，这边是**他在选**。
 * 让模型自己记住"第二家是哪个 storeId"，出错的方式不是记不住——
 * 是**它可能记成另一家店的 id，然后真的把单下了**，而链路看起来完全正常。
 *
 * # 为什么下单由代码发起
 *
 * `.env` 是 `CARLIFE_ANSWER_RUNTIME=direct`：分支出了求解结果之后，
 * 应答由**无工具的直连模型**接管。实测两次（2026-08-12），
 * 模型只会回"试驾预约这个操作，我这边暂时没法直接帮您完成"。
 *
 * 仓里已有先例：`trip_plan_commit` 是图节点直调、`itineraryNode` 自己先
 * `guardGate.check()`。试驾照抄这个形态——**图直调不过 `tools-endpoint`**，
 * 所以权限门与外发项都得子图自己带上，漏了就是"无确认下单"。
 */

import { normalizePhone } from "@carlife/shared";
import { invokeTool, describeDisclosure, type ToolCallContext } from "@carlife/tools";

// 车型索引在**子图之外**（`graph/model-index.ts`）：
// `check:arch` 的 crosstalk 禁止子图互相 import，而两条路要用同一张表。
import { KNOWN_MODELS } from "../model-index";
import type { Intent, TestDrivePlanState, TestDriveStore, TestDriveSlot } from "../state";

/*
 * 指代/时间/联系人解析已上提到平级模块（M44-02）：维修预约子图要用同一套纪律，
 * 而 crosstalk 检查禁止子图互相 import。**对外形状不变**——这里 re-export，
 * supervisor 与既有测试的 import 路径一字不改。
 */
import { resolveSlotRef, resolveStoreRef, pickContact, wantsReset, human } from "../booking-parse";

export { resolveSlotRef, resolveStoreRef, pickContact, wantsReset, human } from "../booking-parse";

// ── 判据 ────────────────────────────────────────────────────

/** 从原话里认车型；认不出返回 undefined，**不猜**。 */
export function matchModel(text: string): string | undefined {
  const q = text.toLowerCase();
  return KNOWN_MODELS.find((m) => m.aliases.some((a) => q.includes(a.toLowerCase())))?.model;
}

/**
 * 城市与区。
 *
 * # 从四城白名单改成认任意城市（M19-07）
 *
 * 原来只认种子覆盖的深圳/广州/上海/杭州，理由写的是"认出一个我们查不到的城市，
 * 下一步就是零命中"。**门店系统现在按 (城市, 区) 现合成，那条理由随之作废**——
 * 现在反过来了：白名单才是唯一挡着"任意城市都能约"的东西。
 *
 * 认城市分两步，顺序有讲究：
 *
 *  1. **先查已知城市表。** 它覆盖车主实际会说出口的绝大多数地名，且零误伤。
 *  2. 再退到 `X市` 的字面模式。这一步**必须过语气词黑名单**——
 *     「我想去市中心看看」里的 `想去市` 会被截成城市，而下游是来者不拒的合成，
 *     于是凭空出现一家「想去体验店」。宁可这一句认不出城市，让助手回去问。
 *
 * # 截错区的代价比截不出来大得多（2026-08-13 真跑）
 *
 * 上一版是贪婪匹配，除了"我在深圳南山"这一种区名正好落在句尾的说法，其余全错：
 * 「深圳南山**有没有啊**」→ 区=`南山有`、「深圳南山**区**」→ 区=`深圳南山`、
 * 「上海浦东新区」→ 区=`海浦东新`。门店系统两边都是包含匹配，全部零命中。
 * 而零命中会被 `describeStores` 如实播报成"这个区真没有店，不是系统故障"——
 * **比报错还难查**，链路上每一层看起来都健康。单测偏偏只覆盖了句尾那一种。
 */
const CITIES = [
  // 直辖市
  "北京", "上海", "天津", "重庆",
  // 省会与自治区首府
  "广州", "杭州", "南京", "武汉", "成都", "西安", "郑州", "济南", "沈阳", "长春",
  "哈尔滨", "石家庄", "太原", "呼和浩特", "长沙", "南昌", "合肥", "福州", "南宁",
  "海口", "贵阳", "昆明", "拉萨", "兰州", "西宁", "银川", "乌鲁木齐", "台北",
  // 计划单列市与主要地级市
  "深圳", "厦门", "宁波", "青岛", "大连", "苏州", "无锡", "常州", "南通", "徐州",
  "佛山", "东莞", "珠海", "中山", "惠州", "汕头", "湛江", "泉州", "温州", "嘉兴",
  "金华", "绍兴", "台州", "烟台", "潍坊", "济宁", "临沂", "洛阳", "唐山", "保定",
  "廊坊", "秦皇岛", "包头", "鄂尔多斯", "大庆", "吉林", "襄阳", "宜昌", "岳阳",
  "常德", "株洲", "湘潭", "衡阳", "赣州", "芜湖", "扬州", "镇江", "盐城", "泰州",
  "淮安", "连云港", "绵阳", "宜宾", "泸州", "德阳", "遵义", "桂林", "柳州", "三亚",
  "香港", "澳门",
];

/**
 * 出现这些字就说明截到的是语气词/动词，不是地名。
 *
 * **只作用在没有「区」字的那条兜底路上**——带「区」字时证据已经够强，
 * 再过一遍黑名单会误杀真区名（`天河`撞「今天」、`上城`撞「上午」、
 * `开福区`/`南开区` 撞下面那组移动动词）。
 *
 * 移动动词那一组是 M19-07 补的：门店系统改成来者不拒地合成之后，
 * 「从深圳**开到**北京」会截出区=`开到`，凭空长出一家「深圳开到体验店」。
 * 以前这种噪音的下场只是零命中，现在会变成一家真的能约的店。
 */
const NOT_DISTRICT = /[的了吗呢啊吧哈嘛有没这那哪要想帮我你他在是和跟就能可试驾店门车约看找周今明后号点个还多少附近哪儿边开到去来往回从走]/;

/** 「X市」的字面模式。只在已知城市表落空时才用，且必须过 `NOT_DISTRICT`。 */
const CITY_SUFFIX_RE = /([一-龥]{2,3})市/;

function pickCity(text: string): string | undefined {
  // **按在句子里出现的先后取**，不是按表的顺序。
  // 按表顺序的话「从深圳开到北京」会判成北京——他人在深圳。
  let best: { city: string; at: number } | undefined;
  for (const c of CITIES) {
    const at = text.indexOf(c);
    if (at >= 0 && (best === undefined || at < best.at)) best = { city: c, at };
  }
  if (best) return best.city;

  const literal = CITY_SUFFIX_RE.exec(text)?.[1];
  // 「我想去市中心」→ `想去市`。下游合成是来者不拒的，放过去就是一家「想去体验店」。
  return literal && !NOT_DISTRICT.test(literal) ? literal : undefined;
}

export function pickCityDistrict(text: string): { city?: string; district?: string } {
  const city = pickCity(text);
  // **先把城市名摘掉再截区**。不摘的话贪婪匹配会把城市名一起吃进去。
  const rest = city ? text.slice(text.indexOf(city) + city.length) : text;

  // ① 带「区」字的最准：取紧挨着「区」的 2~3 个字（浦东新区 → 浦东新）。
  const suffixed = (rest.match(/([一-龥]{2,3})区/) ?? text.match(/([一-龥]{2,3})区/))?.[1];
  if (suffixed && suffixed !== city) return { city, district: suffixed };

  /*
   * ② 没「区」字时只认紧跟在城市后面的两个字。
   *
   * **必须是两个汉字。** 上一版只查了 `length === 2`，于是
   * 「上海 model Y 的…」截出区 = `" m"`（空格 + 字母）——真跑 `turn-fb4498ff` 撞上的。
   * 门店系统那边靠 `isPlausiblePlace` 兜住了没出事，但把噪音发出去本身就是错的：
   * 兜底一旦哪天松一格，凭空长出的就是一家「上海 m 体验店」。
   *
   * 截多了还会把「有没」「的试」当区，所以宁可放弃——真截错了还有
   * `runTestDrive` 那层的城市级回退兜着。
   */
  const bare = city ? rest.slice(0, 2) : "";
  const ok = /^[一-龥]{2}$/.test(bare) && !NOT_DISTRICT.test(bare);
  return { city, district: ok ? bare : undefined };
}

/** 明说要再约一单的说法。 */
const AGAIN_RE = /(再约|再帮我约|再预约|另外约|还想约|重新约|另约|再来一个|再订)/;

/**
 * **已经下过单之后，这一轮是不是在开一单新的。**
 *
 * 真跑 `turn-fb4498ff`（2026-08-14）：会话里先约成了 `TD-000004`（深圳南山），
 * 之后车主说「帮我预约一下上海 Model Y 的八月十五号的试驾」，助手回
 * "上海没有可预约的门店和时段"**并顺手报了深圳的时段**——它一次都没查过上海。
 *
 * 成因：`plan.orderId` 一旦落定，换城市的重查被 `!plan.orderId` 挡掉，
 * 状态机每一步都判定"已经做完了"，于是把那份**已完成的旧计划**又交了一遍上下文，
 * 应答模型只好自己给"上海"编一个结论。**一单下完，那份计划就该退休。**
 *
 * 但不能一见到 booked 就无脑重来：「我那个试驾几点来着」也会路由到试驾，
 * 那时该继续讲已下的那一单。所以要有**新一单的信号**：换了城市、换了车型，
 * 或者明说「再约一个」。
 */
export function startsNewBooking(
  raw: string,
  city: string | undefined,
  model: string,
  prior?: TestDrivePlanState,
): boolean {
  if (!prior?.orderId && prior?.status !== "booked") return false;
  return Boolean(
    (city && city !== prior?.city) || (model && model !== prior?.model) || AGAIN_RE.test(raw),
  );
}

// ── 描述（给应答节点的上下文）────────────────────────────────

/**
 * **还在选时段 = 还没约上。**
 *
 * 真跑 `turn-504db099`（2026-08-15）：车主说「我要八月十七十点的」，
 * 时段解析不出（见 `resolveSlotRef` 的中文日期那段），子图照常把时段列表又交了一遍，
 * 而应答模型回了一句 **"已经帮您约好了，记得带好驾照"**——
 * 轨迹里 `chosenSlot: null`、一次权限门都没过、订单不存在。
 *
 * 这是这个项目最贵的那类错：车主到点开车过去，门店没有他的预约。
 * 而报时段这一步**此前没有任何"没约上就别说约好"的拦截**——
 * 下单那条路上有（"确认结果出来之前不要说已经约好"），偏偏最容易走到的这条没有。
 */
const NOT_BOOKED_YET =
  "⚠️ **本轮没有约上任何时段。**不要说「已经约好」「已经帮您预约」「已为您锁定」，" +
  "也不要交代到店注意事项——那些话只有真下单之后才成立。" +
  "真正下单前编排层会先弹确认框让车主点，弹窗出现之前一律没约上。";

const NO_SLOT_YET =
  "⚠️ **本轮没有查过任何可预约时段。**不要说出任何具体时间、不要说「都有名额」、" +
  "不要问「您想约周六上午吗」——他选定门店之后编排层才会去查真实时段。";

/**
 * 放宽到城市级时**必须说出来**。
 * 他问的是南山，我们给的是福田——不说清楚他到了店门口才发现跑错区。
 */
export function widenNote(from?: string): string {
  return from
    ? `⚠️ 车主问的是**${from}**，那边没有可试驾的门店，下面这几家是**同城其它区**的。请先把这件事告诉他，再报门店。\n`
    : "";
}

export function describeStores(plan: TestDrivePlanState): string {
  if (plan.stores.length === 0) {
    return (
      `试驾预约：${plan.city ?? ""}${plan.district ?? ""}**没有**可试驾 ${plan.model} 的门店` +
      "（门店系统返回零命中，这是事实不是故障）。请如实告知车主，并问他换个区或换个城市要不要。"
    );
  }
  return [
    `试驾预约：${plan.model} · ${plan.city ?? ""}${plan.district ?? ""} 查到 ${plan.stores.length} 家门店（来自门店系统，**不是编的**）：`,
    ...plan.stores.map((x, i) => `${i + 1}. ${x.name}（${x.district}）${x.address}`),
    "请把门店报给车主让他选一家。**门店 id 不要念给他听。**",
    NO_SLOT_YET,
    NOT_BOOKED_YET,
  ].join("\n");
}

export function describeSlots(plan: TestDrivePlanState): string {
  const store = plan.stores.find((s) => s.storeId === plan.chosenStoreId);
  if (plan.slots.length === 0) {
    return `试驾预约：${store?.name ?? "该门店"}最近没有 ${plan.model} 的可预约时段（门店系统返回空）。请如实告知，并问他要不要换一家店。`;
  }
  return [
    `试驾预约：${store?.name ?? ""} 的 ${plan.model} 可预约时段（**来自门店系统，只能从这里面选**）：`,
    ...plan.slots.slice(0, 6).map((s, i) => `${i + 1}. ${human(s.startAt)}${s.remaining <= 1 ? "（仅剩 1 台）" : ""}`),
    "请报给车主让他挑一个。**时段 id 不要念给他听。**",
    NOT_BOOKED_YET,
  ].join("\n");
}

export function describeBooked(plan: TestDrivePlanState): string {
  const store = plan.stores.find((s) => s.storeId === plan.chosenStoreId);
  const slot = plan.slots.find((s) => s.slotId === plan.chosenSlotId);
  // 用了档案里的号时**必须把尾号说出来**（M19-06）：门店回拨打的是哪个号，
  // 是他此刻唯一还来得及纠正的东西。说"手机号"三个字等于没说。
  const tail = plan.contactRef?.phoneTail ?? (plan.contact?.phone ? plan.contact.phone.slice(-4) : undefined);
  return [
    `试驾预约：**已下单成功**，订单号 ${plan.orderId}。`,
    `门店：${store?.name ?? ""}；时间：${slot ? human(slot.startAt) : ""}；车型：${plan.model}。`,
    tail
      ? `已提供给门店的信息：称呼、手机号（**尾号 ${tail}**，门店会回拨这个号确认）。请把尾号念给车主，**不要念星号**。`
      : "已提供给门店的信息：称呼、手机号（门店会回拨确认）。",
    "如实转述以上内容即可，不要另加承诺（比如「到店有礼」这类我们并不知道的事）。",
  ].join("\n");
}

// ── 主流程 ──────────────────────────────────────────────────

export interface TestDriveTurn {
  plan: TestDrivePlanState;
  context: string;
  /** 需要走 HITL 时非空：由节点带着它去调权限门。 */
  booking?: { summary: string; disclosures: string[]; args: Record<string, unknown> };
}

/**
 * 推进一轮。
 *
 * 状态机很浅但每一步都**只陈述工具返回的事实**：
 * 没查过门店就不说门店名，没查过时段就不说时间。
 */
export async function runTestDrive(args: {
  raw: string;
  model: string;
  city?: string;
  district?: string;
  prior?: TestDrivePlanState;
  /** 查档案里登记的联系方式要按用户维度过滤；缺省则退回"问车主"。 */
  userId?: string;
  /** 意图理解给的时间点（M19-08）。缺省则时段解析完全退回正则。 */
  when?: Intent["when"];
  ctx: ToolCallContext;
  sessionId: string;
}): Promise<TestDriveTurn> {
  const { raw, ctx } = args;
  const reset = wantsReset(raw) || startsNewBooking(raw, args.city, args.model, args.prior);
  const prior = reset ? undefined : args.prior;

  const plan: TestDrivePlanState = prior
    ? { ...prior, model: args.model, city: args.city ?? prior.city, district: args.district ?? prior.district }
    : {
        model: args.model,
        // 「换一家店」重来的是选店，**不是重新做人**：城市与联系方式留着。
        // 丢了就会再问一遍手机号，而他刚说过——和 `turn-48794b58` 同一种冒犯。
        city: args.city ?? args.prior?.city,
        district: args.district ?? (args.city ? undefined : args.prior?.district),
        contact: args.prior?.contact,
        // 档案里那条也留着，否则第二单又会问一遍手机号（M19-06 白做）。
        contactRef: args.prior?.contactRef,
        stores: [],
        slots: [],
        status: "choosing_store",
        at: Date.now(),
      };

  /**
   * **中途改地方要真的重查。**
   *
   * 真跑 `turn-48794b58`：门店时段都定完、只差手机号时车主问「上海有没有」，
   * 状态机停在第⑤步根本没走查询分支，于是应答模型自己补了一句
   * "上海我这次没查到可用的试驾名额"——**它一次都没查过**。
   * 缺信息时模型会编，这是这个项目最贵的那类错，得在状态机这层堵。
   *
   * 车型与联系方式留着（换城市不等于换人换车），门店/时段与两个选择全部作废。
   */
  // 已下单的那份计划走不到这里——`startsNewBooking` 在上面就把它退休了。
  // 这一条只管**还没下单时**中途改地方。
  const movedCity = !!(prior && args.city && args.city !== prior.city);
  if (movedCity) {
    plan.stores = [];
    plan.slots = [];
    plan.chosenStoreId = undefined;
    plan.chosenSlotId = undefined;
    plan.district = args.district; // 旧城市的区不能带过去
    plan.status = "choosing_store";
  }

  // 联系方式随时可以补上来
  const c = pickContact(raw);
  if (c.name || c.phone) {
    plan.contact = { name: c.name ?? plan.contact?.name ?? "", phone: c.phone ?? plan.contact?.phone ?? "" };
  }

  // ① 还没查过门店 → 查
  if (plan.stores.length === 0) {
    if (!plan.city) {
      return {
        plan,
        context: `试驾预约：车型已确定为 ${plan.model}，**但还不知道在哪个城市**。请问车主所在城市（最好到区）。在问到之前不要查门店、不要说出任何门店名。`,
      };
    }
    const query = async (district?: string) => {
      const r = (await invokeTool(
        "dealer_stores",
        { model: plan.model, city: plan.city, district },
        ctx,
      )) as { data: { stores: TestDriveStore[] } };
      return r.data.stores;
    };

    let widenedFrom: string | undefined;
    try {
      let rows = await query(plan.district);
      // **区级零命中不等于这个城市没有店。** 两种情况都会走到这里：
      // 区名是我们从原话里截错的，或者他说的那个区确实没店而隔壁区有。
      // 直接播报"没有"两种都是错的答案——所以退回城市级再查一次，
      // 只有城市级也为零才敢说"没有"。
      if (rows.length === 0 && plan.district) {
        const cityWide = await query(undefined);
        if (cityWide.length > 0) {
          widenedFrom = plan.district;
          plan.district = undefined;
          rows = cityWide;
        }
      }
      plan.stores = rows.slice(0, 3);
    } catch (err) {
      return { plan, context: degraded(err) };
    }
    // 只有一家就直接选中——多问一句"你选哪家"是折磨。
    // **但放宽过范围时不自动选**：他问的是南山，我们给的是福田，得让他自己点头。
    if (plan.stores.length === 1 && !widenedFrom) plan.chosenStoreId = plan.stores[0].storeId;
    else return { plan, context: widenNote(widenedFrom) + describeStores(plan) };
  }

  // ② 选门店
  if (!plan.chosenStoreId) {
    const picked = resolveStoreRef(raw, plan.stores);
    if (!picked) return { plan, context: describeStores(plan) };
    plan.chosenStoreId = picked;
  }

  // ③ 查时段
  if (plan.slots.length === 0) {
    try {
      const r = (await invokeTool(
        "dealer_slots",
        { storeId: plan.chosenStoreId, model: plan.model },
        ctx,
      )) as { data: { slots: TestDriveSlot[] } };
      plan.slots = r.data.slots.slice(0, 12);
    } catch (err) {
      return { plan, context: degraded(err) };
    }
    plan.status = "choosing_slot";
    return { plan, context: describeSlots(plan) };
  }

  // ④ 选时段
  if (!plan.chosenSlotId) {
    const picked = resolveSlotRef(raw, plan.slots, args.when);
    if (!picked) {
      plan.status = "choosing_slot";
      return { plan, context: describeSlots(plan) };
    }
    plan.chosenSlotId = picked;
  }

  /*
   * ⑤ 联系方式：**先查档案，问是最后手段**（M19-06）。
   *
   * 这是 M19-04 验收 §6 挂的第一条债。车主本人就在 `vehicle_members` 里
   * （`relation=本人` 那条），每次都让他重念一遍手机号是我们自己没去看。
   *
   * 拿回来的**只有后四位**——真号留在库里，下单时由工具层按 memberId 自己取。
   * 所以这里存 `contactRef` 而不是 `contact`：明文一次都不进图状态、
   * 不进检查点、不进上下文。
   */
  let justSaved = false;
  if (!plan.contactRef && args.userId) {
    try {
      const r = (await invokeTool("contact_lookup", { userId: args.userId }, ctx)) as {
        data: { members: Array<{ memberId: string; displayName: string; phoneTail?: string; hasPhone: boolean }> };
      };
      const hit = r.data.members.find((m) => m.hasPhone && m.phoneTail);
      if (hit) {
        plan.contactRef = { memberId: hit.memberId, displayName: hit.displayName, phoneTail: hit.phoneTail! };
      } else if (plan.contact?.phone) {
        /*
         * 他刚口述了号码而档案里没有 → **记进去**（M19-06 D2：不过门，改完口头告知）。
         *
         * 由子图发起而不是等模型调 `contact_update`：试驾这条路上应答是
         * `CARLIFE_ANSWER_RUNTIME=direct` 的无工具直连模型，模型**结构上不可能**
         * 调到那个工具。指望它去调，等于把这个工具注册了却永远不会被执行。
         *
         * 存不进去不影响这一单——`plan.contact` 还在，照旧用明文下单。
         */
        const self = r.data.members[0];
        if (self) {
          await invokeTool(
            "contact_update",
            { userId: args.userId, memberId: self.memberId, phone: plan.contact.phone },
            ctx,
          );
          plan.contactRef = {
            memberId: self.memberId,
            displayName: plan.contact.name || self.displayName,
            phoneTail: plan.contact.phone.slice(-4),
          };
          justSaved = true;
        }
      }
    } catch {
      // 档案读写失败不是错误路径，退回去问 / 用原话里的号就是了——**不因此中断预约**。
    }
  }

  if (!plan.contactRef && (!plan.contact?.name || !plan.contact?.phone)) {
    plan.status = "confirming";
    const slot = plan.slots.find((s) => s.slotId === plan.chosenSlotId);
    return {
      plan,
      context:
        `试驾预约：门店与时段都定了（${human(slot?.startAt ?? "")}），**还差联系方式**（档案里没查到登记过的手机号）。` +
        "请问车主怎么称呼、手机号多少（门店回拨用）。**不要替他编，也不要代拟备注。**\n" +
        NOT_BOOKED_YET,
    };
  }

  // ⑥ 下单：权限门 → HITL → 由节点执行
  const store = plan.stores.find((s) => s.storeId === plan.chosenStoreId);
  const slot = plan.slots.find((s) => s.slotId === plan.chosenSlotId);
  plan.status = "confirming";
  const ref = plan.contactRef;
  return {
    plan,
    context:
      `试驾预约：正在请车主确认（${store?.name}，${human(slot?.startAt ?? "")}）。确认结果出来之前不要说已经约好。` +
      (ref
        ? `\n联系方式${justSaved ? "已记进他的档案" : "用的是档案里登记的"}：${ref.displayName}，**尾号 ${ref.phoneTail}**。` +
          "跟他核对时说尾号就行——**不要念星号**，也不要说完整号码（你也拿不到）。" +
          (justSaved ? "**顺带告诉他已经记下了，下次不用再报**，要改说一声就行。" : "")
        : ""),
    booking: {
      // 摘要说**人话**：他批的是"周六上午去南山那家"，不是一串 id。
      summary: `预约试驾 · ${store?.name ?? ""} · ${human(slot?.startAt ?? "")} · ${plan.model}`,
      // **图直调不过 tools-endpoint**，所以 DISCLOSURE_BUILDERS 挂不上——
      // 外发项必须子图自己带，漏了车机弹窗上那块就是空的（M15-04 的核心验收点）。
      //
      // 走档案时这里也拿不到明文，所以掩码串自己拼：`describeDisclosure` 的口径是
      // 前 3 后 4，手上只有后 4 位，前三位用 `···` 占位而不是编三个数字。
      disclosures: ref
        ? [`称呼：${ref.displayName}`, `手机号：···****${ref.phoneTail}`]
        : describeDisclosure(plan.contact!).map((d) => `${d.field}：${d.value}`),
      args: {
        storeId: plan.chosenStoreId,
        slotId: plan.chosenSlotId,
        model: plan.model,
        // **优先走 memberId**：真号由工具层取，全程不经过模型也不进图状态。
        ...(ref ? { memberId: ref.memberId, userId: args.userId } : { contact: plan.contact }),
        // 幂等两层：这里一层，mock 服务侧一层。重复确认不下两单。
        idempotencyKey: `${args.sessionId}:${plan.chosenSlotId}`,
      },
    },
  };
}

function degraded(err: unknown): string {
  return (
    `试驾预约：门店系统这次没连通（${err instanceof Error ? err.message : String(err)}）。` +
    "请如实告诉车主门店系统暂时查不了，**一个门店名都不要说**，也不要给时间。"
  );
}
