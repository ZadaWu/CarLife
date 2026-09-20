/**
 * [F-09-07][AC-09-1] [F-20-15][AC-20-1] 拍照问诊 · 拍照页（施工单 M104-03）。读源码不渲染（本包无 jsdom）。
 *
 * 守的是：快门与「相册」在**用户手势栈里**直接 click 隐藏的 input（不经 setState 后 effect——那正是 M103-02
 * 在 iOS 上可能不弹的原因）；拍完以空文字 + 一枚句柄发出；失败留在页上；没有上传端口就禁用不假装。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/features/service/capture.tsx", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const CSS = readFileSync(new URL("../src/features/service/service.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const APP = readFileSync(new URL("../src/app/index.tsx", import.meta.url), "utf8");
const count = (s: string, n: string) => s.split(n).length - 1;

describe("[F-09-07][AC-09-1] 两枚 input：都收图片，恰好一枚直开相机", () => {
  it('恰好两枚 <input type="file"，accept="image/*"，一枚 capture="environment"', () => {
    assert.equal(count(SRC, '<input ref='), 2);
    assert.equal(count(SRC, 'accept="image/*"'), 2);
    assert.equal(count(SRC, 'capture="environment"'), 1);
    assert.equal(SRC.includes("video/*"), false, "拍照问诊只收照片");
  });

  it("快门与「相册」的 onClick 直接 click，不经 setState / effect", () => {
    assert.match(SRC, /onClick=\{\(\) => cameraInputRef\.current\?\.click\(\)\}/);
    assert.match(SRC, /onClick=\{\(\) => galleryInputRef\.current\?\.click\(\)\}/);
    assert.equal(/useEffect/.test(SRC), false, "页内没有 effect——click 只在手势栈里发生");
  });
});

describe("[F-20-15][AC-20-1] 拍完即发：空文字 + 一枚句柄（+ 端上框）", () => {
  it("组件 onSend(handle, detections)；App 侧以空串和单元素数组调 sendText", () => {
    assert.match(SRC, /await onSend\(ref\.handle, readyDetections\(\[pending\]\)\)/);
    assert.match(APP, /onSend=\{\(handle, detections\) => sendText\("", \[handle\], detections\)\}/);
    assert.match(APP, /onDone=\{\(\) => \{\s*setCaptureOpen\(false\);\s*setNav\("dialog"\);/);
  });

  it("预检复用对话层的 checkPendingAdd（上限同一份）；端上框灯按开关跑、失败只当没框", () => {
    assert.match(SRC, /checkPendingAdd\(\[\], file\)/);
    assert.match(SRC, /onDeviceVisionEnabled\(\) \? attachments\.detect\(file\)\.catch\(\(\) => undefined\)/);
  });

  it("失败态留在页上有「重试」与「换一张」；没有上传端口快门与相册禁用", () => {
    assert.ok(SRC.includes("上传失败"));
    assert.ok(SRC.includes(">\n                重试\n") || /重试/.test(SRC));
    assert.ok(/换一张/.test(SRC));
    // 两个入口共用一个判据（`canShoot`），不是各写各的——分开写就会出现「快门灰了相册还能点」。
    assert.match(SRC, /const canShoot = Boolean\(attachments\) && ready && !busy;/);
    assert.match(SRC, /className="cap-shutter"[\s\S]{0,120}disabled=\{!canShoot\}/);
    assert.match(SRC, /className="cap-gallery"[\s\S]{0,120}disabled=\{!canShoot\}/);
  });

  it("「从相册选」与快门并排在底部操作条，不缩在顶栏（用户真机反馈）", () => {
    const bar = SRC.slice(SRC.indexOf('className="cap-bar"'), SRC.indexOf("cap-caption"));
    assert.ok(bar.includes('className="cap-gallery"'), "相册按钮要在底部操作条里");
    assert.ok(bar.includes('className="cap-shutter"'), "快门也在这一条里");
    assert.equal(SRC.includes("cap-head__gallery"), false, "顶栏那枚弱文字链已撤掉");
  });

  it("部位芯片不随消息发出：onSend 的参数里没有 part", () => {
    assert.equal(/onSend\([^)]*part/.test(SRC), false);
  });

  /**
   * 没有识别模型的部位必须点不动（2026-09-18 产品决定）。
   *
   * 守的是**表里只有仪表盘是 true**，而不是"有这个字段"：让车主对着没有模型的部位拍一张，
   * 拿回来的只会是一句含糊话——那比不让拍更伤信任。表改了这条会红，是故意的。
   */
  it("只有仪表盘有模型：另外三个部位标 ready: false，并在页上写明「功能开发中」", () => {
    const table = SRC.slice(SRC.indexOf("export const CAPTURE_PARTS"), SRC.indexOf("];", SRC.indexOf("export const CAPTURE_PARTS")));
    assert.match(table, /id: "dash"[^}]*ready: true/);
    for (const id of ["tire", "under", "body"]) {
      assert.match(table, new RegExp(`id: "${id}"[^}]*ready: false`), `${id} 还没有模型，必须是 false`);
    }
    assert.match(SRC, /const ready = active\?\.ready \?\? false;/);
    assert.ok(SRC.includes("功能开发中"), "灰掉按钮还得说明为什么灰");
  });
});

describe("设计系统守卫：全屏层、一枚实心橙、无红、字号走 Token", () => {
  it("页壳铺满、让顶部安全区、不让底导（全屏层没有底导）；快门芯是唯一实心橙", () => {
    assert.match(CSS, /\.cap\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0/);
    assert.match(CSS, /env\(safe-area-inset-top\)/);
    assert.equal(CSS.includes("--hud-bottom-nav-clear"), false);
    assert.equal(count(CSS, "--hud-amber-cta"), 1);
    assert.equal(/#c0392b|--hud-danger/i.test(CSS), false);
    assert.equal(/font-size:\s*\d/.test(CSS), false);
  });

  it("禁用时快门芯真的变灰，不是把那枚橙调淡", () => {
    assert.match(CSS, /\.cap-shutter:disabled \.cap-shutter__core \{[^}]*background: var\(--hud-text-muted\)/);
    assert.match(CSS, /\.cap-gallery:disabled svg \{[^}]*stroke: var\(--hud-text-muted\)/);
  });
});
