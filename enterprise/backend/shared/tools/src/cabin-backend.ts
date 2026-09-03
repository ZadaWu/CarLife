/**
 * 车机舒适域后端（施工单 M24-02，FL-49 F-49-01/02/09）。
 *
 * # 它只认识"设置"，不认识"人"
 *
 * 这里的一切按 vin → 车机侧车辆 id 走。偏好、组合、谁坐哪属于 Agent 侧（FL-50），
 * 到这层已经翻译成设置值。接口形状与 `mocks/cabin` 的契约逐字对齐——
 * **发现契约不够用回 M24-00 记偏差，不顺手改 mock**。
 *
 * # 绑定与重建收在一处
 *
 * mock-cabin 状态在内存：重启后车辆清空，而④档案还存着旧 id。悬空的表现是一切
 * 座舱操作 404 `vehicle_not_found`——本模块在此**按档案车型自动重建、回写绑定、
 * 重试原操作一次**，工具与子图不感知。不收在一处的话，每个调用点都要自己处理
 * "车没了"，漏一处就是演示现场断一次。
 *
 * # 未接入要说"未接入"
 *
 * 与 dealer backend 同一条纪律（M19-02）：没配 URL 抛 `unconfigured`、连不上抛
 * `upstream`，两条话术都明确拦住模型"那我就说已经调好了吧"——kill 掉车机是
 * Demo 的一部分，"车机没连上"必须如实说出口。
 */

import { ToolError } from "./external";

// ── 数据形状（与 mocks/cabin 的响应对齐，只声明我们消费的字段）──

export interface CabinSeatCapability {
  heatingLevels: number;
  ventilationLevels: number;
  massageModes: string[];
}

export interface CabinCapabilities {
  model: string;
  source: "seed" | "synthesized";
  climate: {
    zones: string[];
    tempRangeC: [number, number];
    tempStepC: number;
    fanLevels: number;
    hasSync: boolean;
  };
  seats: Record<string, CabinSeatCapability>;
  ambientLight: { zones: string[]; modes: string[]; brightnessRange: [number, number] };
  media: { zones: string[]; sources: string[]; volumeRange: [number, number] };
  fragrance: { present: boolean; intensities: string[]; scents: string[] };
  childMode: { zones: string[] };
}

export type CabinState = Record<string, unknown>;

export interface CabinApplyOp {
  domain: string;
  zone?: string;
  set: Record<string, unknown>;
}

export interface CabinOpResult {
  index: number;
  domain: string;
  zones: string[];
  status: "applied" | "partial" | "rejected" | "invalid";
  applied: Record<string, unknown>;
  clamped: Record<string, { requested: unknown; applied: unknown; note: string }>;
  skipped: Record<string, string>;
  reason?: string;
}

export interface CabinApplyResponse {
  vehicleId: string;
  model: string;
  requestId?: string;
  results: CabinOpResult[];
  state: CabinState;
  duplicate?: boolean;
}

export interface CabinStatusResponse {
  vehicleId: string;
  model: string;
  capabilities: CabinCapabilities;
  state: CabinState;
  updatedAt: string;
}

export interface CabinChange {
  seq: number;
  at: string;
  domain: string;
  zone: string;
  field: string;
  from: unknown;
  to: unknown;
}

// ── 原始 HTTP 后端（不懂绑定，只懂车机侧 id）──────────────────

/** 车机侧 404 的结构化形态——上层用它触发重建，**不是**给用户看的错误。 */
/** `GET /vehicles/:id/energy` 的响应（M27 能量遥测）。icev 无 battery、bev 无 fuel。 */
export interface CabinEnergyResponse {
  vehicleId: string;
  model: string;
  energyType: "bev" | "phev" | "icev";
  battery?: { percent: number; rangeKm: number; charging: boolean };
  fuel?: { percent: number; rangeKm: number };
  mode: "driving" | "charging";
  asOf: string;
}

