import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isPiAcpUpdateNotice } from "../src/acp-client/update-bridge";

describe("pi-acp 启动提示", () => {
  it("识别并丢弃固定格式的版本提示", () => {
    assert.equal(
      isPiAcpUpdateNotice(
        "New version available: v0.84.4 (installed v0.84.1). " +
          "Run: `npm i -g @earendil-works/pi-coding-agent`\n",
      ),
      true,
    );
  });

  it("不把相似的模型回答误判成启动提示", () => {
    assert.equal(
      isPiAcpUpdateNotice("New version available: please update the vehicle software"),
      false,
    );
  });
});
