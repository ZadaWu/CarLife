/**
 * [F-09-07] 端上框灯开关的家在设置页（M104 之后从对话页输入条搬来）。读源码，本包无 jsdom。
 *
 * 守两件事：开关在设置页且写 localStorage；对话页选文件时**现读**那个值——
 * 缓存成 state 的话，用户刚在设置页打开、回到对话页选的第一张照片仍然不跑检测。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const SETTINGS = readFileSync(new URL("../src/features/settings/index.tsx", import.meta.url), "utf8");
const DIALOG = readFileSync(new URL("../../shared/ui/src/dialog/DialogScreen.tsx", import.meta.url), "utf8");

describe("端上框灯：开关在设置页，对话页现读", () => {
  it("设置页有这一组，点了写进 localStorage", () => {
    assert.match(SETTINGS, /<h2>端上框灯<\/h2>/);
    assert.match(SETTINGS, /setOnDeviceVisionEnabled\(next\)/);
    assert.match(SETTINGS, /useState<boolean>\(\(\) => onDeviceVisionEnabled\(\)\)/);
  });

  it("对话页选文件时现读，不缓存成 state", () => {
    assert.match(DIALOG, /if \(kind === "image" && onDeviceVisionEnabled\(\)\) startDetect/);
    assert.equal(/const \[onDevice, setOnDevice\]/.test(DIALOG), false, "缓存成 state 的话设置页改完这一轮不生效");
  });

  it("输入条里只剩「相机 + 输入框 + 发送」三件（定稿）", () => {
    assert.equal(DIALOG.includes("dlg-vision-toggle"), false);
    // 附件键是相机线稿，不是 📎 emoji——emoji 字形随系统走，与定稿对不上。
    assert.match(DIALOG, /className="dlg-attach"[\s\S]{0,400}<svg viewBox="0 0 24 24"/);
    // 只看它有没有被当成文本节点渲染出来：文件里两处注释提到 📎，讲的正是"为什么不再用它"。
    assert.equal(/>\s*📎\s*</.test(DIALOG), false);
  });
});