export class CabinVehicleGoneError extends Error {
  constructor(readonly cabinVehicleId: string) {
    super(`车机侧车辆不存在：${cabinVehicleId}（mock 重启即清，属预期状态）`);
    this.name = "CabinVehicleGoneError";
  }
}

// ── 媒体播放（只声明我们消费的字段，与 mock-cabin 的响应对齐）──

export interface CabinTrack {
  trackId: string;
  title: string;
  artist: string | null;
  durationSec: number | null;
  /** 车机那台机器放不放得了。false 时 `reason` 说明原因——转述时要带上。 */
  playable: boolean;
  reason?: string;
}

export interface CabinMediaLibrary {
  dir: string;
  tracks: CabinTrack[];
}

export interface CabinPlayerView {
  zone: string;
  status: "playing" | "paused" | "stopped";
  /**
   * 这一刻**是不是真有声音出来**。`status:"playing"` 但 `audible:false` 是
   * 完全可能的（车机那台机器没有播放后端、或出声位被别的车占了），
   * 转述时必须照实说，不能只看 status 就讲"已经放上了"。
   */
  audible: boolean;
  audibleNote?: string;
  nowPlaying: (CabinTrack & { positionSec: number | null }) | null;
  queue: CabinTrack[];
  cursor: number;
  repeat: "off" | "one" | "all";
  shuffle: boolean;
  source: string;
  volume: number;
  volumeLimit: number | null;
  contentTag: string | null;
  backend: { name: string; note: string };
  /**
   * 谁在出声（M63-01）。`audible` 的主语由它决定：`client` 时说的是**车机端**
   * 有没有声音，与服务端有没有播放后端无关。转述 `audible:false` 时要连它一起读，
   * 否则四类完全不同的原因（端没连上 / 端暂停了 / 端报错了 / 调试形态）
   * 只会被说成同一句话。
   */
  sink?: {
    kind: "client" | "host" | "none";
    sinkId?: string;
    clientStatus?: "playing" | "paused" | "stopped";
    note: string;
  };
  libraryEmpty?: boolean;
  libraryHint?: string;
}

/**
 * 车机端的一次心跳 / 认领。
 *
 * `claim` 与续租分开是刻意的：合成一个语义之后，两个端会每秒互抢一次出声位，
 * 表现是两边各放半秒。语义细节在 mock-cabin 的 `media/player.ts`，本包只转发。
 */
export interface CabinSinkBeat {
  sinkId: string;
  claim?: boolean;
  alive?: boolean;
  status?: "playing" | "paused" | "stopped";
  positionSec?: number;
  /** 本曲在端上自然播完。车机侧据此推进队列——它自己听不见。 */
  ended?: boolean;
  /** 端上的失败原因。**原样往上带，不吞**。 */
  error?: string;
}

/**
 * 曲目字节的原始响应。
 *
 * **刻意不返回 `Buffer`**：整曲进内存会让 Range 变成一句空话，网关也就没法
 * 一边收一边往端上吐。调用方拿到 `body` 自己 pipe，头原样透传。
 */
export interface CabinTrackStream {
  status: number;
  /** 只带 content-type / content-length / content-range / accept-ranges 四个。 */
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | null;
}

export interface CabinMediaCommand {
  command: string;
  query?: string;
  trackIds?: string[];
  repeat?: string;
  shuffle?: boolean;
  autoplay?: boolean;
  // ── duck 专用（M27）────────────────────────────────────────
  //
  // 让路是**系统行为**：车机播报时压低音乐，播完恢复。触发方是端上的播报链路，
  // 不是模型——`cabin_media` 工具的命令白名单里刻意没有 duck。
  // 这里是传输层的形状，与"谁被允许发它"是两件事，别把白名单写进类型里。
  /** true=压低，false=恢复。 */
  on?: boolean;
  /** 压到原音量的百分之几。 */
  toPercent?: number;
  /** 让路租期（毫秒）。到期自动恢复——恢复请求没送达时的兜底。 */
  holdMs?: number;
}

