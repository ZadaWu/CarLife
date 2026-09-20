/**
 * 端上界面的浏览器传输垫片（ACR-049）。
 *
 * # 它解决什么
 *
 * 车机端与手机端的界面是 Tauri 的 WebView 层，网络全在 Rust 侧。把它们单独放到浏览器里，
 * 界面是真的，但 `invoke` 没人应、事件没人发——"长得就是产品，但不能用"。
 * 本模块在浏览器里顶替 Rust 那一侧：接住 `invoke`，用 HTTP/SSE 去打网关，
 * 再把结果按**与 Rust 完全相同的事件名与载荷**发回给界面。
 *
 * # 为什么不用改那 117 处 `isTauriEnv()`
 *
 * 两端判断"是不是在 Tauri 里"看的是 `"__TAURI_INTERNALS__" in window`。
 * Tauri 官方的 `mockIPC`（`@tauri-apps/api/mocks`，本来是给测试用的）正是往 window 上
 * 装这个对象。装上之后，整个界面照常走"在 Tauri 里"的分支，一处守卫都不用碰。
 *
 * # 它不是产品路径
 *
 * 只有演示构建（`VITE_WEB_SHIM=1`）才会 import 本模块，原生构建的产物里没有它。
 * 语音常驻监听、车辆信号、凭据存储、设备配对在这里一律**明确拒绝**——
 * 那些能力按架构就该在 Rust 侧，演示版宁可显示"不可用"，也不伪造一个成功。
 *
 * # 依赖注入而不是直接 import Tauri
 *
 * `@carlife/ui` 不依赖 `@tauri-apps/api`（也不该为了演示去依赖）。`mockIPC` 与 `emit`
 * 由各端入口传进来，本模块因此零 Tauri 依赖、单测里也不需要 window。
 */

import { BRIDGE_EVENTS, type ChatMessage, type EventEnvelope, type HistoryPage } from "@carlife/shared";

import { NO_ON_DEVICE_VISION_MARK } from "../dialog/attachments";
import { fetchAttachment, RAW_IPC_COMMANDS, uploadAttachment, type InvokeOptionsLike } from "./attachments";
import { createLocalState, handleCommand, ShimRejected } from "./commands";
import { Gateway, type Credentials } from "./gateway";
import { project, TurnAccumulator } from "./project";
import type { Recorder } from "./voice";
import { createSpeaker, parseTtsNdjson, type Speaker } from "./speech";

export { project, TurnAccumulator } from "./project";
export { shimCoverage, ShimRejected } from "./commands";
export { Gateway, GatewayError, AUTH_HEADER, errorCodeOf } from "./gateway";
export { browserMicPermission, createBrowserRecorder, encodePcmS16le, resampleTo16k, type Recorder } from "./voice";
export { createSpeaker, parseTtsNdjson, type Speaker } from "./speech";
export { bytesOf, RAW_IPC_COMMANDS, uploadFailureText, type InvokeOptionsLike } from "./attachments";

type Args = Record<string, unknown>;

export interface WebShimDeps {
  /** `@tauri-apps/api/mocks` 的 `mockIPC` */
  /**
   * 参数类型放宽到 unknown：Tauri 的 `InvokeArgs` 还允许是字节数组（原始 IPC，
   * 附件上传走的那条）。字节原样递给 `dispatch`，由它分辨——别在这一层归一成 `{}`，
   * 那样照片在进门那一刻就没了。
   */
  mockIPC: (cb: (cmd: string, args?: unknown) => unknown, options?: { shouldMockEvents?: boolean }) => void;
  /** `@tauri-apps/api/event` 的 `emit` */
  emit: (event: string, payload?: unknown) => Promise<void>;
  credentials: Credentials;
  fetch?: typeof fetch;
  /** 写同源 cookie；不传则不写（单测里没有 document） */
  setCookie?: (token: string) => void;
  /** 当前站点的 origin。端上用它拼高德服务接口代理的地址（同源 `/_AMapService`）。 */
  origin?: string;
  /**
   * 按住说话用的录音器与权限查询。它们要碰 navigator，所以由入口注入；
   * 不传 = 这个环境没有麦克风，界面如实显示"未授权"，对应命令明确拒绝。
   */
  recorder?: Recorder;
  micPermission?: () => Promise<"granted" | "denied" | "undetermined">;
  /**
   * 把回答读出来。收一个工厂而不是现成的 Speaker——它要用 shim 自己的合成端点与
   * emit，而那两样在 shim 造出来之前还不存在。不传 = 这个环境不播报。
   * 播放起止驱动 `speaking` / `idle`，**不由 turn_end 驱动**——见 emitAll 里的抑制逻辑。
   */
  createSpeaker?: (io: {
    synthesize: (text: string) => Promise<{ bytes: Uint8Array; error: string | null }>;
    onPlayingChange: (playing: boolean) => void;
  }) => Speaker;
}

