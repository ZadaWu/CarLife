/**
 * 播放器 —— 队列、游标、传输控制，以及与舒适域媒体设置的对账。
 *
 * # 不新开一套音量/开关：媒体域已有的就是播放器的
 *
 * `state.media[zone]` 里本来就有 `source` / `volume` / `volumeLimit` / `contentTag`。
 * 播放器**不另存一份**：`source` 就是总开关（`off` = 停），`volume` 就是主机输出音量，
 * `contentTag` 就是"现在放的是什么"。理由是单一真相源——两份状态早晚会分叉，
 * 分叉的表现是 UI 显示在放、喇叭里没声音（或者反过来），而且很难查。
 *
 * 好处是既有那条链路零改动就能出声：Agent 侧原本的"上车放点音乐、音量 20"
 * 走的还是 `apply {domain:"media", set:{source:"music", volume:20}}`，
 * 现在它会真的响。新端点只管队列与传输这些设置模型表达不了的动作。
 *
 * # 主机只有一对喇叭：全服务一个出声位
 *
 * 每辆车都有独立的播放器状态，但真正出声的只有**最后一个起播的**那辆。
 * 别的车照常维护队列与播放态，`audible:false` 并说明被谁抢了。
 * 不这么做的话，造两辆车各点一首歌，现场会同时听到两首——那不像车机，像事故。
 *
 * # 分区同理
 *
 * `cabin` / `rear` 是车上的概念，主机分不出来。出声位绑定在一个分区上
 * （`MOCK_CABIN_AUDIBLE_ZONE`，默认 `cabin`），其余分区的媒体设置照常记录、
 * 但不产生声音。**如实上报**，别让人以为后排在放歌。
 *
 * # 出声位可以不在这台机器上（M63-01）
 *
 * 上面那套"主机的喇叭"只在**全部跑在一台机器上**时成立。部署之后 mock-cabin
 * 住在服务器的容器里：那里既没有 mpg123 也没有声卡，装上也没用——响的是服务器，
 * 而车主在车里。所以出声位现在可以由**车机端认领**（`sinkBeat()`）：
 * 端把字节拉走自己放，本进程只维护状态机，`audible` 说的是**端上**有没有声音。
 *
 * 两条路互斥：端认领的那一刻服务端后端立刻停（`backend.stop()`），
 * 之后不再起播——两边同时放就是两首歌叠在一起。端的租约过期（`SINK_TTL_MS`）
 * 后出声位退回服务端后端，单机 demo 因此一行没变。
 */

import { createBackend, backendCaps, type BackendCaps, type PlaybackBackend } from "./backend";
import {
  absPathOf,
  findTrack,
  getLibrary,
  searchTracks,
  type Library,
  type Track,
} from "./library";
import { setMediaField, type VehicleRecord } from "../state";

export type PlayerStatus = "playing" | "paused" | "stopped";
export type RepeatMode = "off" | "one" | "all";

export interface PlayerView {
  vehicleId: string;
  zone: string;
  status: PlayerStatus;
  /** 这辆车此刻是不是真的在主机上出声。false 时 `audibleNote` 说明为什么。 */
  audible: boolean;
  audibleNote?: string;
  nowPlaying: (Track & { positionSec: number | null }) | null;
  queue: Track[];
  cursor: number;
  repeat: RepeatMode;
  shuffle: boolean;
  /** 以下四项是 `state.media[zone]` 的投影，不是播放器自己的副本。 */
  source: string;
  /** 设置值（`state.media[zone].volume`）。让路中实际输出的是 `outputVolume`。 */
  volume: number;
  /** 真正送到播放后端的音量：夹过分区上限、让路中再按比例压低。 */
  outputVolume: number;
  volumeLimit: number | null;
  contentTag: string | null;
  /** 让路中（暖暖说话时压低）。恢复后回到 `volume`。 */
  ducked: boolean;
  /** 让路租约到期时刻（ISO）。到点自动恢复，见 `duck()`。 */
  duckedUntil?: string;
  backend: BackendCaps;
  /** 谁在出声。`audible` 的主语由它决定，转述时要一起读。 */
  sink: PlayerSinkView;
}

