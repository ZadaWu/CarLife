/**
 * `qdrant-backup.ts` 里两个纯函数的单测。
 *
 * 只测这两个是有理由的：备份与恢复本身要连真服务（演练子命令 `drill` 就是它们的验证），
 * 而**删旧备份**是整个脚本里唯一一处会造成不可逆损失的逻辑——它必须在没有服务的环境里也能被钉住。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collectionFromFile, prunable, snapshotFileName } from "./qdrant-backup";

const files = [
  "manual_figures-2026-09-10T01-00-00-000Z.snapshot",
  "manual_figures-2026-09-11T01-00-00-000Z.snapshot",
  "manual_figures-2026-09-12T01-00-00-000Z.snapshot",
  "other_collection-2026-09-12T01-00-00-000Z.snapshot",
  "随手放进来的.txt",
];

describe("qdrant-backup 的保留策略", () => {
  it("保留最近 N 份，删更早的", () => {
    assert.deepEqual(prunable(files, "manual_figures", 2), [
      "manual_figures-2026-09-10T01-00-00-000Z.snapshot",
    ]);
  });

  it("份数不够时一个都不删", () => {
    assert.deepEqual(prunable(files, "manual_figures", 5), []);
  });

  it("keep=0 是「不做保留管理」而不是「全删」——演练里就是这么用的", () => {
    assert.deepEqual(prunable(files, "manual_figures", 0), []);
  });

  it("不碰别的 collection，也不碰非快照文件", () => {
    const out = prunable(files, "manual_figures", 1);
    assert.equal(out.every((f) => f.startsWith("manual_figures-")), true);
    assert.equal(out.includes("随手放进来的.txt"), false);
  });
});

describe("qdrant-backup 的文件名", () => {
  it("文件名能反推回 collection", () => {
    const name = snapshotFileName("manual_figures", new Date("2026-09-12T11:40:54.534Z"));
    assert.equal(collectionFromFile(name), "manual_figures");
  });

  it("文件名里不含冒号与点——部分文件系统上会出问题", () => {
    const name = snapshotFileName("manual_figures", new Date());
    assert.equal(/[:.]/.test(name.replace(".snapshot", "")), false);
  });

  it("不是本脚本产出的文件名，明确报错而不是猜一个 collection", () => {
    assert.throws(() => collectionFromFile("backup.snapshot"), /不像本脚本产出的快照/);
  });
});
