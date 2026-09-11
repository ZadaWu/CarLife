/**
 * [F-20-03][AC-20-1] 官方警报代码表的本地查表（施工单 M80-10）。
 *
 * 为什么是查表不是检索：代码是精确键。真跑 turn-3cf7fe2a——一张图 5 条代码拼进向量检索词后
 * 整条查询被稀释，回来的是软件更新与洗车模式，而 APP_w009 明明在库里。
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ALERT_CATALOG_FILE, loadAlertCatalog } from "../src/alert-catalog";

const withCatalog = (raw: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), "alerts-"));
  writeFileSync(join(dir, ALERT_CATALOG_FILE), typeof raw === "string" ? raw : JSON.stringify(raw));
  return dir;
};

const sample = {
  source: "官方",
  fetchedAt: "2026-09-10",
  entries: {
    APP_w009: { models: ["Model 3", "Model Y"], title: "自动紧急制动不可用", meaning: ["无法在本次行程使用"], action: ["通常不需要处理"] },
  },
};

describe("[F-20-03][AC-20-1] loadAlertCatalog", () => {
  it("命中就给出含义与措施，附收录它的车型", () => {
    const c = loadAlertCatalog(withCatalog(sample))!;
    assert.equal(c.size, 1);
    assert.equal(c.fetchedAt, "2026-09-10");
    assert.deepEqual(c.lookup("APP_w009")!.models, ["Model 3", "Model Y"]);
  });

  it("**查不到返回 null**——这是确定的答案，不是「这次没检索到」", () => {
    const c = loadAlertCatalog(withCatalog(sample))!;
    assert.equal(c.lookup("DI_a223"), null, "官方没公布这条，就是没公布");
  });

  it("大小写与空格不该让一条漏掉——抄写时偶有出入", () => {
    const c = loadAlertCatalog(withCatalog(sample))!;
    assert.ok(c.lookup(" app_w009 "));
    assert.ok(c.lookup("APP_W009"));
  });

  it("文件不在 / 坏 JSON / 空表 → null，不抛：这一层是增强不是必需，缺了不该挡启动", () => {
    assert.equal(loadAlertCatalog(mkdtempSync(join(tmpdir(), "empty-"))), null);
    assert.equal(loadAlertCatalog(withCatalog("{ 这不是 json")), null);
    assert.equal(loadAlertCatalog(withCatalog({ entries: {} })), null);
  });
});
