/**
 * 经销商系统四件套（施工单 M19-02，设计定稿 D4/D5）。
 *
 * # 它们存在的理由：让门店和时段不再是编的
 *
 * 在此之前 `appointment` 收的是 `storeId` / `storeName` / `at` 三个**自由字符串**，
 * schema 只校验非空。M15-04 真跑那次，模型填的是"深圳南山特斯拉中心"和一个它拍的时间——
 * 两个值都没有数据源，而链路看起来完全正常。用户拿着这个"预约成功"过去很可能扑空。
 *
 * # 防编靠 schema，不靠提示词
 *
 * `test_drive_book` 的入参里**没有 `storeName`、没有自由时间字符串**，
 * 只有 `storeId` + `slotId`——两个都得先从前面的接口查回来。
 * 模型编一个 `slotId` 会被 mock 服务 404 拒掉（那边的 id 带不可猜的签名后缀），
 * 工具如实报错，助手只能回去重查。
 *
 * # 未接入要说"未接入"
 *
 * 没配 `MOCK_DEALER_URL` 时四个工具一律抛 `unconfigured`，**不返回空**——
 * 空结果会被上层当成"这个城市没有店"，那是错误信息（`ragflow_retrieve` 的先例）。
 * 这条同时是 Demo 判定第 7 条的后半：当场 kill 掉门店系统，助手要说"没连通"
 * 而不是继续报门店名。
 */

import { resolveContactSecret } from "./contact";
import { defineExternalTool, ToolError, type ExternalTool } from "./external";

// ── 数据形状（与 mocks/dealer 的响应对齐）──────────────────

export type StoreType = "experience" | "service";

export interface DealerStore {
  storeId: string;
  name: string;
  type: StoreType;
  city: string;
  district: string;
  address: string;
  /** 传了 `near` 才有。 */
  distanceKm?: number;
}

export interface DealerSlot {
  slotId: string;
  startAt: string;
  endAt: string;
  /** 该时段还剩几台试驾车。0 表示订满——**仍会返回**，"没有"与"满了"是两件事。 */
  remaining: number;
}

export interface DealerTrim {
  trim: string;
  /** 人民币指导价。**缺省表示本系统没有人民币报价**（如 Cybertruck），不是 0。 */
  priceCny?: number;
  rangeKm: number;
  seats: number;
}

export interface DealerBooking {
  orderId: string;
  storeId: string;
  storeName: string;
  model: string;
  startAt: string;
  status: string;
  /** 实际外发给门店的**字段名**清单（不含值）。 */
  disclosed: string[];
  /** 幂等命中时为 true——同一次确认重发没有下第二单。 */
  duplicate?: boolean;
}

// ── 后端（由装配层注入）────────────────────────────────────────

export interface DealerBackend {
  stores(a: {
    model: string;
    city?: string;
    district?: string;
    near?: { lat: number; lon: number };
    type?: StoreType;
  }): Promise<{ stores: DealerStore[]; matched: number }>;
  slots(a: { storeId: string; model: string; from?: string; to?: string }): Promise<{
    slots: DealerSlot[];
    reason?: string;
    storeName?: string;
  }>;
  pricing(a: { model: string; trim?: string }): Promise<{ model: string; currency: string; trims: DealerTrim[] }>;
  book(a: {
    slotId: string;
    model: string;
    trim?: string;
    contact: { name: string; phone: string; note?: string };
    idempotencyKey?: string;
  }): Promise<DealerBooking>;
}

let backend: DealerBackend | undefined;

/**
 * 装配层注入。传 undefined 表示未接入。
 *
 * **注入口留了不等于接上了**：`car_catalog` 的同款注入口留了却从没被替换过，
 * 任何调用都抛 `unconfigured`，因为它零调用点所以很久没被发现（M15-01 才修）。
 * 所以本 Sprint 要求 `selfcheck` 有一项守 dealer 连通性。
 */
export function setDealerBackend(b: DealerBackend | undefined): void {
  backend = b;
}

export function getDealerBackend(): DealerBackend | undefined {
  return backend;
}

function need(tool: string): DealerBackend {
  if (!backend) {
    throw new ToolError(
      tool,
      "unconfigured",
      "门店系统未接入（MOCK_DEALER_URL 未配置或服务未启动）——这次查不到门店与时段，请如实告知车主，不要报出任何门店名",
      false,
    );
  }
  return backend;
}