export interface CabinMediaResponse {
  ok: boolean;
  command?: string;
  /** 这条命令实际选中的曲目——"给你放的是哪首"要从这里说，别从 query 回读。 */
  matched?: CabinTrack[];
  player: CabinPlayerView;
}

export interface RawCabinBackend {
  health(): Promise<{ ok: boolean; synthesizesAnyModel?: boolean; audio?: CabinAudioHealth }>;
  create(model: string): Promise<CabinStatusResponse>;
  status(cabinVehicleId: string): Promise<CabinStatusResponse>;
  apply(cabinVehicleId: string, a: { requestId?: string; ops: CabinApplyOp[] }): Promise<CabinApplyResponse>;
  changes(cabinVehicleId: string): Promise<{ changes: CabinChange[] }>;
  energy(cabinVehicleId: string): Promise<CabinEnergyResponse>;
  mediaLibrary(): Promise<CabinMediaLibrary>;
  mediaPlayer(cabinVehicleId: string): Promise<CabinPlayerView>;
  mediaCommand(cabinVehicleId: string, c: CabinMediaCommand): Promise<CabinMediaResponse>;
  mediaDuck(d: { on: boolean; toPercent?: number; holdMs?: number }): Promise<CabinDuckResult>;
  mediaSink(cabinVehicleId: string, beat: CabinSinkBeat): Promise<CabinPlayerView>;
  /** `range` 是原样透传的 `Range` 头（`bytes=a-b`）。见 `CabinTrackStream`。 */
  mediaTrack(trackId: string, range?: string): Promise<CabinTrackStream>;
}

/**
 * 让路的结果。**不认车辆 id**：主机只有一套喇叭，让路是给正在出声的那个让。
 *
 * 按车走会引入一整类与让路无关的失败——默认车没绑车机、绑的那辆不是正在
 * 放歌的那辆——而那些失败的现象都只是"音乐没让路"，离根因很远。
 * 演示数据里这两条同时成立过，让路请求 100% 失败。
 */
export interface CabinDuckResult {
  ducked: boolean;
  /** 谁被压低了；null = 此刻没人在放。 */
  vehicleId: string | null;
  outputVolume: number | null;
}

/** `/health` 的音频一节。启动探活要打出来——"接上了"和"接上了但一声不出"看起来一样。 */
export interface CabinAudioHealth {
  backend: string;
  note: string;
  tracks: number;
  playable: number;
  mediaDir: string;
}

const TOOL = "cabin";

function unreachable(err: unknown): ToolError {
  return new ToolError(
    TOOL,
    "upstream",
    `车机没连上（${err instanceof Error ? err.message : String(err)}）——这次设置不了，请如实告知车主，不要说"已经调好了"`,
    true,
  );
}

