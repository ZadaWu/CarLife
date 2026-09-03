/**
 * 出发动画的 cue 表与区间判定（施工单 M64-02，验收 §1 判定 1~6）。
 *
 * 这里守的是整条链上最容易错、且错了不报错的两件事：
 *   ① cue 的时刻不能是第二份手写毫秒（漂了没人知道）；
 *   ② 按相等触发会让大部分 cue 永远不响（rAF 一帧 16ms，时刻不落在帧上）。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { CLIP_START, DEPARTURE_CLIPS, DEPARTURE_TIMELINE, statusAt } from "../src/features/cabin/departure";
import {
  CUE_START,
  DEPARTURE_CUES,
  DEPARTURE_CUE_SPAN,
  cuesBetween,
} from "../src/features/cabin/departure-audio";

const phase = (key: string) => DEPARTURE_TIMELINE.phases.find((p) => p.key === key)!.at;
const cueAt = (cue: string) => DEPARTURE_CUES.find((c) => c.cue === cue)!.at;

describe("cue 时刻来自时间轴，不是第二份毫秒", () => {
  test("四个 cue 的 at 逐条等于对应相位的 at", () => {
    assert.equal(cueAt("chime"), phase("climate"), "chime 必须落在「空调预热」那一拍");
    assert.equal(cueAt("arpeggio"), phase("ambient"), "arpeggio 必须落在「点亮氛围」那一拍");
    assert.equal(
      cueAt("thud"),
      phase("ready"),
      "关门闷响要落在**门关上**那一拍（ready），不是开门那一拍（board）——" +
        "0902 逐帧对齐实测：board=9842ms 时她还在沿车身走，门开在 ~10742ms、关在 ~13442ms",
    );
    assert.equal(cueAt("resolve"), phase("depart"), "resolve 必须落在「出发！」那一拍");
    assert.equal(cueAt("bedIn"), phase("arrive"));
    assert.equal(cueAt("bedOut"), phase("depart"));
  });

  test("换算成片内节拍也对得上——改片子这张表要跟着自动挪", () => {
    assert.equal(cueAt("thud"), CLIP_START.board + DEPARTURE_CLIPS[2].beats.shutAndLit, "门关上、车灯亮的那一拍");
    assert.equal(cueAt("resolve"), CLIP_START.driveoff, "驶离片的片头");
    assert.notEqual(
      DEPARTURE_CUE_SPAN.boardDoorOpen,
      cueAt("thud"),
      "关门声不能落在 doorOpen 上——那是开门",
    );
    assert.equal(DEPARTURE_CUE_SPAN.driveoffStart, cueAt("resolve"));
  });

  test("表按时刻升序，且全部落在时间轴范围内", () => {
    for (let i = 1; i < DEPARTURE_CUES.length; i += 1) {
      assert.ok(DEPARTURE_CUES[i]!.at >= DEPARTURE_CUES[i - 1]!.at, "cue 表必须有序，否则一帧跨两个时顺序会乱");
    }
    assert.equal(DEPARTURE_CUE_SPAN.first, 0);
    assert.ok(DEPARTURE_CUE_SPAN.last < DEPARTURE_CUE_SPAN.total, "最后一个 cue 要留出淡出的余地");
    assert.equal(DEPARTURE_CUE_SPAN.total, DEPARTURE_TIMELINE.total);
  });

  test("「暖暖上车」那一拍没有 cue——它是开门，而我们只有关门声", () => {
    assert.equal(
      DEPARTURE_CUES.filter((c) => c.at === phase("board")).length,
      0,
      "board 是开门那一拍。把关门声挂这儿是第一版的错，0902 逐帧对齐才看出来",
    );
  });
});

describe("按区间触发，不按相等触发", () => {
  test("一帧跨过一个时刻就放一个", () => {
    assert.deepEqual(cuesBetween(4200, 4230), ["chime"]);
  });

  test("一帧跨过两个时刻就一帧放两个，且按序", () => {
    assert.deepEqual(cuesBetween(4200, 5500), ["chime", "arpeggio"]);
  });

  test("没跨过任何时刻就是空——绝大多数帧走这条", () => {
    assert.deepEqual(cuesBetween(0, 16), []);
    assert.deepEqual(cuesBetween(6000, 6016), []);
  });

  test("首帧的 prev 必须是负数，否则 at=0 的铺底会被漏掉且不报错", () => {
    assert.ok(CUE_START < 0);
    assert.deepEqual(cuesBetween(CUE_START, 0), ["bedIn"]);
    assert.deepEqual(cuesBetween(0, 0), [], "prev=0 时 at=0 不命中——这正是 CUE_START 必须为负的原因");
  });
});

describe("边界归属与 statusAt 的 ms >= at 一致", () => {
  const at = phase("climate");

  test("相位起点那一帧算它", () => {
    assert.deepEqual(cuesBetween(at - 1, at), ["chime"]);
  });

  test("下一帧不再算它", () => {
    assert.deepEqual(cuesBetween(at, at + 1), []);
  });

  test("与字幕的边界约定同向：起点那一刻字幕也已经换了", () => {
    assert.equal(statusAt(at), "空调预热");
    assert.notEqual(statusAt(at - 1), "空调预热");
  });
});

describe("同一 cue 在连续帧里只响一次", () => {
  test("上一帧的 now 就是这一帧的 prev，跨过一次就不会再跨第二次", () => {
    assert.deepEqual(cuesBetween(CUE_START, 4217), ["bedIn", "chime"]);
    assert.deepEqual(cuesBetween(4217, 4300), []);
    assert.deepEqual(cuesBetween(4300, 5000), []);
  });

  test("逐帧走完全程，每个 cue 恰好响一次", () => {
    const fired: string[] = [];
    let prev = CUE_START;
    for (let ms = 0; ms <= DEPARTURE_TIMELINE.total; ms += 16) {
      fired.push(...cuesBetween(prev, ms));
      prev = ms;
    }
    assert.equal(fired.length, DEPARTURE_CUES.length, `逐帧走完得到 ${fired.join(",")}`);
    assert.deepEqual(fired, DEPARTURE_CUES.map((c) => c.cue));
  });

  test("掉帧到 200ms 一帧也不会漏 cue", () => {
    const fired: string[] = [];
    let prev = CUE_START;
    for (let ms = 0; ms <= DEPARTURE_TIMELINE.total; ms += 200) {
      fired.push(...cuesBetween(prev, ms));
      prev = ms;
    }
    assert.deepEqual(fired, DEPARTURE_CUES.map((c) => c.cue), "掉帧时靠区间判定兜住，一个都不能漏");
  });
});

describe("重播", () => {
  test("prev 回到 CUE_START 后整表重新可触发", () => {
    assert.deepEqual(cuesBetween(CUE_START, DEPARTURE_TIMELINE.total), DEPARTURE_CUES.map((c) => c.cue));
    // 第二遍：模拟组件按 key={runId} 重挂，effect 内的 prevMs 跟着回到 CUE_START。
    assert.deepEqual(cuesBetween(CUE_START, DEPARTURE_TIMELINE.total), DEPARTURE_CUES.map((c) => c.cue));
  });
});

describe("全程 cue 一个不多一个不少", () => {
  test("六个，且顺序为 bedIn → chime → arpeggio → thud → resolve → bedOut", () => {
    assert.deepEqual(cuesBetween(CUE_START, DEPARTURE_TIMELINE.total), [
      "bedIn",
      "chime",
      "arpeggio",
      "thud",
      "resolve",
      "bedOut",
    ]);
  });

  test("超出时间轴末尾不会再多出 cue", () => {
    assert.deepEqual(cuesBetween(DEPARTURE_TIMELINE.total, DEPARTURE_TIMELINE.total + 10_000), []);
  });
});
