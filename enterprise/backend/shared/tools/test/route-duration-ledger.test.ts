/**
 * 段和核对：拆段只是把同一条路切开，切完的总和必须还是那条路的时长。
 *
 * 回归锚点是 turn-ced08ea1（2026-09-18）：体检要求按 120 分钟上限重拆分段，模型把
 * `上海→包河区` 那条 343 分的路重拆成 `[84,51,43] = 178`，`枞阳县→上海` 那条 449 分的
 * 重拆成 `[103,117,116] = 336`（最后一段 125 分整段丢了）。逐段校验全过——每段单看都是正数、
 * 接续也对。外部症状是端上倒推出"10:32 从上海出发、13:30 到合肥"，460 公里开了 2 小时 58 分。
 *
 * 这一组用例守两头：**该拦的拦住**（上面两条），**不该管的不管**
 * （认不出对应哪条路的链一律跳过——冤枉一条正确的链，模型会去改本来对的数字）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chainsOf,
  isPlaceholderName,
  samePlace,
  toleranceFor,
  verifyLegMinutes,
  type LegLike,
  type RouteDurationRecord,
} from "../src/route-duration-ledger";

const leg = (
  day: number,
  direction: "outbound" | "return",
  from: string,
  to: string,
  minutes: number,
): LegLike => ({ day, direction, from, to: { name: to }, minutes });

/** turn-ced08ea1 那一轮 map_route 的四条实算。 */
const KNOWN: RouteDurationRecord[] = [
  { from: "上海", to: "包河区", durationMin: 343 },
  { from: "包河区", to: "义安区", durationMin: 131 },
  { from: "义安区", to: "枞阳县", durationMin: 79 },
  { from: "枞阳县", to: "上海", durationMin: 449 },
];

describe("连续链的切法", () => {
  it("换天断开、换方向断开；链首的 from 与链尾的 to 就是这条链的两端", () => {
    const chains = chainsOf([
      leg(1, "outbound", "上海", "阳澄湖服务区", 91),
      leg(1, "outbound", "阳澄湖服务区", "荷叶山服务区", 142),
      leg(1, "outbound", "荷叶山服务区", "包河区", 110),
      leg(2, "outbound", "包河区", "义安区", 131),
      leg(4, "return", "枞阳县", "上海", 449),
    ]);
    assert.equal(chains.length, 3);
    assert.deepEqual(
      chains.map((c) => [c.day, c.direction, c.from, c.to, c.minutes, c.legs]),
      [
        [1, "outbound", "上海", "包河区", 343, 3],
        [2, "outbound", "包河区", "义安区", 131, 1],
        [4, "return", "枞阳县", "上海", 449, 1],
      ],
    );
  });

  it("空段列表给空链——不是崩，也不是一条空链", () => {
    assert.deepEqual(chainsOf([]), []);
  });
});

describe("认不认得是同一个地方", () => {
  it("全等 / 切掉括号注解 / 互相包含都算认得", () => {
    assert.equal(samePlace("包河区", "包河区"), true);
    assert.equal(samePlace("屯溪区(黄山市)", "屯溪区"), true);
    assert.equal(samePlace("合肥包河区", "包河区"), true);
  });

  it("一个字的片段不算——那能对上任何地方，核对就成了摆设", () => {
    assert.equal(samePlace("区", "包河区"), false);
    assert.equal(samePlace("", "包河区"), false);
  });

  it("两个不相干的地名不算", () => {
    assert.equal(samePlace("包河区", "义安区"), false);
  });
});