/**
 * 出声位现状。
 *
 * `kind` 与 `audible` 是两件事：`client` 只说明端认领了出声位，
 * 它有没有真的在响要看 `clientStatus`（以及 `audible` 本身）。
 */
export interface PlayerSinkView {
  /** `client` = 车机端；`host` = 服务端后端；`none` = 谁也放不了。 */
  kind: "client" | "host" | "none";
  /** kind==="client" 时的认领者。 */
  sinkId?: string;
  /** 端最近一次上报的播放态；可能落后于 `status`（刚发 play 还没拉到字节）。 */
  clientStatus?: PlayerStatus;
  /** 人话说明。`audibleNote` 为空时的兜底解释。 */
  note: string;
}

/** 车机端认领的出声位。 */
export interface ClientSink {
  sinkId: string;
  /** 最近一次心跳时刻（epoch ms）。超过 `SINK_TTL_MS` 就当它没了。 */
  beatAt: number;
  status: PlayerStatus;
  positionSec: number | null;
  error: string | null;
}

/** 端上报的一次心跳。 */
export interface SinkBeat {
  sinkId: string;
  /**
   * 抢占。**只有 `true` 才换持有者**——续租不抢占。
   * 没有这个区分，两个端会每秒互抢一次，表现是两边各放半秒，
   * 比只有一个能放糟得多。
   */
  claim?: boolean;
  /** `false` = 主动交还出声位（端要退出了）。 */
  alive?: boolean;
  status?: PlayerStatus;
  positionSec?: number;
  /** 本曲在端上自然播完。服务端据此推进队列——它自己听不见，只能靠端说。 */
  ended?: boolean;
  /** 端上的失败原因（拉字节失败、解码失败）。**原样上报，不吞**。 */
  error?: string;
}

/**
 * 端上出声位的租期。端 1 s 一次心跳，5 s 没消息就当它没了。
 *
 * 与让路租约（`duck()`）同一条理由：端崩了、网断了不会有人来"取消认领"，
 * 纯开关语义下的后果是出声位永远被一个已经不存在的端占着，而且一声不响。
 */
export const SINK_TTL_MS = 5_000;

/**
 * 时钟。租约到期要能在测试里推进，而不是真的等 5 秒——
 * 一条 `sleep(5000)` 的用例，跑一百次就是八分钟。
 */
let nowMs: () => number = () => Date.now();

/** 测试用：注入时钟；传 `null` 恢复真实时间。 */
export function __setClock(fn: (() => number) | null): void {
  nowMs = fn ?? (() => Date.now());
}

/** 出声分区。车型没有这个分区时退回它的第一个媒体分区。 */
export function audibleZoneOf(record: VehicleRecord): string {
  const zones = record.caps.media.zones as string[];
  const want = (process.env.MOCK_CABIN_AUDIBLE_ZONE ?? "cabin").trim();
  return zones.includes(want) ? want : (zones[0] ?? "cabin");
}

/** 让路时压到原音量的百分之几。 */
const DEFAULT_DUCK_TO = 30;
/**
 * 让路的默认租期。一句播报再长也到不了这个量级，所以正常路径永远等不到它；
 * 它只在"恢复请求没送达"时兜底。取 30 秒是个折中：短到用户不会以为车坏了，
 * 长到不会把一段正常播报截断成半程恢复音量。
 */
const DEFAULT_DUCK_HOLD_MS = 30_000;
const MAX_DUCK_HOLD_MS = 120_000;

