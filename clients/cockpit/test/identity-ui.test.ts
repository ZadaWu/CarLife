/**
 * 端上身份三处接线的结构断言（施工单 M49-04，[F-56-04][AC-56-4] / [F-56-06][AC-56-7] / [F-56-07][AC-56-2]）。
 *
 * # 为什么读源码而不是渲染
 *
 * `clients/cockpit` 没有 `react-dom`（渲染层断言都在 `@carlife/ui`，见 hud-window-card.test.ts 的说明）。
 * 而这里要守的恰好是**接线**，不是像素：
 *
 *  - `guest` 字段有没有被真的用上——M48-05 里它就是被 `onDeclared={() => setReady(true)}`
 *    整个丢掉的，界面上选访客与选成员毫无区别，而这不报任何错；
 *  - `switch_device_role` 有没有调用方——M48-04 之后它的调用次数是 **0**，
 *    命令有、入口没有，等于这个能力不存在；
 *  - 二维码有没有真的渲染，还是仍然只印一串裸 deviceId。
 *
 * 三条都是"编得过、跑得起来、功能不存在"的形状，只有结构断言拦得住。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");

const MAIN = read("../src/main.tsx");
const BOARDING = read("../src/features/auth/BoardingGate.tsx");
const IDENTITY = read("../src/features/settings/IdentitySection.tsx");
const SETTINGS = read("../src/features/settings/SettingsScreen.tsx");

describe("[F-56-06][AC-56-7] 访客降级说出来", () => {
  it("`guest` 不再被丢掉——onDeclared 收下它", () => {
    assert.ok(
      !MAIN.includes("onDeclared={() => setReady(true)}"),
      "这正是 M48-05 丢掉 guest 的那一行",
    );
    assert.match(MAIN, /result\.guest/, "要读到声明结果里的 guest");
  });

  it("访客时播报一次降级话术，非访客不播", () => {
    assert.match(MAIN, /if \(result\.guest\)/, "播报必须在 guest 分支里");
    assert.match(MAIN, /announce_downgrade/);
    assert.match(MAIN, /访客模式，不读取个人偏好与日历/);
  });

  it("有常驻标记：播报会过去，标记不会", () => {
    assert.match(MAIN, /GuestBadge/);
    assert.match(MAIN, /ready && guest \? <GuestBadge \/> : null/, "只在访客态渲染");
  });

  it("浏览器走查里没有 Tauri，播报失败不许把界面带崩", () => {
    assert.match(MAIN, /announce_downgrade[\s\S]{0,200}\.catch\(/);
  });
});

describe("[F-56-07][AC-56-2] 车机绑定屏画二维码", () => {
  it("真的渲染了二维码，而不是只印一串裸 id", () => {
    assert.match(BOARDING, /qrSvg\(phase\.deviceId/);
    assert.ok(
      !BOARDING.includes("二维码要等图形库"),
      "那条注释描述的是本单要消除的状态，留着它说明没做完",
    );
  });

  it("裸 deviceId 仍在，且分组显示（扫不动时要能手输）", () => {
    assert.match(BOARDING, /groupHex\(phase\.deviceId\)/);
    assert.match(BOARDING, /\.match\(\/\.\{1,4\}\/g\)/, "4 个一组——连成一串手抄必错");
  });

  it("引导语跟着改成'扫描二维码'，不是'扫描下面这个编号'", () => {
    assert.match(BOARDING, /扫描下面这个二维码/);
    assert.ok(!BOARDING.includes("扫描下面这个编号"));
  });
});

describe("[F-56-04][AC-56-4] pad 双角色切换入口", () => {
  it("`switch_device_role` 终于有调用方了", () => {
    assert.match(IDENTITY, /invoke<string>\("switch_device_role"/);
  });

  it("当前身份常驻可见（设计裁决 R12），且区分已绑/未绑车", () => {
    assert.match(IDENTITY, /当前身份/);
    assert.match(IDENTITY, /尚未绑定车辆/);
    assert.match(IDENTITY, /state\.vin\.slice\(-4\)/, "只显示 VIN 末 4 位");
  });

  it("两个方向的按钮文案都在", () => {
    assert.match(IDENTITY, /用作车机/);
    assert.match(IDENTITY, /退出车机模式/);
  });

  it("**不做环境自动检测**——切换只由按钮触发", () => {
    for (const forbidden of ["navigator.userAgent", "battery", "addEventListener(\"deviceorientation"]) {
      assert.ok(!IDENTITY.includes(forbidden), `不许据 ${forbidden} 猜身份（FL-56 负向验收）`);
    }
  });

  it("透出 M49-02 的降级状态，不让人下次上车才发现要重登", () => {
    assert.match(IDENTITY, /credential_storage_degraded/);
    assert.match(IDENTITY, /本机无法安全保存登录状态/);
  });

  it("浏览器走查里整区不渲染，而不是渲染一个点了报错的开关", () => {
    assert.match(IDENTITY, /if \(!state\) return null;/);
  });

  it("已挂进设置页——组件写了没挂等于没做", () => {
    assert.match(SETTINGS, /import \{ IdentitySection \}/);
    assert.match(SETTINGS, /<IdentitySection/);
  });
});
