/**
 * mock-cabin —— 假装是车机的舒适域控制器（参照 mock-dealer 的 M19-01 设计）。
 *
 * # 它为什么是一个独立进程
 *
 * 与 mock-dealer 同一条理由：**能被当场 kill 掉**。使用者问"这是真控车还是写死的"时，
 * 关掉它，助手要如实说"车机没连上"，而不是继续说"空调已调到 23 度"。
 * 内存 mock 做不到这个演示。
 *
 * 由此继承的硬约束：不 import 本仓任何业务包（`@carlife/*` 一个都不引）、
 * 不连 PG/Redis/MinIO。它是别人家的车机。
 *
 * 「状态重启即清」曾经也在这份清单里，现已放宽——设置与变更流水落一个本地
 * JSON 快照（`persistence.ts`），因为真车重启之后空调不会回到出厂 22 度，
 * 而后台的「设置变更历史」需要一份活得比进程长的记录。降级演示不受影响：
 * kill 掉仍然是连接被拒，助手仍然要如实说「车机没连上」。
 *
 * # 车辆先创建、后使用
 *
 * mock 的是**一辆一辆真实的车**：`POST /vehicles` 造车（建时指定车型，
 * 雪佛兰和特斯拉的能力不一样，能力表按车型配置），返回本服务发号的车辆 id。
 * 此后一切请求只认 id——能力、状态、设置都是"这辆车"的；车型只是返回属性，
 * 调用方再也不用带。任意车型都造得出：种子车型走手工档案，种子外按车型名
 * 确定性合成（capabilities.ts），同款车永远同一份能力表。
 *
 * # 它只认识"设置"，不认识"人"
 *
 * 偏好（谁喜欢几度、冬天和夏天有什么不同）由 CarLife Agent 管理，
 * 翻译成设置值之后才到这里。所以接口上没有 memberId、没有"偏好"字样——
 * 只有 `{domain, zone, set}`。把人的概念混进设备层，偏好体系就换不掉了。
 *
 * # 媒体域会真的出声
 *
 * 其它五个域都只是记下设置值（空调 23 度，喇叭不会有反应）。媒体域不一样：
 * `media/` 目录下的音频文件由本进程在**主机**上放出来（`media/backend.ts`）。
 * 这是刻意的——"车机在放歌"这件事，看状态字段和真听见声音是两种可信度。
 *
 * 由此多出两组端点，形状上与舒适域刻意分开：
 *
 *   `/media/library`                 曲库。与车无关，整个服务一份。
 *   `/media/tracks/:trackId`         曲目字节（GET/HEAD，支持 Range）。与车无关。
 *   `/vehicles/:id/media/player`     播放器。GET 看状态，POST 发 `{command}`。
 *   `/vehicles/:id/media/sink`       车机端认领出声位 + 心跳（POST），回一份播放器状态。
 *
 * 后两个是"出声位搬到车机端"的那条路（M63-01）：端拉字节自己放、按 1 s 心跳
 * 跟随播放器状态；本进程只维护状态机。理由见 `media/player.ts` 文件头。
 *
 * **为什么传输控制不塞进 `apply`**：`{domain, zone, set}` 表达的是"设成什么"，
 * 而"下一首"没有对应的设置值可言——硬塞成 `set:{transport:"next"}` 是把动词
 * 打扮成名词，且 apply 的 requestId 幂等语义对它也不成立。
 *
 * 但两者**共用同一份状态**：`state.media[zone]` 的 `source` 就是播放器总开关、
 * `volume` 就是主机输出音量、`contentTag` 就是"正在放什么"。所以 Agent 侧原有的
 * "上车放点音乐、音量 20"（一次普通 apply）零改动就会真的响，新端点只管
 * 队列与点歌这些设置模型表达不了的东西。
 *
 * # 范围：舒适域
 *
 * 空调 / 座椅 / 氛围灯 / 媒体 / 香氛 / 儿童模式。**没有任何行驶相关能力**：
 * 无车门车窗、无动力转向制动——那些属安全域，硬禁在 Agent 侧
 * （guard/hard-block-rules.ts），设备层压根不建模，两头都到不了。
 * 唯一碰到安全边界的一处（儿童锁只上不解）的理由见 state.ts 文件头。
 */

