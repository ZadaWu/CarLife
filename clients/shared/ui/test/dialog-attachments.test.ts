/**
 * [F-09-07][AC-09-5] 选择前的预检：类别、张数、段数、大小、时长提示——与网关同一份上限，选的时候就知道。
 * [F-09-09][AC-09-6] [F-03-08][AC-03-6] 气泡里的附件：没有取件器时只显示占位标签；有 `upload` 才有添加按钮；
 * 车机端只传 `load` 不出现选择器。没有 jsdom，只断言标记。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TURN_ATTACHMENT_LIMITS, type AttachmentRef, type ChatMessage } from "@carlife/shared";

import { DialogScreen, attachmentLabel, checkPendingAdd, durationHint, formatBytes, kindOfFile, kindOfMime, readyHandles, type DialogScreenProps, type PendingAttachment } from "../src/dialog";

const pending = (kind: "image" | "video", status: PendingAttachment["status"] = "ready", i = 0): PendingAttachment => ({
  id: `p${kind}${i}`,
  kind,
  name: `${kind}-${i}`,
  bytes: 1000,
  contentType: kind === "image" ? "image/jpeg" : "video/mp4",
  status,
  ...(status === "ready" ? { ref: { attachmentId: `h${kind}${i}`, kind, handle: `h${kind}${i}` } } : {}),
});

describe("checkPendingAdd：与网关同一份上限", () => {
  it("照片 / 视频放行；PDF 与音频不从对话层进", () => {
    assert.equal(checkPendingAdd([], { type: "image/jpeg", size: 100 }), null);
    assert.equal(checkPendingAdd([], { type: "video/quicktime", size: 100 }), null);
    assert.match(checkPendingAdd([], { type: "application/pdf", size: 100 }) ?? "", /暂不支持/);
  });
  it("第 10 张照片、第 2 段视频、超大文件各有一句人话", () => {
    const nine = Array.from({ length: TURN_ATTACHMENT_LIMITS.maxImages }, (_, i) => pending("image", "ready", i));
    assert.match(checkPendingAdd(nine, { type: "image/png", size: 10 }) ?? "", /最多发 9 张照片/);
    assert.match(checkPendingAdd([pending("video")], { type: "video/mp4", size: 10 }) ?? "", /只能发 1 段视频/);
    assert.match(checkPendingAdd([], { type: "image/png", size: TURN_ATTACHMENT_LIMITS.imageMaxBytes + 1 }) ?? "", /拍近一点/);
    assert.match(checkPendingAdd([], { type: "video/mp4", size: TURN_ATTACHMENT_LIMITS.videoMaxBytes + 1 }) ?? "", /十几秒/);
    assert.match(checkPendingAdd([], { type: "video/mp4", size: 0 }) ?? "", /空的/);
  });
  it("时长只提示不拦：超过 60 秒说只看前 01:00；60 秒内或未知不说", () => {
    assert.equal(durationHint(undefined), null);
    assert.equal(durationHint(60_000), null);
    assert.match(durationHint(75_000) ?? "", /01:15.*只会看前 01:00/);
  });
  it("readyHandles：全部传好才给句柄；有一项在传或失败 → null", () => {
    assert.deepEqual(readyHandles([pending("image"), pending("video")]), ["himage0", "hvideo0"]);
    assert.equal(readyHandles([pending("image"), pending("video", "uploading")]), null);
    assert.equal(readyHandles([pending("image", "failed")]), null);
    assert.deepEqual(readyHandles([]), []);
  });
  it("**空 type 按扩展名兜底**（相册里的 HEIC 常常没有 type）——不能把用户选的照片挡在门外", () => {
    assert.equal(checkPendingAdd([], { type: "", size: 100, name: "IMG_0001.HEIC" }), null);
    assert.equal(checkPendingAdd([], { type: "application/octet-stream", size: 100, name: "clip.MOV" }), null);
    assert.equal(kindOfFile({ type: "", name: "a.avif" }), "image");
    assert.equal(kindOfFile({ type: "", name: "a.3gp" }), "video");
    // 认不出的仍然拒，且话里带得出是什么
    assert.match(checkPendingAdd([], { type: "", size: 100, name: "note.txt" }) ?? "", /暂不支持/);
    assert.equal(kindOfFile({ type: "", name: "logo.svg" }), null, "SVG 是可执行文档，不收");
  });

  it("别名归并：image/jpg 也算照片", () => {
    assert.equal(kindOfMime("image/jpg"), "image");
    assert.equal(checkPendingAdd([], { type: "IMAGE/JPG; charset=x", size: 100, name: "a.jpg" }), null);
  });

  it("标签与格式化", () => {
    assert.equal(kindOfMime("IMAGE/HEIC"), "image");
    assert.equal(kindOfMime("text/plain"), null);
    assert.equal(formatBytes(24_300_000), "23.2 MB");
    assert.equal(attachmentLabel({ kind: "video", bytes: 24_300_000, durationMs: 75_000 }), "视频 01:15 · 23.2 MB");
    assert.equal(attachmentLabel({ kind: "image", bytes: 320_000 }), "照片 · 313 KB");
    assert.equal(attachmentLabel({ kind: "image" }), "照片");
  });
});

const refs: AttachmentRef[] = [
  { attachmentId: "h1", kind: "image", handle: "h1", contentType: "image/jpeg", bytes: 3000, filename: "灯.jpg" },
  { attachmentId: "h2", kind: "video", handle: "h2", contentType: "video/mp4", bytes: 24_300_000 },
];
const withAttachments: ChatMessage[] = [
  { messageId: "m1", sessionId: "s", turnId: "t", role: "user", source: "text", content: "这灯亮了", ts: 1, attachments: refs },
  { messageId: "m2", sessionId: "s", turnId: "t", role: "assistant", source: "text", content: "看到了", ts: 2 },
];
const render = (props: Partial<DialogScreenProps>): string =>
  renderToStaticMarkup(createElement(DialogScreen, { messages: [], streaming: null, connection: "online", ...props }));

describe("DialogScreen：附件的呈现与入口", () => {
  it("没有取件器：用户气泡里是占位标签（不假装有图），助手气泡没有附件条", () => {
    const html = render({ messages: withAttachments });
    assert.match(html, /data-testid="attachment-strip"/);
    assert.match(html, /📷 照片 · 3 KB/);
    assert.match(html, /🎬 视频 · 23.2 MB/);
    assert.equal((html.match(/attachment-strip/g) ?? []).length, 1, "只有用户那条有附件条");
    assert.ok(!html.includes("<img"), "没有取件器就没有 <img>");
  });
  it("有取件器：视频先是「点了才取」的占位按钮，不在渲染时拉字节", () => {
    const html = render({ messages: withAttachments, attachments: { load: async () => new Blob() } });
    assert.match(html, /dlg-att__video-placeholder/);
    assert.match(html, /aria-label="播放视频 · 23.2 MB"/);
    assert.ok(!html.includes("<video"), "首屏没有 <video>");
  });
  it("只有传了 upload 才有添加按钮与文件选择器（车机端只传 load，没有入口）", () => {
    const send = async () => {};
    const withUpload = render({ onSendText: send, attachments: { load: async () => new Blob(), upload: async () => refs[0] } });
    assert.match(withUpload, /data-testid="attachment-picker"/);
    assert.match(withUpload, /accept="image\/\*,video\/\*"/);
    assert.match(withUpload, /aria-label="添加照片或视频"/);
    const loadOnly = render({ onSendText: send, attachments: { load: async () => new Blob() } });
    assert.ok(!loadOnly.includes("attachment-picker"));
    assert.ok(!loadOnly.includes("添加照片或视频"));
  });
});
