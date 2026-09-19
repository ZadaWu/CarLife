/**
 * [F-18-15][AC-18-11] 服务点图层与行程标注互不相干（M93-05）。
 *
 * M19-05 的纪律：`AmapTripLayer` 里那个大 effect 重跑一次 = **7 段路径规划 + 取景 +
 * 跟车动画全部重做**。所以"轻量的变化"一律不进它的依赖数组，另起一个只管自己那批覆盖物的
 * effect（导览角标当年就是这么处理的）。沿途服务点是同一类东西：车主每点一下「餐饮」都要
 * 重算整条路线的话，那一排开关就没法用。
 *
 * 判据只能是**结构性**的：本包没有 jsdom，路径规划也没法在用例里打桩，
 * 所以读源码断言两件事——服务点不在大 effect 的依赖里、它自己那个 effect 只依赖两样。
 * （验收 §5 写明用的是这一种，不是运行时计数桩。）
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/map/AmapTripLayer.tsx", import.meta.url), "utf8");

/** 把源码里每个 `}, [ … ]);` 的依赖数组原文取出来。 */
const depArrays = [...SRC.matchAll(/\}, \[([\s\S]*?)\]\);/g)].map((m) =>
  m[1]!
    .replace(/\/\/[^\n]*/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

describe("[F-18-15][AC-18-11] 沿途服务点是独立一层", () => {
  it("大 effect（stopsKey 那个）的依赖里没有任何 service*", () => {
    const big = depArrays.find((d) => d.includes("stopsKey") && d.includes("navKey"));
    assert.ok(big, "找不到那个大 effect 的依赖数组——它被改了，这条断言要跟着改");
    assert.deepEqual(
      big.filter((d) => d.toLowerCase().includes("service")),
      [],
      `服务点进了大 effect 的依赖：切一次类目就重做 7 段路径规划（${big.join(", ")}）`,
    );
  });

  it("服务点自己的 effect 只依赖 [servicePoisKey, mapEpoch]", () => {
    const own = depArrays.find((d) => d.includes("servicePoisKey"));
    assert.ok(own, "服务点图层的 effect 不见了");
    assert.deepEqual(own, ["servicePoisKey", "mapEpoch"]);
  });

  it("它只增删自己那批覆盖物，不碰行程标注的 ref", () => {
    // 取 `serviceOverlaysRef` 那个 effect 的函数体：从声明处到它的依赖数组为止。
    const at = SRC.indexOf("const prev = serviceOverlaysRef.current;");
    assert.ok(at > 0, "服务点 effect 的结构变了");
    const body = SRC.slice(at, SRC.indexOf("}, [servicePoisKey, mapEpoch]);", at));
    for (const forbidden of ["overlaysRef", "routeLinesRef", "fitToStops", "Driving"]) {
      assert.ok(!body.includes(forbidden), `服务点图层碰了 ${forbidden}——那是大 effect 的东西`);
    }
  });

  it("按内容指纹比，不按数组引用比——调用方每次传的都是新字面量", () => {
    assert.match(SRC, /const servicePoisKey = useMemo\(/);
  });
});
