/**
 * [F-07-02][AC-7-2] 设置页的网关入口（施工单 M54-06，缺口 G6）。
 *
 * 此前只有**登录页**有改网关的入口。登录后换 Wi-Fi，所有请求开始失败，
 * 而能改地址的界面在登录门外——唯一路径是退出登录。守两条：
 * 入口存在于设置页；且是**同一个组件**，不是抄的第二份
 * （抄写的结局是"某一条路上改地址不生效"，GatewayForm 文件头原话）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");
const SETTINGS = read("../src/features/settings/index.tsx");

describe("[G6] 登录后也能改网关", () => {
  it("设置页有「网关连接」组且复用登录页的 GatewayField", () => {
    assert.match(SETTINGS, /import \{ GatewayField \} from "\.\.\/auth\/GatewayField"/);
    assert.match(SETTINGS, /<GatewayField \/>/);
    assert.match(SETTINGS, /网关连接/);
  });

  it("只挂一处，不抄第二份表单", () => {
    assert.equal(SETTINGS.split("<GatewayField").length - 1, 1);
    assert.ok(!/set_gateway_settings/.test(SETTINGS), "设置页不许自己另写一条保存链");
  });
});
