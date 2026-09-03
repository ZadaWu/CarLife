/**
 * 会话生命周期的判据（施工单 M22-03）。
 *
 * 这几条是端上最容易错的：边界方向、"进行中不许切"、以及形象判据是不是派生的。
 * 抽成纯函数就是为了能在这里钉住。M65-02 随 `session-lifecycle.ts` 从 cockpit 搬到
 * `clients/shared/ui`：判据两端共用一份，用例也只有一份，**逐条与搬前同名同断言**。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assistantMode, canRetire, canResume, IDLE_MS } from "../src/dialog/session-lifecycle";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

describe("assistantMode：派生自「本会话有没有说过话」", () => {
  it("零消息 → 休息（开机默认）", () => {
    assert.equal(assistantMode({ messageCount: 0, now: NOW }), "rest");
  });

  it("说过话 → 办公", () => {
    assert.equal(
      assistantMode({ messageCount: 2, lastInteractionAt: NOW - MIN, now: NOW }),
      "work",
    );
  });

  it("**空闲超过阈值 → 回休息**（静默，D3）", () => {
    assert.equal(
      assistantMode({ messageCount: 2, lastInteractionAt: NOW - 31 * MIN, now: NOW }),
      "rest",
    );
  });

  it("**边界与服务端同方向**：正好卡在 30 分钟上还算在办公", () => {
    assert.equal(
      assistantMode({ messageCount: 2, lastInteractionAt: NOW - IDLE_MS, now: NOW }),
      "work",
    );
    assert.equal(
      assistantMode({ messageCount: 2, lastInteractionAt: NOW - IDLE_MS - 1, now: NOW }),
      "rest",
    );
  });
});

describe("canRetire：一轮对话进行中不许收", () => {
  const base = { lastInteractionAt: NOW - 31 * MIN, now: NOW, streaming: false, awaitingPermission: false };

  it("空闲够久且闲着 → 可以收", () => {
    assert.equal(canRetire(base), true);
  });

  /**
   * 把会话收掉会让**未确认的动作连同会话一起消失**，而车主以为他还在等。
   * 晚收几分钟没有任何代价，收错一次的代价是一次说不清的失败。
   */
  it("**正在等应答 → 不收**", () => {
    assert.equal(canRetire({ ...base, streaming: true }), false);
  });

  it("**权限门弹窗挂着 → 不收**", () => {
    assert.equal(canRetire({ ...base, awaitingPermission: true }), false);
  });

  it("还没到点 → 不收", () => {
    assert.equal(canRetire({ ...base, lastInteractionAt: NOW - 5 * MIN }), false);
  });

  it("从没交互过 → 不收（那是个刚建的会话，收它没有意义）", () => {
    assert.equal(canRetire({ ...base, lastInteractionAt: undefined }), false);
  });
});

describe("assistantMode：唤醒窗口把她叫起来（M25-03）", () => {
  it("零消息但唤醒窗口活跃 → 办公（喊一声名字她就该醒）", () => {
    assert.equal(
      assistantMode({ messageCount: 0, now: NOW, wakeUntil: NOW + 15_000 }),
      "work",
    );
  });

  it("窗口过期即消散 → 回休息（截止时刻判定，不是布尔）", () => {
    assert.equal(assistantMode({ messageCount: 0, now: NOW, wakeUntil: NOW }), "rest");
    assert.equal(assistantMode({ messageCount: 0, now: NOW, wakeUntil: NOW - 1 }), "rest");
  });

  it("唤醒窗口不改变既有判据：有近期消息时本来就在办公", () => {
    assert.equal(
      assistantMode({ messageCount: 2, lastInteractionAt: NOW - MIN, now: NOW, wakeUntil: 0 }),
      "work",
    );
  });
});

describe("canResume：bootstrap 时那个会话还能不能接着用", () => {
  it("最后一条消息很新 → 复用", () => {
    assert.equal(canResume({ messages: [{ ts: NOW - MIN }], now: NOW }), true);
  });

  it("**最后一条消息太旧 → 不复用**，建新的", () => {
    assert.equal(canResume({ messages: [{ ts: NOW - 31 * MIN }], now: NOW }), false);
  });

  it("近期创建且空历史 → 复用", () => {
    assert.equal(canResume({ messages: [], createdAt: NOW - MIN, now: NOW }), true);
  });

  it("空历史但没有创建时间 → 不复用（可能是旧的已过期会话）", () => {
    assert.equal(canResume({ messages: [], now: NOW }), false);
  });

  it("空历史且创建太久 → 不复用", () => {
    assert.equal(canResume({ messages: [], createdAt: NOW - 31 * MIN, now: NOW }), false);
  });

  it("按**最后一条**判，不是第一条", () => {
    assert.equal(
      canResume({ messages: [{ ts: NOW - 99 * MIN }, { ts: NOW - MIN }], now: NOW }),
      true,
    );
  });
});