import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { SEED_MODELS } from "./capabilities";
import { viewEnergy } from "./energy";
import { backendCaps } from "./media/backend";
import { absPathOf, contentTypeOf, findTrack, getLibrary, scanLibrary } from "./media/library";
import {
  audibleZoneOf,
  duckAudible,
  liveClientSinkCount,
  reconcileAfterApply,
  runCommand,
  sinkBeatFor,
  viewFor,
  PLAYER_COMMANDS,
  type SinkBeat,
} from "./media/player";
import {
  applyOps,
  createVehicle,
  getVehicle,
  newVehicleId,
  priorResponse,
  rememberResponse,
  resetVehicle,
  vehicleCount,
  type CabinOp,
  type VehicleRecord,
  readEnergy,
  setEnergy,
} from "./state";

const PORT = Number(process.env.MOCK_CABIN_PORT ?? 8793);

/** 所有响应都带它——上游要能如实标注数据来源（与 mock-dealer 同一条纪律）。 */
const PROVENANCE = "simulated" as const;

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

/**
 * 一首曲子的字节。**这是"出声位搬到车机端"的整条链路里唯一传音频的地方**
 * （M63-01）：端拉走自己放，本进程不出声。
 *
 * # Range 只做单区间
 *
 * `bytes=a-b` 一种形态，多区间（`multipart/byteranges`）**刻意不做**——
 * 手写那套 multipart 的收益为零而出错面很大，而端上要它只为了 seek。
 * 收到多区间就当整曲请求处理，如实回 200 而不是假装支持。
 *
 * # 20 MB 上限
 *
 * 挡的是"有人往 media/ 里丢了一部电影"。413 带上 `bytes` 与 `limit`，
 * 让端与网关都转述得出原因——只回一个数字的话，现象就只是"这首歌放不了"。
 */
const TRACK_BYTES_LIMIT = 20 * 1024 * 1024;

async function handleTrackBytes(
  req: IncomingMessage,
  res: ServerResponse,
  trackId: string,
): Promise<void> {
  const lib = await getLibrary();
  const track = findTrack(lib, trackId);
  // 编一个 id 就死在这里——与 vehicle_not_found 同一条防编纪律。
  if (!track) return json(res, 404, { error: "track_not_found", trackId });

  const abs = absPathOf(track);
  let total: number;
  try {
    total = statSync(abs).size;
  } catch {
    // 曲库扫过之后文件被删了。如实说，别让端一直重试一个不存在的东西。
    return json(res, 404, { error: "track_file_missing", trackId, file: track.file });
  }
  if (total > TRACK_BYTES_LIMIT) {
    return json(res, 413, { error: "track_too_large", trackId, bytes: total, limit: TRACK_BYTES_LIMIT });
  }

  const type = contentTypeOf(track);
  const range = /^bytes=(\d*)-(\d*)$/.exec((req.headers.range ?? "").trim());
  if (range) {
    const startRaw = range[1];
    const endRaw = range[2];
    // `bytes=-N` 是"最后 N 字节"，与 `bytes=N-` 不是一回事。
    const start = startRaw === "" ? Math.max(0, total - Number(endRaw || 0)) : Number(startRaw);
    const end = startRaw === "" ? total - 1 : endRaw === "" ? total - 1 : Math.min(Number(endRaw), total - 1);
    if (!Number.isFinite(start) || start > end || start >= total) {
      res.writeHead(416, { "content-range": `bytes */${total}`, "accept-ranges": "bytes" });
      return void res.end();
    }
    res.writeHead(206, {
      "content-type": type,
      "content-length": String(end - start + 1),
      "content-range": `bytes ${start}-${end}/${total}`,
      "accept-ranges": "bytes",
    });
    if (req.method === "HEAD") return void res.end();
    return void createReadStream(abs, { start, end }).pipe(res);
  }

  res.writeHead(200, {
    "content-type": type,
    "content-length": String(total),
    "accept-ranges": "bytes",
  });
  if (req.method === "HEAD") return void res.end();
  createReadStream(abs).pipe(res);
}

function stateBody(record: VehicleRecord): Record<string, unknown> {
  return {
    vehicleId: record.vehicleId,
    model: record.model,
    source: record.caps.source,
    capabilities: record.caps,
    state: record.state,
    // 主机就一对喇叭，分区是车上的概念。只有这一个分区的媒体设置会真的出声，
    // 其余分区照常记录但没声音——不说出来的话，"后排在放歌"会被当成真的。
    audibleZone: audibleZoneOf(record),
    updatedAt: record.updatedAt,
  };
}

/** 造一辆车。车型必填——没有车型就没有"这辆车有什么"可言。 */
async function handleCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJson(req)) as { model?: string };
  if (!body.model?.trim()) {
    return json(res, 400, { error: "model_required", hint: "创建车辆需指定车型：{ model: \"Model Y\" }" });
  }
  const record = createVehicle(newVehicleId(), body.model.trim());
  json(res, 201, stateBody(record));
}