/** HTTP 后端。`baseUrl` 由装配层给，`enterprise/backend/shared/tools` 不读环境变量（注册表文件头第 3 条）。 */
export function createHttpDealerBackend(baseUrl: string): DealerBackend {
  const call = async (tool: string, path: string, init?: RequestInit): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, init);
    } catch (err) {
      /*
       * 连不上是**可重试**的（服务在重启）。但演示时的实际情况是它被当场 kill 掉，
       * 重试完仍失败——所以这条话术必须和 `unconfigured` 那条一样，
       * 明确拦住模型"那我凭印象说个门店名吧"。
       *
       * 这是真跑发现的：`unconfigured`（没配 URL）写了这句，而 kill 掉服务走的是
       * 这条 upstream 分支，原本只有一句 "fetch failed"。而 Demo 判定第 7 条
       * 演的正是后者。
       */
      throw new ToolError(
        tool,
        "upstream",
        `门店系统连不上（${err instanceof Error ? err.message : String(err)}）——` +
          "这次查不到门店与时段，请如实告知车主门店系统没连通，**不要报出任何门店名或时间**",
        true,
      );
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return body;

    // 4xx 一律**不可重试**：重试一次编造的 slotId 还是编造的。
    // 消息要让模型看懂该回去重查，而不是换个措辞再试一遍。
    const detail = String(body.error ?? res.status);
    const hint =
      detail === "slot_not_found"
        ? "这个时段不存在（可能是编的，或者已经过期）——请先调 dealer_slots 拿到真实的 slotId 再下单"
        : detail === "slot_full"
          ? "这个时段刚被订满了——请重新查一次可预约时段"
          : detail;
    throw new ToolError(tool, res.status >= 500 ? "upstream" : "invalid", hint, res.status >= 500);
  };

  return {
    async stores(a) {
      const q = new URLSearchParams({ model: a.model });
      if (a.city) q.set("city", a.city);
      if (a.district) q.set("district", a.district);
      if (a.type) q.set("type", a.type);
      if (a.near) q.set("near", `${a.near.lat},${a.near.lon}`);
      return (await call("dealer_stores", `/stores?${q}`)) as { stores: DealerStore[]; matched: number };
    },
    async slots(a) {
      const q = new URLSearchParams({ model: a.model });
      if (a.from) q.set("from", a.from);
      if (a.to) q.set("to", a.to);
      return (await call(
        "dealer_slots",
        `/stores/${encodeURIComponent(a.storeId)}/slots?${q}`,
      )) as { slots: DealerSlot[]; reason?: string; storeName?: string };
    },
    async pricing(a) {
      const q = new URLSearchParams({ model: a.model });
      if (a.trim) q.set("trim", a.trim);
      return (await call("dealer_pricing", `/pricing?${q}`)) as {
        model: string;
        currency: string;
        trims: DealerTrim[];
      };
    },
    async book(a) {
      return (await call("test_drive_book", "/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(a),
      })) as DealerBooking;
    },
  };
}

// ── 四个工具 ──────────────────────────────────────────────────

export interface DealerStoresArgs {
  model: string;
  city?: string;
  district?: string;
  near?: { lat: number; lon: number };
  type?: StoreType;
}

export const dealerStoresTool: ExternalTool<DealerStoresArgs, { stores: DealerStore[]; matched: number }> =
  defineExternalTool({
    name: "dealer_stores",
    provider: "mock-dealer",
    // 只读检索 → §8.4 第三行自动放行，根本不调权限门。
    sensitive: false,
    timeoutMs: 5_000,
    retries: 2,
    real: async (args) => {
      if (!args.model?.trim()) throw new ToolError("dealer_stores", "invalid", "必须指定车型", false);
      return need("dealer_stores").stores(args);
    },
  });

export interface DealerSlotsArgs {
  storeId: string;
  model: string;
  from?: string;
  to?: string;
}

export const dealerSlotsTool: ExternalTool<
  DealerSlotsArgs,
  { slots: DealerSlot[]; reason?: string; storeName?: string }
> = defineExternalTool({
  name: "dealer_slots",
  provider: "mock-dealer",
  sensitive: false,
  timeoutMs: 5_000,
  retries: 2,
  real: async (args) => {
    if (!args.storeId?.trim()) {
      throw new ToolError("dealer_slots", "invalid", "必须指定门店 id（先用 dealer_stores 查）", false);
    }
    if (!args.model?.trim()) throw new ToolError("dealer_slots", "invalid", "必须指定车型", false);
    return need("dealer_slots").slots(args);
  },
});

