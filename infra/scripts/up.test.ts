/**
 * `up.sh` 的启动门契约。
 *
 * Compose 的一条 `up --build` 命令在部分服务构建失败时可能继续使用旧镜像；
 * 这里锁定脚本必须先完成独立 build，再用 `--no-build` 启动。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const SOURCE = readFileSync(new URL("./up.sh", import.meta.url), "utf8");

describe("容器启动门", () => {
  it("构建失败时不会通过一条 up --build 继续启动旧镜像", () => {
    const buildStatements = [...SOURCE.matchAll(/^compose build$/gm)];
    const startStatements = [...SOURCE.matchAll(/^compose up -d --no-build$/gm)];

    assert.equal(buildStatements.length, 1, "必须有且只有一个独立 compose build 阶段");
    assert.equal(startStatements.length, 1, "必须有且只有一个 --no-build 启动阶段");
    assert.ok(
      buildStatements[0].index! < startStatements[0].index!,
      "启动阶段必须排在构建阶段之后",
    );
    assert.doesNotMatch(SOURCE, /^compose up -d --build$/m);
  });
});