/** HTTP 后端。`baseUrl` 由装配层给，`enterprise/backend/shared/tools` 不读环境变量（注册表文件头第 3 条）。 */
export function createHttpCabinBackend(baseUrl: string, timeoutMs = 3_000): RawCabinBackend {
  const call = async (path: string, init?: RequestInit): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw unreachable(err);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 404 && body.error === "vehicle_not_found") {
      throw new CabinVehicleGoneError(String(body.vehicleId ?? ""));
    }
    // 400 带 hint 的是**业务答复**不是故障："曲库里没有这首歌"要原样递给模型去转述，
    // 报成 upstream 会让它说成"车机出问题了"——两者对车主是完全不同的两句话。
    if (res.status === 400 && typeof body.hint === "string") {
      throw new ToolError(TOOL, "invalid", body.hint, false);
    }
    if (!res.ok) {
      throw new ToolError(TOOL, "upstream", `车机返回 ${res.status}：${String(body.error ?? "unknown")}`, false);
    }
    return body;
  };

  return {
    health: () => call("/health") as Promise<{ ok: boolean; synthesizesAnyModel?: boolean }>,
    create: (model) =>
      call("/vehicles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
      }) as Promise<CabinStatusResponse>,
    status: (id) => call(`/vehicles/${encodeURIComponent(id)}/state`) as Promise<CabinStatusResponse>,
    apply: (id, a) =>
      call(`/vehicles/${encodeURIComponent(id)}/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(a),
      }) as Promise<CabinApplyResponse>,
    changes: (id) => call(`/vehicles/${encodeURIComponent(id)}/changes`) as Promise<{ changes: CabinChange[] }>,
    energy: (id) => call(`/vehicles/${encodeURIComponent(id)}/energy`) as Promise<CabinEnergyResponse>,
    mediaLibrary: () => call("/media/library") as Promise<CabinMediaLibrary>,
    mediaPlayer: (id) => call(`/vehicles/${encodeURIComponent(id)}/media/player`) as Promise<CabinPlayerView>,
    mediaCommand: (id, c) =>
      call(`/vehicles/${encodeURIComponent(id)}/media/player`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(c),
      }) as Promise<CabinMediaResponse>,
    mediaDuck: (d) =>
      call("/media/duck", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(d),
      }) as Promise<CabinDuckResult>,
    mediaSink: (id, beat) =>
      call(`/vehicles/${encodeURIComponent(id)}/media/sink`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(beat),
      }) as Promise<CabinPlayerView>,
    mediaTrack: (trackId, range) => trackBytes(baseUrl, timeoutMs, trackId, range),
  };
}

/** 曲目字节响应里唯一往上带的四个头。别的（Date、Connection）是这一跳自己的事。 */
const TRACK_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges"] as const;

/**
 * 曲目字节。**和 `call()` 并列而不是复用它**，两个理由：
 *
 *  1. `call()` 一律 `res.json()`，音频进去就是一个 parse 错误；
 *  2. `call()` 的 `AbortSignal.timeout` 覆盖到读完 body 为止。套在字节流上的后果是
 *     **一首拉了 3 秒还没完的歌会被自己掐断**，而现象只是"放到一半没了"。
 *     所以这里的超时只覆盖到取回响应头：`fetch` 一 resolve 就 `clearTimeout`，
 *     body 之后爱流多久流多久。
 */
async function trackBytes(
  baseUrl: string,
  timeoutMs: number,
  trackId: string,
  range?: string,
): Promise<CabinTrackStream> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/media/tracks/${encodeURIComponent(trackId)}`, {
      ...(range ? { headers: { range } } : {}),
      signal: ac.signal,
    });
  } catch (err) {
    throw unreachable(err);
  } finally {
    // 头到手就解除。**这一行就是"超时只覆盖响应头"本身**，删了它就退回旧行为。
    clearTimeout(timer);
  }

  // 4xx/5xx 的 body 是 JSON，读成人话再抛——上层只拿到一个数字的话，
  // "这首歌放不了"就永远查不出是没有这首、还是文件太大、还是车机没连上。
  if (res.status >= 400) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const detail = String(body.error ?? res.status);
    if (res.status === 404) {
      throw new ToolError(TOOL, "invalid", `车机曲库里没有这首（${detail}）`, false);
    }
    if (res.status === 413) {
      throw new ToolError(TOOL, "invalid", `这首曲子超过了车机的单曲上限（${body.bytes} > ${body.limit} 字节）`, false);
    }
    throw new ToolError(TOOL, "upstream", `车机返回 ${res.status}：${detail}`, false);
  }

  const headers: Record<string, string> = {};
  for (const h of TRACK_HEADERS) {
    const v = res.headers.get(h);
    if (v !== null) headers[h] = v;
  }
  return { status: res.status, headers, body: res.body };
}

// ── 绑定层（vin ↔ 车机侧 id，含自动重建）─────────────────────

