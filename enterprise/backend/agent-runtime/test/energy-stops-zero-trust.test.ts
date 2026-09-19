/**
 * [F-18-05][F-18-08] energyStops 的来源核对：汇聚侧兜底 + 按轮登记簿
 * （行程详情「沿途服务」数据源交接，待执行事项 3）。
 *
 * 交接文档的验收判据：构造一个不在工具返回内的站名，断言其**不被静默写入快照**。
 * 工具侧的当场退回在 `@carlife/tools` 的用例里；这里钉的是正文回落通道与
 * "核对器只接了一半"时的最后一道网，以及登记簿的按轮生命周期。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  peekEnergyStopCandidates,
  recordEnergyStopCandidates,
  resetEnergyStopCandidates,
  sweepEnergyStopCandidates,
} from "../src/energy-candidates";
import { mergeItinerary } from "../src/graph/subgraphs/itinerary";
import type { BranchResult } from "../src/graph/fanout";
import { driveText, legsFrom } from "./helpers/drive-legs";

const INPUT = { goal: "去徐州", constraints: [], userText: "去徐州玩两天", turnId: "t-1" };

const submitted = (agent: string, submission: unknown): BranchResult => ({
  agent,
  status: "ok",
  text: "",
  startedAt: 0,
  endedAt: 1,
  submission,
});

const tour = submitted("tour-task", {
  destination: "徐州",
  days: [
    { day: 1, theme: "到达", area: "云龙湖", spots: [{ name: "云龙湖" }] },
    { day: 2, theme: "返程", area: "云龙湖", spots: [{ name: "彭祖园" }] },
  ],
});

const drive = (energyStops: string[]) =>
  submitted("drive-task", {
    origin: "上海",
    legs: legsFrom([220, 128, 95], ["平桥服务区", "淮安六洞服务区国家电网充电站"], [1, 1, 1], { origin: "上海", destination: "徐州" }),
    energyStops,
  });

afterEach(() => resetEnergyStopCandidates());

describe("汇聚侧：不在本轮补能站返回里的站名不进快照", () => {
  it("一个真站一个编的：真站进快照，编的记入 missing 而不是静默丢", () => {
    const out = mergeItinerary(
      [tour, drive(["淮安六洞服务区国家电网充电站（约 260km 处）", "泗阳服务区充电站"])],
      INPUT,
      ["drive", "tour"],
      { knownEnergyStops: () => [{ name: "淮安六洞服务区国家电网充电站" }] },
    );
    assert.deepEqual(out.plan.energyStops, ["淮安六洞服务区国家电网充电站（约 260km 处）"]);
    assert.ok(
      out.missing.some((m) => m.includes("泗阳服务区充电站") && m.includes("已剔除")),
      `剔除的站名必须让应答看得见：\n${out.missing.join("\n")}`,
    );
  });

  it("全是编的：快照里没有 energyStops，且 legs 的段尾不再被标成 charge", () => {
    const out = mergeItinerary([tour, drive(["泗阳服务区充电站"])], INPUT, ["drive", "tour"], {
      knownEnergyStops: () => [{ name: "淮安六洞服务区国家电网充电站" }],
    });
    assert.equal(out.plan.energyStops, undefined);
    assert.ok(!(out.plan.legs ?? []).some((l) => l.reason === "charge"));
  });

  it("本轮没查过补能站（登记簿为空）：交上来的全部剔除", () => {
    const out = mergeItinerary([tour, drive(["淮安六洞服务区国家电网充电站"])], INPUT, ["drive", "tour"], {
      knownEnergyStops: () => [],
    });
    assert.equal(out.plan.energyStops, undefined);
    assert.ok(out.missing.some((m) => m.includes("淮安六洞服务区国家电网充电站")));
  });

  it("没有登记簿（离线 / 单测）：行为逐字等于从前，照旧写入", () => {
    const out = mergeItinerary([tour, drive(["随便一个站"])], INPUT, ["drive", "tour"]);
    assert.deepEqual(out.plan.energyStops, ["随便一个站"]);
  });

  it("核对通过的站名保留原字符串，段尾对得上就标 charge", () => {
    const out = mergeItinerary([tour, drive(["淮安六洞服务区国家电网充电站"])], INPUT, ["drive", "tour"], {
      knownEnergyStops: () => [{ name: "淮安六洞服务区国家电网充电站" }],
    });
    assert.deepEqual(out.plan.energyStops, ["淮安六洞服务区国家电网充电站"]);
    assert.ok((out.plan.legs ?? []).some((l) => l.reason === "charge"), "段尾是补能站的那段要标 charge");
  });
});

describe("按轮登记簿：记、读、清", () => {
  const cand = (name: string) => ({ name, lat: 33.5, lon: 119.1, kind: "charging" as const });

  it("按 (sessionId, turnId) 归轮；同名后写不覆盖前写；轮结束清空", () => {
    recordEnergyStopCandidates({ sessionId: "s", turnId: "t1" }, [cand("A 站"), cand("B 站")]);
    recordEnergyStopCandidates({ sessionId: "s", turnId: "t1" }, [{ ...cand("A 站"), lat: 0 }]);
    recordEnergyStopCandidates({ sessionId: "s", turnId: "t2" }, [cand("C 站")]);
    const t1 = peekEnergyStopCandidates("s", "t1");
    assert.deepEqual(t1.map((c) => c.name), ["A 站", "B 站"]);
    assert.equal(t1[0]!.lat, 33.5, "先到的那份不被顶掉");
    assert.deepEqual(peekEnergyStopCandidates("s", "t2").map((c) => c.name), ["C 站"]);
    sweepEnergyStopCandidates("s", "t1");
    assert.deepEqual(peekEnergyStopCandidates("s", "t1"), []);
    assert.equal(peekEnergyStopCandidates("s", "t2").length, 1, "只清这一轮");
  });

  it("缺 turnId 就不记——归不了轮的候选谁也读不到", () => {
    recordEnergyStopCandidates({ sessionId: "s" }, [cand("A 站")]);
    assert.deepEqual(peekEnergyStopCandidates("s", "t1"), []);
  });
});