class Player {
  readonly vehicleId: string;
  queue: Track[] = [];
  cursor = 0;
  status: PlayerStatus = "stopped";
  repeat: RepeatMode = "all";
  shuffle = false;
  ducked = false;
  duckTo = DEFAULT_DUCK_TO;
  /** 让路租约的到期时刻（null = 没在让路）。见 `duck()`。 */
  duckUntil: number | null = null;
  private duckTimer: ReturnType<typeof setTimeout> | null = null;
  backend: PlaybackBackend | null = null;
  lastError: string | null = null;
  /** 车机端认领的出声位。null = 没有端在放，出声位归服务端后端。 */
  clientSink: ClientSink | null = null;

  constructor(
    vehicleId: string,
    private readonly record: VehicleRecord,
  ) {
    this.vehicleId = vehicleId;
  }

  get zone(): string {
    return audibleZoneOf(this.record);
  }

  private mediaState() {
    return this.record.state.media[this.zone as "cabin" | "rear"];
  }

  /** 实际下发给后端的音量：让路时按比例压低，且永远不越过分区上限。 */
  effectiveVolume(): number {
    const ms = this.mediaState();
    const base = ms?.volume ?? 20;
    const limited = ms?.volumeLimit !== null && ms?.volumeLimit !== undefined ? Math.min(base, ms.volumeLimit) : base;
    return this.ducked ? Math.round((limited * this.duckTo) / 100) : limited;
  }

  current(): Track | null {
    return this.queue[this.cursor] ?? null;
  }

  // ── 端上出声位 ────────────────────────────────────────────

  /** 活着的端 sink；过期的当没有。 */
  liveSink(): ClientSink | null {
    if (!this.clientSink) return null;
    return nowMs() - this.clientSink.beatAt > SINK_TTL_MS ? null : this.clientSink;
  }

  /**
   * 端上的一次心跳 / 认领。
   *
   * 三条语义，缺一条都会咬人：
   *  - `alive:false` 交还出声位（只有持有者交得了，别人交不了别人的）；
   *  - `claim:true` 才抢占，**续租不抢占**（理由见 `SinkBeat.claim`）；
   *  - 非持有者不带 `claim` 的心跳照常回状态，但**不改变持有者**。
   */
  sinkBeat(beat: SinkBeat): void {
    const holder = this.liveSink();
    const isHolder = holder?.sinkId === beat.sinkId;

    if (beat.alive === false) {
      if (isHolder) this.clientSink = null;
      return;
    }
    if (!isHolder && !beat.claim) return;

    if (!isHolder) {
      // 认领的第一件事是让服务端后端闭嘴。单机 demo 下端与 mock 在同一台机器上，
      // 不停的话就是同一首歌错开半秒放两遍。
      this.backend?.stop();
    }
    this.clientSink = {
      sinkId: beat.sinkId,
      beatAt: nowMs(),
      status: beat.status ?? this.status,
      positionSec: typeof beat.positionSec === "number" ? beat.positionSec : null,
      error: typeof beat.error === "string" && beat.error.trim() ? beat.error.trim() : null,
    };
    // 本曲在端上播完了。服务端听不见，队列只能靠这一句往前走——
    // 它对应的正是服务端后端那条 `onEnded` 回调。
    if (beat.ended) this.onTrackEnded();
  }

  private sinkView(): PlayerSinkView {
    const live = this.liveSink();
    if (live) {
      return {
        kind: "client",
        sinkId: live.sinkId,
        clientStatus: live.status,
        note: live.error
          ? `车机端持有出声位，但它报了错：${live.error}`
          : `车机端（${live.sinkId}）持有出声位`,
      };
    }
    const caps = backendCaps();
    return caps.name === "none"
      ? { kind: "none", note: `车机端没有认领出声位，服务端也放不了：${caps.note}` }
      : {
          kind: "host",
          note: `车机端没有认领出声位，暂由服务端 ${caps.name} 出声（单机调试形态）`,
        };
  }

  private ensureBackend(): PlaybackBackend {
    if (this.backend) return this.backend;
    this.backend = createBackend({
      onEnded: () => this.onTrackEnded(),
      onError: (m) => {
        this.lastError = m;
        this.status = "stopped";
        this.writeBackStopped();
      },
    });
    return this.backend;
  }