/** 切 SSE 帧：空行分帧，只取 `data:` 行。坏帧丢掉，不让一帧坏掉带走整条流。 */
export function parseSseChunk(buffer: string): { envelopes: EventEnvelope[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const envelopes: EventEnvelope[] = [];
  for (const frame of parts) {
    const data = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      envelopes.push(JSON.parse(data) as EventEnvelope);
    } catch {
      // 忽略
    }
  }
  return { envelopes, rest };
}

export function createShim(deps: WebShimDeps) {
  const gw = new Gateway(deps.fetch ?? fetch.bind(globalThis), deps.credentials, deps.setCookie);
  const local = createLocalState();
  local.set("origin", deps.origin ?? "");
  const streams = new Map<string, AbortController>();

  /*
   * 合成与播报必须定义在 `emitAll` **之前**。
   * const 有暂时性死区：定义在后面的话，emitAll 每次执行都抛 ReferenceError，
   * 而它被上层的 try 吞掉——现象是播报整个静默失效，控制台里一行异常都没有。
   */
  /** 合成一段文本。网关的 `/v1/tts/speech` 三档共用，密钥全在服务端。 */
  const synthesize = async (text: string) => {
    const res = await gw.request("POST", "/v1/tts/speech", { json: { req_params: { text } } });
    return parseTtsNdjson(await res.text());
  };

  /**
   * 播放起止直接驱动助手形象的状态。这是 M2-05 的约束：`speaking` 由播放起止驱动，
   * 不由"有没有回答"驱动——否则字出完了形象还在说，或者反过来。
   */
  const speaker = deps.createSpeaker?.({
    synthesize,
    onPlayingChange: (playing) => void deps.emit(BRIDGE_EVENTS.assistantState, playing ? "speaking" : "idle"),
  });


  /**
   * 正在跑的那一轮（用于"点一下打断"）。受理回执到了就算开始，收口或撤回就算结束。
   * 与原生端不同的是这里不管 TTS——浏览器演示版没有播报那条链，打断只剩"取消这一轮"。
   */
  let inflight: { sessionId: string; turnId: string } | null = null;

  const emitAll = async (env: EventEnvelope, acc: TurnAccumulator) => {
    const ev = env.event;
    if (ev.type === "prompt") {
      inflight = { sessionId: env.sessionId, turnId: ev.turnId };
      // 新一轮开口就停掉上一轮的播报：不停的话两段声音会叠在一起
      speaker?.stop();
    }
    if (ev.type === "update" && (ev.kind === "turn_end" || ev.kind === "retract") && inflight?.turnId === ev.turnId) inflight = null;

    /*
     * 撤回撤的是**内容本身**，不是"屏幕上那段字"（F-26-06）。
     * 不停播的话，屏幕上写着"这条我收回了"，而声音把被审核拦下的原文完整念完——
     * 车机端 2026-09-19 实测过这个形态。所以撤回第一件事是停声音。
     */
    if (ev.type === "update" && ev.kind === "retract") speaker?.stop();

    const outs = project(env, acc);

    /*
     * 助手消息产生且要播报时，**抑制 turn_end 投影出的那个 idle**（与原生端同一条纪律）。
     * 不抑制的话形象会 idle→speaking 闪一下，因为播放起止比 turn_end 晚到几百毫秒。
     * 状态交给播放起止驱动：开播 speaking、播完 idle。
     */
    const reply = outs.find(
      (o) => o.event === BRIDGE_EVENTS.dialogMessage && (o.payload as { role?: string }).role === "assistant",
    );
    // 访客在设置页关掉播报 → local 里那个开关为假，这一轮不播也不抑制 idle
    const willSpeak =
      reply !== undefined && speaker !== undefined && local.get("broadcast_enabled") === true && ev.type === "update" && ev.kind === "turn_end";

    for (const out of outs) {
      if (willSpeak && out.event === BRIDGE_EVENTS.assistantState && out.payload === "idle") continue;
      await deps.emit(out.event, out.payload);
    }

    if (willSpeak) {
      const text = (reply!.payload as { content: string }).content;
      // 不 await：播报是旁路，等它播完再读下一帧会把整条流堵住
      void speaker!.speak(text);
    }
  };

  /**
   * 会话流。断了就重连，重连期间如实告诉界面 `reconnecting`——
   * 原生端的 Rust 也是这么报的，界面顶部那条"正在重连"就靠它。
   */
  /** 处理事件时的代码错误计数。测试据此断言"这条流跑得干净"。 */
  let frameErrors = 0;

  function startSessionStream(sessionId: string): void {
    streams.get(sessionId)?.abort();
    const ctrl = new AbortController();
    streams.set(sessionId, ctrl);
    const acc = new TurnAccumulator();

    void (async () => {
      let attempt = 0;
      while (!ctrl.signal.aborted) {
        try {
          const res = await gw.stream("/v1/session/" + encodeURIComponent(sessionId) + "/stream", ctrl.signal);
          attempt = 0;
          await deps.emit(BRIDGE_EVENTS.netConnection, { state: "online" });
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const parsed = parseSseChunk(buffer + decoder.decode(value, { stream: true }));
            buffer = parsed.rest;
            for (const env of parsed.envelopes) {
              /*
               * 处理一帧时的**代码错误**必须与网络错误分开。
               *
               * 原先这一层和下面的 catch 共用：emitAll 里一个 ReferenceError
               * 会被当成"断线"，于是静默重连——表现是播报整个失效而控制台一行异常都没有
               * （2026-09-20 实测：speaker 定义在 emitAll 之后，暂时性死区，
               * 38 条单测全绿而线上是死的）。
               *
               * 所以这里单独兜：报出来、计数、继续处理下一帧。一帧坏掉不该拖垮整条流，
               * 但也绝不能装作没发生。
               */
              try {
                await emitAll(env, acc);
              } catch (err) {
                frameErrors += 1;
                console.error("[web-shim] 处理事件失败（第 " + frameErrors + " 次）", err);
              }
            }
          }
        } catch {
          if (ctrl.signal.aborted) return;
        }
        if (ctrl.signal.aborted) return;
        await deps.emit(BRIDGE_EVENTS.netConnection, { state: "reconnecting" });
        attempt += 1;
        // 退避封顶 10 秒：演示环境的网关偶尔重启，别把它的恢复期打成一波请求
        await new Promise((r) => setTimeout(r, Math.min(10_000, 1000 * 2 ** Math.min(attempt, 4))));
      }
    })();
  }

  const authStatus = () => {
    const user = gw.currentUser();
    return { authenticated: user !== null, userId: user?.id ?? null, displayName: user?.displayName ?? null };
  };

  async function history(sessionId: string): Promise<ChatMessage[]> {
    const page = await gw.json<HistoryPage>("GET", "/v1/session/" + encodeURIComponent(sessionId) + "/messages?limit=100");
    return page.messages;
  }

  /**
   * `rawArgs` 多数时候是对象形参；原始 IPC 的命令（附件上传）递进来的是字节。
   * `options` 是 `invoke` 的第三个参数——mockIPC 不转发它，由 `installWebShim` 补递。
   */
  async function dispatch(cmd: string, rawArgs: unknown = {}, options?: InvokeOptionsLike): Promise<unknown> {
    const args: Args =
      rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) && !ArrayBuffer.isView(rawArgs) && !(rawArgs instanceof ArrayBuffer)
        ? (rawArgs as Args)
        : {};
    switch (cmd) {
      // ── 身份 ──────────────────────────────────────────────
      case "auth_status":
        // 演示账号在装垫片时就登录好了，端上的登录门因此直接放行
        return authStatus();
      case "auth_login":
        try {
          await gw.login({ username: String(args.username ?? ""), password: String(args.password ?? "") });
        } catch (err) {
          const status = (err as { status?: number }).status;
          // 与 Rust 那侧同一口径：401 是"账号或口令不对"，其它是"连不上"——用户能不能自己解决，差在这里
          throw status === 401 ? "账号或口令不对" : "连不上服务端";
        }
        return authStatus();
      case "auth_logout":
        gw.logout();
        return null;

      // ── 对话核心 ──────────────────────────────────────────
      case "create_session":
        return (await gw.json<{ sessionId: string }>("POST", "/v1/session", {})).sessionId;
      case "start_session_stream":
        startSessionStream(String(args.sessionId));
        return null;
      case "start_user_events_stream":
        // 账号级通道只发"去重拉"的信号（ACR-033）。演示版单标签页单会话，不订阅也不会错过什么
        return null;
      case "send_text_message": {
        // **不做本地乐观插入**：用户气泡由 SSE 的 prompt 事件回流（与原生端同一条纪律）
        // 附件句柄与端上框：缺省 / 空 = 请求体与纯文字那一版逐字节相同（与 Rust 的 send_text_with_detections 同一条纪律）
        const handles = Array.isArray(args.attachments) ? args.attachments : [];
        const detections = args.detections && typeof args.detections === "object" ? (args.detections as Record<string, unknown>) : {};
        const r = await gw.json<{ turnId: string }>("POST", "/v1/session/" + encodeURIComponent(String(args.sessionId)) + "/messages", {
          content: String(args.content ?? ""),
          ...(handles.length ? { attachments: handles } : {}),
          ...(Object.keys(detections).length ? { detections } : {}),
        });
        return r.turnId;
      }

      // ── 附件（照片 / 视频）────────────────────────────────
      case "upload_attachment":
        return uploadAttachment(gw, rawArgs, options);
      case "fetch_attachment":
        return fetchAttachment(gw, args.handle);
      case "resume_interrupt":
        await gw.request("POST", "/v1/session/" + encodeURIComponent(String(args.sessionId)) + "/resume", {
          json: { interruptId: args.interruptId, approved: args.approved === true },
        });
        return true;
      case "interrupt_assistant_cmd": {
        // 返回值是"有没有打断到东西"，与 Rust 那侧同一语义：没有在跑的轮次就是 false，不算错
        const turn = inflight;
        speaker?.stop();
        if (!turn) return false;
        inflight = null;
        await gw.request("POST", "/v1/session/" + encodeURIComponent(turn.sessionId) + "/cancel", { json: {} });
        return true;
      }
      case "interrupt_stats":
        return { pushToTalk: 0, tap: 0, voice: 0, cancelFailed: 0, noActiveTurn: 0 };
      case "cancel_turn":
        await gw.request("POST", "/v1/session/" + encodeURIComponent(String(args.sessionId)) + "/cancel", { json: {} });
        return null;
      case "close_session": {
        const id = String(args.sessionId);
        streams.get(id)?.abort();
        streams.delete(id);
        await gw.request("POST", "/v1/session/" + encodeURIComponent(id) + "/close", { json: {} });
        return null;
      }
      case "refresh_history":
        return history(String(args.sessionId));
      case "read_cached_messages":
        // 浏览器里没有 Rust 的本地缓存，回源就是唯一的来源
        return history(String(args.sessionId));

      // ── 按住说话 ──────────────────────────────────────────
      case "mic_permission_status":
        return deps.micPermission ? deps.micPermission() : "denied";
      case "start_push_to_talk": {
        if (!deps.recorder) throw "permission_denied";
        try {
          await deps.recorder.start();
        } catch (err) {
          // 抛**裸字符串**：Rust 命令的 Err(String) 到了 JS 这边就是一个字符串，
          // 界面用 `String(err) === "permission_denied"` 和 `reason.startsWith(...)` 判
          const reason = (err as Error).message || "capture_failed";
          await deps.emit(BRIDGE_EVENTS.voiceCapture, { kind: "failed", reason });
          throw reason;
        }
        await deps.emit(BRIDGE_EVENTS.voiceCapture, { kind: "started", mode: "push_to_talk" });
        return null;
      }
      case "stop_push_to_talk": {
        if (!deps.recorder?.active) throw "not_recording";
        const rec = await deps.recorder.stop();
        await deps.emit(BRIDGE_EVENTS.voiceCapture, { kind: "stopped", durationMs: rec.durationMs });
        await deps.emit(BRIDGE_EVENTS.voiceCapture, { kind: "uploading" });
        try {
          // 车机端松手时可能还没有会话（关闭会话之后是 None）——与 Rust 那侧一样，现建一个并随结果交回
          let sessionId = typeof args.sessionId === "string" && args.sessionId ? args.sessionId : null;
          const created = sessionId === null;
          if (sessionId === null) sessionId = (await gw.json<{ sessionId: string }>("POST", "/v1/session", {})).sessionId;
          const meta = { durationMs: rec.durationMs, format: "pcm_s16le", sampleRateHz: 16_000, channels: 1 };
          /*
           * 元数据走两条路：标准做法是 `x-audio-meta` 头；同时把时长放进查询参数 `ms`。
           * 魔搭创空间的边缘很可能剥自定义头（只发自定义鉴权头的那一版是 401，
           * 加了 cookie 才通），而 AudioMeta 里只有时长是变的，其余都是常量——
           * 所以 nginx 在头缺席时能用 `ms` 把它原样合成出来（见 proxy-common.conf.template）。
           */
          const res = await gw.request("POST", "/v1/session/" + encodeURIComponent(sessionId) + "/messages?ms=" + Math.round(rec.durationMs), {
            body: rec.bytes as unknown as BodyInit,
            headers: { "content-type": "audio/pcm_s16le", "x-audio-meta": JSON.stringify(meta) },
          });
          const { turnId } = (await res.json()) as { turnId: string };
          await deps.emit(BRIDGE_EVENTS.voiceCapture, { kind: "uploaded" });
          return { turnId, durationMs: rec.durationMs, truncated: false, ...(created ? { sessionId } : {}) };
        } catch {
          await deps.emit(BRIDGE_EVENTS.voiceCapture, { kind: "failed", reason: "upload_failed" });
          throw "upload_failed";
        }
      }
    }

    const handled = await handleCommand(cmd, args, gw, local);
    if (handled) return handled.value;
    // 没登记的命令：**响亮地失败**。静默返回 undefined 会让界面拿着空值继续跑，
    // 症状会出现在离这里很远的地方。
    throw new ShimRejected(cmd, "这个命令没有登记在垫片里");
  }

  return {
    dispatch,
    gateway: gw,
    synthesize,
    /** 处理事件时出过几次代码错误。正常应当恒为 0。 */
    get frameErrors() {
      return frameErrors;
    },
  };
}