/** 绑定的读写口。装配层用④档案（VehicleStore）实现——本包不 import 存储。 */
export interface CabinBindingStore {
  /** null = 这辆车没有档案（不是"没绑定"——没档案连车型都不知道，无从建号）。 */
  load(vin: string): Promise<{ model: string; cabinVehicleId?: string } | null>;
  save(vin: string, cabinVehicleId: string): Promise<void>;
}

export interface CabinStatusData extends CabinStatusResponse {
  /** 本次调用重建过车机侧车辆（旧 id 悬空）。转述时如实带一句"车机重新连接了"。 */
  rebuilt: boolean;
}

export interface CabinApplyData extends CabinApplyResponse {
  rebuilt: boolean;
}

export interface CabinClient {
  /** 绑定（幂等）：已绑定且车机侧存在则原样返回；悬空或未绑定则建号并回写。 */
  bind(vin: string): Promise<CabinStatusData>;
  status(vin: string): Promise<CabinStatusData>;
  apply(vin: string, a: { requestId?: string; ops: CabinApplyOp[] }): Promise<CabinApplyData>;
  changes(vin: string): Promise<{ changes: CabinChange[] }>;
  /** 剩余电量/油量（读时车机侧推进仿真）。走 withVehicle：悬空绑定自动重建。 */
  energy(vin: string): Promise<CabinEnergyResponse & { rebuilt: boolean }>;
  /** 曲库与车无关（一台车机一份），所以不走绑定层。 */
  mediaLibrary(): Promise<CabinMediaLibrary>;
  /** 让路同理，而且更彻底：它给**正在出声的那个**让，见 `CabinDuckResult`。 */
  mediaDuck(d: { on: boolean; toPercent?: number; holdMs?: number }): Promise<CabinDuckResult>;
  mediaPlayer(vin: string): Promise<CabinPlayerView & { rebuilt: boolean }>;
  mediaCommand(vin: string, c: CabinMediaCommand): Promise<CabinMediaResponse & { rebuilt: boolean }>;
  /** 车机端心跳/认领。走绑定层：车机侧车辆悬空时与 `mediaPlayer` 同样自动重建。 */
  mediaSink(vin: string, beat: CabinSinkBeat): Promise<CabinPlayerView & { rebuilt: boolean }>;
  /** 曲目字节。曲库与车无关，所以和 `mediaLibrary` 一样不走绑定层。 */
  mediaTrack(trackId: string, range?: string): Promise<CabinTrackStream>;
}

/** 从未绑定（≠悬空）：不静默建号，引导车主绑定（AC-49-8）。 */
export class CabinUnboundError extends ToolError {
  constructor(vin: string) {
    super(
      "cabin",
      "invalid",
      `车机未绑定（${vin}）——请引导车主在档案页完成一次绑定；本次先如实说明，不要替他绑定，也不要假装已设置`,
      false,
    );
    this.name = "CabinUnboundError";
  }
}

function noProfile(vin: string): ToolError {
  return new ToolError(
    TOOL,
    "invalid",
    `车辆档案不存在：${vin}——先建档（车型是建号的必要输入），不要替车主猜一辆车`,
    false,
  );
}

