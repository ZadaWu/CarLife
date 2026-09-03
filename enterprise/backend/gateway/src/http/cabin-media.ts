/**
 * 车内音乐的让路端点（M27）—— 播报期间把音乐压低，播完恢复。
 *
 * # 它一路不认车辆
 *
 * 端侧没有"当前这辆车"（vin 活在前端 state 里，而播报发生在 Rust 最底层），
 * 所以最初的写法是按**登录用户的默认车**解析。真跑当场打脸：演示数据里默认车
 * 是迈锐宝 XL（**没绑车机**），而正在放歌的是另一辆 Model Y——让路请求
 * 100% 失败，且现象只是"音乐没让路"，离根因很远。
 *
 * 根子在于按车走这件事本身：让路的物理事实是"主机这套喇叭现在要让给播报"，
 * 而主机只有一套喇叭。所以它交给车机侧的 `POST /media/duck`——
 * 那一层认的是**出声位**不是车辆 id，绑定、默认车、多车全都不参与。
 *
 * # 它不是绑定端点的一部分
 *
 * `vehicle-cabin.ts` 管的是绑定三态（未绑定/离线/已绑定），是设备接入的事；
 * 让路是播放器命令。两者共用 `CabinClient` 但不是同一件事，混在一个路由文件里
 * 下次找"绑定为什么失败"会先读到一堆音量逻辑。
 *
 * # 失败一律 204，不让播报等它
 *
 * 车机没连上、没有默认车、mock 挂了——对播报来说全都是"没什么可压的"。
 * 端侧收到错误也做不了任何事（它总不能因此不说话），而把这些如实报成 4xx/5xx
 * 只会让端侧多一条要处理的分支，且**每一条的正确处理都是"忽略"**。
 * 真正的原因记在网关日志里，排查看那儿。
 *
 * ────────────────────────────────────────────────────────────
 *
 * # 车机端的播放通路（M63-02）：三个端点，失败语义与 duck 相反
 *
 *   GET  /v1/cabin/media/player          播放器现状
 *   POST /v1/cabin/media/sink            认领 + 心跳（响应体也是播放器现状）
 *   GET  /v1/cabin/media/tracks/:id      曲目字节（Range 原样往返）
 *
 * 它们存在的理由：车机端要自己出声。mock-cabin 的三个播放后端全是 spawn
 * 本进程主机上的二进制，部署之后那台机器是服务器——装上 mpg123 响的也是服务器。
 * 所以字节要能被端拉走。
 *
 * **失败必须如实报**，与上面那条 204 恰好相反：duck 失败的后果只是音乐没压低，
 * 而这三个端点失败的后果是**车主听不到歌**，端要据此停播、助手要据此转述原因。
 * 一律 204 的话，端只能一直以为"马上就有声了"。
 *
 * # VIN 从 token 取，不从路径或请求体取
 *
 * 端上有 `bound_vin()`，但信它就等于让端自己声明在操作哪辆车。
 * `req.vehicleVin` 来自设备记录（`auth/index.ts` 校验过 token 的 vin 与库里一致），
 * 不是 token 自称的。**也不要退回"按登录用户的默认车"**——本文件头上半段
 * 记着那条路踩过的坑。
 *
 * # 网关在这一跳上就是一根管子
 *
 * 出声位的租约、后来者赢、`audible` 的取值链**全在 mock/tools 那一侧**（设计 §3）。
 * 这里一条业务 `if` 都没有。本文件里出现"判断该不该出声"的代码就是走错了。
 */

import { Readable } from "node:stream";

import { Router, json } from "express";
import type { Response } from "express";

import { CabinUnboundError, ToolError, type CabinClient, type CabinSinkBeat } from "@carlife/tools";

import type { AuthedRequest } from "../auth";

export interface CabinMediaDeps {
  /** 未注入 = MOCK_CABIN_URL 没配。让路静默跳过——没有车机就没有音乐可压。 */
  cabin?: CabinClient;
}

/** 压到原音量的百分之几。车机侧也有默认值，这里显式给是为了口径写在一处。 */
const DUCK_TO_PERCENT = 30;