async function handleApply(req: IncomingMessage, record: VehicleRecord, res: ServerResponse): Promise<void> {
  const body = (await readJson(req)) as {
    requestId?: string;
    ops?: CabinOp[];
  };

  if (body.requestId) {
    const prior = priorResponse(body.requestId);
    // 同一次确认网络重发不改第二遍状态——改设置是有副作用的动作。
    if (prior) return json(res, 200, { ...(prior as object), duplicate: true });
  }

  if (!Array.isArray(body.ops) || body.ops.length === 0) {
    return json(res, 400, { error: "ops_required", hint: "ops: [{domain, zone?, set}]" });
  }
  if (body.ops.length > 20) {
    return json(res, 400, { error: "too_many_ops", max: 20 });
  }

  const results = applyOps(record, body.ops);
  // 设置改完，播放器跟着收敛：source 关了就停、音量改了就跟着变。
  // 放在 rememberResponse 之前——幂等重发拿的是缓存响应，不该再跑一次副作用。
  await reconcileAfterApply(record);
  const response = {
    vehicleId: record.vehicleId,
    model: record.model,
    requestId: body.requestId,
    results,
    state: record.state,
    updatedAt: record.updatedAt,
  };
  rememberResponse(body.requestId, response);
  json(res, 200, response);
}

