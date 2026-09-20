/**
 * 浏览器里的按住说话（ACR-049 第 4 步）。
 *
 * # 端上不做识别
 *
 * 网关的发消息接口本来就收 `audio/*` 原始字节并在服务端转写。原生端发的是
 * `pcm_s16le` / 16 kHz / 单声道，这里照着发同一种格式——网关把 PCM 包成 WAV 交给 ASR，
 * 不会有 webm / opus 这类容器格式不被接受的问题。
 *
 * # 为什么对车机端是必需项
 *
 * 车机界面没有文字输入框，`sendText` 只在程序内部用（点时间轴节点、"结束导航"），
 * 对话入口只有长按说话。浏览器里没有语音，车机端就是一个只能看的界面。
 *
 * # 不做的事
 *
 * 常驻哨兵、唤醒词、回声消除后的打断——那是 Rust 里 VAD + AEC + 常驻监听的一整条链。
 * 浏览器自带的 echoCancellation 够按住说话用，别的不碰。
 */

export const TARGET_RATE = 16_000;

/** 线性插值重采样到 16 kHz。浏览器的采样率由设备定（常见 44.1k / 48k），不能假设。 */
export function resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_RATE) return input;
  const ratio = inputRate / TARGET_RATE;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, input.length - 1);
    const frac = pos - left;
    out[i] = input[left] * (1 - frac) + input[right] * frac;
  }
  return out;
}

/** Float32 [-1, 1] → 有符号 16 位小端。越界钳住，不回绕——回绕出来的是爆音。 */
export function encodePcmS16le(samples: Float32Array): Uint8Array {
  const out = new DataView(new ArrayBuffer(samples.length * 2));
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}

export function concat(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export interface Recording {
  bytes: Uint8Array;
  durationMs: number;
}

export interface Recorder {
  start(): Promise<void>;
  stop(): Promise<Recording>;
  readonly active: boolean;
}

/** 单段上限。原生端也有封顶；一段按住说话没有理由超过一分钟，超了多半是松手事件丢了。 */
const MAX_MS = 60_000;

/**
 * 基于 getUserMedia 的录音器。
 *
 * 用 ScriptProcessorNode 而不是 AudioWorklet：前者已标记废弃但所有浏览器都还在，
 * 而后者要单独加载一个模块文件——挂在子路径（`/mobile/`）和创空间的 iframe 下，
 * 多一个要对路径的资源就多一处会静默 404 的地方。演示用途，取稳。
 */
export function createBrowserRecorder(): Recorder {
  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let node: ScriptProcessorNode | null = null;
  let chunks: Float32Array[] = [];
  let startedAt = 0;

  const cleanup = () => {
    node?.disconnect();
    stream?.getTracks().forEach((t) => t.stop());
    void ctx?.close().catch(() => undefined);
    node = null;
    stream = null;
    ctx = null;
  };

  return {
    get active() {
      return ctx !== null;
    },
    async start() {
      if (ctx) throw new Error("already_recording");
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (err) {
        // 与 Rust 那侧同一个原因串：界面按 `permission_denied` 前缀判，决定要不要提示去开权限
        const name = (err as { name?: string }).name ?? "";
        throw new Error(name === "NotAllowedError" || name === "SecurityError" ? "permission_denied" : "no_input_device");
      }
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new Ctor();
      chunks = [];
      startedAt = Date.now();
      const source = ctx.createMediaStreamSource(stream);
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => {
        if (Date.now() - startedAt > MAX_MS) return;
        chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      source.connect(node);
      // 必须接到 destination 才会出回调；输出缓冲是静音（我们没往里写），不会回放
      node.connect(ctx.destination);
    },
    async stop() {
      if (!ctx) throw new Error("not_recording");
      const rate = ctx.sampleRate;
      const durationMs = Math.min(Date.now() - startedAt, MAX_MS);
      const samples = resampleTo16k(concat(chunks), rate);
      cleanup();
      return { bytes: encodePcmS16le(samples), durationMs };
    },
  };
}

/** 浏览器的麦克风授权状态，翻译成 Rust 那侧的三个值。查不了就当还没问过。 */
export async function browserMicPermission(): Promise<"granted" | "denied" | "undetermined"> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return "denied";
  try {
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return status.state === "granted" ? "granted" : status.state === "denied" ? "denied" : "undetermined";
  } catch {
    return "undetermined";
  }
}
