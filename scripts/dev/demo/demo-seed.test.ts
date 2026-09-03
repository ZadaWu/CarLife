/**
 * 预置数据自身的不变量（INC-0023）。
 *
 * 这条用例存在的理由很具体：`demo:seed` 的两个 VIN 曾经写成
 * `DEMO0SEED0MODELY1` / `DEMO0SEED0MALIBU1`——里面的 O 和 I 是**字母**，
 * 而 VIN 标准把 I/O/Q 排除在外（与 1/0 易混），`isValidVin` 因此判它们非法。
 *
 * 后果不是报错，是**静默失败**：对演示车的任何档案写入（口头补录、问诊留档、
 * 里程推进）在校验那一步就被挡下，助手照样答得很好，日志里也没有异常。
 * 整整一个 Sprint 没人发现，直到 M26-04 真跑去 PG 读回才暴露。
 *
 * 所以这里断言的不是"字符串等于某个值"，而是"预置数据能被系统接受"。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { isValidVin } from "../../../enterprise/backend/shared/memory/src/vehicle-store";

// 不 import demo-seed.ts：它拉 `@carlife/db`，而 infra/ 不是 workspace 成员，
// `test:infra` 会直接 MODULE_NOT_FOUND。这里读源文件抽字面量，
// 断言的正是"文件里写着的那两个 VIN"——比经过一层运行时更贴近要防的东西。
const SRC = readFileSync(path.join(import.meta.dirname, "demo-seed.ts"), "utf8");
const literal = (name: string): string => {
  const m = new RegExp(`${name} = "([^"]+)"`).exec(SRC);
  assert.ok(m, `demo-seed.ts 里找不到 ${name} 的字面量——改了写法就同步改这里`);
  return m[1];
};
const DEMO_VIN_PREFIX = literal("DEMO_VIN_PREFIX");
const seedVins = (): string[] => [literal("VIN_EV"), literal("VIN_ICE")];

describe("demo:seed 的 VIN 必须过得了系统自己的校验", () => {
  it("每个预置 VIN 都 `isValidVin`——否则演示车什么都写不进去", () => {
    const vins = seedVins();
    assert.ok(vins.length > 0, "一个预置 VIN 都没有，这条用例就失去意义了");
    for (const vin of vins) {
      assert.equal(isValidVin(vin), true, `${vin} 过不了 isValidVin`);
    }
  });

  it("**字母 I / O / Q 一个都不能有**——它们与 1/0 易混，标准里就排除了", () => {
    for (const vin of seedVins()) {
      assert.equal(/[IOQ]/.test(vin), false, `${vin} 里有 I/O/Q`);
    }
  });

  it("reset 的前缀必须真的是 VIN 的前缀，否则清不掉自己造的数据", () => {
    for (const vin of seedVins()) {
      assert.ok(vin.startsWith(DEMO_VIN_PREFIX), `${vin} 不以 ${DEMO_VIN_PREFIX} 开头`);
    }
    assert.equal(/[IOQ]/.test(DEMO_VIN_PREFIX), false, "前缀自己也不能有 I/O/Q");
  });
});

/**
 * 预置里程**不许覆盖用户自己录的数**。
 *
 * 这条守的是一次真实事故：`vehicleUpsertPayload` 的 `update` 里原来带着 `odometerKm`，
 * 而它是一条**绕过仓储层的裸 upsert**——连 `advanceOdometerWithin` 的"只前进"都不过。
 * 车主在端上把里程从 18500 调到 20000 之后，谁跑一次 `demo:seed`（评测前会跑）
 * 就被无声写回 41280；现象是"我明明改过，档案页却没变"，而且没有任何报错。
 *
 * 同一段还守 `odometerAt`：新建时不写时刻的话，新鲜度体检永远判 `unknown`，
 * 于是助手对预置车**每一轮都追问一次里程**，答了也不收敛。
 *
 * 断言读源文件而不是调函数，理由与文件头同一条：demo-seed.ts 拉 `@carlife/db`。
 */
describe("demo:seed 不覆盖用户录进去的里程", () => {
  const body = (): string => {
    const start = SRC.indexOf("export function vehicleUpsertPayload");
    assert.ok(start > 0, "找不到 vehicleUpsertPayload——改了函数名就同步改这里");
    const end = SRC.indexOf("\nfunction maintenance", start);
    return SRC.slice(start, end > start ? end : undefined);
  };
  const section = (label: string): string => {
    const src = body();
    const i = src.indexOf(`${label}:`);
    assert.ok(i > 0, `载荷里没有 ${label}`);
    // 到下一个顶层键为止；`update` 是最后一个，切到函数尾。
    const rest = src.slice(i);
    const next = rest.indexOf("\n    update:", 1);
    return next > 0 ? rest.slice(0, next) : rest;
  };

  it("`update` 里**没有** odometerKm——已存在的车不碰里程", () => {
    assert.equal(
      /odometerKm/.test(section("update")),
      false,
      "update 带上里程 = 每跑一次 seed 就把用户改过的数写回预置值",
    );
  });

  it("`create` 里**有** odometerAt——不写时刻，新鲜度体检永远判 unknown", () => {
    assert.match(section("create"), /odometerAt/);
  });

  it("里程确实被从 `...rest` 里摘了出来（不是靠 update 覆盖顺序碰巧生效）", () => {
    assert.match(body(), /const \{[^}]*odometerKm[^}]*\.\.\.rest\s*\}\s*=\s*v/);
  });
});