export interface DealerPricingArgs {
  model: string;
  trim?: string;
}

export const dealerPricingTool: ExternalTool<
  DealerPricingArgs,
  { model: string; currency: string; trims: DealerTrim[] }
> = defineExternalTool({
  name: "dealer_pricing",
  provider: "mock-dealer",
  sensitive: false,
  timeoutMs: 5_000,
  retries: 2,
  real: async (args) => {
    if (!args.model?.trim()) throw new ToolError("dealer_pricing", "invalid", "必须指定车型", false);
    return need("dealer_pricing").pricing(args);
  },
});

/**
 * 外发给门店的联系信息。
 *
 * 字段是**白名单**：收窄到这三项，意味着 VIN、住址、行程、日历内容
 * 都没有出口能流到门店（与 `appointment` 同一条纪律）。
 */
export interface TestDriveContact {
  name: string;
  phone: string;
  /** 备注，**由用户自己填**，模型不代拟。 */
  note?: string;
}

export interface TestDriveBookArgs {
  /** 来自 `dealer_stores`。 */
  storeId: string;
  /** 来自 `dealer_slots`。**编一个会被 404 拒掉。** */
  slotId: string;
  model: string;
  trim?: string;
  /** 直接给的联系方式。**档案里有号时不该走这条**——见 `memberId`。 */
  contact?: TestDriveContact;
  /** 档案里的人员 id（来自 `contact_lookup`）。给了它就由本层去库里取真号。 */
  memberId?: string;
  /** 取真号要按用户维度过滤；由编排层注入。 */
  userId?: string;
  idempotencyKey?: string;
}

const PHONE_RE = /^1[3-9]\d{9}$/;

export const testDriveBookTool: ExternalTool<TestDriveBookArgs, DealerBooking> = defineExternalTool({
  name: "test_drive_book",
  provider: "mock-dealer",
  // 有后果但合法 → §8.4 需确认档。裁决在权限门，工具自己不判断。
  sensitive: true,
  timeoutMs: 10_000,
  // 有副作用，绝不重试：重试一次预约就是下两次单。
  retries: 0,
  real: async (args) => {
    if (!args.storeId?.trim() || !args.slotId?.trim()) {
      throw new ToolError(
        "test_drive_book",
        "invalid",
        "缺少门店 id 或时段 id——两个都必须来自 dealer_stores / dealer_slots，不能自己填",
        false,
      );
    }
    /**
     * 联系方式两条来源，**优先档案**（M19-06）。
     *
     * 走 `memberId` 时真号从库里取，全程不经过模型——`contact_lookup` 之所以
     * 只给后四位，靠的就是这条路存在。取不到就硬失败**而不是回落到 `contact`**：
     * 回落会让"档案里那个号已经被删了"变成"用了模型手里那个不知哪来的号"。
     */
    const contact = args.memberId
      ? await (async () => {
          const found = args.userId
            ? await resolveContactSecret(args.userId, args.memberId!)
            : undefined;
          if (!found) {
            throw new ToolError(
              "test_drive_book",
              "invalid",
              `档案里 memberId=${args.memberId} 没有登记手机号。请先用 contact_update 登记，**不要自己填一个**`,
              false,
            );
          }
          return { name: found.name, phone: found.phone, note: args.contact?.note };
        })()
      : args.contact;

    if (!contact?.name?.trim()) {
      throw new ToolError("test_drive_book", "invalid", "缺少称呼——门店需要知道找谁", false);
    }
    if (!PHONE_RE.test((contact.phone ?? "").replace(/\D/g, ""))) {
      // 号码错了门店打不通，用户以为约上了。硬失败，不"尽力提交"。
      throw new ToolError("test_drive_book", "invalid", "手机号格式不正确，门店将无法回拨", false);
    }
    return need("test_drive_book").book({
      slotId: args.slotId,
      model: args.model,
      trim: args.trim,
      contact,
      idempotencyKey: args.idempotencyKey,
    });
  },
});

/*
 * 「将提供给门店的信息」**不在这里另起一个导出**。
 *
 * 试驾与维修用的是 `appointment.ts` 的同一个 `describeDisclosure`——
 * 同一份掩码规则、同一处修改点。这里曾经 re-export 过一个
 * `describeTestDriveDisclosure` 别名，但没有任何调用方用它
 * （`DISCLOSURE_BUILDERS` 直接用原名），留着只会让人以为掩码有两套。
 */