  /** 一曲自然播完：按 repeat / shuffle 推进。 */
  private onTrackEnded(): void {
    if (this.status !== "playing") return;
    if (this.repeat === "one") {
      this.startCurrent();
      return;
    }
    const last = this.cursor >= this.queue.length - 1;
    if (last && this.repeat === "off") {
      this.status = "stopped";
      this.writeBackStopped();
      return;
    }
    this.cursor = last ? 0 : this.cursor + 1;
    if (last && this.shuffle) this.reshuffle();
    this.startCurrent();
  }

  private reshuffle(): void {
    // Fisher-Yates。整轮放完才重洗，避免"随机"退化成一首歌反复出现。
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
  }

  private startCurrent(): void {
    const track = this.current();
    if (!track) {
      this.status = "stopped";
      this.writeBackStopped();
      return;
    }
    if (!track.playable) {
      this.lastError = track.reason ?? "该曲目当前后端放不了";
      this.status = "stopped";
      this.writeBackStopped();
      return;
    }
    claimAudioSlot(this);
    this.lastError = null;
    // 端认领了出声位就由端出声，服务端一声不发。状态机照常走——
    // 端是从动方，它靠轮询这份状态知道该放哪首。
    if (!this.liveSink()) this.ensureBackend().load(absPathOf(track), this.effectiveVolume());
    this.status = "playing";
    this.writeBackPlaying(track);
  }

  // ── 与舒适域状态的回写 ────────────────────────────────────
  //
  // 起播/停播要让 `state.media[zone]` 跟着动，否则 `GET /state` 与
  // `cabin_status` 工具看到的还是 `source:"off"`，而喇叭里正在放歌。

  private writeBackPlaying(track: Track): void {
    setMediaField(this.record, this.zone, "source", "music");
    setMediaField(this.record, this.zone, "contentTag", track.title);
  }

  private writeBackStopped(): void {
    setMediaField(this.record, this.zone, "source", "off");
    setMediaField(this.record, this.zone, "contentTag", null);
  }

  // ── 传输控制 ──────────────────────────────────────────────

  play(): void {
    if (this.status === "paused") {
      claimAudioSlot(this);
      if (!this.liveSink()) this.ensureBackend().resume();
      this.status = "playing";
      const t = this.current();
      if (t) this.writeBackPlaying(t);
      return;
    }
    if (this.status === "playing") return;
    this.startCurrent();
  }

  pause(): void {
    if (this.status !== "playing") return;
    this.backend?.pause();
    this.status = "paused";
    // 暂停不改 source：车机上暂停后媒体源还是"音乐"，只是没在响。
  }

  stop(): void {
    this.backend?.stop();
    this.status = "stopped";
    this.writeBackStopped();
    releaseAudioSlot(this);
  }

  next(): void {
    if (!this.queue.length) return;
    const last = this.cursor >= this.queue.length - 1;
    this.cursor = last ? 0 : this.cursor + 1;
    if (last && this.shuffle) this.reshuffle();
    if (this.status === "stopped") return;
    this.startCurrent();
  }

  previous(): void {
    if (!this.queue.length) return;
    // 车机的通行做法：放过 3 秒以上的，「上一首」先理解成「重放这一首」。
    // 后端报不了进度就没这一档，直接退到上一首。
    const pos = this.backend?.positionSec() ?? null;
    if (pos !== null && pos > 3 && this.status !== "stopped") {
      this.startCurrent();
      return;
    }
    this.cursor = this.cursor <= 0 ? Math.max(0, this.queue.length - 1) : this.cursor - 1;
    if (this.status === "stopped") return;
    this.startCurrent();
  }

