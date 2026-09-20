/**
 * [ACR-049] 浏览器传输垫片。
 *
 * 投影这一组消费的是 `contracts/fixtures/contract-events.json`——Rust 那侧
 * `carlife-core/tests/contract_roundtrip.rs` 用的同一份。两边各自实现了 `project()`，
 * 靠同一份样例对齐，不靠"我照着抄的应该没错"。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { BRIDGE_EVENTS, type EventEnvelope } from "@carlife/shared";

import { createShim, parseSseChunk, project, shimCoverage, TurnAccumulator } from "../src/web-shim/index.ts";

const FIXTURE = JSON.parse(
  readFileSync(new URL("../../../../contracts/fixtures/contract-events.json", import.meta.url), "utf8"),
) as { envelopes: EventEnvelope[] };

const env = (event: unknown, turn = "t1"): EventEnvelope =>
  ({ eventId: "1", sessionId: "sess-1", ts: 1789000000000, event }) as EventEnvelope;

describe("[ACR-049] 投影：与 Rust 的 fanout::project 对同一份契约样例", () => {
  it("夹具里的每一种事件都有去处，没有一种被默默吞掉（session 除外——Rust 也忽略它）", () => {
    const acc = new TurnAccumulator();
    const seen = new Map<string, string[]>();
    for (const e of FIXTURE.envelopes) {
      const key = e.event.type + ("kind" in e.event ? "/" + e.event.kind : "");
      seen.set(key, project(e, acc).map((o) => o.event));
    }
    assert.deepEqual(seen.get("session"), []);
    assert.deepEqual(seen.get("prompt"), [BRIDGE_EVENTS.dialogMessage]);
    assert.deepEqual(seen.get("update/state"), [BRIDGE_EVENTS.assistantState]);
    assert.deepEqual(seen.get("update/filler"), [BRIDGE_EVENTS.dialogFiller]);
    assert.deepEqual(seen.get("update/delta"), [BRIDGE_EVENTS.dialogDelta]);
    assert.deepEqual(seen.get("update/branch"), [BRIDGE_EVENTS.dialogBranch]);
    assert.deepEqual(seen.get("permission"), [BRIDGE_EVENTS.dialogPermission]);
    assert.deepEqual(seen.get("tool_call"), [BRIDGE_EVENTS.dialogToolCall]);
    assert.deepEqual(seen.get("update/turn_end"), [BRIDGE_EVENTS.dialogMessage, BRIDGE_EVENTS.assistantState]);
  });

  it("透传的载荷不带 type / kind——Rust emit 的是内层结构体，没有外层枚举的标签", () => {
    const perm = FIXTURE.envelopes.find((e) => e.event.type === "permission")!;
    const out = project(perm, new TurnAccumulator())[0].payload as Record<string, unknown>;
    assert.equal("type" in out, false);
    assert.equal(typeof out.interruptId, "string");
    const branch = FIXTURE.envelopes.find((e) => e.event.type === "update" && e.event.kind === "branch")!;
    const b = project(branch, new TurnAccumulator())[0].payload as Record<string, unknown>;
    assert.equal("kind" in b, false);
    assert.equal("type" in b, false);
  });

  it("用户气泡的唯一来源是 prompt 回流，messageId 镜像网关约定 msg-{turnId}-u", () => {
    const out = project(env({ type: "prompt", turnId: "t9", source: "text", transcript: "胎压正常吗" }), new TurnAccumulator());
    const m = out[0].payload as { messageId: string; role: string; content: string };
    assert.equal(m.messageId, "msg-t9-u");
    assert.equal(m.role, "user");
    assert.equal(m.content, "胎压正常吗");
  });

  it("不带原文的 prompt 忽略，不造一个空气泡", () => {
    assert.deepEqual(project(env({ type: "prompt", turnId: "t9", source: "text", transcript: null }), new TurnAccumulator()), []);
  });

  it("delta 累积到 turn_end 拼成一条助手消息，随后回 idle", () => {
    const acc = new TurnAccumulator();
    project(env({ type: "update", kind: "delta", turnId: "t1", text: "续航" }), acc);
    project(env({ type: "update", kind: "delta", turnId: "t1", text: "正常" }), acc);
    const out = project(env({ type: "update", kind: "turn_end", turnId: "t1", messageId: "m-1" }), acc);
    assert.equal((out[0].payload as { content: string }).content, "续航正常");
    assert.equal((out[0].payload as { messageId: string }).messageId, "m-1");
    assert.deepEqual(out[1], { event: BRIDGE_EVENTS.assistantState, payload: "idle" });
  });

  it("累积为空的 turn_end 只回 idle，不追加空消息", () => {
    const out = project(env({ type: "update", kind: "turn_end", turnId: "t1", messageId: "m-1" }), new TurnAccumulator());
    assert.deepEqual(out, [{ event: BRIDGE_EVENTS.assistantState, payload: "idle" }]);
  });

  it("撤回必须投影：替换文案成一条消息，并清掉本轮累积——否则被审核拦下的原文还留在屏上", () => {
    const acc = new TurnAccumulator();
    project(env({ type: "update", kind: "delta", turnId: "t1", text: "不该出现的内容" }), acc);
    const out = project(env({ type: "update", kind: "retract", turnId: "t1", replacement: "这段我不能说", reason: "moderation" }), acc);
    assert.equal((out[0].payload as { content: string }).content, "这段我不能说");
    assert.equal((out[0].payload as { messageId: string }).messageId, "msg-t1-retracted");
    // 撤回之后 turn_end 照常到来：累积已清，不能再冒出那段原文
    const after = project(env({ type: "update", kind: "turn_end", turnId: "t1", messageId: "m-1" }), acc);
    assert.deepEqual(after, [{ event: BRIDGE_EVENTS.assistantState, payload: "idle" }]);
  });

  it("垫场话、工具进展、标题都不进累积——进去了用户翻历史会看到一串旁白", () => {
    const acc = new TurnAccumulator();
    project(env({ type: "update", kind: "filler", turnId: "t1", text: "我查一下", source: "L0", interruptible: true }), acc);
    project(env({ type: "tool_call", toolCallId: "c1", toolName: "x", displayName: "正在查", status: "started" }), acc);
    project(env({ type: "update", kind: "title", turnId: "t1", title: "胎压" }), acc);
    assert.equal(acc.take("t1"), "");
  });
});

describe("[ACR-049] SSE 切帧", () => {
  it("粘包切出完整帧，尾巴留着下次拼；坏帧丢掉不抛", () => {
    const good = JSON.stringify(env({ type: "session", status: "created" }));
    const r = parseSseChunk("id: 1\ndata: " + good + "\n\ndata: {坏的\n\ndata: {\"半");
    assert.equal(r.envelopes.length, 1);
    assert.equal(r.rest, "data: {\"半");
  });
});

describe("[ACR-049] 命令面", () => {
  const calls: { method: string; url: string; headers: Record<string, string>; body: string | undefined }[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    });
    const body =
      url === "/v1/auth/login"
        ? { accessToken: "tok-1", user: { id: "demo-user", displayName: "演示用户" } }
        : url === "/v1/session"
          ? { sessionId: "sess-9" }
          : url.endsWith("/messages") && init?.method === "POST"
            ? { turnId: "turn-7" }
            : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const make = () => {
    calls.length = 0;
    return createShim({
      mockIPC: () => undefined,
      emit: async () => undefined,
      credentials: { username: "demo", password: "pw" },
      fetch: fakeFetch,
    });
  };

  it("只发同源相对路径，鉴权头不用平台保留的 Authorization", async () => {
    const shim = make();
    await shim.dispatch("create_session");
    assert.ok(calls.every((c) => c.url.startsWith("/v1/")), "出现了非同源地址：" + calls.map((c) => c.url).join(","));
    const authed = calls.find((c) => c.url === "/v1/session")!;
    assert.equal(authed.headers["x-carlife-auth"], "Bearer tok-1");
    assert.equal(Object.keys(authed.headers).some((k) => k.toLowerCase() === "authorization"), false);
  });

  it("返回形状与 Rust 命令一致：create_session 给裸 sessionId，send_text_message 给裸 turnId", async () => {
    const shim = make();
    assert.equal(await shim.dispatch("create_session"), "sess-9");
    assert.equal(await shim.dispatch("send_text_message", { sessionId: "sess-9", content: "在吗" }), "turn-7");
  });

  it("并发的首批命令只登录一次——端启动时十几个命令同时进来", async () => {
    const shim = make();
    await Promise.all([shim.dispatch("fetch_vehicles"), shim.dispatch("fetch_preferences"), shim.dispatch("get_guide_jobs")]);
    assert.equal(calls.filter((c) => c.url === "/v1/auth/login").length, 1);
  });

  it("车机界面以私人身份运行：device_role 不是 cockpit，BoardingGate 因此放行到用户登录门", async () => {
    const shim = make();
    assert.equal(await shim.dispatch("device_role"), "personal");
    await shim.gateway.login();
    assert.deepEqual(await shim.dispatch("auth_status"), { authenticated: true, userId: "demo-user", displayName: "演示用户" });
  });

  it("bodyJson 是 JSON 串（Rust 侧的约定），发出去的是解析后的对象而不是被二次转义的串", async () => {
    const shim = make();
    await shim.dispatch("save_member", { vin: "V1", bodyJson: JSON.stringify({ name: "小明" }) });
    const c = calls.find((x) => x.url === "/v1/vehicles/V1/members")!;
    assert.equal(c.method, "POST");
    assert.deepEqual(JSON.parse(c.body!), { name: "小明" });
  });

  it("做不了的能力明确拒绝并写明原因，不伪造成功", async () => {
    const shim = make();
    await assert.rejects(() => shim.dispatch("sentinel_start"), /常驻哨兵只在原生端/);
    await assert.rejects(() => shim.dispatch("vision_detect", {}), /原生模型/);
  });

  it("没登记的命令响亮地失败——静默返回 undefined 的症状会出现在很远的地方", async () => {
    const shim = make();
    await assert.rejects(() => shim.dispatch("some_future_command"), /没有登记在垫片里/);
  });
});

describe("[ACR-049] 两端实际用到的命令，垫片都表过态", () => {
  it("源码里出现的每个 invoke 命令名，要么实现、要么明确拒绝", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = new URL("../../../", import.meta.url).pathname;
    const used = new Set<string>();
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (!/node_modules|dist|src-tauri|test/.test(name)) walk(p);
        } else if (/\.(ts|tsx)$/.test(name)) {
          for (const m of readFileSync(p, "utf8").matchAll(/invoke(?:<[^>]+>)?\(\s*"([a-z_0-9]+)"/g)) used.add(m[1]);
        }
      }
    };
    walk(join(root, "cockpit/src"));
    walk(join(root, "mobile/src"));

    const shim = createShim({
      mockIPC: () => undefined,
      emit: async () => undefined,
      credentials: { username: "demo", password: "pw" },
      fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });
    const unknown: string[] = [];
    for (const cmd of used) {
      try {
        await shim.dispatch(cmd, { sessionId: "s", vin: "v", id: "i" });
      } catch (err) {
        if (/没有登记在垫片里/.test(String((err as Error).message))) unknown.push(cmd);
      }
    }
    assert.deepEqual(unknown.sort(), [], "这些命令端上在用、垫片却没表态：界面调到时会直接报错");
    assert.ok(shimCoverage().passthrough.length > 20);
  });
});

describe("[ACR-049] 按住说话", () => {
  it("重采样到 16 kHz：48k 进来长度变三分之一，16k 进来原样", async () => {
    const { resampleTo16k } = await import("../src/web-shim/index.ts");
    assert.equal(resampleTo16k(new Float32Array(4800), 48_000).length, 1600);
    const same = new Float32Array([0.1, 0.2]);
    assert.equal(resampleTo16k(same, 16_000), same);
  });

  it("编码成 s16le：越界钳住不回绕——回绕出来的是爆音", async () => {
    const { encodePcmS16le } = await import("../src/web-shim/index.ts");
    const view = new DataView(encodePcmS16le(new Float32Array([0, 1, -1, 2, -2])).buffer);
    assert.deepEqual([0, 1, 2, 3, 4].map((i) => view.getInt16(i * 2, true)), [0, 32767, -32768, 32767, -32768]);
  });

  const setup = (recorder: { start(): Promise<void>; stop(): Promise<{ bytes: Uint8Array; durationMs: number }>; active: boolean }) => {
    const events: { event: string; payload: unknown }[] = [];
    const calls: { url: string; headers: Record<string, string>; bodyBytes: number }[] = [];
    const shim = createShim({
      mockIPC: () => undefined,
      emit: async (event, payload) => void events.push({ event, payload }),
      credentials: { username: "demo", password: "pw" },
      recorder,
      micPermission: async () => "granted",
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          headers: (init?.headers ?? {}) as Record<string, string>,
          bodyBytes: init?.body instanceof Uint8Array ? init.body.byteLength : 0,
        });
        const body =
          url === "/v1/auth/login"
            ? { accessToken: "tok", user: { id: "demo-user", displayName: null } }
            : url === "/v1/session"
              ? { sessionId: "sess-new" }
              : { turnId: "turn-v" };
        return new Response(JSON.stringify(body), { status: 200 });
      }) as unknown as typeof fetch,
    });
    return { shim, events, calls };
  };

  it("松手后按原生端同一种格式上传，事件顺序 started → stopped → uploading → uploaded", async () => {
    let active = false;
    const { shim, events, calls } = setup({
      get active() { return active; },
      start: async () => void (active = true),
      stop: async () => { active = false; return { bytes: new Uint8Array(3200), durationMs: 1234 }; },
    });
    await shim.dispatch("start_push_to_talk");
    const out = (await shim.dispatch("stop_push_to_talk", { sessionId: "sess-1" })) as Record<string, unknown>;
    assert.deepEqual(out, { turnId: "turn-v", durationMs: 1234, truncated: false });

    const upload = calls.find((c) => c.url.includes("/messages"))!;
    // 时长同时放进 ?ms=：自定义头被平台剥掉时，nginx 靠它把 X-Audio-Meta 合成出来
    assert.equal(upload.url, "/v1/session/sess-1/messages?ms=1234");
    assert.equal(upload.headers["content-type"], "audio/pcm_s16le");
    assert.deepEqual(JSON.parse(upload.headers["x-audio-meta"]), { durationMs: 1234, format: "pcm_s16le", sampleRateHz: 16000, channels: 1 });
    assert.equal(upload.bodyBytes, 3200);

    const kinds = events.filter((e) => e.event === BRIDGE_EVENTS.voiceCapture).map((e) => (e.payload as { kind: string }).kind);
    assert.deepEqual(kinds, ["started", "stopped", "uploading", "uploaded"]);
  });

  it("松手时还没有会话就现建一个，并随结果交回——车机端关闭会话之后就是这种情形", async () => {
    let active = true;
    const { shim } = setup({
      get active() { return active; },
      start: async () => undefined,
      stop: async () => { active = false; return { bytes: new Uint8Array(10), durationMs: 500 }; },
    });
    const out = (await shim.dispatch("stop_push_to_talk", { sessionId: null })) as Record<string, unknown>;
    assert.equal(out.sessionId, "sess-new");
  });

  it("麦克风被拒时抛裸字符串 permission_denied——界面用 String(err) 与 startsWith 判，包成 Error 就对不上了", async () => {
    const { shim, events } = setup({
      active: false,
      start: async () => { throw new Error("permission_denied"); },
      stop: async () => ({ bytes: new Uint8Array(), durationMs: 0 }),
    });
    await assert.rejects(() => shim.dispatch("start_push_to_talk"), (err) => err === "permission_denied");
    assert.deepEqual(events.at(-1)?.payload, { kind: "failed", reason: "permission_denied" });
  });

  it("没在录就松手 → not_recording，与 Rust 同一个原因串", async () => {
    const { shim } = setup({ active: false, start: async () => undefined, stop: async () => ({ bytes: new Uint8Array(), durationMs: 0 }) });
    await assert.rejects(() => shim.dispatch("stop_push_to_talk", { sessionId: "s" }), (err) => err === "not_recording");
  });
});

describe("[ACR-049] 把回答读出来", () => {
  it("NDJSON 拼成 mp3：多条分片按序拼接，终止行不算内容", async () => {
    const { parseTtsNdjson } = await import("../src/web-shim/index.ts");
    const b64 = (s: string) => Buffer.from(s, "binary").toString("base64");
    const r = parseTtsNdjson(
      `{"code":0,"data":"${b64("AB")}"}\n{"code":0,"data":"${b64("CD")}"}\n{"code":20000000,"message":"OK"}\n`,
    );
    assert.equal(Buffer.from(r.bytes).toString("binary"), "ABCD");
    assert.equal(r.error, null);
  });

  it("失败行里那句话是「今天为什么没声音」的唯一线索，要留住；坏行跳过不影响其余", async () => {
    const { parseTtsNdjson } = await import("../src/web-shim/index.ts");
    const r = parseTtsNdjson('不是 JSON\n{"code":45000002,"message":"今日合成字符已达上界"}\n');
    assert.equal(r.error, "今日合成字符已达上界");
    assert.equal(r.bytes.length, 0);
  });

  const fakeAudio = () => {
    const calls: string[] = [];
    const audio = {
      onended: null as null | (() => void),
      onerror: null as null | (() => void),
      play: async () => void calls.push("play"),
      pause: () => void calls.push("pause"),
    };
    return { audio, calls };
  };

  it("播放起止驱动 speaking / idle——不是「有没有回答」驱动", async () => {
    const { createSpeaker } = await import("../src/web-shim/index.ts");
    const states: boolean[] = [];
    let ended!: () => void;
    const speaker = createSpeaker({
      synthesize: async () => ({ bytes: new Uint8Array([1, 2]), error: null }),
      onPlayingChange: (p) => void states.push(p),
      createAudio: () => {
        const a = { onended: null as null | (() => void), onerror: null, play: async () => undefined, pause: () => undefined };
        ended = () => a.onended?.();
        return a as unknown as HTMLAudioElement;
      },
    });
    const done = speaker.speak("短句，一段就够。");
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(states, [true], "开播就该报 speaking");
    ended();
    await done;
    assert.deepEqual(states, [true, false], "播完才报 idle");
  });

  it("合成期间被抢占（撤回 / 下一轮）→ 这一段作废，不会晚几秒再冒出来", async () => {
    const { createSpeaker } = await import("../src/web-shim/index.ts");
    const states: boolean[] = [];
    let release!: () => void;
    const speaker = createSpeaker({
      synthesize: () => new Promise((r) => (release = () => r({ bytes: new Uint8Array([1]), error: null }))),
      onPlayingChange: (p) => void states.push(p),
      createAudio: () => fakeAudio().audio as unknown as HTMLAudioElement,
    });
    const first = speaker.speak("被撤回的原文");
    speaker.stop();
    release();
    await first;
    assert.deepEqual(states, [], "作废的那一段不该驱动出任何播放状态");
  });

  it("合成失败或自动播放被拒 → 静音降级，不抛错、不打断对话", async () => {
    const { createSpeaker } = await import("../src/web-shim/index.ts");
    const speaker = createSpeaker({
      synthesize: async () => { throw new Error("boom"); },
      onPlayingChange: () => undefined,
      createAudio: () => fakeAudio().audio as unknown as HTMLAudioElement,
    });
    await speaker.speak("随便");
    assert.equal(speaker.playing, false);
  });
});

describe("[ACR-049] 播报与事件流的配合", () => {
  /**
   * 用一条假的 SSE 流驱动真实的 emitAll：fetch 返回一个可控的 ReadableStream，
   * 我们往里推帧，看垫片 emit 了什么、speaker 被怎么调。
   * 这样测的是**真实的抑制与抢占逻辑**，不是把 project 的结果重念一遍。
   */
  const harness = (opts: { speaker?: boolean } = {}) => {
    const spoken: string[] = [];
    const stops: string[] = [];
    const events: { event: string; payload: unknown }[] = [];
    let push!: (frame: string) => void;
    let close!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        push = (frame) => c.enqueue(new TextEncoder().encode(frame));
        close = () => c.close();
      },
    });
    const shim = createShim({
      mockIPC: () => undefined,
      emit: async (event, payload) => void events.push({ event, payload }),
      credentials: { username: "demo", password: "pw" },
      fetch: (async (url: string) => {
        if (url.endsWith("/stream")) return new Response(body, { status: 200 });
        return new Response(
          JSON.stringify(url === "/v1/auth/login" ? { accessToken: "t", user: { id: "u", displayName: null } } : {}),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
      ...(opts.speaker === false
        ? {}
        : {
            createSpeaker: () => ({
              speak: async (t: string) => void spoken.push(t),
              stop: () => void stops.push("stop"),
              get playing() { return false; },
            }),
          }),
    });
    const frame = (event: unknown) =>
      "data: " + JSON.stringify({ eventId: "1", sessionId: "s", ts: 1, event }) + "\n\n";
    const settle = () => new Promise((r) => setTimeout(r, 30));
    /*
     * 收尾必须走 close_session，不能只关流。
     * 流自然结束时垫片会当成断线去重连（生产里就该如此——网关重启后要自己接回来），
     * 只 close() 的话重连定时器一直挂着，node:test 永远不退出。
     */
    const teardown = async () => {
      await shim.dispatch("close_session", { sessionId: "s" });
      close();
    };
    return { shim, spoken, stops, events, push, frame, settle, teardown };
  };

  const states = (events: { event: string; payload: unknown }[]) =>
    events.filter((e) => e.event === BRIDGE_EVENTS.assistantState).map((e) => e.payload);

  /**
   * 每条用例收尾都要断言这一条。
   *
   * 2026-09-20 踩过：`speaker` 定义在 `emitAll` 之后（暂时性死区），
   * emitAll 每帧都抛 ReferenceError，被 SSE 泵的 catch 当成断线吞掉——
   * 线上播报整个失效，而这套测试 38 条全绿。
   * "有没有播"这一个判据不够，还要问"这条流跑得干不干净"。
   */
  const assertClean = (shim: { frameErrors: number }) =>
    assert.equal(shim.frameErrors, 0, "处理事件时抛了异常——多半是代码 bug 被当成断线吞掉了");

  it("turn_end 时播报正文，并抑制那一个 idle——不抑制的话形象会 idle→speaking 闪一下", async () => {
    const h = harness();
    await h.shim.dispatch("start_session_stream", { sessionId: "s" });
    await h.settle();
    h.push(h.frame({ type: "update", kind: "delta", turnId: "t1", text: "续航正常" }));
    h.push(h.frame({ type: "update", kind: "turn_end", turnId: "t1", messageId: "m1" }));
    await h.settle();
    assert.deepEqual(h.spoken, ["续航正常"]);
    assert.deepEqual(states(h.events), [], "turn_end 那个 idle 必须被抑制，状态交给播放起止");
    assertClean(h.shim);
    await h.teardown();
  });

  it("没有 speaker 时照常回 idle——播报不可用不该把状态机也一起停掉", async () => {
    const h = harness({ speaker: false });
    await h.shim.dispatch("start_session_stream", { sessionId: "s" });
    await h.settle();
    h.push(h.frame({ type: "update", kind: "delta", turnId: "t1", text: "嗯" }));
    h.push(h.frame({ type: "update", kind: "turn_end", turnId: "t1", messageId: "m1" }));
    await h.settle();
    assert.deepEqual(states(h.events), ["idle"]);
    assertClean(h.shim);
    await h.teardown();
  });

  it("撤回时停播并且不念替换文案——否则屏幕写着「我收回了」而声音把原文念完", async () => {
    const h = harness();
    await h.shim.dispatch("start_session_stream", { sessionId: "s" });
    await h.settle();
    h.push(h.frame({ type: "update", kind: "delta", turnId: "t1", text: "不该出现的内容" }));
    h.push(h.frame({ type: "update", kind: "retract", turnId: "t1", replacement: "这段我不能说", reason: "moderation" }));
    await h.settle();
    assert.deepEqual(h.spoken, []);
    assert.equal(h.stops.length >= 1, true);
    assertClean(h.shim);
    await h.teardown();
  });

  it("新一轮开口先停上一轮的播报——不停的话两段声音叠在一起", async () => {
    const h = harness();
    await h.shim.dispatch("start_session_stream", { sessionId: "s" });
    await h.settle();
    h.push(h.frame({ type: "prompt", turnId: "t2", source: "text", transcript: "再问一句" }));
    await h.settle();
    assert.equal(h.stops.length >= 1, true);
    assertClean(h.shim);
    await h.teardown();
  });

  it("访客在设置页关掉播报 → 不播，且 idle 照常回来", async () => {
    const h = harness();
    await h.shim.dispatch("set_broadcast_enabled", { enabled: false });
    await h.shim.dispatch("start_session_stream", { sessionId: "s" });
    await h.settle();
    h.push(h.frame({ type: "update", kind: "delta", turnId: "t1", text: "嗯" }));
    h.push(h.frame({ type: "update", kind: "turn_end", turnId: "t1", messageId: "m1" }));
    await h.settle();
    assert.deepEqual(h.spoken, []);
    assert.deepEqual(states(h.events), ["idle"]);
    assertClean(h.shim);
    await h.teardown();
  });
});

