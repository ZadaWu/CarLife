/**
 * [F-24-02][AC-24-8] 手册图标图片的定位（施工单 M78-01）：按 `vehicle:` 行认目录、缺什么都安静返回 null、两层缓存。
 * 全用注入的读盘替身，不碰真实文件系统。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createIconImageResolver } from "../src/icon-images";

/** 造一个内存文件系统：路径 → 内容；目录列表按前缀算。 */
function fakeFs(files: Record<string, string | Buffer>) {
  const reads: string[] = [];
  const dirReads: string[] = [];
  return {
    reads,
    dirReads,
    readFile: (p: string): Buffer => {
      reads.push(p);
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return Buffer.isBuffer(v) ? v : Buffer.from(v);
    },
    readDir: (p: string): string[] => {
      dirReads.push(p);
      const prefix = `${p}/`;
      const names = new Set<string>();
      for (const k of Object.keys(files)) {
        if (!k.startsWith(prefix)) continue;
        names.add(k.slice(prefix.length).split("/")[0]);
      }
      if (names.size === 0) throw new Error(`ENOENT ${p}`);
      return [...names];
    },
  };
}

describe("[F-24-02][AC-24-8] 手册图标图片定位", () => {
  it("按 md 里的 vehicle: 行认目录——目录名与车型串不相似也认得出", () => {
    // 目录名 tesla-model3，车型串 "Tesla Model 3/Y"：斜杠、空格、大小写全对不上，只能靠 vehicle: 行
    const fs = fakeFs({
      "/icons/tesla-model3-indicators.md": "# 目录\n\nvehicle: Tesla Model 3/Y\n\n| symbol_id |\n",
      "/icons/tesla-model3/low_beam.png": "PNG-LOW",
      "/icons/byd-han-indicators.md": "vehicle: 比亚迪 汉 EV\n",
      "/icons/byd-han/low_beam.png": "PNG-HAN",
    });
    const r = createIconImageResolver({ root: "/icons", ...fs });
    assert.equal(r("Tesla Model 3/Y", "low_beam")?.toString(), "PNG-LOW");
    assert.equal(r("比亚迪 汉 EV", "low_beam")?.toString(), "PNG-HAN", "两个车型各取各的图，不能串");
    assert.deepEqual(r.vehicles().sort(), ["Tesla Model 3/Y", "比亚迪 汉 EV"]);
  });

  it("缺 root / 缺 md / 缺 vehicle 行 / 缺图片 —— 四种都返回 null 且不抛", () => {
    const none = createIconImageResolver({ root: "/nope", ...fakeFs({}) });
    assert.equal(none("Tesla Model 3/Y", "low_beam"), null, "root 不存在");
    assert.deepEqual(none.vehicles(), []);

    const noMd = createIconImageResolver({ root: "/icons", ...fakeFs({ "/icons/readme.txt": "x" }) });
    assert.equal(noMd("Tesla Model 3/Y", "low_beam"), null, "目录里没有 -indicators.md");

    const noVehicle = createIconImageResolver({ root: "/icons", ...fakeFs({ "/icons/a-indicators.md": "# 没有那一行\n" }) });
    assert.equal(noVehicle("Tesla Model 3/Y", "low_beam"), null, "md 里没有 vehicle: 行");

    const noPng = createIconImageResolver({
      root: "/icons",
      ...fakeFs({ "/icons/t-indicators.md": "vehicle: Tesla Model 3/Y\n", "/icons/t/other.png": "x" }),
    });
    assert.equal(noPng("Tesla Model 3/Y", "low_beam"), null, "要的那张图不存在");
    assert.equal(noPng("Tesla Model 3/Y", "other")?.toString(), "x", "目录映射本身是通的——缺的只是那一张，不是整条路");
  });

  it("symbol_id 只认 [a-z0-9_]——不让它拼出目录外的路径", () => {
    const fs = fakeFs({ "/icons/t-indicators.md": "vehicle: V\n", "/icons/t/ok.png": "x" });
    const r = createIconImageResolver({ root: "/icons", ...fs });
    assert.equal(r("V", "ok")?.toString(), "x");
    for (const bad of ["../../etc/passwd", "a/b", "Low_Beam", "a.png"]) assert.equal(r("V", bad), null, bad);
    assert.ok(!fs.reads.some((p) => p.includes("..")), "非法 id 根本不该走到读盘");
  });

  it("两层缓存：目录只扫一次，同一张图只读一次；读不到也缓存（别每轮重试）", () => {
    const fs = fakeFs({ "/icons/t-indicators.md": "vehicle: V\n", "/icons/t/a.png": "A" });
    const r = createIconImageResolver({ root: "/icons", ...fs });
    r("V", "a");
    r("V", "a");
    r("V", "missing");
    r("V", "missing");
    assert.equal(fs.dirReads.length, 1, "目录只扫一次");
    assert.equal(fs.reads.filter((p) => p.endsWith("/a.png")).length, 1, "命中的图只读一次");
    assert.equal(fs.reads.filter((p) => p.endsWith("/missing.png")).length, 1, "读不到的也只试一次");
  });

  it("soleVehicle：恰好一款车时顶上，零款或多款一律 null（宁可不核验，不拿别的车的图去比）", () => {
    const one = createIconImageResolver({ root: "/icons", ...fakeFs({ "/icons/t-indicators.md": "vehicle: Tesla Model 3/Y\n", "/icons/t/a.png": "x" }) });
    assert.equal(one.soleVehicle(), "Tesla Model 3/Y");
    const two = createIconImageResolver({
      root: "/icons",
      ...fakeFs({ "/icons/t-indicators.md": "vehicle: Tesla Model 3/Y\n", "/icons/t/a.png": "x", "/icons/b-indicators.md": "vehicle: 比亚迪 汉 EV\n", "/icons/b/a.png": "y" }),
    });
    assert.equal(two.soleVehicle(), null, "两款车而不知道是哪款——不猜");
    assert.equal(createIconImageResolver({ root: "/nope", ...fakeFs({}) }).soleVehicle(), null);
  });

  it("root 扫不出东西这个结论本身也缓存——不是每次调用都重扫一遍目录", () => {
    const fs = fakeFs({});
    const r = createIconImageResolver({ root: "/nope", ...fs });
    r("V", "a");
    r("V", "b");
    r.vehicles();
    assert.equal(fs.dirReads.length, 1);
  });
});
