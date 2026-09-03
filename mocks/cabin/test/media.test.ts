/**
 * 媒体域：曲库、点歌、传输控制，以及与舒适域设置的对账。
 *
 * 跑的是**静音后端**（`MOCK_CABIN_AUDIO=off`）：单测不该往机器的喇叭上放歌，
 * 而且 CI 上根本没有声卡。状态机与端点形状是这里要盯的，"真出声"由
 * `probe:cabin-audio` 在真机上验（见 §能力上报 的用例：静音时必须
 * `audible:false` 并说明原因，不能假装在放）。
 *
 * 盯四条主线：
 *
 *  1. **防编**：编一个 trackId 要被拒；点不到的歌要明说没有，
 *     **不做"最接近的一首"兜底**——点歌有副作用，猜错就是放错。
 *  2. **单一真相源**：播放器不另存音量/开关，`state.media[zone]` 就是它的。
 *     两个方向都要通：播放器起播要改 `source`，apply 改 `source` 要停播放器。
 *  3. **诚实**：出不了声就得说出不了声、被别的车抢了出声位要说被谁抢了。
 *  4. **可复现**：trackId 由文件名派生，加歌删歌不让已有 id 漂移。
 *  5. **出声位可以在端上**（M63-01）：字节拿得走、端认领得了、租约会过期，
 *     且**没有端认领时的行为与从前逐字相同**——单机 demo 那条路不能被这条新路带坏。
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

// 必须在建服务之前设：后端探测结论进程内只算一次。
process.env.MOCK_CABIN_AUDIO = "off";

const fixtureDir = mkdtempSync(join(tmpdir(), "mock-cabin-media-"));
process.env.MOCK_CABIN_MEDIA_DIR = fixtureDir;

const { createCabinServer, __resetAll, __resetPlayers, __resetLibrary } = await import("../src/index");
const { __setClock, playerFor, SINK_TTL_MS } = await import("../src/media/player");
const { getVehicle } = await import("../src/state");

/** `无名曲.mp3` 的字节数。字节端点与 Range 的用例都对着它算。 */
const TRACK_BYTES = 4096;

let server: Server;
let base = "";