describe("[ACR-049] 播报分段：档位是算出来的，不是拍的", () => {
  it("短文本不切——一段十来个字，切了反而多付一次固定开销", async () => {
    const { splitForSpeech } = await import("../src/web-shim/segment.ts");
    assert.deepEqual(splitForSpeech("胎压 2.3 偏低了。"), ["胎压 2.3 偏低了。"]);
  });

  it("首段要短（≥12 字就切）——它决定车主多久听到第一个字", async () => {
    const { splitForSpeech } = await import("../src/web-shim/segment.ts");
    const segs = splitForSpeech("续航掉得快，先别慌，多数情况是正常的。手册里说，开始几个月预估续航会略微减少，之后趋于平稳。结合你这台车看，近期日均 40 公里，这个水平不算异常。");
    assert.ok(segs.length >= 3, "长回答要切成多段：" + JSON.stringify(segs));
    assert.ok([...segs[0]].length <= 24, "首段过长就失去了分段的意义：" + segs[0]);
    assert.equal(segs.join(""), "续航掉得快，先别慌，多数情况是正常的。手册里说，开始几个月预估续航会略微减少，之后趋于平稳。结合你这台车看，近期日均 40 公里，这个水平不算异常。");
  });

  it("ASCII 句点有歧义，要看前后——不看就会把「3.5 小时」读成「三」「五小时」", async () => {
    const { splitForSpeech } = await import("../src/web-shim/segment.ts");
    const text = "预计还要开 3.5 小时才到，中途建议在服务区休息一次，顺便补个电，这样后半程会轻松很多。";
    for (const seg of splitForSpeech(text)) {
      assert.equal(/\d\.$/.test(seg), false, "在数字中间的小数点上切了：" + seg);
    }
  });

  it("尾巴太短并进前一段——免得最后蹦出两个字", async () => {
    const { splitForSpeech } = await import("../src/web-shim/segment.ts");
    const segs = splitForSpeech("这是第一句话，说得稍微长一点好触发切分。好的。");
    assert.ok([...segs[segs.length - 1]].length >= 8, "尾段太短：" + JSON.stringify(segs));
  });

  it("分段播报：第一段拿到就开口，不等整段合成完", async () => {
    const { createSpeaker } = await import("../src/web-shim/index.ts");
    const order: string[] = [];
    const audios: { onended: null | (() => void) }[] = [];
    const speaker = createSpeaker({
      synthesize: async (t) => {
        order.push("synth:" + [...t].length);
        return { bytes: new Uint8Array([1]), error: null };
      },
      onPlayingChange: (p) => void order.push(p ? "playing" : "stopped"),
      createAudio: () => {
        const a = { onended: null as null | (() => void), onerror: null, play: async () => undefined, pause: () => undefined };
        audios.push(a);
        // 下一个 tick 就播完，让队列往前走
        void Promise.resolve().then(() => a.onended?.());
        return a as unknown as HTMLAudioElement;
      },
    });
    await speaker.speak("续航掉得快，先别慌，多数情况是正常的。手册里说，开始几个月预估续航会略微减少，之后趋于平稳。结合你这台车看，近期日均 40 公里，这个水平不算异常。");
    assert.ok(audios.length >= 3, "应当按段播多次：" + audios.length);
    // 第一次 playing 必须发生在最后一段合成之前——这就是"不等整段"的判据
    const firstPlay = order.indexOf("playing");
    const lastSynth = order.lastIndexOf(order.filter((o) => o.startsWith("synth:")).at(-1)!);
    assert.ok(firstPlay < lastSynth, "开口太晚：" + JSON.stringify(order));
  });
});

