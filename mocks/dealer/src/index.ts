/**
 * mock-dealer —— 假装是特斯拉的第三方（施工单 M19-01，设计定稿 D1~D3）。
 *
 * # 它为什么是一个独立进程
 *
 * 唯一的理由，也是它必须成立的验收点：**能被当场 kill 掉**。
 * 罗启明问"这是真调用还是写死的"时，关掉它，助手要如实说"门店系统没连通"，
 * 而不是继续报出门店名。内存 mock 做不到这个演示。
 *
 * 由此推出三条硬约束：不 import 本仓任何业务包（`@carlife/*` 一个都不引）、
 * 不连 PG/Redis/MinIO、预约落进程内存重启即清。它是别人家的系统。
 *
 * # 防编靠 id
 *
 * `POST /bookings` **只收 `slotId`**。模型编一个会被 404 拒掉。
 * 上游 `test_drive_book` 的 schema 里因此没有 `storeName`、没有自由时间字符串——
 * 在此之前，`appointment` 收的是三个自由字符串，"深圳南山特斯拉中心"就是那么来的。
 *
 * # 用 node 内置 http 而不是 express
 *
 * 依赖越少越像"别人家的服务"，也越容易被单独起停。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { generateSlots, parseSlotId, type Slot } from "./slots";
import { findModel, findStore, searchStores, STORES, MODELS, type StoreType } from "./store";

const PORT = Number(process.env.MOCK_DEALER_PORT ?? 8792);

/** 所有响应都带它——上游要能如实标注数据来源（F-39-12 同源）。 */
const PROVENANCE = "simulated" as const;

interface Booking {
  orderId: string;
  slotId: string;
  storeId: string;
  storeName: string;
  model: string;
  trim?: string;
  startAt: string;
  status: "confirmed";
  /** 只留字段名，不留值——与 audit_logs 同一条纪律。 */
  disclosed: string[];
}

/** 预约表。进程内存，重启即清：它是模拟系统，不该占我们的 PG。 */
const bookings = new Map<string, Booking>();
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

/** 该时段还剩几台（生成值 − 已占用）。 */
function remainingOf(slot: Slot): number {
  return Math.max(0, slot.remaining - (taken.get(slot.slotId) ?? 0));
}

function handleStores(url: URL, res: ServerResponse): void {
  const model = url.searchParams.get("model");
  if (!model) return json(res, 400, { error: "model_required" });

  const type = (url.searchParams.get("type") ?? "experience") as StoreType;
  const nearRaw = url.searchParams.get("near");
  let near: { lat: number; lon: number } | undefined;
  if (nearRaw) {
    const [lat, lon] = nearRaw.split(",").map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) near = { lat, lon };
  }

  const stores = searchStores({
    model,
    city: url.searchParams.get("city") ?? undefined,
    district: url.searchParams.get("district") ?? undefined,
    type,
    near,
  });
  // 零命中是 200 + 空数组：「这个区没有店」是事实，不是错误。
  // 返回 404 的话上游分不清"没有店"和"接口坏了"。
  json(res, 200, { stores, matched: stores.length });
}

function handleSlots(url: URL, storeId: string, res: ServerResponse): void {
  const store = findStore(storeId);
  if (!store) return json(res, 404, { error: "store_not_found", storeId });

  const model = url.searchParams.get("model");
  if (!model) return json(res, 400, { error: "model_required" });

  const def = findModel(model);
  if (!def || !store.models.includes(def.model)) {
    // 这家店不提供这款车 —— 空数组 + 说明。空数组配 reason，
    // 上游才说得出"这家店没有 Model Y 的试驾车"而不是"没查到时段"。
    return json(res, 200, {
      slots: [],
      reason: `${store.name}不提供${model}的试驾`,
      storeId,
    });
  }

  const slots = generateSlots({
    storeId,
    model: def.model,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    now: new Date(),
  }).map((s) => ({ ...s, remaining: remainingOf(s) }));

  json(res, 200, { slots, storeId, storeName: store.name, model: def.model });
}

