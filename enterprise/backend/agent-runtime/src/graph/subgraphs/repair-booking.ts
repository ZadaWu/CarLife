/**
 * 维修预约引导子图（施工单 M44-02）。
 *
 * # 形态照试驾（B 型状态机），理由一条不少
 *
 * "多步引导 + 有副作用终点"按 §4.5 就该 B 型；且 `CARLIFE_ANSWER_RUNTIME=direct`
 * 下应答模型无工具——M41-05 真跑（sess-66e43c90-cca）证实用户说"帮我约保养"
 * 只能得到诚实的"没有确认回执"。**希望必然发生的调用，就得由代码发起。**
 *
 * # 与试驾子图的三点差异
 *
 *  1. 站少（种子 3 家）：不带城市就全列让他选，不追问"你在哪"；
 *  2. 时段是固定进厂窗口（每天 09/11/14/16 点），不是伪随机排班；
 *  3. 下单终点是 `appointment` 工具（M41-03 已切 mock-repair 后端），
 *     VIN 经 subject 的 `VIN:` 前缀传递、stationId 由后端防编校验。
 *
 * 指代解析全部复用 `../booking-parse`（唯一命中、解析不出不猜、
 * NOT_BOOKED_YET 拦截——纪律与出处见那边与试驾子图的注释）。
 */

import { invokeTool, describeDisclosure, type ToolCallContext } from "@carlife/tools";

import {
  human,
  pickContact,
  resolveSlotRef,
  resolveStoreRef,
  wantsReset,
  type IntentWhen,
} from "../booking-parse";
import type { RepairBookingPlanState, RepairBookingSlot, RepairBookingStation } from "../state";

// ── 意图门与粘性判据（route 与 supervisor 共用）─────────────────

/**
 * 预约维修/保养的明确说法。**判得窄**：含糊句走双路 narrator（它会如实说，
 * 不会误下单）；"记录一下我做了保养"是留档（archiveIntent 在前，见 supervisor）。
 */
const BOOKING_RE =
  // 动词与维修词之间放宽到 30 字：一步到位的说法会把日期与完整站名塞在中间
  // （"帮我预约 9 月 1 号上午 9 点在上海浦东前滩服务中心做机油保养"实测 28 字），
  // 收窄会让最顺畅的说法反而进不了引导流。误纳的代价只是多列一次维修站
  // （下单仍有确认弹窗兜底），漏纳的代价是整条链路走不到——取宽。
  /(预约|约个|约一下|约下|帮我约|想约).{0,30}(保养|维修|修车|进厂|检修)|(保养|维修|修车).{0,8}(预约|约个|约一下|约个时间)/;

export function repairBookingIntent(text: string): boolean {
  return BOOKING_RE.test(text);
}

/**
 * 预约进行中时的续接说法（M44-02 粘性判据，形状照 TEST_DRIVE_REFINE）。
 *
 * 只认选择/补信息类句式——粘错的代价是把闲聊推进一条带下单动作的流程。
 */
export const REPAIR_BOOKING_REFINE =
  /(第[一二三123]\s*[家个]|那家|这家|就它|就这家|[上下]午|周[一二三四五六日天]|\d{1,2}\s*[号日点]|[一二两三四五六七八九十]{1,3}\s*点|我姓[一-龥]|1[3-9]\d{9}|换个站|换一家|换个时[间段]|确认|可以|好的)/;

/** 维修项目词表：抓到什么记什么，抓不到默认"常规保养"——项目描述给维修站参考，不是防编面。 */
const ITEM_WORDS = [
  "机油", "机滤", "保养", "轮胎", "换胎", "补胎", "刹车", "钣金", "喷漆", "空调",
  "电瓶", "蓄电池", "检查", "检修", "异响", "玻璃", "雨刮", "滤芯",
];

