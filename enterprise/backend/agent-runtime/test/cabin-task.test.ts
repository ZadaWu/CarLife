/**
 * cabin-task 的提示词组装与**事实核对**（M24 收口：座舱全面 A 型）。
 *
 * 事实核对是 A 型独有的护栏：模型可能不调工具却声称做了（真跑
 * sess-36f62962-9e4 就是这样——只查了状态就说"已经帮小宝把亮度调到 20 了"，
 * 而车机侧 brightness 还是 30）。B 型没有这个风险，因为动作由代码发出。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cabinTaskPrompt, cabinTaskResult, MUTATING_CABIN_TOOLS } from "../src/graph/cabin-task";
import type { VehicleMember } from "@carlife/memory";

const CAPS = {
  vin: "V", model: "Model Y",
  capabilities: {
    model: "Model Y", source: "seed" as const,
    climate: { zones: ["driver", "passenger"], tempRangeC: [16, 28] as [number, number], tempStepC: 0.5, fanLevels: 5, hasSync: true },
    seats: {
      driver: { heatingLevels: 3, ventilationLevels: 3, massageModes: ["off"] },
      rearLeft: { heatingLevels: 3, ventilationLevels: 0, massageModes: ["off"] },
    },
    ambientLight: { zones: ["front"], modes: ["static"], brightnessRange: [0, 100] as [number, number] },
    media: { zones: ["cabin"], sources: ["music", "kids"], volumeRange: [0, 100] as [number, number] },
    fragrance: { present: false, intensities: [], scents: [] },
    childMode: { zones: ["rearLeft"] },
  },
};

const mom: VehicleMember = {
  id: "m-mom", vin: "V", ownerId: "u1", displayName: "妈妈", relation: "母亲",
  roles: ["passenger"], ageBand: "senior", needs: [], cabinPreference: { tempMaxC: 24 }, updatedAt: 0,
};

describe("预取事实进 prompt（省掉模型自己查能力表那一跳）", () => {
  it("能力表写进 prompt：分区名、温度区间、哪个座位没通风、有没有香氛", () => {
    const p = cabinTaskPrompt("空调调到 23 度", { caps: CAPS, roster: [] });
    assert.match(p, /driver \/ passenger/);
    assert.match(p, /16~28℃/);
    assert.match(p, /rearLeft（加热 0~3、无通风/);
    assert.match(p, /香氛：\*\*没有\*\*/);
    assert.match(p, /不必再查/);
  });

  it("名单**带 id**——几个工具都只收 memberId（防编）", () => {
    const p = cabinTaskPrompt("今天副驾是妈妈", { caps: CAPS, roster: [mom] });
    assert.match(p, /id=m-mom/);
    assert.match(p, /已登记座舱偏好/);
    assert.match(p, /不要编/);
  });

  it("能力表读不到时如实写进 prompt，**不许当成「没有」**", () => {
    const p = cabinTaskPrompt("空调调到 23 度", { caps: { error: "车机没连上" }, roster: [] });
    assert.match(p, /读不到/);
    assert.match(p, /车机没连上/);
    assert.match(p, /不要说"已经调好了"|不要说「已经调好了」/);
  });

  it("没有用户身份 / 名单为空，各有各的说法（不混成一句）", () => {
    assert.match(cabinTaskPrompt("x", { caps: undefined, roster: [] }), /没有用户身份/);
    assert.match(cabinTaskPrompt("x", { caps: CAPS, roster: [] }), /还没登记过任何人/);
  });
});

describe("事实核对：说了做了没有，以工具调用记录为准", () => {
  const claiming = "已经帮小宝把氛围灯亮度调到 20 了，以后都会这样。";

  it("零变更工具 + 文本声称做了 → 插入纠正指令", () => {
    const out = cabinTaskResult(claiming, []);
    assert.match(out, /事实核对：这一轮没有执行任何设置或登记动作/);
    assert.match(out, /绝不要复述任何「已经生效」的说法/);
  });

  it("调过变更工具 → 不插入（正常路径不该被噪音污染）", () => {
    const out = cabinTaskResult(claiming, ["cabin_control"]);
    assert.equal(out.includes("事实核对"), false);
  });

  it("零变更工具但文本没声称做了（如追问）→ 不插入", () => {
    const out = cabinTaskResult("您想调到多少度？告诉我具体数值我就去设。", []);
    assert.equal(out.includes("事实核对"), false);
  });

  it("变更工具集合只含真正改变世界的四个——只查询的不算", () => {
    assert.deepEqual(
      [...MUTATING_CABIN_TOOLS].sort(),
      ["cabin_apply_preferences", "cabin_child_mode", "cabin_control", "member_preference_set"],
    );
    for (const readOnly of ["cabin_status", "vehicle_member", "preference_recall"]) {
      assert.equal(MUTATING_CABIN_TOOLS.has(readOnly), false, `${readOnly} 是只读，不该算变更`);
    }
  });
});