function handlePricing(url: URL, res: ServerResponse): void {
  const model = url.searchParams.get("model");
  if (!model) return json(res, 400, { error: "model_required" });

  const def = findModel(model);
  if (!def) return json(res, 404, { error: "model_not_found", model });

  const trim = url.searchParams.get("trim");
  /*
   * **精确匹配优先。**
   *
   * 实测踩到：`trim=后轮驱动版` 用包含匹配会同时命中「后轮驱动版」与
   * 「长续航后轮驱动版」（后者包含前者）。而这个价马上要成为 `cost_calc` 的车价源——
   * 取错一个就是两万四的差，且分项、假设、出处一应俱全，只有车价是错的
   * （M15-02 已经用另一种方式踩过一次：FSD 选装包被当成车价）。
   *
   * 所以：有精确命中就只给它；没有才退回模糊匹配（用户说"长续航"这种半截词）。
   */
  const trims = (() => {
    if (!trim) return def.trims;
    const exact = def.trims.filter((t) => t.trim === trim);
    if (exact.length > 0) return exact;
    return def.trims.filter((t) => t.trim.includes(trim) || trim.includes(t.trim));
  })();
  if (trim && trims.length === 0) return json(res, 404, { error: "trim_not_found", model: def.model, trim });

  json(res, 200, { model: def.model, currency: "CNY", trims });
}

async function handleBooking(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJson(req)) as {
    slotId?: string;
    model?: string;
    trim?: string;
    contact?: { name?: string; phone?: string; note?: string };
    idempotencyKey?: string;
  };

  if (body.idempotencyKey) {
    const prior = byIdemKey.get(body.idempotencyKey);
    // 同一次确认网络重发不下两单——预约是有副作用的动作，重复提交要打电话取消。
    if (prior) return json(res, 200, { ...bookings.get(prior)!, duplicate: true });
  }

  if (!body.slotId) return json(res, 400, { error: "slot_id_required" });
  if (!body.contact?.name || !body.contact?.phone) {
    return json(res, 400, { error: "contact_required" });
  }

  const parsed = parseSlotId(body.slotId);
  const store = parsed ? findStore(parsed.storeId) : undefined;
  // **编一个 slotId 就死在这里。** 整个防编设计建立在这一行上：
  // 宽容地"尽力下单"会让模型编的时段变成一次真实预约。
  if (!parsed || !store) return json(res, 404, { error: "slot_not_found", slotId: body.slotId });

  const model = body.model ? findModel(body.model)?.model : undefined;
  if (!model || !store.models.includes(model)) {
    return json(res, 400, { error: "model_not_available_at_store", storeId: store.storeId, model: body.model });
  }

  const slot = generateSlots({ storeId: store.storeId, model, now: new Date() }).find(
    (s) => s.slotId === body.slotId,
  );
  // 格式对但不在可预约范围内（比如已经过期的日期）——同样是"不存在"。
  if (!slot) return json(res, 404, { error: "slot_not_found", slotId: body.slotId });
  if (remainingOf(slot) <= 0) return json(res, 409, { error: "slot_full", slotId: body.slotId });

  seq += 1;
  const record: Booking = {
    orderId: `TD-${String(seq).padStart(6, "0")}`,
    slotId: slot.slotId,
    storeId: store.storeId,
    storeName: store.name,
    model,
    trim: body.trim,
    startAt: slot.startAt,
    status: "confirmed",
    // 留字段名不留值：审计里不该再存一份手机号。
    disclosed: ["称呼", "手机号", ...(body.contact.note ? ["备注"] : [])],
  };
  bookings.set(record.orderId, record);
  taken.set(slot.slotId, (taken.get(slot.slotId) ?? 0) + 1);
  if (body.idempotencyKey) byIdemKey.set(body.idempotencyKey, record.orderId);

  json(res, 200, record);
}

export function createDealerServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, {
          ok: true,
          stores: STORES.length,
          models: MODELS.length,
          // 种子之外按 (城市, 区) 现合成（M19-07）。写进 health 是因为
          // "只有十家店"和"任意城市都有店"是两种完全不同的系统，
          // 而从一次 /stores 调用的结果上分辨不出来。
          synthesizesAnyCity: true,
        });
      }
      if (req.method === "GET" && url.pathname === "/stores") return handleStores(url, res);

      const slotsMatch = /^\/stores\/([^/]+)\/slots$/.exec(url.pathname);
      if (req.method === "GET" && slotsMatch) {
        return handleSlots(url, decodeURIComponent(slotsMatch[1]), res);
      }
      if (req.method === "GET" && url.pathname === "/pricing") return handlePricing(url, res);
      if (req.method === "POST" && url.pathname === "/bookings") return void (await handleBooking(req, res));

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
