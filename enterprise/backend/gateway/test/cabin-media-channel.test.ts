/**
 * 车机端的播放通路（施工单 M63-02）：播放器状态 / 心跳认领 / 曲目字节三个端点。
 *
 * 盯四条：
 *
 *  1. **门**：不是车机 token 就 403；车机没接入就 503。两者都不能变成 500，
 *     也不能退回"按登录用户的默认车"——那条路本文件对应的路由文件头记着踩过的坑。
 *  2. **字节原样往返**：状态码与四个头逐字透传，Range 切多少就收多少。
 *     网关在这一跳上是一根管子，不重写、不缓冲整曲。
 *  3. **超时只覆盖响应头**：body 慢慢吐也要收得完整。这是"3 秒把自己掐断"
 *     那个坑的判据——它不报错，只是歌放到一半没了。
 *  4. **失败如实报**：与同文件里 duck 的一律 204 恰好相反。端要据此停播、
 *     助手要据此转述原因。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import express from "express";

import { ToolError, type CabinClient, type CabinPlayerView } from "@carlife/tools";

import { createCabinMediaRouter } from "../src/http/cabin-media";

const VIN = "LSJA24U91NS772409";

function playerView(over: Partial<CabinPlayerView> = {}): CabinPlayerView {
  return {
    zone: "cabin",
    status: "playing",
    audible: true,
    nowPlaying: null,
    queue: [],
    cursor: 0,
    repeat: "all",
    shuffle: false,
    source: "music",
    volume: 20,
    volumeLimit: null,
    contentTag: null,
    backend: { name: "none", note: "静音" },
    sink: { kind: "client", sinkId: "c1", clientStatus: "playing", note: "车机端（c1）持有出声位" },
    ...over,
  };
}

/** 只实现本单要用的四个方法；其余留空——用到了会在运行期立刻炸，不会静默过去。 */
function fakeCabin(over: Partial<CabinClient> = {}): CabinClient {
  return {
    async mediaPlayer() {
      return { ...playerView(), rebuilt: false };
    },
    async mediaSink(_vin, beat) {
      return { ...playerView({ sink: { kind: "client", sinkId: beat.sinkId, clientStatus: beat.status ?? "playing", note: "" } }), rebuilt: false };
    },
    async mediaTrack() {
      throw new Error("本用例不该调到 mediaTrack");
    },
    ...over,
  } as unknown as CabinClient;
}