export function createCabinMediaRouter(deps: CabinMediaDeps): Router {
  const router = Router();

  router.post("/v1/cabin/media/duck", async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    // 先回，再做。让路是装饰性的，**播报不该等它**——端侧那边这一跳是
    // fire-and-forget，网关这边也没有理由把它变成一次同步等待。
    res.status(204).end();

    const on = (req.body as { on?: unknown })?.on !== false;
    const holdMs = (req.body as { holdMs?: unknown })?.holdMs;

    try {
      if (!deps.cabin) return;
      await deps.cabin.mediaDuck({
        on,
        toPercent: DUCK_TO_PERCENT,
        ...(typeof holdMs === "number" ? { holdMs } : {}),
      });
    } catch (err) {
      // 记一行就够：让路失败的后果只是音乐没压低，不影响任何人说话。
      // **但不能一声不吭**——"演示时音乐没让路"总得查得到原因。
      console.warn(
        `[cabin] 让路失败（on=${on}）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // ── 车机端播放通路（M63-02）────────────────────────────────

  /**
   * 三个端点共用的门。返回 VIN，或者已经把拒绝写完了（返回 null）。
   *
   * 抽出来不是为了少写几行：三处各判一遍，迟早有一处漏掉 `deps.cabin`
   * 的空值，而那一处的表现是 500 而不是"车机没接入"。
   */
  const cockpitVin = (req: AuthedRequest, res: Response): string | null => {
    if (!req.vehicleVin) {
      res.status(403).json({
        error: "cockpit_token_required",
        hint: "这三个端点只给绑定车机用：请用车机的设备令牌调用",
      });
      return null;
    }
    if (!deps.cabin) {
      res.status(503).json({
        error: "cabin_not_configured",
        hint: "网关没有配 MOCK_CABIN_URL，车机侧没有接入",
      });
      return null;
    }
    return req.vehicleVin;
  };

  /**
   * 错误映射。`ToolError` 的三档是**上游已经分好的**，这里只做 HTTP 状态码的换算，
   * 不重新判断——重判一次就是第二处真相源。
   */
  const sendCabinError = (res: Response, err: unknown): void => {
    if (err instanceof CabinUnboundError) {
      res.status(409).json({ error: "cabin_unbound", hint: err.message });
      return;
    }
    if (err instanceof ToolError) {
      res.status(err.category === "invalid" ? 400 : 502).json({ error: err.category, hint: err.message });
      return;
    }
    res.status(502).json({ error: "upstream", hint: err instanceof Error ? err.message : String(err) });
  };

  router.get("/v1/cabin/media/player", async (req: AuthedRequest, res: Response) => {
    const vin = cockpitVin(req, res);
    if (!vin) return;
    try {
      res.json(await deps.cabin!.mediaPlayer(vin));
    } catch (err) {
      sendCabinError(res, err);
    }
  });

  /**
   * 心跳即取状态：一次往返办两件事。
   *
   * 分成两个端点的话端每秒要打两次，而且两次之间状态还可能变——
   * 端拿到的"该放哪首"与"我刚上报的进度"会对不上。
   */
  router.post("/v1/cabin/media/sink", json({ limit: "8kb" }), async (req: AuthedRequest, res: Response) => {
    const vin = cockpitVin(req, res);
    if (!vin) return;
    const body = (req.body ?? {}) as Partial<CabinSinkBeat>;
    const sinkId = typeof body.sinkId === "string" ? body.sinkId.trim() : "";
    if (!sinkId) {
      res.status(400).json({ error: "sink_id_required", hint: "心跳要带 sinkId" });
      return;
    }
    try {
      res.json(await deps.cabin!.mediaSink(vin, { ...body, sinkId }));
    } catch (err) {
      sendCabinError(res, err);
    }
  });

  /**
   * 曲目字节。**原样往返，不"帮忙"**：状态码、四个头、字节流都不重写。
   *
   * 不缓存——没有失效策略的缓存会让换歌之后还放旧的。
   * 不接配额——它不花钱，接上只会让配额报表失真。
   */
  router.get("/v1/cabin/media/tracks/:trackId", async (req: AuthedRequest, res: Response) => {
    if (!cockpitVin(req, res)) return;
    try {
      const upstream = await deps.cabin!.mediaTrack(String(req.params.trackId), req.header("range"));
      res.writeHead(upstream.status, upstream.headers);
      if (!upstream.body) {
        res.end();
        return;
      }
      // 一边收一边吐。`arrayBuffer()` 会把整曲进内存，也会让 Range 变成一句空话。
      Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
    } catch (err) {
      sendCabinError(res, err);
    }
  });

  return router;
}