/**
 * 在浏览器里装上垫片。必须在 React 渲染**之前**调用——
 * 两端的组件在挂载 effect 里就会 `invoke`。
 */
export async function installWebShim(deps: WebShimDeps): Promise<void> {
  const shim = createShim(deps);
  /*
   * 声明"本环境没有端上检测"（ACR-050）。端上框灯缺省是开的，而 `vision_detect` 在垫片里是明确拒绝的——
   * 不声明的话每张照片都会先白跑一次注定失败的检测，设置页还会摆着一枚拨了没用的开关。
   * 照片因此不带框上行，由服务端的 vision-infer 定位。必须在 React 渲染之前：设置页挂载时就读它。
   */
  (globalThis as Record<string, unknown>)[NO_ON_DEVICE_VISION_MARK] = true;
  deps.mockIPC((cmd, args) => shim.dispatch(cmd, args), { shouldMockEvents: true });
  /*
   * mockIPC 装上的 `invoke(cmd, args, _options)` **不转发第三个参数**，而附件上传的
   * 会话号 / MIME / 文件名全在 `options.headers` 里。所以在它之上再包一层：
   * 只有点了名的命令改走这里，其余（含 `plugin:event|*` 的事件模拟）原样交回 mockIPC。
   * 经 globalThis 取——本模块不直接依赖 window，单测里没有这个对象时整段跳过。
   */
  type InvokeFn = (cmd: string, args?: unknown, options?: InvokeOptionsLike) => Promise<unknown>;
  const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: InvokeFn } }).__TAURI_INTERNALS__;
  const mocked = internals?.invoke;
  if (internals && mocked) {
    internals.invoke = (cmd, args, options) => (RAW_IPC_COMMANDS.has(cmd) ? shim.dispatch(cmd, args, options) : mocked(cmd, args, options));
  }
  // 先把演示账号登录好：`auth_status` 是同步语义的命令，端上拿到 authenticated=false 就会弹登录门
  await shim.gateway.login().catch(() => undefined);
}