export function createCabinClient(backend: RawCabinBackend, store: CabinBindingStore): CabinClient {
  /** 建号 + 回写。重建与首绑走同一条路——差别只在 `rebuilt` 标记。 */
  async function establish(vin: string, model: string): Promise<CabinStatusResponse> {
    const created = await backend.create(model);
    await store.save(vin, created.vehicleId);
    return created;
  }

  async function resolve(vin: string): Promise<{ model: string; cabinVehicleId?: string }> {
    const binding = await store.load(vin);
    if (!binding) throw noProfile(vin);
    return binding;
  }

  /**
   * 带自动重建地执行一次车机操作。**只重试一次**：重建后仍 404 说明问题不是
   * "车没了"（比如 mock 在反复重启），按不可达处理，不进重试循环。
   */
  async function withVehicle<T>(vin: string, run: (cabinVehicleId: string) => Promise<T>): Promise<{ value: T; rebuilt: boolean }> {
    const binding = await resolve(vin);
    // **从未绑定 ≠ 悬空**：前者要引导（绑定是车主的显式动作，AC-49-8），
    // 后者是 mock 重启的技术状态，自动修复（F-49-09）。混成一条会让工具静默替车主绑定。
    if (!binding.cabinVehicleId) throw new CabinUnboundError(vin);
    try {
      return { value: await run(binding.cabinVehicleId), rebuilt: false };
    } catch (err) {
      if (!(err instanceof CabinVehicleGoneError)) throw err;
      // 悬空：mock 重启清了内存。按档案车型重建、回写、重试一次。
    }
    const created = await establish(vin, binding.model);
    try {
      return { value: await run(created.vehicleId), rebuilt: true };
    } catch (err) {
      if (err instanceof CabinVehicleGoneError) throw unreachable(err);
      throw err;
    }
  }

  return {
    async bind(vin) {
      const binding = await resolve(vin);
      if (binding.cabinVehicleId) {
        try {
          return { ...(await backend.status(binding.cabinVehicleId)), rebuilt: false };
        } catch (err) {
          if (!(err instanceof CabinVehicleGoneError)) throw err;
        }
        return { ...(await establish(vin, binding.model)), rebuilt: true };
      }
      return { ...(await establish(vin, binding.model)), rebuilt: false };
    },

    async status(vin) {
      const { value, rebuilt } = await withVehicle(vin, (id) => backend.status(id));
      return { ...value, rebuilt };
    },

    async apply(vin, a) {
      const { value, rebuilt } = await withVehicle(vin, (id) => backend.apply(id, a));
      return { ...value, rebuilt };
    },

    async changes(vin) {
      const { value } = await withVehicle(vin, (id) => backend.changes(id));
      return value;
    },

    async energy(vin) {
      const { value, rebuilt } = await withVehicle(vin, (id) => backend.energy(id));
      return { ...value, rebuilt };
    },

    mediaLibrary: () => backend.mediaLibrary(),

    mediaDuck: (d) => backend.mediaDuck(d),

    async mediaPlayer(vin) {
      const { value, rebuilt } = await withVehicle(vin, (id) => backend.mediaPlayer(id));
      return { ...value, rebuilt };
    },

    async mediaCommand(vin, c) {
      // 走 withVehicle 是为了继承悬空自动重建。**重建过就意味着播放队列没了**
      // （车机侧的播放器跟着车辆 id 走），`rebuilt` 要一路带到转述层：
      // 用户问"刚才那首呢"，答案是"车机重连了、队列重置了"，不是装作无事发生。
      const { value, rebuilt } = await withVehicle(vin, (id) => backend.mediaCommand(id, c));
      return { ...value, rebuilt };
    },

    async mediaSink(vin, beat) {
      // 与 mediaCommand 同待遇：重建过意味着播放队列没了，`rebuilt` 一路带上去，
      // 端据此重新认领而不是对着一个已经不存在的队列继续心跳。
      const { value, rebuilt } = await withVehicle(vin, (id) => backend.mediaSink(id, beat));
      return { ...value, rebuilt };
    },

    mediaTrack: (trackId, range) => backend.mediaTrack(trackId, range),
  };
}

// ── 注入口（装配层设置；未注入 = 未接入）────────────────────

let client: CabinClient | undefined;

/**
 * **注入口留了不等于接上了**（M15-01 `car_catalog` 教训）：装配处必须有测试，
 * selfcheck 的 mock-cabin 项自 M24-02 起为阻断级。
 */
export function setCabinClient(c: CabinClient | undefined): void {
  client = c;
}

export function getCabinClient(): CabinClient | undefined {
  return client;
}

export function requireCabinClient(): CabinClient {
  if (!client) {
    throw new ToolError(
      TOOL,
      "unconfigured",
      "车机未接入（MOCK_CABIN_URL 未配置）——座舱设置不可用，请如实告知车主",
      false,
    );
  }
  return client;
}