  setQueue(tracks: Track[], startIndex: number, autoplay: boolean): void {
    this.queue = tracks;
    this.cursor = Math.max(0, Math.min(startIndex, Math.max(0, tracks.length - 1)));
    if (this.shuffle && tracks.length > 1) {
      // 洗牌后把点名的那首挪到最前——「随机播放」不该让点歌点不准。
      const picked = this.queue[this.cursor];
      this.reshuffle();
      const at = this.queue.indexOf(picked);
      if (at > 0) [this.queue[0], this.queue[at]] = [this.queue[at], this.queue[0]];
      this.cursor = 0;
    }
    if (autoplay) this.startCurrent();
    else if (this.status !== "stopped") this.startCurrent();
  }

  enqueue(tracks: Track[]): void {
    this.queue.push(...tracks);
    if (this.status === "stopped" && this.queue.length === tracks.length) {
      // 队列本来是空的：追加即起播，符合「再放一首」的直觉。
      this.cursor = 0;
    }
  }

  /**
   * 让路（车机播报期间把音乐压低）。**是租约不是开关**。
   *
   * 触发方是车机端的播报链路：说话前压低、说完恢复。而"说完"那一次调用
   * 是可能永远不来的——播报进程崩了、客户端被关掉、网络断了。
   * 纯开关语义下的后果是**音乐永远停在压低状态，而且一声不响**：
   * 用户只觉得"这车怎么声音这么小"，不会往一次没送达的恢复请求上想。
   *
   * 所以压低带一个到期时间，到点自动恢复。要压更久就续租（再发一次）。
   * 恢复请求照常发、照常立即生效——租约只是它没送达时的兜底。
   */
  duck(on: boolean, toPercent?: number, holdMs?: number): void {
    if (typeof toPercent === "number") this.duckTo = Math.max(0, Math.min(100, Math.round(toPercent)));
    if (this.duckTimer) {
      clearTimeout(this.duckTimer);
      this.duckTimer = null;
    }
    this.ducked = on;
    if (on) {
      const hold = Math.max(1_000, Math.min(MAX_DUCK_HOLD_MS, Math.round(holdMs ?? DEFAULT_DUCK_HOLD_MS)));
      this.duckUntil = Date.now() + hold;
      this.duckTimer = setTimeout(() => {
        this.duckTimer = null;
        this.duckUntil = null;
        this.ducked = false;
        this.applyVolume();
      }, hold);
      // 不能因为一个兜底定时器就让进程退不出去。
      this.duckTimer.unref?.();
    } else {
      this.duckUntil = null;
    }
    this.applyVolume();
  }

  /** 音量变了（apply 改的、或 duck 改的）：推给后端。 */
  applyVolume(): void {
    if (this.status === "stopped") return;
    this.backend?.setVolume(this.effectiveVolume());
  }

  /**
   * 与舒适域状态对账。`apply` 之后调，做的是**声明式收敛**而不是事件 diff：
   * 无论谁把 `source` 改成了 `off`，收敛的结果都是停下来。
   *
   * `lib` 是为了"把媒体源切到音乐但队列是空的"这一种情况：车机上按下音源键
   * 就该出声，所以这里**拿整个曲库当默认队列**。不这么做的话，
   * `apply {source:"music"}` 会写下一个"在放音乐"的状态却一声不出——
   * 状态说在放、喇叭里没有，是这套东西最不该有的那种假话。
   * 曲库也是空的时候，`startCurrent()` 会把 source 写回 `off`，
   * 于是 apply 的响应里带的是真状态，模型转述时不会说"已经放上了"。
   */
  reconcile(lib: Library): void {
    const ms = this.mediaState();
    if (!ms) return;
    if (ms.source === "off" && this.status !== "stopped") {
      this.backend?.stop();
      this.status = "stopped";
      releaseAudioSlot(this);
      setMediaField(this.record, this.zone, "contentTag", null);
      return;
    }
    if (ms.source === "music" && this.status === "stopped") {
      if (!this.queue.length) this.queue = lib.tracks.filter((t) => t.playable);
      if (this.queue.length) {
        this.cursor = Math.min(this.cursor, this.queue.length - 1);
        this.startCurrent();
        return;
      }
      // 曲库空：如实收敛回 off，别留一个"在放"的状态。
      this.writeBackStopped();
      return;
    }
    this.applyVolume();
  }