describe("[ACR-049] 播报前剥掉 markdown 记号", () => {
  /**
   * 前两条与 Rust 侧 `strip_markdown_for_speech` 的单测**同一组样例**——
   * 两边各有一份实现，靠同样的输入对齐。
   */
  it("剥掉加粗与行内记号", async () => {
    const { stripMarkdownForSpeech } = await import("../src/web-shim/segment.ts");
    assert.equal(
      stripMarkdownForSpeech("换成**里白酒店**，评分`4.9`，*很方便*"),
      "换成里白酒店，评分4.9，很方便",
    );
  });

  it("剥掉行首列表与标题，保留内容", async () => {
    const { stripMarkdownForSpeech } = await import("../src/web-shim/segment.ts");
    assert.equal(stripMarkdownForSpeech("# 第1天\n- 越秀公园\n> 提示"), "第1天\n越秀公园\n提示");
  });

  it("链接只留可读文字——不然会把整串 URL 念出来", async () => {
    const { stripMarkdownForSpeech } = await import("../src/web-shim/segment.ts");
    assert.equal(stripMarkdownForSpeech("详见[保养手册](https://example.com/a?b=1)。"), "详见保养手册。");
  });

  it("剥记号必须在分段之前——先切会把成对的 ** 切散，两半落进不同段就剥不掉", async () => {
    const { splitForSpeech, stripMarkdownForSpeech } = await import("../src/web-shim/segment.ts");
    const raw = "结合你这台车看，近期日均 **40.8 公里**，常温实测续航 **428 公里**，这个水平不算异常。再往下还有几句补充说明。";
    for (const seg of splitForSpeech(stripMarkdownForSpeech(raw))) {
      assert.equal(/[*_`]/.test(seg), false, "送去合成的段里还有记号：" + seg);
    }
  });

  it("送去合成的文本已经剥过记号——这是 TTS 把「星星」读出来的唯一防线", async () => {
    const { createSpeaker } = await import("../src/web-shim/index.ts");
    const sent: string[] = [];
    const speaker = createSpeaker({
      synthesize: async (t) => {
        sent.push(t);
        return { bytes: new Uint8Array(), error: null };
      },
      onPlayingChange: () => undefined,
    });
    await speaker.speak("胎压 **2.3** 偏低了，`建议`充气。");
    assert.deepEqual(sent, ["胎压 2.3 偏低了，建议充气。"]);
  });
});
