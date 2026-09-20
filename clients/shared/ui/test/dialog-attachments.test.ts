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

import { DialogScreen, attachmentLabel, checkPendingAdd, detectSummary, durationHint, formatBytes, kindOfFile, kindOfMime, onDeviceVisionAvailable, onDeviceVisionEnabled, setOnDeviceVisionEnabled, NO_ON_DEVICE_VISION_MARK, ON_DEVICE_VISION_KEY, readyDetections, readyHandles, MAX_DETECTIONS_PER_PHOTO, type DialogScreenProps, type PendingAttachment } from "../src/dialog";

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

describe("端上框灯（ACR-044）", () => {
  it("摘要：跑着 / 失败 / 没框到 / 框到几盏——只报事实，不下结论", () => {
    assert.equal(detectSummary(undefined), null);
    assert.equal(detectSummary({ status: "running" }), "端上找灯中…");
    assert.match(detectSummary({ status: "failed", error: "boom" }) ?? "", /失败：boom/);
    assert.equal(detectSummary({ status: "done", result: { width: 1, height: 1, detections: [], infer_ms: 12 } }), "端上没框到指示灯（12 ms）");
    const s = detectSummary({ status: "done", result: { width: 1, height: 1, infer_ms: 210, detections: [{ bbox: [1, 2, 3, 4], class_id: 11, name: "low_beam", conf: 0.843 }] } }) ?? "";
    assert.match(s, /框到 1 盏（210 ms）：low_beam 84%/);
    assert.doesNotMatch(s, /故障|请立即|联系/);
  });
  it("开关缺省开（ACR-050；没有 localStorage 也不炸）", () => {
    assert.equal(onDeviceVisionEnabled(), true);
  });
  it("显式关过的保持关：关写的是 \"0\" 不是删键——删键分不清「从没碰过」与「碰过又关了」", () => {
    const g = globalThis as { localStorage?: unknown };
    const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    });
    try {
      assert.equal(onDeviceVisionEnabled(), true, "从没碰过 = 缺省开");
      setOnDeviceVisionEnabled(false);
      assert.equal(store.get(ON_DEVICE_VISION_KEY), "0");
      assert.equal(onDeviceVisionEnabled(), false);
      setOnDeviceVisionEnabled(true);
      assert.equal(onDeviceVisionEnabled(), true);
      // 旧版本打开过的人存的是 "1"，照旧是开
      store.set(ON_DEVICE_VISION_KEY, "1");
      assert.equal(onDeviceVisionEnabled(), true);
    } finally {
      if (before) Object.defineProperty(globalThis, "localStorage", before);
      else delete g.localStorage;
    }
  });
  it("没有端上检测的环境（网页演示版）恒为关，哪怕偏好里写着开", () => {
    const g = globalThis as Record<string, unknown>;
    g[NO_ON_DEVICE_VISION_MARK] = true;
    try {
      assert.equal(onDeviceVisionAvailable(), false);
      assert.equal(onDeviceVisionEnabled(), false);
    } finally {
      delete g[NO_ON_DEVICE_VISION_MARK];
    }
    assert.equal(onDeviceVisionAvailable(), true);
  });
  it("开关不在输入条里（M104 起搬去设置页）；也没有任何自测入口（车机不选文件，FL-06）", () => {
    const base: DialogScreenProps = { messages: [], streaming: null, connection: "open", onSendText: async () => {} } as unknown as DialogScreenProps;
    const load = async () => new Blob();
    const detect = async () => ({ width: 1, height: 1, detections: [], infer_ms: 1 });
    const without = renderToStaticMarkup(createElement(DialogScreen, { ...base, attachments: { load } }));
    assert.doesNotMatch(without, /on-device-vision-toggle|端上框灯/);
    /*
     * 给了 detect 也不在输入条里出现：定稿的输入条只有「相机 + 输入框 + 发送」三件，
     * 那枚开关占掉近 90pt 宽、把输入框挤成一条缝；而且它要在**选照片之前**定
     * （`onPickFiles` 里现读），放这一行既不好看也不好用。开关在手机端设置页，
     * 由 `clients/mobile/test/settings-vision-toggle.test.ts` 守。
     */
    const withDetect = renderToStaticMarkup(createElement(DialogScreen, { ...base, attachments: { load, detect } }));
    assert.doesNotMatch(withDetect, /on-device-vision-toggle|端上框灯/);
    assert.doesNotMatch(withDetect, /detect-picker|自测/);
  });
});

describe("readyDetections：端上的框随消息上行（ACR-046）", () => {
  const det = (status: "running" | "done" | "failed", detections: Array<{ bbox: [number, number, number, number]; name: string; conf: number }> = []) =>
    ({ status, ...(status === "done" ? { result: { width: 3024, height: 4032, infer_ms: 312, detections: detections.map((d) => ({ ...d, class_id: 0 })) } } : {}) }) as PendingAttachment["detect"];
  const box = { bbox: [111, 197, 189, 222] as [number, number, number, number], name: "parking_lights", conf: 0.97 };

  it("检测完成的照片按句柄带上；形状对齐服务端（inferMs、没有 class_id）", () => {
    const r = readyDetections([{ ...pending("image"), detect: det("done", [box]) }]);
    assert.deepEqual(r, { himage0: { width: 3024, height: 4032, inferMs: 312, items: [box] } });
  });

  it("检测在跑 / 失败 / 没开（没有 detect）/ 视频 / 还没传好 → 不带；一张都没有 → undefined", () => {
    assert.equal(readyDetections([{ ...pending("image"), detect: det("running") }]), undefined);
    assert.equal(readyDetections([{ ...pending("image"), detect: det("failed") }]), undefined);
    assert.equal(readyDetections([pending("image")]), undefined);
    assert.equal(readyDetections([{ ...pending("video"), detect: det("done", [box]) }]), undefined);
    assert.equal(readyDetections([{ ...pending("image", "uploading"), detect: det("done", [box]) }]), undefined);
  });

  it("没框到也照带空 items（服务端说未识别到，不回落云端）", () => {
    assert.deepEqual(readyDetections([{ ...pending("image"), detect: det("done", []) }])?.himage0.items, []);
  });

  it("按服务端约束整理：丢退化框、名字截 64、置信夹 0–1、按置信取前 24", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...box, conf: i / 100 }));
    const r = readyDetections([{ ...pending("image"), detect: det("done", [...many, { ...box, bbox: [5, 5, 5, 9] }, { ...box, name: "x".repeat(80), conf: 1.2 }]) }])!;
    const items = r.himage0.items;
    assert.equal(items.length, MAX_DETECTIONS_PER_PHOTO);
    assert.equal(items[0].conf, 1, "超 1 夹到 1，且排第一");
    assert.equal(items[0].name.length, 64);
    assert.ok(items.every((d) => d.bbox[2] > d.bbox[0] && d.bbox[3] > d.bbox[1]), "退化框被丢");
    assert.equal(items[items.length - 1].conf, 0.07, "取置信最高的 24 条");
  });

  it("DialogScreen 的 onSendText 类型接受第三个参数（编译期）", () => {
    const f: NonNullable<DialogScreenProps["onSendText"]> = async (_c, _a, d) => {
      void d?.himage0?.items;
    };
    assert.equal(typeof f, "function");
  });
});
