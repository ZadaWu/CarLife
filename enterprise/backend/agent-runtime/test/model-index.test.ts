/**
 * 配置事实表与整车/选装判据（施工单 M21-01，F-47-01 / F-47-05 / F-47-06）。
 *
 * # 这一组盯的是「一个选装包有没有机会被当成一台车」
 *
 * M15-02 实测踩过：`$APF2 | 特斯拉辅助驾驶 | 64,000` 比整车便宜，
 * "取最低价"把它当成了车价，整份五年成本按 6.4 万算出来，
 * 分项、假设、出处一应俱全，**只有车价是错的**。
 * 配置比较（M21-02）会把这类表格行成批摊开，同一个坑的入口从一个变成几十个，
 * 所以判据必须只有一份、且被钉死。
 *
 * # 另一半盯的是「配置的属性有没有被说成车型的属性」
 *
 * 「六座」只属于 `Model Y L`，而它比后驱版贵 7.55 万。
 * 归一必须落到具体配置上（`resolveTrim`），归不了就返回 undefined——**不猜**。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  KNOWN_MODELS,
  MIN_VEHICLE_PRICE_CNY,
  NO_CNY_PRICE_NOTE,
  cnyPriceAvailability,
  entryOf,
  isBelowVehiclePriceFloor,
  isVehicleRow,
  resolveTrim,
  trimsOf,
  vehiclePriceFloor,
} from "../src/graph/model-index";

// enterprise/backend/agent-runtime/test → 仓库根要四层（ACR-020 批④ 后深了一层）
const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const SEED_PATH = resolve(REPO_ROOT, "mocks/dealer/data/models.json");
const KB_DIR = resolve(REPO_ROOT, "data/kb-md");

interface SeedTrim {
  trim: string;
  priceCny?: number;
  rangeKm: number;
  seats: number;
}

function readSeed(): { model: string; trims: SeedTrim[] }[] | undefined {
  if (!existsSync(SEED_PATH)) return undefined;
  return (JSON.parse(readFileSync(SEED_PATH, "utf8")) as { models: { model: string; trims: SeedTrim[] }[] })
    .models;
}

describe("配置事实表（F-47-01）", () => {
  it("列得出每款车的配置，且与报价系统种子逐字一致", () => {
    assert.equal(trimsOf("Model Y").length, 4);
    assert.equal(trimsOf("Model 3").length, 3);
    assert.equal(trimsOf("Cybertruck").length, 2);

    const seed = readSeed();
    assert.ok(seed, "报价系统种子读不到，本条断言失去意义");
    for (const m of seed) {
      const known = trimsOf(m.model).map((t) => t.trim);
      assert.deepEqual(
        known,
        m.trims.map((t) => t.trim),
        `${m.model}: 事实表的配置名必须与 models.json 的 trim 逐字一致且同序`,
      );
    }
  });

  it("没有配置级资料的车型返回空数组——不编配置出来", () => {
    // 迈锐宝在报价系统的种子里根本没有。空数组让它安静地不进配置比较。
    assert.deepEqual(trimsOf("迈锐宝"), []);
    assert.deepEqual(trimsOf("根本不存在的车"), []);
  });

  it("事实表不含价格/续航/座位——那三样跟着报价系统走", () => {
    for (const m of KNOWN_MODELS) {
      for (const t of m.trims) {
        assert.deepEqual(
          Object.keys(t).sort(),
          ["aliases", "trim"],
          `${m.model} ${t.trim}: 事实表只回答命名问题，多一个字段就是多一处会漂移的真相`,
        );
      }
    }
  });
});

describe("配置归一（F-47-01 / F-47-07）", () => {
  it("多种写法归到同一个配置", () => {
    for (const said of ["长续航后驱", "Long Range RWD", "长续航后轮驱动版", "长续航后驱版"]) {
      assert.equal(resolveTrim("Model Y", said), "长续航后轮驱动版", said);
    }
  });

  it("取匹配到的最长别名，不是数组里第一个命中的", () => {
    // 「长续航后轮驱动版」里包含「后轮驱动版」。取第一个命中就会把长续航版
    // 当成标准版回答，两者差 2.5 万，而全程不会有任何报错。
    assert.equal(resolveTrim("Model Y", "我想看长续航后轮驱动版"), "长续航后轮驱动版");
    assert.equal(resolveTrim("Model Y", "我想看后轮驱动版"), "后轮驱动版");
  });

  it("「六座」落到具体配置上，而不是变成车型的属性", () => {
    assert.equal(resolveTrim("Model Y", "Model Y 六座的多少钱"), "Model Y L");
    // 同样的说法在别的车型上归不了——六座是那一个配置的事。
    assert.equal(resolveTrim("Model 3", "六座"), undefined);
  });

  it("归不了就返回 undefined——不猜", () => {
    assert.equal(resolveTrim("Model Y", "随便什么版本"), undefined);
    assert.equal(resolveTrim("迈锐宝", "长续航后驱"), undefined);
    assert.equal(resolveTrim("根本不存在的车", "后驱"), undefined);
  });
});

describe("整车与选装的判据（F-47-05）", () => {
  it("FSD 选装包不是一台车（M15-02 事故复现）", () => {
    // 它比整车便宜、位数也够，唯一拦得住它的是「配置名里必须出现车型名」。
    assert.equal(isVehicleRow("Model 3", "特斯拉辅助驾驶", 64_000), false);
    assert.equal(isVehicleRow("Model Y", "$APF2 特斯拉辅助驾驶", 64_000), false);
  });

  it("整车行判为真", () => {
    assert.equal(isVehicleRow("Model Y", "Model Y 后轮驱动版", 263_500), true);
    assert.equal(isVehicleRow("Model 3", "Model 3 长续航全轮驱动版", 285_500), true);
  });

  it("三位数的服务包不是车", () => {
    assert.equal(isVehicleRow("Model Y", "高级车载娱乐服务 1 年包", 118), false);
    assert.equal(isVehicleRow("Model Y", "Model Y 加装", MIN_VEHICLE_PRICE_CNY - 1), false);
  });

  it("车型不在索引里时退回用车型名本身做判据", () => {
    assert.equal(isVehicleRow("某新车", "某新车 顶配", 200_000), true);
    assert.equal(isVehicleRow("某新车", "轮毂选装", 200_000), false);
  });

  it("非数值金额一律不是车", () => {
    assert.equal(isVehicleRow("Model Y", "Model Y 后轮驱动版", Number.NaN), false);
    assert.equal(isVehicleRow("Model Y", "Model Y 后轮驱动版", Number.POSITIVE_INFINITY), false);
  });
});

describe("整车价的下界（F-47-05 第三条判据）", () => {
  const seed = readSeed();

  it("下界取报价系统里最低配的人民币价", () => {
    assert.ok(seed);
    const modelY = seed.find((m) => m.model === "Model Y");
    assert.ok(modelY);
    assert.equal(vehiclePriceFloor(modelY.trims), 263_500);
  });

  it("每个配置的价格都不低于该车型的下界", () => {
    assert.ok(seed);
    for (const m of seed) {
      const floor = vehiclePriceFloor(m.trims);
      for (const t of m.trims) {
        if (typeof t.priceCny !== "number") continue;
        assert.equal(
          isBelowVehiclePriceFloor(t.priceCny, floor),
          false,
          `${m.model} ${t.trim} (${t.priceCny}) 低于下界 ${floor}`,
        );
      }
    }
  });

  it("拿不到价格就没有下界——不臆造一个", () => {
    assert.equal(vehiclePriceFloor(undefined), undefined);
    assert.equal(vehiclePriceFloor([]), undefined);
    assert.equal(vehiclePriceFloor([{ priceCny: undefined }]), undefined);
    // 没有下界时任何金额都不该被这一条判死。
    assert.equal(isBelowVehiclePriceFloor(1, undefined), false);
  });

  it("Cybertruck 没有人民币价，因此没有下界可用", () => {
    assert.ok(seed);
    const ct = seed.find((m) => m.model === "Cybertruck");
    assert.ok(ct);
    assert.equal(vehiclePriceFloor(ct.trims), undefined);
  });
});

describe("无人民币报价的如实降级（F-47-06）", () => {
  it("Cybertruck 如实说没有，且不换算汇率", () => {
    const r = cnyPriceAvailability("Cybertruck");
    assert.equal(r.available, false);
    assert.match(r.note ?? "", new RegExp(NO_CNY_PRICE_NOTE));
    assert.match(r.note ?? "", /不换算汇率/);
    // 说明文本里**不允许出现任何人民币金额**。
    assert.doesNotMatch(r.note ?? "", /\d{5,}|万元|人民币\s*\d/);
  });

  it("人民币车型且报价系统有价 → 可用", () => {
    const seed = readSeed();
    assert.ok(seed);
    const modelY = seed.find((m) => m.model === "Model Y");
    assert.ok(modelY);
    assert.deepEqual(cnyPriceAvailability("Model Y", modelY.trims), { available: true });
  });

  it("人民币车型但报价系统里这一款全缺价 → 说是数据没有，不是我们不给", () => {
    const r = cnyPriceAvailability("Model Y", [{ priceCny: undefined }]);
    assert.equal(r.available, false);
    assert.match(r.note ?? "", /报价系统里这一款没有人民币价/);
  });

  it("车型不在索引里时如实说不在索引里", () => {
    const r = cnyPriceAvailability("某新车");
    assert.equal(r.available, false);
    assert.match(r.note ?? "", /不在车型索引里/);
  });

  it("USD 车型的币种标记与 KNOWN_MODELS 一致", () => {
    assert.equal(entryOf("Cybertruck")?.priceCurrency, "USD");
  });
});

describe("报价系统与选配表语料的一致性对账（M21-01 任务 4）", () => {
  /**
   * 语料里的价格写成 `263,500`，种子里是 `263500`。两种写法都要认。
   * 这里**不做修正**：对不上就报出双方的数，交回给人判断——
   * 两份数据谁对谁错不是脚本能定的。
   */
  const formats = (n: number): string[] => [String(n), n.toLocaleString("en-US")];

  function optionSheetFor(model: string): { name: string; text: string } | undefined {
    if (!existsSync(KB_DIR)) return undefined;
    const patterns = entryOf(model)?.docPatterns ?? [];
    const hit = readdirSync(KB_DIR).find(
      (name) => name.includes("选配") && patterns.some((re) => re.test(name)),
    );
    return hit ? { name: hit, text: readFileSync(resolve(KB_DIR, hit), "utf8") } : undefined;
  }

  it("每个有人民币价的配置，其价格都能在选配表语料里找到", (t) => {
    const seed = readSeed();
    if (!seed) return t.skip("跳过：读不到 mocks/dealer/data/models.json");
    if (!existsSync(KB_DIR)) return t.skip(`跳过：语料目录不存在（${KB_DIR}）`);

    const mismatches: string[] = [];
    const skipped: string[] = [];
    let checked = 0;

    for (const m of seed) {
      const sheet = optionSheetFor(m.model);
      if (!sheet) {
        skipped.push(`${m.model}：语料里找不到它的选配表`);
        continue;
      }
      for (const trim of m.trims) {
        if (typeof trim.priceCny !== "number") continue;
        checked += 1;
        if (!formats(trim.priceCny).some((f) => sheet.text.includes(f))) {
          mismatches.push(
            `${m.model} ${trim.trim}：种子里是 ${trim.priceCny}，${sheet.name} 里找不到这个数`,
          );
        }
      }
    }

    if (checked === 0) {
      return t.skip(`跳过：一条都没对上账（${skipped.join("；") || "没有带人民币价的配置"}）`);
    }
    assert.deepEqual(
      mismatches,
      [],
      `两份数据对不上就是两个真相，交回给人判断，不自动修正：\n${mismatches.join("\n")}`,
    );
    // 跳过的车型要说出来，静默通过的检查等于没有检查。
    if (skipped.length > 0) console.log(`  ⓘ 对账跳过：${skipped.join("；")}`);
  });
});