export function pickRepairItems(text: string): string | undefined {
  const hits = ITEM_WORDS.filter((w) => text.includes(w));
  if (hits.length === 0) return undefined;
  // 去重后拼短语；"机油保养" 会命中两个词，原话更可读就用原话里的连续片段。
  return [...new Set(hits)].slice(0, 4).join("、");
}

/** 明说要再约一单的说法（照试驾 AGAIN_RE）。 */
const AGAIN_RE = /(再约|再帮我约|再预约|另外约|还想约|重新约|另约|再来一个)/;

/** 已下单的计划该退休：新意图（再约/换站类明说）才重开，问"我那单几点"不该重开。 */
export function startsNewRepairBooking(raw: string, prior?: RepairBookingPlanState): boolean {
  if (!prior?.orderId && prior?.status !== "booked") return false;
  return AGAIN_RE.test(raw) || repairBookingIntent(raw);
}

// ── 描述（给应答节点的上下文；拦截话术与试驾同源同款）────────────

const NOT_BOOKED_YET =
  "⚠️ **本轮没有约上任何时段。**不要说「已经约好」「已经帮您预约」，也不要交代到店" +
  "注意事项——那些话只有真下单之后才成立。真正下单前编排层会先弹确认框让车主点，" +
  "弹窗出现之前一律没约上。";

export function describeStations(plan: RepairBookingPlanState): string {
  if (plan.stations.length === 0) {
    return (
      "维修预约：维修系统里没有查到可预约的维修站（返回零命中，这是事实不是故障）。" +
      "请如实告知车主。"
    );
  }
  return [
    `维修预约：查到 ${plan.stations.length} 家维修站（来自维修系统，**不是编的**）：`,
    ...plan.stations.map((x, i) => `${i + 1}. ${x.name}（${x.city}${x.district}）`),
    "请把维修站报给车主让他选一家。**站点 id 不要念给他听。**",
    NOT_BOOKED_YET,
  ].join("\n");
}

export function describeRepairSlots(plan: RepairBookingPlanState): string {
  const station = plan.stations.find((s) => s.stationId === plan.chosenStationId);
  if (plan.slots.length === 0) {
    return `维修预约：${station?.name ?? "该维修站"}最近没有可预约的进厂时段（维修系统返回空）。请如实告知，并问他要不要换一家。`;
  }
  return [
    `维修预约：${station?.name ?? ""} 的可预约进厂时段（**来自维修系统，只能从这里面选**；进厂窗口是每天 09/11/14/16 点）：`,
    ...plan.slots.slice(0, 8).map((s, i) => `${i + 1}. ${human(s.startAt)}${s.remaining <= 1 ? "（仅剩 1 个工位）" : ""}`),
    "请报给车主让他挑一个。**时段 id 不要念给他听。**",
    NOT_BOOKED_YET,
  ].join("\n");
}

export function describeRepairBooked(plan: RepairBookingPlanState): string {
  const station = plan.stations.find((s) => s.stationId === plan.chosenStationId);
  const slot = plan.slots.find((s) => s.slotId === plan.chosenSlotId);
  const tail = plan.contactRef?.phoneTail ?? (plan.contact?.phone ? plan.contact.phone.slice(-4) : undefined);
  return [
    `维修预约：**已下单成功**，订单号 ${plan.orderId}（模拟维修系统，等门店回执确认）。`,
    `维修站：${station?.name ?? ""}；进厂时间：${slot ? human(slot.startAt) : ""}；项目：${plan.items}。`,
    tail
      ? `已提供给维修站的信息：称呼、手机号（**尾号 ${tail}**，维修站会回拨这个号确认）。请把尾号念给车主，**不要念星号**。`
      : "已提供给维修站的信息：称呼、手机号（维修站会回拨确认）。",
    "如实转述以上内容即可，不要另加承诺（比如费用或工期——报价要到店检查后才有）。",
  ].join("\n");
}

// ── 主流程 ──────────────────────────────────────────────────

export interface RepairBookingTurn {
  plan: RepairBookingPlanState;
  context: string;
  /** 需要走 HITL 时非空：由节点带着它去调权限门（图直调不过 tools-endpoint）。 */
  booking?: { summary: string; disclosures: string[]; args: Record<string, unknown> };
}

