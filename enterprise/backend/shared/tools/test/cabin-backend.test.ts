/**
 * cabin backend 的绑定与重建语义（施工单 M24-02）。
 *
 * 盯三条：**四分类错误可区分**（上游转述的依据）、**悬空自动重建只重试一次**、
 * **绑定幂等**。stub 服务器模拟 mock-cabin 的契约，包括 404 vehicle_not_found 形状。
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createServer, type Server } from "node:http";

import {
  CabinUnboundError,
  createCabinClient,
  createHttpCabinBackend,
  requireCabinClient,
  setCabinClient,
  ToolError,
  type CabinBindingStore,
} from "../src/index";

// ── stub mock-cabin：可编程的最小契约 ─────────────────────────
let server: Server;
let base = "";
let vehicles = new Map<string, string>(); // id -> model
let seq = 0;
let requestLog: string[] = [];
let lastBeat: Record<string, unknown> = {};

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      requestLog.push(`${req.method} ${req.url}`);
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const url = req.url ?? "";
      if (url === "/health") return send(200, { ok: true, synthesizesAnyModel: true });
      if (req.method === "POST" && url === "/vehicles") {
        const { model } = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        seq += 1;
        const id = `VEH-${String(seq).padStart(6, "0")}`;
        vehicles.set(id, model);
        return send(201, { vehicleId: id, model, capabilities: {}, state: {}, updatedAt: "t" });
      }
      const m = /^\/vehicles\/([^/]+)\/(state|apply|changes)$/.exec(url);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (!vehicles.has(id)) return send(404, { error: "vehicle_not_found", vehicleId: id });
        if (m[2] === "state") return send(200, { vehicleId: id, model: vehicles.get(id), capabilities: {}, state: {}, updatedAt: "t" });
        if (m[2] === "changes") return send(200, { vehicleId: id, changes: [] });
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        return send(200, { vehicleId: id, model: vehicles.get(id), requestId: body.requestId, results: [], state: {} });
      }
      // ── 端上出声位（M63-02）：与上面同一条"车没了就 404"的契约 ──
      const sink = /^\/vehicles\/([^/]+)\/media\/sink$/.exec(url);
      if (sink && req.method === "POST") {
        const id = decodeURIComponent(sink[1]);
        if (!vehicles.has(id)) return send(404, { error: "vehicle_not_found", vehicleId: id });
        const beat = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        lastBeat = beat;
        return send(200, { zone: "cabin", status: "playing", audible: true, sink: { kind: "client", sinkId: beat.sinkId, note: "" } });
      }
      // ── 曲目字节：三种上游形态，各对应一种转述 ──
      const track = /^\/media\/tracks\/(.+)$/.exec(url);
      if (track) {
        const id = decodeURIComponent(track[1]);
        if (id === "t-missing") return send(404, { error: "track_not_found", trackId: id });
        if (id === "t-huge") return send(413, { error: "track_too_large", trackId: id, bytes: 99, limit: 10 });
        const bytes = Buffer.alloc(2048, 3);
        const r = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
        if (r) {
          const start = Number(r[1]);
          const end = r[2] === "" ? bytes.length - 1 : Number(r[2]);
          res.writeHead(206, {
            "content-type": "audio/mpeg",
            "content-length": String(end - start + 1),
            "content-range": `bytes ${start}-${end}/${bytes.length}`,
            "accept-ranges": "bytes",
          });
          return void res.end(bytes.subarray(start, end + 1));
        }
        res.writeHead(200, {
          "content-type": "audio/mpeg",
          "content-length": String(bytes.length),
          "accept-ranges": "bytes",
        });
        return void res.end(bytes);
      }
      send(404, { error: "not_found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(() => server.close());
beforeEach(() => {
  vehicles = new Map();
  seq = 0;
  requestLog = [];
});

/** 内存绑定存储：断言 save 被正确调用的探针。 */
function memoryStore(initial: Record<string, { model: string; cabinVehicleId?: string }>): CabinBindingStore & {
  data: Map<string, { model: string; cabinVehicleId?: string }>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async load(vin) {
      return data.get(vin) ?? null;
    },
    async save(vin, cabinVehicleId) {
      const row = data.get(vin);
      if (!row) throw new Error("no profile");
      data.set(vin, { ...row, cabinVehicleId });
    },
  };
}

describe("未接入与档案缺失", () => {
  it("未注入 client → unconfigured，话术拦住\"假装调好\"", () => {
    setCabinClient(undefined);
    assert.throws(
      () => requireCabinClient(),
      (e: unknown) => e instanceof ToolError && e.category === "unconfigured" && /车机未接入/.test(e.message),
    );
  });

  it("没有档案 → invalid（没档案连车型都不知道，无从建号）", async () => {
    const client = createCabinClient(createHttpCabinBackend(base), memoryStore({}));
    await assert.rejects(
      () => client.status("LSJNOPE0000000001"),
      (e: unknown) => e instanceof ToolError && e.category === "invalid" && /档案不存在/.test(e.message),
    );
  });

  it("连不上 → upstream 且话术是\"车机没连上\"", async () => {
    const client = createCabinClient(
      createHttpCabinBackend("http://127.0.0.1:1", 300),
      memoryStore({ vin1: { model: "Model Y", cabinVehicleId: "VEH-000001" } }),
    );
    await assert.rejects(
      () => client.status("vin1"),
      (e: unknown) => e instanceof ToolError && e.category === "upstream" && /车机没连上/.test(e.message),
    );
  });
});