  view(lib: Library): PlayerView {
    const ms = this.mediaState();
    const track = this.current();
    const slotHolder = audioSlot;
    const live = this.liveSink();
    let audible: boolean;
    let audibleNote: string | undefined;
    if (live) {
      // 端持有出声位：`audible` 的主语是车机，服务端有没有播放后端与它无关。
      audible = this.status !== "stopped" && live.status === "playing";
      if (!audible) {
        audibleNote = live.error
          ? `车机端没放出来：${live.error}`
          : this.status === "stopped"
            ? "未在播放"
            : `车机端上报的是 ${live.status}`;
      }
    } else {
      // 没有端认领：与本单之前逐字相同的三条分支（单机 demo 走这里）。
      audible = this.status !== "stopped" && slotHolder === this && backendCaps().name !== "none";
      if (!audible) {
        if (backendCaps().name === "none") audibleNote = backendCaps().note;
        else if (this.status === "stopped") audibleNote = "未在播放";
        else if (slotHolder && slotHolder !== this)
          audibleNote = `主机的出声位被车辆 ${slotHolder.vehicleId} 占用（一台主机只有一套喇叭）`;
      }
    }
    return {
      vehicleId: this.vehicleId,
      zone: this.zone,
      status: this.status,
      audible,
      ...(audibleNote ? { audibleNote } : {}),
      nowPlaying: track
        ? {
            ...track,
            // 端在放的时候进度只有端知道；服务端后端此刻是停着的，问它恒为 null。
            positionSec:
              this.status === "stopped"
                ? null
                : live
                  ? live.positionSec
                  : (this.backend?.positionSec() ?? null),
          }
        : null,
      queue: this.queue,
      cursor: this.cursor,
      repeat: this.repeat,
      shuffle: this.shuffle,
      source: ms?.source ?? "off",
      volume: ms?.volume ?? 0,
      volumeLimit: ms?.volumeLimit ?? null,
      contentTag: ms?.contentTag ?? null,
      ducked: this.ducked,
      // `volume` 是设置值，让路时真正送到后端的是另一个数。不报出来的话，
      // 「音乐怎么这么小声」就只能靠猜——而这两个数正是答案本身。
      outputVolume: this.effectiveVolume(),
      // 租约到期时刻同理，排查时第一眼看它。
      ...(this.duckUntil ? { duckedUntil: new Date(this.duckUntil).toISOString() } : {}),
      backend: this.backend?.caps ?? backendCaps(),
      sink: this.sinkView(),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(lib.tracks.length === 0
        ? { libraryEmpty: true, libraryHint: `资源目录里还没有音频文件：${lib.dir}` }
        : {}),
    } as PlayerView;
  }

  dispose(): void {
    if (this.duckTimer) {
      clearTimeout(this.duckTimer);
      this.duckTimer = null;
    }
    this.backend?.dispose();
    this.backend = null;
    this.clientSink = null;
    this.status = "stopped";
  }
}

// ── 出声位（全服务一个）────────────────────────────────────

let audioSlot: Player | null = null;

function claimAudioSlot(p: Player): void {
  if (audioSlot === p) return;
  if (audioSlot) {
    // 抢占：让出的那辆车真的停下来，不留一个还在响的后台进程。
    audioSlot.backend?.stop();
    audioSlot.status = "stopped";
  }
  audioSlot = p;
}

function releaseAudioSlot(p: Player): void {
  if (audioSlot === p) audioSlot = null;
}

// ── 按车持有 ────────────────────────────────────────────────

const players = new Map<string, Player>();

export function playerFor(record: VehicleRecord): Player {
  let p = players.get(record.vehicleId);
  if (!p) {
    p = new Player(record.vehicleId, record);
    players.set(record.vehicleId, p);
  }
  return p;
}

