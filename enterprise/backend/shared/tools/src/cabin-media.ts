/**
 * cabin_media —— 车内音乐的选曲与播放控制（曲库 / 点歌 / 播放暂停上一首下一首）。
 *
 * # 为什么不并进 cabin_control
 *
 * `cabin_control` 的形状是 `{domain, zone, set}`——它表达"设成什么"。
 * 而"下一首"没有对应的设置值可言：硬写成 `set:{transport:"next"}` 是把动词
 * 打扮成名词，而且 `cabin_control` 的 requestId 幂等语义对它根本不成立
 * （同一个键重发"下一首"应当只跳一首，重发"温度 23"则是同一件事）。
 *
 * # 但音量与开关**仍然归 cabin_control**
 *
 * 车机侧只有一份媒体状态：`source` 是总开关、`volume` 是输出音量。
 * 本工具不另开一套——两份状态早晚分叉，分叉的表现是"界面显示在放、喇叭没声"。
 * 所以分工是：**选什么、放不放、跳哪首归这里；多大声、要不要音乐源归 cabin_control**。
 * 提示词里写死了这条，别在两边各实现一半。
 *
 * # `audible` 与 `status` 是两件事
 *
 * `status:"playing"` 只说明播放器进了播放态；**车机上**到底有没有声音出来，
 * 是 `audible` 说的。**两者都要转述**——只看 status 就说"已经放上了"，
 * 正是这套东西最该防的那种假话（M19-02 同一条纪律）。
 *
 * # `audible` 的主语是车机端，不是这台服务器（M63）
 *
 * 出声位已经搬到端上：车机自己拉字节、自己解码出声，服务端只维护状态机。
 * 所以 `audible:false` 的原因要从 `player.sink` 读，而它有**四种**：
 * 端没认领（车机还没接上）／端认领了但暂停了／端上报了错（拉字节或解码失败）／
 * 根本没有车机在场（`sink.kind:"host"`，单机调试形态）。
 *
 * 用一句话盖过这四种，就会说出"这台车机没接出声的部件"那样的话——
 * 它在四种原因里只有一种是对的，另外三种下它是**在让车主去修一台没坏的车**。
 * 分辨口径写在 `pi-agents/prompts/cabin.md` 的那张表里，这里是它的代码侧副本。
 */

import { resolveCabinVin, type CabinVinArgs } from "./cabin-status";
import {
  requireCabinClient,
  type CabinMediaCommand,
  type CabinPlayerView,
  type CabinTrack,
} from "./cabin-backend";
import { defineExternalTool, ToolError, type ExternalTool } from "./external";

/**
 * 模型能发的命令。
 *
 * **`duck` 刻意不在这里**：让路（暖暖说话时把音乐压低）是系统行为，
 * 由播报链路自己触发，不是车主会开口要求的事。把它暴露给模型只会多一条
 * 能被误用的路径——模型没有任何理由主动压低音乐。
 */
export const CABIN_MEDIA_COMMANDS = [
  "list",
  "select",
  "enqueue",
  "play",
  "pause",
  "next",
  "previous",
  "stop",
  "mode",
] as const;

export type CabinMediaCommandName = (typeof CABIN_MEDIA_COMMANDS)[number];

export interface CabinMediaArgs extends CabinVinArgs {
  command?: string;
  query?: string;
  trackIds?: string[];
  repeat?: "off" | "one" | "all";
  shuffle?: boolean;
}

export interface CabinMediaData {
  vin: string;
  command: CabinMediaCommandName;
  /** 曲库（`list` 时给全量；点歌命中时只给命中的那几首）。 */
  tracks?: CabinTrack[];
  /** 播放器现状。`list` 之外的命令都带。 */
  player?: CabinPlayerView;
  /** 本次调用重建过车机侧车辆——队列跟着没了，转述时要说。 */
  rebuilt?: boolean;
}

/** 传输类命令（不需要 query/trackIds）。 */
const TRANSPORT = new Set(["play", "pause", "next", "previous", "stop"]);

export const cabinMediaTool: ExternalTool<CabinMediaArgs, CabinMediaData> = defineExternalTool({
  name: "cabin_media",
  provider: "mock-cabin",
  timeoutMs: 6_000,
  async real(args) {
    const command = String(args.command ?? "").trim() as CabinMediaCommandName;
    if (!CABIN_MEDIA_COMMANDS.includes(command)) {
      throw new ToolError(
        "cabin_media",
        "invalid",
        `command 必须是 ${CABIN_MEDIA_COMMANDS.join("/")} 之一，收到「${args.command ?? ""}」`,
        false,
      );
    }

    const client = requireCabinClient();

    // 曲库与车无关（一台车机一份），**不解析 vin**——车主问"有什么歌"时
    // 还没绑定车也该答得上来，多要一个 vin 只会平白多一种失败。
    if (command === "list") {
      const lib = await client.mediaLibrary();
      return { vin: "", command, tracks: lib.tracks };
    }

    const vin = await resolveCabinVin("cabin_media", args);

    if (command === "mode" && args.repeat === undefined && args.shuffle === undefined) {
      throw new ToolError("cabin_media", "invalid", "mode 至少要给 repeat 或 shuffle 其中之一", false);
    }
    // 点歌不给目标就是整库随机放。这是允许的（"随便放点什么"），但**不要
    // 拿它兜 select 打错的字**——匹配不上时车机侧会直接报 no_match 带原因，
    // 那条原因要原样转述，而不是退成"那给你随便放一首"。
    const body: CabinMediaCommand = { command };
    if (!TRANSPORT.has(command)) {
      if (args.query?.trim()) body.query = args.query.trim();
      if (args.trackIds?.length) body.trackIds = args.trackIds;
      if (args.repeat !== undefined) body.repeat = args.repeat;
      if (args.shuffle !== undefined) body.shuffle = args.shuffle;
    }

    const r = await client.mediaCommand(vin, body);
    return {
      vin,
      command,
      ...(r.matched ? { tracks: r.matched } : {}),
      player: r.player,
      rebuilt: r.rebuilt,
    };
  },
});
