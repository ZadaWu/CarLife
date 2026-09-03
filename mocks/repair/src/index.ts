/**
 * mock-repair —— 假装是 4S 店的维修系统（施工单 M41-01）。
 *
 * 与 mock-dealer 同一套存在理由与硬约束（那边文件头写全了，此处只列结论）：
 * **能被当场 kill 掉**、不 import 本仓任何业务包、不连 PG/Redis、
 * 预约落进程内存重启即清、防编靠 id（编一个 slotId/orderId 就 404）。
 *
 * 与 mock-dealer 的分工：那边是"卖车的店"（试驾/报价），这边是"修车的店"
 * （历史维修记录/预约维修/维修中报价单）。维修历史按 VIN 提供——它是
 * "这辆车"的数据，与本地 PG 的用车数据同一把关联键（总览决策 4），
 * 但**绝不写进本地表**：假系统的数据进真表会污染保养推算。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  STATIONS,
  HISTORY,
  SEED_ORDERS,
  SEED_QUOTES,
  findStation,
  searchStations,
  historyOf,
  generateRepairSlots,
  parseRepairSlotId,
  type SeedOrder,
} from "./store";

const PORT = Number(process.env.MOCK_REPAIR_PORT ?? 8797);

/** 所有响应都带它——上游要能如实标注数据来源（与 mock-dealer 同一条纪律）。 */
const PROVENANCE = "simulated" as const;

interface RepairBooking {
  orderId: string;
  slotId: string;
  stationId: string;
  stationName: string;
  vin: string;
  items: string[];
  startAt: string;
  status: "confirmed";
  /** 只留字段名，不留值——审计里不该再存一份手机号。 */
  disclosed: string[];
}

/** 预约表。进程内存，重启即清。 */
const bookings = new Map<string, RepairBooking>();
/** idempotencyKey → orderId。同一次确认重发不下两单。 */
const byIdemKey = new Map<string, string>();
/** slotId → 已占用数。 */
const taken = new Map<string, number>();
let seq = 0;

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify({ ...(body as object), provenance: PROVENANCE });
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function handleHistory(vin: string, res: ServerResponse): void {
  const records = historyOf(vin);
  // 未知 VIN 是 200 + 空数组 + known:false：「这辆车没在本店修过」是事实不是错误，
  // 但上游要能区分"没修过"和"系统不认识这辆车"两种表述。
  json(res, 200, { vin, records, known: records.length > 0 });
}

function handleStations(url: URL, res: ServerResponse): void {
  const stations = searchStations(url.searchParams.get("city") ?? undefined);
  json(res, 200, { stations, matched: stations.length });
}

function handleSlots(url: URL, stationId: string, res: ServerResponse): void {
  const station = findStation(stationId);
  if (!station) return json(res, 404, { error: "station_not_found", stationId });
  const slots = generateRepairSlots({
    stationId,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  }).map((s) => ({ ...s, remaining: Math.max(0, s.capacity - (taken.get(s.slotId) ?? 0)) }));
  json(res, 200, { slots, stationId, stationName: station.name });
}

async function handleBooking(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJson(req)) as {
    vin?: string;
    slotId?: string;
    items?: string[];
    contact?: { name?: string; phone?: string };
    idempotencyKey?: string;
  };

  if (body.idempotencyKey) {
    const prior = byIdemKey.get(body.idempotencyKey);
    if (prior) return json(res, 200, { ...bookings.get(prior)!, duplicate: true });
  }

  if (!body.vin) return json(res, 400, { error: "vin_required" });
  if (!body.slotId) return json(res, 400, { error: "slot_id_required" });
  if (!body.contact?.name || !body.contact?.phone) return json(res, 400, { error: "contact_required" });

  const parsed = parseRepairSlotId(body.slotId);
  const station = parsed ? findStation(parsed.stationId) : undefined;
  // 编一个 slotId 就死在这里（防编设计的地基，mock-dealer 同款）。
  if (!parsed || !station) return json(res, 404, { error: "slot_not_found", slotId: body.slotId });

  const slot = generateRepairSlots({ stationId: station.stationId }).find((s) => s.slotId === body.slotId);
  if (!slot) return json(res, 404, { error: "slot_not_found", slotId: body.slotId });
  if ((taken.get(slot.slotId) ?? 0) >= slot.capacity) return json(res, 409, { error: "slot_full", slotId: body.slotId });

  seq += 1;
  const record: RepairBooking = {
    orderId: `RB-${String(seq).padStart(6, "0")}`,
    slotId: slot.slotId,
    stationId: station.stationId,
    stationName: station.name,
    vin: body.vin,
    items: Array.isArray(body.items) && body.items.length > 0 ? body.items.map(String) : ["常规保养"],
    startAt: slot.startAt,
    status: "confirmed",
    disclosed: ["称呼", "手机号"],
  };
  bookings.set(record.orderId, record);
  taken.set(slot.slotId, (taken.get(slot.slotId) ?? 0) + 1);
  if (body.idempotencyKey) byIdemKey.set(body.idempotencyKey, record.orderId);

  json(res, 200, record);
}

function handleOrder(orderId: string, res: ServerResponse): void {
  const seeded: SeedOrder | undefined = SEED_ORDERS.find((o) => o.orderId === orderId);
  if (seeded) return json(res, 200, seeded);
  const booked = bookings.get(orderId);
  if (booked) return json(res, 200, booked);
  json(res, 404, { error: "order_not_found", orderId });
}

function handleQuotes(url: URL, vin: string, res: ServerResponse): void {
  const status = url.searchParams.get("status") ?? undefined;
  const quotes = SEED_QUOTES.filter((q) => q.vin === vin && (!status || q.status === status));
  // 空数组是事实（这辆车没有进行中的报价单），不是错误。
  json(res, 200, { vin, quotes, matched: quotes.length });
}

export function createRepairServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

      if (req.method === "GET" && url.pathname === "/health") {
        // 数字要打出来：种子没加载成功时，"起来了"和"起来了但是空的"看起来一样。
        return json(res, 200, {
          ok: true,
          stations: STATIONS.length,
          historyRecords: HISTORY.length,
          seededQuotes: SEED_QUOTES.length,
        });
      }
      if (req.method === "GET" && url.pathname === "/stations") return handleStations(url, res);

      const historyMatch = /^\/vehicles\/([^/]+)\/repairs$/.exec(url.pathname);
      if (req.method === "GET" && historyMatch) return handleHistory(decodeURIComponent(historyMatch[1]), res);

      const quotesMatch = /^\/vehicles\/([^/]+)\/quotes$/.exec(url.pathname);
      if (req.method === "GET" && quotesMatch) return handleQuotes(url, decodeURIComponent(quotesMatch[1]), res);

      const slotsMatch = /^\/stations\/([^/]+)\/slots$/.exec(url.pathname);
      if (req.method === "GET" && slotsMatch) return handleSlots(url, decodeURIComponent(slotsMatch[1]), res);

      const orderMatch = /^\/repair-orders\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && orderMatch) return handleOrder(decodeURIComponent(orderMatch[1]), res);

      if (req.method === "POST" && url.pathname === "/repair-bookings") return void (await handleBooking(req, res));

      // 未知路径也回 JSON：上游拿到 HTML 会在 JSON.parse 处炸，错得离现场很远。
      json(res, 404, { error: "not_found", path: url.pathname });
    } catch (err) {
      json(res, 500, { error: "internal", detail: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** 仅测试用：清掉预约状态，让用例之间互不污染。 */
export function __resetBookings(): void {
  bookings.clear();
  byIdemKey.clear();
  taken.clear();
  seq = 0;
}