/**
 * apply 之后对账。index.ts 在每次 `POST /apply` 与 `POST /reset` 后调一次。
 *
 * 车还没有播放器时也要建一个：`apply {source:"music"}` 是**第一次**碰媒体域的
 * 常见路径（Agent 侧的 `cabin_control` 走的就是它），此时若没有播放器就静默跳过，
 * 表现正是"状态写了在放音乐，喇叭里没声音"。
 */
export async function reconcileAfterApply(record: VehicleRecord): Promise<void> {
  const ms = record.state.media[audibleZoneOf(record) as "cabin" | "rear"];
  if (!players.has(record.vehicleId) && ms?.source !== "music") return;
  playerFor(record).reconcile(await getLibrary());
}

/**
 * 给**正在出声的那个**让路。不认车辆 id。
 *
 * # 为什么不按车走
 *
 * 让路的物理事实是"主机这套喇叭现在要让给播报"，而主机只有一套喇叭——
 * 出声位同一时刻只有一个占用者（见本文件头）。按 vin 找车会引入一整类
 * 与让路无关的失败：默认车没绑车机、绑的那辆不是正在放歌的那辆。
 * 演示数据里这两条**同时**成立过：默认车是迈锐宝 XL（未绑定），
 * 放歌的是另一辆 Model Y，于是让路请求 100% 失败且现象只是"音乐没让路"。
 *
 * 没人在放就是没人在放，如实返回 `ducked:false`，不要凭空造一个播放器出来。
 */
export function duckAudible(
  on: boolean,
  toPercent?: number,
  holdMs?: number,
): { ducked: boolean; vehicleId: string | null; outputVolume: number | null } {
  const p = audioSlot;
  if (!p) return { ducked: false, vehicleId: null, outputVolume: null };
  p.duck(on, toPercent, holdMs);
  return { ducked: p.ducked, vehicleId: p.vehicleId, outputVolume: p.effectiveVolume() };
}

/**
 * 端上的一次心跳 / 认领。**总是回一份最新状态**——心跳与取状态是同一次往返，
 * 端不必为了知道该放哪首而再打一个端点。
 */
export async function sinkBeatFor(record: VehicleRecord, beat: SinkBeat): Promise<PlayerView> {
  const p = playerFor(record);
  p.sinkBeat(beat);
  return p.view(await getLibrary());
}

/** 此刻有几个车机端持着出声位。`/health` 用它回答"车机到底连上没有"。 */
export function liveClientSinkCount(): number {
  let n = 0;
  for (const p of players.values()) if (p.liveSink()) n += 1;
  return n;
}

export function disposePlayer(vehicleId: string): void {
  const p = players.get(vehicleId);
  if (!p) return;
  releaseAudioSlot(p);
  p.dispose();
  players.delete(vehicleId);
}

export function __resetPlayers(): void {
  for (const id of [...players.keys()]) disposePlayer(id);
  players.clear();
  audioSlot = null;
}

// ── 命令 ────────────────────────────────────────────────────

export interface PlayerCommand {
  command?: string;
  trackIds?: unknown;
  query?: unknown;
  startIndex?: unknown;
  autoplay?: unknown;
  repeat?: unknown;
  shuffle?: unknown;
  on?: unknown;
  toPercent?: unknown;
  holdMs?: unknown;
}

export interface CommandOutcome {
  ok: boolean;
  error?: string;
  hint?: string;
  /** 这条命令实际选中的曲目（点歌时用来如实回话："给你放的是 X"）。 */
  matched?: Track[];
}

export const PLAYER_COMMANDS = [
  "select",
  "enqueue",
  "play",
  "pause",
  "next",
  "previous",
  "stop",
  "mode",
  "duck",
] as const;