describe("段和核对", () => {
  it("[回归 turn-ced08ea1] 343 分的路被拆成 178 分：拦住，并把两个数都摆出来", () => {
    const problems = verifyLegMinutes(
      [
        leg(1, "outbound", "上海", "阳澄湖服务区(京沪高速北京方向)", 84),
        leg(1, "outbound", "阳澄湖服务区(京沪高速北京方向)", "荷叶山服务区(沪武高速武汉方向)", 51),
        leg(1, "outbound", "荷叶山服务区(沪武高速武汉方向)", "包河区", 43),
      ],
      KNOWN,
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /第 1 天/);
    assert.match(problems[0]!, /178 分/);
    assert.match(problems[0]!, /343 分/);
    assert.match(problems[0]!, /少了 165 分/);
    // 退回文案要说清**怎么改**，否则模型会去删段凑数（M94-04 同款）。
    assert.match(problems[0]!, /atMinute/);
  });

  it("[回归 turn-ced08ea1] 449 分的回程被拆成 336 分：同样拦住，且说的是「回程」不是「第 4 天」", () => {
    const problems = verifyLegMinutes(
      [
        leg(4, "return", "枞阳县", "顺安停车区(沪渝高速上海方向)", 103),
        leg(4, "return", "顺安停车区(沪渝高速上海方向)", "长兴服务区(沪渝高速上海方向)", 117),
        leg(4, "return", "长兴服务区(沪渝高速上海方向)", "上海", 116),
      ],
      KNOWN,
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /回程/);
    assert.match(problems[0]!, /少了 113 分/);
  });

  it("按 restStops 的切点正确拆开：一条都不报", () => {
    const problems = verifyLegMinutes(
      [
        leg(1, "outbound", "上海", "阳澄湖服务区", 91),
        leg(1, "outbound", "阳澄湖服务区", "荷叶山服务区", 142),
        leg(1, "outbound", "荷叶山服务区", "包河区", 110),
        leg(2, "outbound", "包河区", "义安区", 131),
        leg(3, "outbound", "义安区", "枞阳县", 79),
        leg(4, "return", "枞阳县", "上海", 449),
      ],
      KNOWN,
    );
    assert.deepEqual(problems, []);
  });

  it("取整漂移在容差内不报——切点是整分钟，三段拆下来差一两分是正常的", () => {
    const problems = verifyLegMinutes(
      [
        leg(1, "outbound", "上海", "阳澄湖服务区", 91),
        leg(1, "outbound", "阳澄湖服务区", "荷叶山服务区", 142),
        leg(1, "outbound", "荷叶山服务区", "包河区", 113),
      ],
      KNOWN,
    );
    assert.deepEqual(problems, []);
    assert.equal(toleranceFor(343), 10);
    assert.equal(toleranceFor(79), 6, "短途按下限，不能让容差小到被取整噎住");
  });

  it("多出来也拦：回程被重复计进去程那天时，段和会比实算大一截", () => {
    const problems = verifyLegMinutes([leg(4, "outbound", "枞阳县", "上海", 898)], KNOWN);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /多了 449 分/);
  });

  it("链尾写成了酒店名（只认得出起点）：**不比**——两次真跑证明「只认起点」会把第 1 天的链当成整趟总览路线", () => {
    const problems = verifyLegMinutes(
      [
        leg(1, "outbound", "上海", "阳澄湖服务区", 84),
        leg(1, "outbound", "阳澄湖服务区", "如家商旅酒店(合肥包河区万达广场包公园地铁站店)", 94),
      ],
      KNOWN,
    );
    assert.deepEqual(problems, [], "认不出终点就不比：冤一条正确的链的代价是整条自驾方案没了");
  });

  it("[回归 sess-03e06df4] 整趟总览路线与第 1 天的链共享起点（终点是真名）：同样不比", () => {
    const problems = verifyLegMinutes(
      [
        leg(1, "outbound", "成都", "康定驿站", 183),
        leg(1, "outbound", "康定驿站", "理塘天空之城主题服务区", 355),
        leg(1, "outbound", "理塘天空之城主题服务区", "左贡县", 855),
      ],
      [{ from: "成都", to: "定日县", durationMin: 4656 }],
    );
    assert.deepEqual(problems, []);
  });

  it("[回归 sess-69433628] 只认起点那一档不认终点是占位名的路——整趟总览路线不能拿来比第 1 天的链", () => {
    // 模型给 map_route 传了坐标没传名字：resolvePlace 把终点写成「终点(lat,lon)」，那条 4410 分是七天总览。
    const problems = verifyLegMinutes(
      [
        leg(1, "outbound", "成都", "康定驿站", 183),
        leg(1, "outbound", "康定驿站", "G318八角楼服务区", 184),
        leg(1, "outbound", "G318八角楼服务区", "理塘天空之城主题服务区", 171),
        leg(1, "outbound", "理塘天空之城主题服务区", "巴塘", 402),
        leg(1, "outbound", "巴塘", "左贡县", 300),
      ],
      [{ from: "成都", to: "终点(28.1932,86.8283)", durationMin: 4410 }],
    );
    assert.deepEqual(problems, [], "终点是谁都不知道的路，不能拿来猜链尾");
    assert.equal(isPlaceholderName("终点(28.1932,86.8283)"), true);
    assert.equal(isPlaceholderName("途经点2(30.1,118.2)"), true);
    assert.equal(isPlaceholderName("包河区"), false);
    // 起终点都认得出（exact）时占位名不构成豁免——那是同一条路。
    assert.equal(verifyLegMinutes([leg(1, "outbound", "成都", "终点(28.1932,86.8283)", 1000)], [{ from: "成都", to: "终点(28.1932,86.8283)", durationMin: 4410 }]).length, 1);
  });

  it("只认得出起点时什么都不报——那一天分两跳算路的链天然更长，按多了报就是冤枉", () => {
    const problems = verifyLegMinutes(
      [
        leg(1, "outbound", "上海", "苏州", 120),
        leg(1, "outbound", "苏州", "某某酒店", 240),
      ],
      KNOWN,
    );
    assert.deepEqual(problems, []);
  });

  it("同一个起点有两条路时也不比——分不清比哪条就不比", () => {
    const problems = verifyLegMinutes(
      [leg(1, "outbound", "上海", "某某酒店", 10)],
      [...KNOWN, { from: "上海", to: "杭州", durationMin: 120 }],
    );
    assert.deepEqual(problems, []);
  });

  it("**认不出对应哪条路的链一律跳过**——宁可漏，不可冤", () => {
    const problems = verifyLegMinutes(
      [leg(1, "outbound", "杭州", "千岛湖", 999)],
      KNOWN,
    );
    assert.deepEqual(problems, []);
  });

  it("本轮一条路都没算过（登记簿为空）：不核对，那一档由 assertDriveLegs 的 minutes>0 管", () => {
    assert.deepEqual(verifyLegMinutes([leg(1, "outbound", "上海", "包河区", 5)], []), []);
  });

  it("同一条路只报一次，不会因为链里段多就报多条", () => {
    const problems = verifyLegMinutes(
      [
        leg(1, "outbound", "上海", "A", 20),
        leg(1, "outbound", "A", "B", 20),
        leg(1, "outbound", "B", "C", 20),
        leg(1, "outbound", "C", "包河区", 20),
      ],
      KNOWN,
    );
    assert.equal(problems.length, 1);
  });
});
