/**
 * [F-58-10][F-58-11][AC-58-5][AC-58-7] 体检行进弹窗解析（M77-04）：体检行被抽出成 audit，
 * 天序 / 大交通行不受影响，天序行按 finding 的天打 attention / repaired 标；无体检行时 audit 为 undefined。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseConfirm } from "../src/features/hitl/parseConfirm";
import { DEMO_PERMISSION } from "../src/data/demoPermission";

describe("[F-58-11][AC-58-7] parseConfirm × 体检行", () => {
  it("演示夹具：4 天 + 大交通照旧；audit 解出 5 / 1 / 1 / 1；第 2 天 repaired、第 3 天 attention", () => {
    const v = parseConfirm(DEMO_PERMISSION.details, DEMO_PERMISSION.title);
    assert.equal(v.days.length, 4);
    assert.ok(v.transit);
    assert.equal(v.rows.length, 0, "体检行不该掉进未结构化的 rows");
    assert.ok(v.audit);
    assert.equal(v.audit.passed, 5);
    assert.equal(v.audit.attention.length, 1);
    assert.equal(v.audit.unverifiable.length, 1);
    assert.equal(v.audit.repaired.length, 1);
    assert.deepEqual(v.days[1]!.flags, { repaired: true });
    assert.deepEqual(v.days[2]!.flags, { attention: true });
    assert.equal(v.days[0]!.flags, undefined);
    assert.match(v.audit.unverifiable[0]!.text, /缺出发地/);
  });

  it("没有体检行：audit 为 undefined，其余解析与之前逐字相同", () => {
    const plain = DEMO_PERMISSION.details.filter((d) => !d.label.startsWith("体检·"));
    const v = parseConfirm(plain, DEMO_PERMISSION.title);
    assert.equal(v.audit, undefined);
    assert.equal(v.days.length, 4);
    assert.ok(v.days.every((d) => d.flags === undefined));
  });
});
