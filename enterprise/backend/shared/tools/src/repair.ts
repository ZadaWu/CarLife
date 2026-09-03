/**
 * 4S 维修系统的后端与工具（施工单 M41-03，服务本体见 mocks/repair）。
 *
 * # 与 dealer.ts 的分工
 *
 * dealer 是"卖车的店"（试驾/报价），这里是"修车的店"：历史维修记录、可约时段、
 * 预约下单、维修中报价单。四类里只有下单有副作用——它不在本文件成为独立工具，
 * 而是作为 `appointment` 的新后端（`createRepairAppointmentBackend`），
 * HITL 弹窗、披露、幂等的既有形态因此一个字不用改。
 *
 * # 错误纪律与 dealer 完全同款
 *
 * unconfigured / upstream 的话术都明确拦住模型"那我凭印象说个维修站吧"——
 * 关掉 mock-repair 是 Demo 的一部分，此时应答必须是"维修系统没连通"。
 */

import { ToolError, defineExternalTool, type ExternalTool } from "./external";

export interface RepairHistoryRecord {
  id: string;
  vin: string;
  at: string;
  odometerKm: number;
  items: string[];
  symptom?: string;
  resolution: string;
  stationId: string;
  stationName: string;
  totalFee: number;
}

export interface RepairStation {
  stationId: string;
  name: string;
  city: string;
  district: string;
  services: string[];
}

export interface RepairSlot {
  slotId: string;
  stationId: string;
  startAt: string;
  remaining: number;
}

export interface RepairQuoteItem {
  name: string;
  partsFee: number;
  laborFee: number;
}

export interface RepairQuote {
  quoteId: string;
  orderId: string;
  vin: string;
  status: string;
  items: RepairQuoteItem[];
  partsFee: number;
  laborFee: number;
  total: number;
  currency: string;
  updatedAt: string;
}

export interface RepairBackend {
  history(vin: string): Promise<{ vin: string; records: RepairHistoryRecord[]; known: boolean }>;
  stations(a: { city?: string }): Promise<{ stations: RepairStation[]; matched: number }>;
  slots(a: { stationId: string; from?: string; to?: string }): Promise<{
    slots: RepairSlot[];
    stationName?: string;
  }>;
  book(a: {
    vin: string;
    slotId: string;
    items?: string[];
    contact: { name: string; phone: string };
    idempotencyKey?: string;
  }): Promise<{ orderId: string; status: string; stationName: string; startAt: string }>;
  quotes(a: { vin: string; status?: string }): Promise<{ quotes: RepairQuote[]; matched: number }>;
}

let backend: RepairBackend | undefined;

/** 装配层注入（同 setDealerBackend 的纪律：注入口留了不等于接上了，启动要探活）。 */
export function setRepairBackend(b: RepairBackend | undefined): void {
  backend = b;
}

export function getRepairBackend(): RepairBackend | undefined {
  return backend;
}

function need(tool: string): RepairBackend {
  if (!backend) {
    throw new ToolError(
      tool,
      "unconfigured",
      "维修系统未接入（MOCK_REPAIR_URL 未配置或服务未启动）——这次查不到维修记录/时段/报价单，请如实告知车主，不要报出任何维修站名或金额",
      false,
    );
  }
  return backend;
}

