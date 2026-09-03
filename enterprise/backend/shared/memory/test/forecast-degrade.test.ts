/**
 * 保养推算的降级理由与"不可用速率传不进来"（施工单 M26-05，F-53-10/11，AC-53-10）。
 *
 * 这一组守的是工单约束 1 查出来的那个真实缺陷：
 * `enterprise/backend/worker/vehicle-reminder.ts` 只判了 `sampleSize > 0`、没判 `verdict.usable`，
 * 于是 ⑥ **陈旧**的速率照样进推算，提醒里那句"按当前用车强度约 N 天后到期"
 * 建立在 `usage_profile` 自己都判为不可用的数据上。
 *
 * 修法不是"记得多判一次"，是让它**在类型上传不进来**。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAINTENANCE_DEGRADE_LABEL,
  forecastMaintenance,
  usableRate,
} from "../src/vehicle-store";

const day = (n: number) => Date.UTC(2026, 0, n);
const car = {
  odometerKm: 18_000,
  maintenanceIntervalKm: 10_000,
  maintenance: [{ at: day(1), odometerKm: 10_000, items: "常规", source: "dealer" }],
};

describe("usableRate：不可用的速率造不出来", () => {
  it("`usable: false` → undefined，不管数字多好看", () => {
    assert.equal(usableRate(42, false), undefined);
  });

  it("可用但数字非法（0 / 负 / NaN / undefined）→ 同样 undefined", () => {
    for (const v of [0, -1, Number.NaN, undefined]) {
      assert.equal(usableRate(v as number | undefined, true), undefined, `${v} 不该通过`);
    }
  });

  it("可用且合法 → 拿得到速率", () => {
    assert.deepEqual(usableRate(42, true), { avgDailyKm: 42 });
  });
});

describe("降级理由：说清缺什么，不是一个布尔", () => {
  it("数据齐全 → 没有理由，degraded 为 false", () => {
    const f = forecastMaintenance(car, { rate: usableRate(40, true) });
    assert.deepEqual(f.reasons, []);
    assert.equal(f.degraded, false);
  });

  it("缺周期 / 缺上次保养各自成一条理由", () => {
    const f = forecastMaintenance({ odometerKm: 5_000, maintenance: [] }, {
      rate: usableRate(40, true),
    });
    assert.ok(f.reasons.includes("no-interval"));
    assert.ok(f.reasons.includes("no-last-service"));
    assert.equal(f.degraded, true, "degraded 由 reasons 派生，向后兼容");
  });

  it("**⑥ 不可用 → 只给里程口径，不给天数**，并记 `rate-unusable`", () => {
    const f = forecastMaintenance(car, { rate: usableRate(42, false) });
    assert.equal(f.etaDays, undefined, "不拿一个不知道的速率去折算天数");
    assert.equal(f.remainingKm, 2_000, "里程口径照给");
    assert.ok(f.reasons.includes("rate-unusable"));
    assert.ok(f.basis.some((b) => b.includes("不给到期时间估计")));
  });

  it("**④ 里程陈旧 → 记 `stale-odometer` 并在依据里说出来**（AC-53-10）", () => {
    const f = forecastMaintenance(car, { rate: usableRate(40, true), odometerStale: true });
    assert.ok(f.reasons.includes("stale-odometer"));
    assert.ok(
      f.basis.some((b) => b.includes("很久没更新")),
      "陈旧要说出口，不能默默按它算",
    );
    assert.equal(f.degraded, true);
  });

  it("每条理由都有能直接念出来的说法", () => {
    for (const r of ["no-interval", "no-last-service", "stale-odometer", "rate-unusable"] as const) {
      assert.ok(MAINTENANCE_DEGRADE_LABEL[r].length > 8, `${r} 的说法太短，等于没说`);
      assert.equal(
        MAINTENANCE_DEGRADE_LABEL[r].includes("数据不足"),
        false,
        "「数据不足」四个字对用户没有用处",
      );
    }
  });

  it("补录前后可区分：补了 ④ 但 ⑥ 仍不可用 → 有里程口径、仍没有天数", () => {
    const before = forecastMaintenance({ odometerKm: 5_000, maintenance: [] }, {
      rate: usableRate(40, false),
    });
    const after = forecastMaintenance(car, { rate: usableRate(40, false) });
    assert.ok(before.reasons.includes("no-last-service"));
    assert.equal(after.reasons.includes("no-last-service"), false, "补录后这条理由消失");
    assert.equal(after.etaDays, undefined, "⑥ 仍不可用 ⇒ 仍然不给天数");
    assert.ok(after.reasons.includes("rate-unusable"));
  });

  it("④⑥ 都补齐 → 天数出现，且没有任何降级理由", () => {
    const f = forecastMaintenance(car, { rate: usableRate(40, true) });
    assert.ok((f.etaDays ?? 0) > 0);
    assert.deepEqual(f.reasons, []);
  });
});