export async function runRepairBooking(args: {
  raw: string;
  /** 默认车 VIN（来自 vehicle_profile）。缺失只引导建档，不下单。 */
  vin?: string;
  city?: string;
  prior?: RepairBookingPlanState;
  userId?: string;
  when?: IntentWhen;
  ctx: ToolCallContext;
  sessionId: string;
}): Promise<RepairBookingTurn> {
  const { raw, ctx } = args;
  const reset = wantsReset(raw) || startsNewRepairBooking(raw, args.prior);
  const prior = reset ? undefined : args.prior;

  const plan: RepairBookingPlanState = prior
    ? { ...prior, vin: args.vin ?? prior.vin }
    : {
        vin: args.vin ?? args.prior?.vin,
        items: pickRepairItems(raw) ?? args.prior?.items ?? "常规保养",
        city: args.city ?? args.prior?.city,
        // 「换一家」重来的是选站，不是重新做人：联系方式留着（试驾 turn-48794b58 的教训）。
        contact: args.prior?.contact,
        contactRef: args.prior?.contactRef,
        stations: [],
        slots: [],
        status: "choosing_station",
        at: Date.now(),
      };

  // 项目与联系方式随时可以补上来
  const items = pickRepairItems(raw);
  if (items) plan.items = items;
  const c = pickContact(raw);
  if (c.name || c.phone) {
    plan.contact = { name: c.name ?? plan.contact?.name ?? "", phone: c.phone ?? plan.contact?.phone ?? "" };
  }

  // ⓪ 没有车辆档案就没有 VIN——引导建档，**不编 VIN 不下单**（与 runRepairContext 同口径）。
  if (!plan.vin) {
    return {
      plan,
      context:
        "维修预约：**没有车辆档案（缺 VIN），约不了维修**。请如实告知车主：先补录车辆信息" +
        "（车架号）建档，之后就能直接帮他预约。不要报出任何维修站名或时段。",
    };
  }

  // ① 还没查过维修站 → 查（站少：不带城市就全列，不追问"你在哪"）
  if (plan.stations.length === 0) {
    try {
      const r = (await invokeTool("repair_stations", { city: plan.city }, ctx)) as {
        data: { stations: RepairBookingStation[] };
      };
      plan.stations = r.data.stations.slice(0, 5);
    } catch (err) {
      return { plan, context: degraded(err) };
    }
    if (plan.stations.length === 1) plan.chosenStationId = plan.stations[0].stationId;
  }

  /*
   * ② 选维修站。**查完当轮就尝试解析同一句话**——一步到位的说法
   * （"帮我预约周一上午 9 点在××服务中心做保养"）里站名已经在原话里，
   * 查完就返回列表等于把他说过的话再问一遍。唯一命中的纪律不变：
   * 解析不出（或命中多家）才播报列表回去问。
   */
  if (!plan.chosenStationId) {
    const picked = resolveStoreRef(
      raw,
      plan.stations.map((s) => ({ storeId: s.stationId, name: s.name, district: s.district })),
    );
    if (!picked) return { plan, context: describeStations(plan) };
    plan.chosenStationId = picked;
  }

  // ③ 查进厂时段（同上：查完当轮就尝试解析，不空转一轮）
  if (plan.slots.length === 0) {
    try {
      const r = (await invokeTool("repair_slots", { stationId: plan.chosenStationId }, ctx)) as {
        data: { slots: RepairBookingSlot[] };
      };
      plan.slots = r.data.slots.slice(0, 12);
    } catch (err) {
      return { plan, context: degraded(err) };
    }
    plan.status = "choosing_slot";
  }

  // ④ 选时段（唯一命中，解析不出回去问——纪律与出处见 booking-parse）
  if (!plan.chosenSlotId) {
    const picked = resolveSlotRef(raw, plan.slots, args.when);
    if (!picked) {
      plan.status = "choosing_slot";
      return { plan, context: describeRepairSlots(plan) };
    }
    plan.chosenSlotId = picked;
  }

  // ⑤ 联系方式：先查档案，问是最后手段（M19-06 纪律；只存尾号，明文不进图状态）
  if (!plan.contactRef && args.userId) {
    try {
      const r = (await invokeTool("contact_lookup", { userId: args.userId }, ctx)) as {
        data: { members: Array<{ memberId: string; displayName: string; phoneTail?: string; hasPhone: boolean }> };
      };
      const hit = r.data.members.find((m) => m.hasPhone && m.phoneTail);
      if (hit) {
        plan.contactRef = { memberId: hit.memberId, displayName: hit.displayName, phoneTail: hit.phoneTail! };
      }
    } catch {
      // 档案读失败不是错误路径：退回去问 / 用原话里的号，不中断预约。
    }
  }

  if (!plan.contactRef && (!plan.contact?.name || !plan.contact?.phone)) {
    plan.status = "confirming";
    const slot = plan.slots.find((s) => s.slotId === plan.chosenSlotId);
    return {
      plan,
      context:
        `维修预约：站点与时段都定了（${human(slot?.startAt ?? "")}），**还差联系方式**` +
        "（档案里没查到登记过的手机号）。请问车主怎么称呼、手机号多少（维修站回拨用）。" +
        "**不要替他编。**\n" +
        NOT_BOOKED_YET,
    };
  }

  // ⑥ 下单：权限门 → HITL → 由节点执行
  const station = plan.stations.find((s) => s.stationId === plan.chosenStationId);
  const slot = plan.slots.find((s) => s.slotId === plan.chosenSlotId);
  plan.status = "confirming";
  const ref = plan.contactRef;
  return {
    plan,
    context:
      `维修预约：正在请车主确认（${station?.name}，${human(slot?.startAt ?? "")}，项目：${plan.items}）。` +
      "确认结果出来之前不要说已经约好。" +
      (ref
        ? `\n联系方式用的是档案里登记的：${ref.displayName}，**尾号 ${ref.phoneTail}**。` +
          "跟他核对时说尾号就行——**不要念星号**，也不要说完整号码（你也拿不到）。"
        : ""),
    booking: {
      // 摘要说人话：他批的是"周一上午去前滩做保养"，不是一串 id。
      summary: `预约维修保养 · ${station?.name ?? ""} · ${human(slot?.startAt ?? "")} · ${plan.items}`,
      // 图直调不过 tools-endpoint，外发项子图自己带（与试驾同一条 M15-04 验收点）。
      // 档案路手上只有后 4 位：前三位用 `···` 占位，不编三个数字。
      disclosures: ref
        ? [`称呼：${ref.displayName}`, `手机号：···****${ref.phoneTail}`]
        : describeDisclosure({ name: plan.contact!.name, phone: plan.contact!.phone }).map(
            (d) => `${d.field}：${d.value}`,
          ),
      args: {
        kind: "service",
        storeId: plan.chosenStationId,
        storeName: station?.name ?? "",
        at: slot?.startAt ?? "",
        // VIN 经 subject 前缀传递（M41-03 的 createRepairAppointmentBackend 契约）。
        subject: `VIN:${plan.vin} ${plan.items}`,
        // 优先走 memberId：真号由工具层取（M44-01），不经模型不进图状态。
        ...(ref ? { memberId: ref.memberId, userId: args.userId } : { contact: plan.contact }),
        // 幂等两层：这里一层，mock 服务侧一层。重复确认不下两单。
        idempotencyKey: `${args.sessionId}:${plan.chosenSlotId}`,
      },
    },
  };
}

function degraded(err: unknown): string {
  return (
    `维修预约：维修系统这次没连通（${err instanceof Error ? err.message : String(err)}）。` +
    "请如实告诉车主维修系统暂时约不了，**一个维修站名都不要说**，也不要给时间。"
  );
}