/** HTTP 后端。`baseUrl` 由装配层给，`enterprise/backend/shared/tools` 不读环境变量。 */
export function createHttpRepairBackend(baseUrl: string): RepairBackend {
  const call = async (tool: string, path: string, init?: RequestInit): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, init);
    } catch (err) {
      // 关掉 mock-repair 是 Demo 的一部分——话术必须拦住"凭印象说个维修站"。
      throw new ToolError(
        tool,
        "upstream",
        `维修系统连不上（${err instanceof Error ? err.message : String(err)}）——` +
          "这次查不到维修记录/时段/报价单，请如实告知车主维修系统没连通，**不要报出任何维修站名、金额或时间**",
        true,
      );
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return body;
    const detail = String(body.error ?? res.status);
    const hint =
      detail === "slot_not_found"
        ? "这个进厂时段不存在（可能是编的或已过期）——维修站进厂窗口是每天 09/11/14/16 点，请先查可约时段再下单"
        : detail === "slot_full"
          ? "这个进厂时段刚被订满了——请换一个窗口"
          : detail;
    throw new ToolError(tool, res.status >= 500 ? "upstream" : "invalid", hint, res.status >= 500);
  };

  return {
    async history(vin) {
      return (await call("repair_history", `/vehicles/${encodeURIComponent(vin)}/repairs`)) as {
        vin: string;
        records: RepairHistoryRecord[];
        known: boolean;
      };
    },
    async stations(a) {
      const q = new URLSearchParams();
      if (a.city) q.set("city", a.city);
      return (await call("repair_stations", `/stations?${q}`)) as {
        stations: RepairStation[];
        matched: number;
      };
    },
    async slots(a) {
      const q = new URLSearchParams();
      if (a.from) q.set("from", a.from);
      if (a.to) q.set("to", a.to);
      return (await call("repair_slots", `/stations/${encodeURIComponent(a.stationId)}/slots?${q}`)) as {
        slots: RepairSlot[];
        stationName?: string;
      };
    },
    async book(a) {
      return (await call("appointment", "/repair-bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(a),
      })) as { orderId: string; status: string; stationName: string; startAt: string };
    },
    async quotes(a) {
      const q = new URLSearchParams();
      if (a.status) q.set("status", a.status);
      return (await call("repair_quote", `/vehicles/${encodeURIComponent(a.vin)}/quotes?${q}`)) as {
        quotes: RepairQuote[];
        matched: number;
      };
    },
  };
}

// ── 两个只读工具 ──────────────────────────────────────────────

export interface RepairHistoryArgs {
  vin: string;
}

export const repairHistoryTool: ExternalTool<
  RepairHistoryArgs,
  { vin: string; records: RepairHistoryRecord[]; known: boolean }
> = defineExternalTool({
  name: "repair_history",
  provider: "mock-repair",
  // 只读检索 → §8.4 第三行自动放行。
  sensitive: false,
  timeoutMs: 5_000,
  retries: 2,
  real: async (args) => {
    if (!args.vin?.trim()) throw new ToolError("repair_history", "invalid", "必须指定 VIN", false);
    return need("repair_history").history(args.vin.trim());
  },
});

export interface RepairStationsArgs {
  city?: string;
}

export const repairStationsTool: ExternalTool<RepairStationsArgs, { stations: RepairStation[]; matched: number }> =
  defineExternalTool({
    name: "repair_stations",
    provider: "mock-repair",
    sensitive: false,
    timeoutMs: 5_000,
    retries: 2,
    real: async (args) => need("repair_stations").stations({ city: args.city?.trim() || undefined }),
  });

export interface RepairSlotsArgs {
  stationId: string;
}

export const repairSlotsTool: ExternalTool<RepairSlotsArgs, { slots: RepairSlot[]; stationName?: string }> =
  defineExternalTool({
    name: "repair_slots",
    provider: "mock-repair",
    sensitive: false,
    timeoutMs: 5_000,
    retries: 2,
    real: async (args) => {
      if (!args.stationId?.trim()) {
        throw new ToolError("repair_slots", "invalid", "必须指定维修站 id（先用 repair_stations 查）", false);
      }
      return need("repair_slots").slots({ stationId: args.stationId.trim() });
    },
  });

export interface RepairQuoteArgs {
  vin: string;
}

export const repairQuoteTool: ExternalTool<RepairQuoteArgs, { quotes: RepairQuote[]; matched: number }> =
  defineExternalTool({
    name: "repair_quote",
    provider: "mock-repair",
    sensitive: false,
    timeoutMs: 5_000,
    retries: 2,
    real: async (args) => {
      if (!args.vin?.trim()) throw new ToolError("repair_quote", "invalid", "必须指定 VIN", false);
      // 只看进行中的：历史报价单没有"还要不要修"的决策价值，别把噪音喂给模型。
      return need("repair_quote").quotes({ vin: args.vin.trim(), status: "in_progress" });
    },
  });