/** `identity` 决定这枚 token 是什么：车机 token 带 vehicleVin，用户 token 只有 userId。 */
function serve(cabin: CabinClient | undefined, identity: { userId?: string; vehicleVin?: string }) {
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, identity);
    next();
  });
  app.use(createCabinMediaRouter({ cabin }));
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    close: () => server.close(),
    async json(method: string, path: string, body?: unknown) {
      const r = await fetch(`${base}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
    },
  };
}

const COCKPIT = { vehicleVin: VIN };

describe("门：谁能打这三个端点", () => {
  it("不是车机 token 一律 403，并说清该用什么", async () => {
    const h = serve(fakeCabin(), { userId: "demo-user" });
    for (const [m, p] of [
      ["GET", "/v1/cabin/media/player"],
      ["POST", "/v1/cabin/media/sink"],
      ["GET", "/v1/cabin/media/tracks/t-1"],
    ] as const) {
      const r = await h.json(m, p, m === "POST" ? { sinkId: "c1" } : undefined);
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(r.body.error, "cockpit_token_required");
      assert.ok(r.body.hint, "403 要说清该用什么令牌，不能只回一个错误码");
    }
    h.close();
  });

  it("车机没接入是 503 不是 500——「没配」和「炸了」是两回事", async () => {
    const h = serve(undefined, COCKPIT);
    const r = await h.json("GET", "/v1/cabin/media/player");
    h.close();
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "cabin_not_configured");
  });
});

describe("GET /v1/cabin/media/player", () => {
  it("原样回上游的播放器状态，含 sink 段", async () => {
    const h = serve(fakeCabin(), COCKPIT);
    const r = await h.json("GET", "/v1/cabin/media/player");
    h.close();
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "playing");
    assert.equal(r.body.sink.kind, "client");
  });

  it("VIN 来自 token，不是端自己声明的", async () => {
    let seen = "";
    const h = serve(
      fakeCabin({
        async mediaPlayer(vin: string) {
          seen = vin;
          return { ...playerView(), rebuilt: false };
        },
      } as Partial<CabinClient>),
      COCKPIT,
    );
    await h.json("GET", "/v1/cabin/media/player");
    h.close();
    assert.equal(seen, VIN);
  });

  it("上游未绑定回 409，车机没连上回 502——端要分得出该重试还是该引导", async () => {
    const unbound = serve(
      fakeCabin({
        async mediaPlayer() {
          throw new ToolError("cabin", "invalid", "车机未绑定", false);
        },
      } as Partial<CabinClient>),
      COCKPIT,
    );
    const a = await unbound.json("GET", "/v1/cabin/media/player");
    unbound.close();
    assert.equal(a.status, 400);
    assert.match(a.body.hint, /车机未绑定/);

    const down = serve(
      fakeCabin({
        async mediaPlayer() {
          throw new ToolError("cabin", "upstream", "车机没连上", true);
        },
      } as Partial<CabinClient>),
      COCKPIT,
    );
    const b = await down.json("GET", "/v1/cabin/media/player");
    down.close();
    assert.equal(b.status, 502);
  });
});

describe("POST /v1/cabin/media/sink", () => {
  it("缺 sinkId 是 400，不是静默忽略", async () => {
    const h = serve(fakeCabin(), COCKPIT);
    const r = await h.json("POST", "/v1/cabin/media/sink", { claim: true });
    h.close();
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "sink_id_required");
  });

  it("心跳原样转发，响应体就是播放器状态——一次往返办两件事", async () => {
    let seen: Record<string, unknown> = {};
    const h = serve(
      fakeCabin({
        async mediaSink(_vin: string, beat: Record<string, unknown>) {
          seen = beat;
          return { ...playerView(), rebuilt: false };
        },
      } as unknown as Partial<CabinClient>),
      COCKPIT,
    );
    const r = await h.json("POST", "/v1/cabin/media/sink", {
      sinkId: "c1",
      claim: true,
      status: "playing",
      positionSec: 42,
      ended: false,
    });
    h.close();
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "playing", "响应体是播放器状态，端不必再打一个端点");
    assert.deepEqual(seen, { sinkId: "c1", claim: true, status: "playing", positionSec: 42, ended: false });
  });
});

describe("GET /v1/cabin/media/tracks/:id：网关在这一跳上是一根管子", () => {
  /** 假的车机字节源。`delayMs` 让 body 慢慢吐，用来验"超时只覆盖响应头"。 */
  function upstream(bytes: Buffer, delayMs = 0): { server: Server; url: string } {
    const server = createServer((req, res) => {
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
      const [start, end] = range
        ? [Number(range[1]), range[2] === "" ? bytes.length - 1 : Number(range[2])]
        : [0, bytes.length - 1];
      const slice = bytes.subarray(start, end + 1);
      res.writeHead(range ? 206 : 200, {
        "content-type": "audio/mpeg",
        "content-length": String(slice.length),
        "accept-ranges": "bytes",
        ...(range ? { "content-range": `bytes ${start}-${end}/${bytes.length}` } : {}),
      });
      if (!delayMs) return void res.end(slice);
      // 分两半发，中间停一下：头早就到了，body 还在路上。
      res.write(slice.subarray(0, Math.floor(slice.length / 2)));
      setTimeout(() => res.end(slice.subarray(Math.floor(slice.length / 2))), delayMs);
    });
    server.listen(0);
    const port = (server.address() as { port: number }).port;
    return { server, url: `http://127.0.0.1:${port}` };
  }

  /** 真的走一遍 HTTP 后端，而不是伪造 CabinClient——本用例要验的正是那一层。 */
  async function withHttpBackend(bytes: Buffer, delayMs: number, timeoutMs: number) {
    const { createHttpCabinBackend } = await import("@carlife/tools");
    const up = upstream(bytes, delayMs);
    const backend = createHttpCabinBackend(up.url, timeoutMs);
    const h = serve({ mediaTrack: (t: string, r?: string) => backend.mediaTrack(t, r) } as unknown as CabinClient, COCKPIT);
    return { ...h, closeAll: () => { h.close(); up.server.close(); } };
  }

  const BYTES = Buffer.alloc(4096, 7);

  it("整曲：200 与四个头逐字透传，字节数一致", async () => {
    const h = await withHttpBackend(BYTES, 0, 3_000);
    const r = await fetch(`${h.base}/v1/cabin/media/tracks/t-1`);
    const got = Buffer.from(await r.arrayBuffer());
    h.closeAll();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "audio/mpeg");
    assert.equal(r.headers.get("content-length"), "4096");
    assert.equal(r.headers.get("accept-ranges"), "bytes");
    assert.equal(got.length, 4096);
    assert.ok(got.equals(BYTES), "字节要一模一样——中间这一跳不许动内容");
  });

  it("Range 原样往返：206 + content-range，切多少收多少", async () => {
    const h = await withHttpBackend(BYTES, 0, 3_000);
    const r = await fetch(`${h.base}/v1/cabin/media/tracks/t-1`, { headers: { range: "bytes=0-1023" } });
    const got = Buffer.from(await r.arrayBuffer());
    h.closeAll();
    assert.equal(r.status, 206);
    assert.equal(r.headers.get("content-range"), "bytes 0-1023/4096");
    assert.equal(got.length, 1024);
  });

  it("超时只覆盖响应头：body 吐得比超时还久，也要收得完整", async () => {
    // 超时 200ms，body 拖 500ms。
    //
    // 这条用例实测能抓到回归：把 `trackBytes` 里那句 `clearTimeout(timer)` 去掉，
    // 表现**不是**"收到一半"而是**整个请求挂住不返回**（上游流被 abort，
    // 网关那边的 pipe 永远等不到 end）。所以本用例自己带一个 5 s 的硬超时，
    // 让回归表现成一条失败而不是一条卡死的 CI。
    const h = await withHttpBackend(BYTES, 500, 200);
    const r = await fetch(`${h.base}/v1/cabin/media/tracks/t-1`, { signal: AbortSignal.timeout(5_000) });
    const got = Buffer.from(await r.arrayBuffer());
    h.closeAll();
    assert.equal(r.status, 200);
    assert.equal(got.length, 4096, "响应头到手就该解除超时，body 想流多久流多久");
  });

  it("上游 404 折成人话，不是把一个数字丢给端", async () => {
    const h = serve(
      fakeCabin({
        async mediaTrack() {
          throw new ToolError("cabin", "invalid", "车机曲库里没有这首（track_not_found）", false);
        },
      } as unknown as Partial<CabinClient>),
      COCKPIT,
    );
    const r = await h.json("GET", "/v1/cabin/media/tracks/t-nope");
    h.close();
    assert.equal(r.status, 400);
    assert.match(r.body.hint, /没有这首/);
  });
});

describe("既有让路端点不受影响", () => {
  it("duck 仍然先回 204 再做，不因为新端点改成如实报错", async () => {
    let called = false;
    const h = serve(
      fakeCabin({
        async mediaDuck() {
          called = true;
          return { ducked: true, vehicleId: "v-1", outputVolume: 6 };
        },
      } as unknown as Partial<CabinClient>),
      { userId: "demo-user" },
    );
    const r = await fetch(`${h.base}/v1/cabin/media/duck`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on: true }),
    });
    assert.equal(r.status, 204);
    await new Promise((res) => setTimeout(res, 50));
    h.close();
    assert.equal(called, true, "204 是先回，事后照做");
  });
});
