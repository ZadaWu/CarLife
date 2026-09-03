/**
 * cabin_media（M27）—— 车内音乐的选曲与播放控制。
 *
 * 盯四条：
 *
 *  1. **命令白名单**：模型编一个 command 要当场被拒，不能悄悄当成某个默认动作。
 *  2. **`duck` 不对模型开放**：让路是播报链路的系统行为，模型没有理由主动压低音乐；
 *     暴露给它只是多一条能被误用的路径。
 *  3. **曲库不要 vin**：车主问"有什么歌"时可能还没绑定车，多要一个 vin 只是
 *     平白多一种失败——这条用例钉住"list 不解析 vin"。
 *  4. **透传不加工**：`audible` / `rebuilt` / 匹配到的曲目原样交给转述层。
 *     其中 `audible` 是最要紧的一个：`status:"playing"` 但没声音是真实存在的状态，
 *     工具层把它抹平，模型就只能说"已经放上了"。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  cabinMediaTool,
  setCabinClient,
  ToolError,
  type CabinClient,
  type CabinMediaCommand,
  type CabinPlayerView,
  type CabinTrack,
} from "../src/index";
import { setVehicleStore } from "../src/vehicle-profile";
import type { VehicleStore } from "@carlife/memory";

const VIN = "LSJA24U91NS662403";

const fakeVehicles = {
  async get() {
    return null;
  },
  async listByOwner() {
    return [
      {
        vin: VIN,
        ownerId: "u1",
        model: "Model Y",
        modelYear: 2024,
        purchasedAt: 0,
        odometerKm: 0,
        maintenance: [],
        repairs: [],
        updatedAt: 0,
      },
    ];
  },
} as unknown as VehicleStore;

const track = (id: string, title: string): CabinTrack => ({
  trackId: id,
  title,
  artist: "某某",
  durationSec: 200,
  playable: true,
});

const LIB = [track("t-1", "江湖天涯客"), track("t-2", "长夜")];

function player(over: Partial<CabinPlayerView> = {}): CabinPlayerView {
  return {
    zone: "cabin",
    status: "playing",
    audible: true,
    nowPlaying: { ...LIB[0], positionSec: 3 },
    queue: LIB,
    cursor: 0,
    repeat: "all",
    shuffle: false,
    source: "music",
    volume: 20,
    volumeLimit: null,
    contentTag: "江湖天涯客",
    backend: { name: "mpg123", note: "" },
    ...over,
  };
}

function fakeClient(
  log: CabinMediaCommand[],
  over: { player?: CabinPlayerView; rebuilt?: boolean } = {},
): CabinClient {
  return {
    async bind() {
      throw new Error("not used");
    },
    async status() {
      throw new Error("not used");
    },
    async apply() {
      throw new Error("not used");
    },
    async changes() {
      throw new Error("not used");
    },
    async mediaLibrary() {
      return { dir: "/tmp/media", tracks: LIB };
    },
    async mediaPlayer() {
      throw new Error("not used");
    },
    async mediaCommand(_vin, c) {
      log.push(c);
      return {
        ok: true,
        command: c.command,
        matched: c.query ? [LIB[0]] : undefined,
        player: over.player ?? player(),
        rebuilt: over.rebuilt ?? false,
      };
    },
  };
}

afterEach(() => {
  setCabinClient(undefined);
  setVehicleStore(undefined);
});

const ctx = { sessionId: "s1", turnId: "t1" };

describe("命令白名单：编一个要当场被拒", () => {
  it("未知 command → invalid，并把可选值列出来", async () => {
    setVehicleStore(fakeVehicles);
    setCabinClient(fakeClient([]));
    await assert.rejects(
      () => cabinMediaTool.call({ userId: "u1", command: "rewind" }, ctx),
      (e: unknown) => e instanceof ToolError && /play\/pause/.test(e.message),
    );
  });

  it("不给 command → 同样被拒，不默认成某个动作", async () => {
    setVehicleStore(fakeVehicles);
    setCabinClient(fakeClient([]));
    await assert.rejects(
      () => cabinMediaTool.call({ userId: "u1" }, ctx),
      (e: unknown) => e instanceof ToolError,
    );
  });

  it("**`duck` 不在白名单里**——让路是系统行为，不该由模型发起", async () => {
    setVehicleStore(fakeVehicles);
    setCabinClient(fakeClient([]));
    await assert.rejects(
      () => cabinMediaTool.call({ userId: "u1", command: "duck" }, ctx),
      (e: unknown) => e instanceof ToolError,
    );
  });

  it("mode 不给 repeat 也不给 shuffle → 拒，不静默什么都不做", async () => {
    setVehicleStore(fakeVehicles);
    setCabinClient(fakeClient([]));
    await assert.rejects(
      () => cabinMediaTool.call({ userId: "u1", command: "mode" }, ctx),
      (e: unknown) => e instanceof ToolError && /repeat|shuffle/.test(e.message),
    );
  });
});

describe("曲库：与车无关，不要 vin", () => {
  it("list 不解析 vin——没有车辆档案也答得上「有什么歌」", async () => {
    // 刻意**不装** vehicleStore：装了就测不出"到底有没有去解析 vin"。
    setCabinClient(fakeClient([]));
    const { data } = await cabinMediaTool.call({ userId: "u1", command: "list" }, ctx);
    assert.equal(data.tracks?.length, 2);
    assert.equal(data.command, "list");
  });

  it("车机没接入时 list 也要如实报未接入，不返回空曲库", async () => {
    // 空曲库和"车机没连上"是两句完全不同的话：前者是"库里没歌"，
    // 后者是"我现在够不着车机"。混成一句，车主会去翻他明明放好了的目录。
    await assert.rejects(
      () => cabinMediaTool.call({ userId: "u1", command: "list" }, ctx),
      (e: unknown) => e instanceof ToolError && e.category === "unconfigured",
    );
  });
});

describe("点歌与传输：参数怎么传下去", () => {
  it("select 带 query → 原样下传，并回报实际选中的曲目", async () => {
    setVehicleStore(fakeVehicles);
    const log: CabinMediaCommand[] = [];
    setCabinClient(fakeClient(log));
    const { data } = await cabinMediaTool.call({ userId: "u1", command: "select", query: "江湖" }, ctx);
    assert.deepEqual(log, [{ command: "select", query: "江湖" }]);
    // "给你放的是哪首"要从 matched 说，不是从 query 回读——两者可以不一样。
    assert.equal(data.tracks?.[0].title, "江湖天涯客");
  });

  it("select 不带目标 → 不传 query（整库随便放），这是「放首歌」的正常路径", async () => {
    setVehicleStore(fakeVehicles);
    const log: CabinMediaCommand[] = [];
    setCabinClient(fakeClient(log));
    await cabinMediaTool.call({ userId: "u1", command: "select" }, ctx);
    assert.deepEqual(log, [{ command: "select" }]);
  });

  it("传输命令不夹带 query/trackIds——「下一首」跟点了什么歌无关", async () => {
    setVehicleStore(fakeVehicles);
    const log: CabinMediaCommand[] = [];
    setCabinClient(fakeClient(log));
    await cabinMediaTool.call({ userId: "u1", command: "next", query: "江湖" }, ctx);
    assert.deepEqual(log, [{ command: "next" }]);
  });

  it("mode 把 repeat/shuffle 传下去", async () => {
    setVehicleStore(fakeVehicles);
    const log: CabinMediaCommand[] = [];
    setCabinClient(fakeClient(log));
    await cabinMediaTool.call({ userId: "u1", command: "mode", repeat: "one", shuffle: true }, ctx);
    assert.deepEqual(log, [{ command: "mode", repeat: "one", shuffle: true }]);
  });
});

describe("透传不加工：转述层要拿到真状态", () => {
  it("`audible:false` 原样带出——播放器在播不等于有声音", async () => {
    setVehicleStore(fakeVehicles);
    setCabinClient(
      fakeClient([], {
        player: player({
          status: "playing",
          audible: false,
          audibleNote: "本机没有 mpg123 也没有 afplay",
          backend: { name: "none", note: "本机没有可用的播放后端" },
        }),
      }),
    );
    const { data } = await cabinMediaTool.call({ userId: "u1", command: "play" }, ctx);
    assert.equal(data.player?.status, "playing");
    assert.equal(data.player?.audible, false, "audible 被抹平的话，模型只会说「已经放上了」");
    assert.ok(data.player?.audibleNote);
  });

  it("`sink` 段原样带出——模型靠它分辨 audible:false 的四种原因（M63）", async () => {
    // 抹掉 sink 的后果不是编译红，是模型只剩一句"没接出声的部件"可说，
    // 而那句话在四种原因里只有一种是对的，另外三种下它是在让车主去修一台没坏的车。
    setVehicleStore(fakeVehicles);
    setCabinClient(
      fakeClient([], {
        player: player({
          status: "playing",
          audible: false,
          audibleNote: "车机端上报的是 paused",
          sink: { kind: "client", sinkId: "cockpit-1", clientStatus: "paused", note: "车机端（cockpit-1）持有出声位" },
        }),
      }),
    );
    const { data } = await cabinMediaTool.call({ userId: "u1", command: "play" }, ctx);
    assert.equal(data.player?.sink?.kind, "client");
    assert.equal(data.player?.sink?.clientStatus, "paused");
    assert.match(data.player?.audibleNote ?? "", /车机端/);
  });

  it("`rebuilt` 原样带出——车机重连过就意味着队列没了", async () => {
    setVehicleStore(fakeVehicles);
    setCabinClient(fakeClient([], { rebuilt: true }));
    const { data } = await cabinMediaTool.call({ userId: "u1", command: "play" }, ctx);
    assert.equal(data.rebuilt, true);
  });

  it("显式 vin 优先于默认车", async () => {
    setVehicleStore(fakeVehicles);
    setCabinClient(fakeClient([]));
    const { data } = await cabinMediaTool.call({ userId: "u1", vin: "LSJA24U91NS660001", command: "play" }, ctx);
    assert.equal(data.vin, "LSJA24U91NS660001");
  });
});