/** 把 `{trackIds}` / `{query}` 解析成曲目列表。两者都没有 = 整个曲库。 */
function resolveTracks(lib: Library, body: PlayerCommand): { tracks?: Track[]; error?: string; hint?: string } {
  if (Array.isArray(body.trackIds) && body.trackIds.length) {
    const tracks: Track[] = [];
    const missing: string[] = [];
    for (const id of body.trackIds) {
      const t = typeof id === "string" ? findTrack(lib, id) : undefined;
      if (t) tracks.push(t);
      else missing.push(String(id));
    }
    // 编一个 trackId 会死在这里，与 vehicle_not_found 同一条防编纪律。
    if (missing.length) {
      return { error: "track_not_found", hint: `曲库里没有：${missing.join("、")}。先 GET /media/library 看有哪些。` };
    }
    return { tracks };
  }
  if (typeof body.query === "string" && body.query.trim()) {
    const hits = searchTracks(lib, body.query);
    if (!hits.length) {
      return {
        error: "no_match",
        hint: `曲库里没有匹配「${body.query}」的曲目。共 ${lib.tracks.length} 首，GET /media/library 可列出。`,
      };
    }
    return { tracks: hits };
  }
  if (!lib.tracks.length) {
    return { error: "library_empty", hint: `资源目录里还没有音频文件：${lib.dir}` };
  }
  return { tracks: [...lib.tracks] };
}

export async function runCommand(record: VehicleRecord, body: PlayerCommand): Promise<CommandOutcome> {
  const lib = await getLibrary();
  const p = playerFor(record);
  const cmd = String(body.command ?? "").trim();

  if (!PLAYER_COMMANDS.includes(cmd as (typeof PLAYER_COMMANDS)[number])) {
    return { ok: false, error: "unknown_command", hint: `command 可选 ${PLAYER_COMMANDS.join("/")}` };
  }

  switch (cmd) {
    case "select":
    case "enqueue": {
      const r = resolveTracks(lib, body);
      if (!r.tracks) return { ok: false, error: r.error, hint: r.hint };
      if (cmd === "enqueue") {
        p.enqueue(r.tracks);
        if (body.autoplay === true) p.play();
      } else {
        const start = typeof body.startIndex === "number" ? body.startIndex : 0;
        // 点歌默认就放——「点歌但不播」不是这个动作的常态。
        p.setQueue(r.tracks, start, body.autoplay !== false);
      }
      return { ok: true, matched: r.tracks };
    }
    case "play":
      if (!p.queue.length) {
        const r = resolveTracks(lib, body);
        if (!r.tracks) return { ok: false, error: r.error, hint: r.hint };
        p.setQueue(r.tracks, 0, true);
        return { ok: true, matched: r.tracks };
      }
      p.play();
      return { ok: true };
    case "pause":
      p.pause();
      return { ok: true };
    case "next":
      if (!p.queue.length) return { ok: false, error: "queue_empty", hint: "先 select 一批曲目" };
      p.next();
      return { ok: true };
    case "previous":
      if (!p.queue.length) return { ok: false, error: "queue_empty", hint: "先 select 一批曲目" };
      p.previous();
      return { ok: true };
    case "stop":
      p.stop();
      return { ok: true };
    case "mode": {
      if (body.repeat !== undefined) {
        const r = String(body.repeat);
        if (!["off", "one", "all"].includes(r)) {
          return { ok: false, error: "invalid_repeat", hint: "repeat 可选 off/one/all" };
        }
        p.repeat = r as RepeatMode;
      }
      if (body.shuffle !== undefined) {
        if (typeof body.shuffle !== "boolean") return { ok: false, error: "invalid_shuffle", hint: "shuffle 需要 boolean" };
        p.shuffle = body.shuffle;
      }
      return { ok: true };
    }
    case "duck": {
      const on = body.on !== false;
      const to = typeof body.toPercent === "number" ? body.toPercent : undefined;
      const hold = typeof body.holdMs === "number" ? body.holdMs : undefined;
      p.duck(on, to, hold);
      return { ok: true };
    }
    default:
      return { ok: false, error: "unknown_command" };
  }
}

export async function viewFor(record: VehicleRecord): Promise<PlayerView> {
  const lib = await getLibrary();
  return playerFor(record).view(lib);
}