before(async () => {
  // 内容无所谓——静音后端不解码。要的是文件名与扩展名。
  writeFileSync(join(fixtureDir, "小明 - 江湖天涯客.mp3"), "");
  writeFileSync(join(fixtureDir, "小明 - 长夜.mp3"), "");
  // 唯一一个有内容的：字节端点要有东西可发，Range 也得有边界可越。
  // 4096 是随手取的，只要 > 1024（Range 用例切的那一刀）就行。
  writeFileSync(join(fixtureDir, "无名曲.mp3"), Buffer.alloc(TRACK_BYTES, 7));
  writeFileSync(join(fixtureDir, "封面.jpg"), "");

  server = createCabinServer();
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(() => {
  server.close();
  __resetPlayers();
  rmSync(fixtureDir, { recursive: true, force: true });
});

beforeEach(() => {
  __resetPlayers();
  __resetAll();
  __resetLibrary();
});

const get = async (path: string) => {
  const r = await fetch(`${base}${path}`);
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

const post = async (path: string, body: unknown) => {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

const createCar = async (model = "Model Y"): Promise<string> => {
  const r = await post("/vehicles", { model });
  assert.equal(r.status, 201);
  return r.body.vehicleId as string;
};

const player = (id: string, body: unknown) => post(`/vehicles/${id}/media/player`, body);

describe("GET /media/library：目录里有哪些歌", () => {
  it("扫得到 mp3，按「艺人 - 曲名」拆元数据", async () => {
    const r = await get("/media/library");
    assert.equal(r.status, 200);
    assert.equal(r.body.tracks.length, 3);
    const t = r.body.tracks.find((x: any) => x.title === "江湖天涯客");
    assert.ok(t, "应当认出「江湖天涯客」");
    assert.equal(t.artist, "小明");
    assert.equal(t.format, "mp3");
  });

  it("没有「 - 」的文件名整个当曲名，艺人为 null", async () => {
    const r = await get("/media/library");
    const t = r.body.tracks.find((x: any) => x.title === "无名曲");
    assert.equal(t.artist, null);
  });

  it("非音频文件被忽略并计数——目录指错地方时这个数会很显眼", async () => {
    const r = await get("/media/library");
    assert.equal(r.body.ignored, 1);
  });

  it("不外泄绝对路径：track.file 是相对资源目录的", async () => {
    const r = await get("/media/library");
    for (const t of r.body.tracks) assert.ok(!t.file.startsWith("/"), `${t.file} 不该是绝对路径`);
  });

  it("trackId 由文件名派生：重扫之后逐字不变", async () => {
    const a = await get("/media/library");
    const b = await post("/media/library", {});
    assert.equal(b.body.rescanned, true);
    assert.deepEqual(
      a.body.tracks.map((t: any) => t.trackId),
      b.body.tracks.map((t: any) => t.trackId),
    );
  });
});

describe("点歌：匹配不到就说没有，不猜", () => {
  it("query 命中曲名 → 起播，并如实回报选中了哪首", async () => {
    const id = await createCar();
    const r = await player(id, { command: "select", query: "江湖天涯客" });
    assert.equal(r.status, 200);
    assert.equal(r.body.matched.length, 1);
    assert.equal(r.body.matched[0].title, "江湖天涯客");
    assert.equal(r.body.player.status, "playing");
  });

  it("query 命中艺人 → 该艺人的全部曲目进队列", async () => {
    const id = await createCar();
    const r = await player(id, { command: "select", query: "小明" });
    assert.equal(r.body.player.queue.length, 2);
  });

  it("匹配不到 → 400 no_match，**不退而求其次放一首别的**", async () => {
    const id = await createCar();
    const r = await player(id, { command: "select", query: "根本没有这首歌" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "no_match");
    assert.equal(r.body.player.status, "stopped");
  });

  it("编一个 trackId → 400 track_not_found（与 vehicle_not_found 同一条防编纪律）", async () => {
    const id = await createCar();
    const r = await player(id, { command: "select", trackIds: ["t-deadbeef"] });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "track_not_found");
  });

  it("不带 query 也不带 trackIds → 整个曲库进队列", async () => {
    const id = await createCar();
    const r = await player(id, { command: "select" });
    assert.equal(r.body.player.queue.length, 3);
  });

  it("未知 command → 400 并把可选值列出来", async () => {
    const id = await createCar();
    const r = await player(id, { command: "shuffle-all-the-things" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "unknown_command");
    assert.ok(r.body.commands.includes("previous"));
  });

  it("车都没造就点歌 → 404，不顺手建一辆", async () => {
    const r = await player("VEH-999999", { command: "play" });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "vehicle_not_found");
  });
});

describe("传输控制：播放 / 暂停 / 上一首 / 下一首", () => {
  const queued = async () => {
    const id = await createCar();
    await player(id, { command: "select", query: "小明", autoplay: false });
    return id;
  };

  it("select 带 autoplay:false 时不起播", async () => {
    const id = await queued();
    const r = await get(`/vehicles/${id}/media/player`);
    assert.equal(r.body.status, "stopped");
    assert.equal(r.body.queue.length, 2);
  });

  it("play → playing，pause → paused，再 play → 回到 playing", async () => {
    const id = await queued();
    assert.equal((await player(id, { command: "play" })).body.player.status, "playing");
    assert.equal((await player(id, { command: "pause" })).body.player.status, "paused");
    assert.equal((await player(id, { command: "play" })).body.player.status, "playing");
  });

  it("next 推进游标，末尾回卷到 0", async () => {
    const id = await queued();
    await player(id, { command: "play" });
    assert.equal((await player(id, { command: "next" })).body.player.cursor, 1);
    assert.equal((await player(id, { command: "next" })).body.player.cursor, 0);
  });

  it("previous 从 0 退到末尾", async () => {
    const id = await queued();
    await player(id, { command: "play" });
    assert.equal((await player(id, { command: "previous" })).body.player.cursor, 1);
  });

  it("队列空时 next/previous → 400 queue_empty，不静默成功", async () => {
    const id = await createCar();
    const r = await player(id, { command: "next" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "queue_empty");
  });

  it("stop 之后 nowPlaying 的进度归 null", async () => {
    const id = await queued();
    await player(id, { command: "play" });
    const r = await player(id, { command: "stop" });
    assert.equal(r.body.player.status, "stopped");
    assert.equal(r.body.player.nowPlaying.positionSec, null);
  });

  it("mode 设 repeat/shuffle；非法 repeat 被拒", async () => {
    const id = await queued();
    const ok = await player(id, { command: "mode", repeat: "one", shuffle: true });
    assert.equal(ok.body.player.repeat, "one");
    assert.equal(ok.body.player.shuffle, true);
    const bad = await player(id, { command: "mode", repeat: "sometimes" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "invalid_repeat");
  });
});

describe("单一真相源：播放器与 state.media 是同一份状态", () => {
  it("起播会把 media.source 写成 music、contentTag 写成曲名", async () => {
    const id = await createCar();
    await player(id, { command: "select", query: "江湖天涯客" });
    const s = await get(`/vehicles/${id}/state`);
    assert.equal(s.body.state.media.cabin.source, "music");
    assert.equal(s.body.state.media.cabin.contentTag, "江湖天涯客");
  });

  it("apply 把 source 设成 off → 播放器停下来（声明式收敛）", async () => {
    const id = await createCar();
    await player(id, { command: "select", query: "江湖天涯客" });
    await post(`/vehicles/${id}/apply`, { ops: [{ domain: "media", zone: "cabin", set: { source: "off" } }] });
    const r = await get(`/vehicles/${id}/media/player`);
    assert.equal(r.body.status, "stopped");
  });

  it("reset 之后播放器也停——不能「重置了」却还在响", async () => {
    const id = await createCar();
    await player(id, { command: "select", query: "江湖天涯客" });
    await post(`/vehicles/${id}/reset`, {});
    const r = await get(`/vehicles/${id}/media/player`);
    assert.equal(r.body.status, "stopped");
  });

  it("音量取自 state.media，不是播放器自己的副本", async () => {
    const id = await createCar();
    await post(`/vehicles/${id}/apply`, { ops: [{ domain: "media", zone: "cabin", set: { volume: 35 } }] });
    await player(id, { command: "select", query: "江湖天涯客" });
    const r = await get(`/vehicles/${id}/media/player`);
    assert.equal(r.body.volume, 35);
  });

  it("分区音量上限对播放器同样成立", async () => {
    const id = await createCar();
    await post(`/vehicles/${id}/apply`, {
      ops: [{ domain: "media", zone: "cabin", set: { volumeLimit: 20, volume: 80 } }],
    });
    const r = await get(`/vehicles/${id}/media/player`);
    assert.equal(r.body.volumeLimit, 20);
    assert.equal(r.body.volume, 20);
  });

  it("起播这件事进得了变更流水（GET /changes 看得见）", async () => {
    const id = await createCar();
    await player(id, { command: "select", query: "江湖天涯客" });
    const c = await get(`/vehicles/${id}/changes`);
    const hit = c.body.changes.filter((x: any) => x.domain === "media" && x.field === "source");
    assert.equal(hit.at(-1).to, "music");
  });
});

describe("让路：暖暖说话时压低，不是停掉", () => {
  it("duck 打开后仍在播放，只是 ducked 置位", async () => {
    const id = await createCar();
    await player(id, { command: "select", query: "江湖天涯客" });
    const on = await player(id, { command: "duck", on: true, toPercent: 25 });
    assert.equal(on.body.player.ducked, true);
    assert.equal(on.body.player.status, "playing", "让路不该把歌停掉");
    const off = await player(id, { command: "duck", on: false });
    assert.equal(off.body.player.ducked, false);
  });

  it("**让路是租约**：恢复请求没来也会自己恢复", async () => {
    // 触发方是车机端的播报链路，而「说完了」那次调用可能永远不来
    // （播报进程崩了、客户端被关掉）。纯开关语义下音乐就永远停在压低状态，
    // 而且一声不响——用户只会觉得"这车声音怎么这么小"。
    const id = await createCar();
    await player(id, { command: "select", query: "江湖天涯客" });
    const on = await player(id, { command: "duck", on: true, holdMs: 1000 });
    assert.equal(on.body.player.ducked, true);
    assert.ok(on.body.player.duckedUntil, "租约到期时刻要报出来，排查时第一眼看它");

    await new Promise((r) => setTimeout(r, 1400));
    const later = await get(`/vehicles/${id}/media/player`);
    assert.equal(later.body.ducked, false, "租约到期必须自己恢复");
    assert.equal(later.body.duckedUntil, undefined);
    assert.equal(later.body.status, "playing", "恢复音量不该把歌停掉");
  });

  it("`POST /media/duck` 不认车辆 id，压的是**正在出声的那个**", async () => {
    // 按车走会引入一整类与让路无关的失败：默认车没绑车机、绑的那辆不是正在
    // 放歌的那辆。演示数据里这两条同时成立过，让路 100% 失败，
    // 而现象只是"音乐没让路"——离根因很远。主机只有一套喇叭，认出声位就够了。
    const id = await createCar();
    await player(id, { command: "select", query: "江湖天涯客" });
    const r = await post("/media/duck", { on: true, toPercent: 25 });
    assert.equal(r.status, 200);
    assert.equal(r.body.ducked, true);
    assert.equal(r.body.vehicleId, id, "压的应当是持有出声位的那辆");
    const v = await get(`/vehicles/${id}/media/player`);
    assert.equal(v.body.ducked, true);
    assert.equal(v.body.status, "playing", "让路不是停播");
  });

  it("没人在放时如实说没人，不凭空造一个播放器", async () => {
    await post("/media/duck", { on: true });
    const r = await post("/media/duck", { on: true });
    assert.equal(r.body.ducked, false);
    assert.equal(r.body.vehicleId, null);
    assert.equal(r.body.outputVolume, null);
  });

  it("两辆车时压的是抢到出声位的后一辆", async () => {
    const a = await createCar();
    const b = await createCar();
    await player(a, { command: "select", query: "江湖天涯客" });
    await player(b, { command: "select", query: "长夜" }); // b 抢走出声位
    const r = await post("/media/duck", { on: true });
    assert.equal(r.body.vehicleId, b);
  });

  it("续租：租约到期前再压一次，从新的时刻起算", async () => {
    const id = await createCar();
    await player(id, { command: "select", query: "江湖天涯客" });
    await player(id, { command: "duck", on: true, holdMs: 1000 });
    await new Promise((r) => setTimeout(r, 600));
    await player(id, { command: "duck", on: true, holdMs: 1000 }); // 续租
    await new Promise((r) => setTimeout(r, 700)); // 已超过第一次的租期
    const v = await get(`/vehicles/${id}/media/player`);
    assert.equal(v.body.ducked, true, "续租之后不该按第一次的到期时刻恢复");
  });
});

describe("能力上报：出不了声就要说出不了声", () => {
  it("静音后端下 audible 为 false 并给出原因", async () => {
    const id = await createCar();
    const r = await player(id, { command: "select", query: "江湖天涯客" });
    assert.equal(r.body.player.status, "playing");
    assert.equal(r.body.player.audible, false, "静音后端不该报 audible");
    assert.ok(r.body.player.audibleNote, "必须说明为什么没声音");
    assert.equal(r.body.player.backend.name, "none");
  });

  it("/health 带上后端与曲库数量——「起来了」和「起来了但一声不出」要分得开", async () => {
    const r = await get("/health");
    assert.equal(r.body.audio.backend, "none");
    assert.equal(r.body.audio.tracks, 3);
    assert.ok(r.body.audio.mediaDir);
  });

  it("GET /state 说明哪个分区才真的出声", async () => {
    const id = await createCar();
    const r = await get(`/vehicles/${id}/state`);
    assert.equal(r.body.audibleZone, "cabin");
  });

  it("主机只有一套喇叭：后起播的车抢走出声位，前一辆停下并说明被谁抢了", async () => {
    const a = await createCar();
    const b = await createCar();
    await player(a, { command: "select", query: "江湖天涯客" });
    await player(b, { command: "select", query: "长夜" });
    const va = await get(`/vehicles/${a}/media/player`);
    assert.equal(va.body.status, "stopped", "被抢占的车必须真的停下，不能留个后台还在响");
    const vb = await get(`/vehicles/${b}/media/player`);
    assert.equal(vb.body.status, "playing");
  });
});

// ── 出声位搬到车机端（M63-01）──────────────────────────────

describe("GET /media/tracks/:id：端把字节拉走自己放", () => {
  const trackIdOf = async (title: string): Promise<string> => {
    const r = await get("/media/library");
    const t = r.body.tracks.find((x: any) => x.title === title);
    assert.ok(t, `曲库里应当有「${title}」`);
    return t.trackId as string;
  };

  it("整曲：200 + content-length 等于文件大小，且声明支持 Range", async () => {
    const id = await trackIdOf("无名曲");
    const r = await fetch(`${base}/media/tracks/${id}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "audio/mpeg");
    assert.equal(r.headers.get("content-length"), String(TRACK_BYTES));
    assert.equal(r.headers.get("accept-ranges"), "bytes");
    assert.equal((await r.arrayBuffer()).byteLength, TRACK_BYTES);
  });

  it("Range：206 + content-range，实收的字节数就是要的那一段", async () => {
    const id = await trackIdOf("无名曲");
    const r = await fetch(`${base}/media/tracks/${id}`, { headers: { range: "bytes=0-1023" } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get("content-range"), `bytes 0-1023/${TRACK_BYTES}`);
    assert.equal(r.headers.get("content-length"), "1024");
    assert.equal((await r.arrayBuffer()).byteLength, 1024);
  });

  it("开区间 `bytes=N-` 取到文件尾", async () => {
    const id = await trackIdOf("无名曲");
    const r = await fetch(`${base}/media/tracks/${id}`, { headers: { range: "bytes=4000-" } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get("content-range"), `bytes 4000-${TRACK_BYTES - 1}/${TRACK_BYTES}`);
    assert.equal((await r.arrayBuffer()).byteLength, TRACK_BYTES - 4000);
  });

  it("越界的 Range 回 416 并说明总长——端据此重新算，不要静默给别的段", async () => {
    const id = await trackIdOf("无名曲");
    const r = await fetch(`${base}/media/tracks/${id}`, { headers: { range: `bytes=${TRACK_BYTES}-` } });
    assert.equal(r.status, 416);
    assert.equal(r.headers.get("content-range"), `bytes */${TRACK_BYTES}`);
  });

  it("HEAD 有头无体——端上探大小不必把整曲拉一遍", async () => {
    const id = await trackIdOf("无名曲");
    const r = await fetch(`${base}/media/tracks/${id}`, { method: "HEAD" });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-length"), String(TRACK_BYTES));
    assert.equal((await r.arrayBuffer()).byteLength, 0);
  });

  it("编一个 trackId 就死在这里，不「顺手给一首」", async () => {
    const r = await get("/media/tracks/t-deadbeef");
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "track_not_found");
  });
});

describe("POST /vehicles/:id/media/sink：车机端认领出声位", () => {
  const beat = (id: string, body: unknown) => post(`/vehicles/${id}/media/sink`, body);

  afterEach(() => __setClock(null));

  it("认领之后 audible 说的是车机端，不是服务端有没有播放后端", async () => {
    const id = await createCar();
    await player(id, { command: "select", query: "长夜" });

    // 没认领时：静音后端，如实说放不了。
    const before = await get(`/vehicles/${id}/media/player`);
    assert.equal(before.body.audible, false);
    assert.equal(before.body.sink.kind, "none");

    const r = await beat(id, { sinkId: "cockpit-1", claim: true, status: "playing" });
    assert.equal(r.status, 200);
    assert.equal(r.body.sink.kind, "client");
    assert.equal(r.body.sink.sinkId, "cockpit-1");
    assert.equal(r.body.audible, true, "端说它在放，那就是真的在放——服务端的后端与此无关");
  });

  it("端说暂停就是暂停，不许说成「设备没有播放器件」", async () => {
    const id = await createCar();
    await player(id, { command: "select", query: "长夜" });
    await beat(id, { sinkId: "cockpit-1", claim: true, status: "playing" });
    const r = await beat(id, { sinkId: "cockpit-1", status: "paused" });
    assert.equal(r.body.audible, false);
    assert.match(r.body.audibleNote, /车机端上报的是 paused/);
  });

  it("端上的错原样上报，不吞——听不到声时得查得到原因", async () => {
    const id = await createCar();
    await player(id, { command: "select", query: "长夜" });
    const r = await beat(id, {
      sinkId: "cockpit-1",
      claim: true,
      status: "stopped",
      error: "拉字节失败：502",
    });
    assert.equal(r.body.audible, false);
    assert.match(r.body.sink.note, /拉字节失败：502/);
  });

  it("心跳带回最新状态：一次往返办两件事", async () => {
    const id = await createCar();
    await beat(id, { sinkId: "cockpit-1", claim: true });
    await player(id, { command: "select", query: "江湖天涯客" });
    const r = await beat(id, { sinkId: "cockpit-1", status: "playing" });
    assert.equal(r.body.nowPlaying.title, "江湖天涯客");
    assert.equal(r.body.status, "playing");
  });

  it("端在放时进度来自端，不来自那个停着的服务端后端", async () => {
    const id = await createCar();
    await player(id, { command: "select", query: "长夜" });
    await beat(id, { sinkId: "cockpit-1", claim: true, status: "playing", positionSec: 42 });
    const r = await get(`/vehicles/${id}/media/player`);
    assert.equal(r.body.nowPlaying.positionSec, 42);
  });

  it("端说本曲播完了，队列才往前走——服务端听不见，只能靠它说", async () => {
    const id = await createCar();
    await player(id, { command: "mode", repeat: "all" });
    await player(id, { command: "select" }); // 整库
    await beat(id, { sinkId: "cockpit-1", claim: true, status: "playing" });
    const first = (await get(`/vehicles/${id}/media/player`)).body.nowPlaying.trackId;
    const r = await beat(id, { sinkId: "cockpit-1", status: "playing", ended: true });
    assert.notEqual(r.body.nowPlaying.trackId, first, "ended 之后应当是下一首");
  });

  it("认领时服务端后端立刻让位：此后不再为这辆车起播", async () => {
    const id = await createCar();
    await beat(id, { sinkId: "cockpit-1", claim: true, status: "playing" });
    await player(id, { command: "select", query: "长夜" });
    const record = getVehicle(id);
    assert.ok(record);
    // `ensureBackend()` 是后端进程唯一的来路。端持着出声位时它一次都不该被调到——
    // 两边同时放就是同一首歌错开半秒放两遍。
    assert.equal(playerFor(record).backend, null, "端认领后服务端不该再建播放后端");
  });

  it("claim 才抢占，续租不抢占——否则两个端会每秒互抢一次", async () => {
    const id = await createCar();
    await beat(id, { sinkId: "c1", claim: true, status: "playing" });
    const taken = await beat(id, { sinkId: "c2", claim: true, status: "playing" });
    assert.equal(taken.body.sink.sinkId, "c2", "带 claim 的后来者赢");

    const c1again = await beat(id, { sinkId: "c1", status: "playing" });
    assert.equal(c1again.body.sink.sinkId, "c2", "不带 claim 的心跳不夺回");

    const c1claims = await beat(id, { sinkId: "c1", claim: true, status: "playing" });
    assert.equal(c1claims.body.sink.sinkId, "c1", "再 claim 一次才夺得回来");
  });

  it("alive:false 交还出声位，且只交得了自己的", async () => {
    const id = await createCar();
    await beat(id, { sinkId: "c1", claim: true, status: "playing" });
    const notMine = await beat(id, { sinkId: "c2", alive: false });
    assert.equal(notMine.body.sink.sinkId, "c1", "别人交不了我的出声位");
    const mine = await beat(id, { sinkId: "c1", alive: false });
    assert.notEqual(mine.body.sink.kind, "client");
  });

  it("租约会过期：端崩了不会让出声位永远被一个不存在的端占着", async () => {
    const id = await createCar();
    await player(id, { command: "select", query: "长夜" });
    await beat(id, { sinkId: "c1", claim: true, status: "playing" });
    assert.equal((await get(`/vehicles/${id}/media/player`)).body.audible, true);

    const t0 = Date.now();
    __setClock(() => t0 + SINK_TTL_MS + 1);
    const r = await get(`/vehicles/${id}/media/player`);
    assert.notEqual(r.body.sink.kind, "client");
    assert.equal(r.body.audible, false, "端没了就是没声了，别接着说在放");
  });

  it("sinkId 缺失是 400 带 hint，不是静默忽略", async () => {
    const id = await createCar();
    const r = await beat(id, { claim: true });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "sink_id_required");
    assert.ok(r.body.hint);
  });

  it("/health 报出有几个端持着出声位——「车机连上没有」的第一手证据", async () => {
    const id = await createCar();
    assert.equal((await get("/health")).body.audio.clientSinks, 0);
    await beat(id, { sinkId: "c1", claim: true, status: "playing" });
    assert.equal((await get("/health")).body.audio.clientSinks, 1);
  });
});
