/**
 * 客户端版本线的纯逻辑（`check-client-versions.ts` / `release-client.ts`）。
 *
 * 这两个脚本挡的是同一种错：版本号散在三处，改漏一处**不会报错**，
 * 只会让 About 面板与崩溃报告写着两个数字。所以判定逻辑本身必须有测试——
 * 一个自己都没被测过的守卫，和没有守卫的区别只是多了一行绿色输出。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cargoVersion, checkOne, type VersionSource } from "../check/check-client-versions";
import { bump } from "../release/release-client";

const src = (file: string, version?: string): VersionSource => ({ file, version });

describe("cargoVersion", () => {
  it("取 [package] 段里的 version", () => {
    assert.equal(cargoVersion('[package]\nname = "x"\nversion = "1.2.3"\n'), "1.2.3");
  });

  it("**不吃依赖项里的 version**——那是最容易取错的一处", () => {
    const toml = [
      "[package]",
      'name = "cockpit"',
      'version = "0.1.0"',
      "",
      "[dependencies]",
      'tauri = { version = "2", features = [] }',
      'serde = "1"',
    ].join("\n");
    assert.equal(cargoVersion(toml), "0.1.0");
  });

  it("依赖段排在 package 段之前时也不串", () => {
    const toml = ['[workspace]', 'members = []', "", "[package]", 'version = "9.9.9"'].join("\n");
    assert.equal(cargoVersion(toml), "9.9.9");
  });

  it("没有 [package] 段就回 undefined，不猜", () => {
    assert.equal(cargoVersion('[dependencies]\nfoo = { version = "1.0.0" }'), undefined);
  });
});

describe("checkOne", () => {
  const files = [
    "clients/cockpit/package.json",
    "clients/cockpit/src-tauri/tauri.conf.json",
    "clients/cockpit/src-tauri/Cargo.toml",
  ];

  it("三处相同 → 没问题", () => {
    assert.deepEqual(checkOne("cockpit", files.map((f) => src(f, "0.1.0"))), []);
  });

  it("**差一处就报**，且报文里点得出是哪几个文件各是什么", () => {
    const issues = checkOne("cockpit", [
      src(files[0], "0.1.0"),
      src(files[1], "0.2.0"),
      src(files[2], "0.1.0"),
    ]);
    assert.equal(issues.length, 1);
    assert.match(issues[0].detail, /tauri\.conf\.json=0\.2\.0/);
    assert.match(issues[0].detail, /package\.json=0\.1\.0/);
  });

  it("读不到的那一处单独报出来", () => {
    const issues = checkOne("mobile", [src(files[0], "0.1.0"), src(files[1]), src(files[2], "0.1.0")]);
    assert.equal(issues.length, 1);
    assert.match(issues[0].detail, /读不到版本号/);
  });

  it("非 X.Y.Z 形状要拦——Tauri 打包认这个形状", () => {
    const issues = checkOne("cockpit", files.map((f) => src(f, "0.1.0-beta")));
    assert.equal(issues.length, 3, "三处都不合形状就报三条");
    for (const i of issues) assert.match(i.detail, /X\.Y\.Z/);
  });
});

describe("bump", () => {
  it("patch / minor / major 各进各的位", () => {
    assert.equal(bump("0.1.0", "patch"), "0.1.1");
    assert.equal(bump("0.1.9", "minor"), "0.2.0");
    assert.equal(bump("0.9.9", "major"), "1.0.0");
  });

  it("minor 与 major 要把低位归零，不是原样带过去", () => {
    assert.equal(bump("1.4.7", "minor"), "1.5.0");
    assert.equal(bump("1.4.7", "major"), "2.0.0");
  });

  it("给定版本原样采用", () => {
    assert.equal(bump("0.1.0", "3.2.1"), "3.2.1");
  });

  it("认不出的参数直接抛——别默默当成 patch", () => {
    assert.throws(() => bump("0.1.0", "next"), /patch \/ minor \/ major/);
  });
});