describe("未绑定 ≠ 悬空", () => {
  it("从未绑定的车做状态/设置 → CabinUnboundError 引导绑定，**不静默建号**", async () => {
    const store = memoryStore({ vin1: { model: "Model Y" } });
    const client = createCabinClient(createHttpCabinBackend(base), store);
    await assert.rejects(
      () => client.status("vin1"),
      (e: unknown) => e instanceof CabinUnboundError && /档案页完成一次绑定/.test((e as Error).message),
    );
    assert.equal(vehicles.size, 0, "没有替车主建号");
    assert.equal(store.data.get("vin1")?.cabinVehicleId, undefined);
  });
});

describe("绑定：首绑、幂等、回写", () => {
  it("未绑定 → 建号并回写 store", async () => {
    const store = memoryStore({ vin1: { model: "Model Y" } });
    const client = createCabinClient(createHttpCabinBackend(base), store);
    const r = await client.bind("vin1");
    assert.equal(r.vehicleId, "VEH-000001");
    assert.equal(r.rebuilt, false);
    assert.equal(store.data.get("vin1")?.cabinVehicleId, "VEH-000001");
  });

  it("已绑定且车机侧存在 → 幂等：不建第二辆", async () => {
    const store = memoryStore({ vin1: { model: "Model Y" } });
    const client = createCabinClient(createHttpCabinBackend(base), store);
    await client.bind("vin1");
    const again = await client.bind("vin1");
    assert.equal(again.vehicleId, "VEH-000001");
    assert.equal(vehicles.size, 1, "mock 侧只有一辆车");
  });
});

describe("悬空自动重建（F-49-09）", () => {
  it("旧 id 404 → 按档案车型重建、回写、重试原操作一次，rebuilt=true", async () => {
    const store = memoryStore({ vin1: { model: "Model Y", cabinVehicleId: "VEH-STALE" } });
    const client = createCabinClient(createHttpCabinBackend(base), store);
    const r = await client.status("vin1");
    assert.equal(r.rebuilt, true);
    assert.equal(r.vehicleId, "VEH-000001");
    assert.equal(store.data.get("vin1")?.cabinVehicleId, "VEH-000001", "绑定已更新");
    assert.ok(requestLog.some((l) => l.includes("VEH-STALE")), "先试过旧 id");
  });

  it("apply 的重建透传 requestId，且只重试一次", async () => {
    const store = memoryStore({ vin1: { model: "Model 3", cabinVehicleId: "VEH-GONE" } });
    const client = createCabinClient(createHttpCabinBackend(base), store);
    const r = await client.apply("vin1", { requestId: "req-9", ops: [{ domain: "climate", set: { tempC: 23 } }] });
    assert.equal(r.requestId, "req-9");
    assert.equal(r.rebuilt, true);
    const applies = requestLog.filter((l) => l.includes("/apply"));
    assert.equal(applies.length, 2, "旧 id 一次 + 重建后一次，没有循环");
  });
});

// ── 端上播放通路（M63-02）─────────────────────────────────────

describe("mediaSink：心跳走绑定层，与 mediaPlayer 同待遇", () => {
  it("请求体原样转发，响应体就是播放器状态", async () => {
    const store = memoryStore({ vin1: { model: "Model Y", cabinVehicleId: "VEH-000001" } });
    const client = createCabinClient(createHttpCabinBackend(base), store);
    // 先建一辆真的，否则走的是重建路径。
    const bound = await client.bind("vin1");
    const v = await client.mediaSink("vin1", { sinkId: "c1", claim: true, status: "playing", positionSec: 7 });
    assert.equal(v.sink?.sinkId, "c1");
    assert.deepEqual(lastBeat, { sinkId: "c1", claim: true, status: "playing", positionSec: 7 });
    assert.ok(bound.vehicleId);
  });

  it("车机侧车辆悬空时自动重建，rebuilt 一路带上来——端据此重新认领", async () => {
    const store = memoryStore({ vin1: { model: "Model Y", cabinVehicleId: "VEH-GONE-2" } });
    const client = createCabinClient(createHttpCabinBackend(base), store);
    const v = await client.mediaSink("vin1", { sinkId: "c1", claim: true });
    assert.equal(v.rebuilt, true, "重建过就意味着队列没了，端不该对着一个不存在的队列继续心跳");
  });
});

describe("mediaTrack：字节走并列通道，不经 call()", () => {
  it("整曲：状态码与四个头原样带上来，body 是流不是 Buffer", async () => {
    const client = createCabinClient(createHttpCabinBackend(base), memoryStore({}));
    const r = await client.mediaTrack("t-1");
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "audio/mpeg");
    assert.equal(r.headers["content-length"], "2048");
    assert.equal(r.headers["accept-ranges"], "bytes");
    assert.ok(r.body, "要给流——整曲进内存会让 Range 变成一句空话");
    const chunks: Uint8Array[] = [];
    for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) chunks.push(c);
    assert.equal(Buffer.concat(chunks).length, 2048);
  });

  it("Range 透传：206 + content-range", async () => {
    const client = createCabinClient(createHttpCabinBackend(base), memoryStore({}));
    const r = await client.mediaTrack("t-1", "bytes=0-511");
    assert.equal(r.status, 206);
    assert.equal(r.headers["content-range"], "bytes 0-511/2048");
    assert.equal(r.headers["content-length"], "512");
  });

  it("404 折成「曲库里没有这首」而不是一个数字", async () => {
    const client = createCabinClient(createHttpCabinBackend(base), memoryStore({}));
    await assert.rejects(
      () => client.mediaTrack("t-missing"),
      (e: unknown) => e instanceof ToolError && e.category === "invalid" && /没有这首/.test(e.message),
    );
  });

  it("413 说清超了多少，别只说「放不了」", async () => {
    const client = createCabinClient(createHttpCabinBackend(base), memoryStore({}));
    await assert.rejects(
      () => client.mediaTrack("t-huge"),
      (e: unknown) => e instanceof ToolError && e.category === "invalid" && /99 > 10/.test(e.message),
    );
  });
});