export function createCabinServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

      if (req.method === "GET" && url.pathname === "/health") {
        const lib = await getLibrary();
        const caps = backendCaps();
        return json(res, 200, {
          ok: true,
          service: "mock-cabin",
          vehicles: vehicleCount(),
          seedModels: SEED_MODELS.length,
          // 音频这一节要打出数字和后端名：**"服务起来了"和"起来了但一声都出不了"
          // 看起来完全一样**，而后者只有在演示现场点歌时才会暴露。
          audio: {
            backend: caps.name,
            note: caps.note,
            canPauseResume: caps.canPauseResume,
            canSetVolumeLive: caps.canSetVolumeLive,
            mediaDir: lib.dir,
            tracks: lib.tracks.length,
            playable: lib.tracks.filter((t) => t.playable).length,
            // "车机到底连上没有"——排查听不到声时第一个被 curl 的就是这里。
            clientSinks: liveClientSinkCount(),
          },
          // 与 mock-dealer 的 synthesizesAnyCity 同理："只造得出两款车"和
          // "任意车型都造得出"是两种完全不同的系统，从一次调用的结果上分辨不出来。
          synthesizesAnyModel: true,
        });
      }

      if (req.method === "POST" && url.pathname === "/vehicles") {
        return void (await handleCreate(req, res));
      }

      // ── 让路：给正在出声的那个让，不认车辆 id ────────────────
      //
      // 主机只有一套喇叭，出声位同一时刻只有一个占用者。按车走会引入一整类
      // 与让路无关的失败（默认车没绑车机、绑的那辆不是正在放歌的那辆），
      // 而那些失败的现象都只是"音乐没让路"。
      if (req.method === "POST" && url.pathname === "/media/duck") {
        const body = (await readJson(req)) as { on?: unknown; toPercent?: unknown; holdMs?: unknown };
        const r = duckAudible(
          body.on !== false,
          typeof body.toPercent === "number" ? body.toPercent : undefined,
          typeof body.holdMs === "number" ? body.holdMs : undefined,
        );
        return json(res, 200, r);
      }

      // ── 曲目字节：与车无关（曲库整个服务一份），端拉走自己放 ──
      const trackMatch = /^\/media\/tracks\/([^/]+)$/.exec(url.pathname);
      if (trackMatch && (req.method === "GET" || req.method === "HEAD")) {
        return void (await handleTrackBytes(req, res, decodeURIComponent(trackMatch[1])));
      }

      // ── 曲库：与车无关，整个服务一份 ──────────────────────
      if (url.pathname === "/media/library") {
        if (req.method === "GET") {
          const lib = await getLibrary();
          return json(res, 200, { ...lib, backend: backendCaps() });
        }
        if (req.method === "POST") {
          // 往目录里丢了新歌不用重启服务——演示前临时加一首是常事。
          const lib = await scanLibrary();
          return json(res, 200, { ...lib, backend: backendCaps(), rescanned: true });
        }
      }

      const vehicleMatch = /^\/vehicles\/([^/]+)\/(capabilities|state|changes|apply|reset|energy|media\/player|media\/sink)$/.exec(
        url.pathname,
      );
      if (vehicleMatch) {
        const vehicleId = decodeURIComponent(vehicleMatch[1]);
        const action = vehicleMatch[2];
        const record = getVehicle(vehicleId);
        // 编一个 id 就死在这里——与 mock-dealer 的 slotId 同一条防编纪律：
        // 宽容地"顺手建一辆"会让模型编的 id 变成一辆真实存在的车。
        if (!record) return json(res, 404, { error: "vehicle_not_found", vehicleId, hint: "先 POST /vehicles 创建" });

        if (req.method === "GET" && action === "capabilities") {
          return json(res, 200, { vehicleId: record.vehicleId, model: record.model, capabilities: record.caps });
        }
        if (req.method === "GET" && action === "state") {
          return json(res, 200, stateBody(record));
        }
        if (action === "energy") {
          // 遥测端点：GET 读（读时推进仿真），POST 演示控制（直接设值/切模式）。
          // 不进 changes 流水——理由见 energy.ts 文件头（流水是设置历史，遥测会把它冲走）。
          if (req.method === "GET") {
            return json(res, 200, {
              vehicleId: record.vehicleId,
              model: record.model,
              ...viewEnergy(readEnergy(record), record.model),
            });
          }
          if (req.method === "POST") {
            const body = (await readJson(req)) as Record<string, unknown>;
            try {
              const next = setEnergy(record, {
                batteryPercent: body.batteryPercent as number | undefined,
                fuelPercent: body.fuelPercent as number | undefined,
                mode: body.mode as "driving" | "charging" | undefined,
              });
              return json(res, 200, { vehicleId: record.vehicleId, model: record.model, ...viewEnergy(next, record.model) });
            } catch (err) {
              if (err instanceof RangeError) return json(res, 400, { error: "invalid", detail: err.message });
              throw err;
            }
          }
        }
        if (req.method === "GET" && action === "changes") {
          return json(res, 200, { vehicleId: record.vehicleId, changes: record.changes });
        }
        if (req.method === "POST" && action === "apply") {
          return void (await handleApply(req, record, res));
        }
        if (req.method === "POST" && action === "reset") {
          resetVehicle(record);
          // 状态回了默认值（media.source = "off"），播放器得跟着停，
          // 否则"重置了"之后喇叭还在响。
          await reconcileAfterApply(record);
          return json(res, 200, stateBody(record));
        }

        if (action === "media/player") {
          if (req.method === "GET") {
            return json(res, 200, await viewFor(record));
          }
          if (req.method === "POST") {
            const body = (await readJson(req)) as Parameters<typeof runCommand>[1];
            const outcome = await runCommand(record, body);
            if (!outcome.ok) {
              return json(res, 400, {
                error: outcome.error,
                hint: outcome.hint,
                commands: PLAYER_COMMANDS,
                player: await viewFor(record),
              });
            }
            // 成功也把全量播放器状态带回去：调用方要能如实转述"现在放的是哪首、
            // 队列里还有几首、这台机器上到底出没出声"，不用再问一次。
            return json(res, 200, {
              ok: true,
              command: body.command,
              ...(outcome.matched ? { matched: outcome.matched } : {}),
              player: await viewFor(record),
            });
          }
        }

        // ── 端上出声位：心跳即取状态，一次往返办两件事 ──────
        //
        // 端 1 s 一次，为的就是拿回最新的播放器状态去 diff。分成两个端点
        // 只会让端每秒打两次，且两次之间的状态还可能不一致。
        if (action === "media/sink" && req.method === "POST") {
          const beat = (await readJson(req)) as Partial<SinkBeat>;
          const sinkId = typeof beat.sinkId === "string" ? beat.sinkId.trim() : "";
          if (!sinkId) {
            return json(res, 400, {
              error: "sink_id_required",
              hint: "心跳要带 sinkId：{ sinkId, claim?, alive?, status?, positionSec?, ended?, error? }",
            });
          }
          return json(res, 200, await sinkBeatFor(record, { ...beat, sinkId }));
        }
      }

      // 未知路径也回 JSON：上游拿到 HTML 会在 JSON.parse 处炸，错得离现场很远。
      json(res, 404, { error: "not_found", path: url.pathname });
    } catch (err) {
      json(res, 500, { error: "internal", detail: err instanceof Error ? err.message : String(err) });
    }
  });
}

export { __resetAll } from "./state";
export { __resetPlayers } from "./media/player";
export { __resetLibrary } from "./media/library";
