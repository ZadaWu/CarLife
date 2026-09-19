/**
 * 拍照问诊 · 拍照页（施工单 M104-03，设计 UI-01 v1.1 第 2 步；FL-20 F-20-15、FL-09 F-09-07 的 WebView 那一半）。
 *
 * 全屏层：部位芯片 + 取景提示 + 快门。**快门是一枚 `<input type="file" accept="image/*" capture="environment">`
 * 的 `click()`，在用户手势的调用栈里**——iOS WKWebView 直开系统相机，不引相机插件、不动 capabilities。
 * M103-02 那条「切页后在 effect 里 click，出了手势栈 iOS 不弹」的尾巴由它解掉。「相册」是不带 `capture` 的同款 input。
 *
 * 拍完的流程在页内完成：预检（复用对话层的 `checkPendingAdd`，上限同一份）→ 上传（`attachments.upload`）→
 * 端上框灯（`detect`，可失败，不阻塞）→ `onSend(handle, detections)`（空文字带句柄，一个字不用打）→ `onDone()`。
 * 上传失败留在页上「重试 / 换一张」，不静默。
 *
 * 部位芯片只决定取景提示，**不随消息发出**（Brief §3：不进模型判断）。
 * 取景区是示意不是实时画面：`getUserMedia` 在 Tauri iOS 未验证，`capture` 属性是零配置的系统相机。
 */

import { useRef, useState, type ChangeEvent } from "react";
import type { AttachmentRef, ClientDetections } from "@carlife/shared";
import { checkPendingAdd, onDeviceVisionEnabled, readyDetections, type OnDeviceDetectResult, type PendingAttachment } from "@carlife/ui";
import { explainAttachmentFailure } from "../../data/attachmentFailure";

/*
 * 取景区的示意图（2026-09-18 用户走查：「引导素材没有切图用到实现代码里，现在是很丑的」）。
 * 仪表盘那张直接从定稿 `photo-diagnosis-02-capture.png` 的虚线框内裁下来；其余三个部位按同一套
 * 处理（深色车内 + 橙色检测框 + 橙底芯片）补齐——与暖暖立绘、主页入口卡同一条纪律：素材从定稿取，不由代码画。
 * 它是**示意不是实时画面**：告诉车主"拍成这样，我就能把灯框出来"。
 */
import frameDash from "./assets/frame-dash.png";
import frameTire from "./assets/frame-tire.png";
import frameUnder from "./assets/frame-under.png";
import frameBody from "./assets/frame-body.png";

import "./service.css";

export type CapturePart = "dash" | "tire" | "under" | "body";

/**
 * `ready` = 这个部位的识别模型训练好了没（2026-09-18 产品决定）。
 *
 * 只有仪表盘那一档有模型（M71 起的警示灯目录 + 端上 YOLO）；轮胎 / 车底漏液 / 车身的样本还没采，
 * **让车主拍了传上去只会得到一句含糊话**——那比不让拍更糟。所以未就绪的部位：示意图照常给
 * （让他知道以后能拍什么），底下明写「功能开发中」，快门与「从相册选」一起置灰。
 */
export const CAPTURE_PARTS: ReadonlyArray<{ id: CapturePart; label: string; hint: string; art: string; ready: boolean }> = [
  { id: "dash", label: "仪表盘", hint: "把仪表盘放进框里，开着车灯拍", art: frameDash, ready: true },
  { id: "tire", label: "轮胎", hint: "拍到整条轮胎，含胎面与胎壁", art: frameTire, ready: false },
  { id: "under", label: "车底 / 漏液", hint: "蹲低一点拍车底那滩液体，带上参照物", art: frameUnder, ready: false },
  { id: "body", label: "车身", hint: "离远一点拍到整块车身", art: frameBody, ready: false },
];

export interface MobileCaptureProps {
  /** 上传与端上检测端口；浏览器预览没有（快门禁用并说明）。 */
  attachments?: { upload: (file: File) => Promise<AttachmentRef>; detect?: (file: File) => Promise<OnDeviceDetectResult> };
  /** 拍完发出去：空文字 + 句柄（+ 端上框）。 */
  onSend: (handle: string, detections?: Record<string, ClientDetections>) => Promise<void>;
  /** 发出去之后（父层关页并切到对话页）。 */
  onDone: () => void;
  onClose: () => void;
  /** 初始部位（补拍时由引导卡指定）。 */
  initialPart?: CapturePart;
}

type Phase = { kind: "idle" } | { kind: "uploading"; name: string } | { kind: "failed"; name: string; reason: string; file: File };

export function MobileCapture({ attachments, onSend, onDone, onClose, initialPart = "dash" }: MobileCaptureProps) {
  const [part, setPart] = useState<CapturePart>(initialPart);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const active = CAPTURE_PARTS.find((p) => p.id === part);
  const hint = active?.hint ?? "";
  const art = active?.art ?? frameDash;
  /** 这个部位还没有识别模型时，两个入口一起关掉——见 `CAPTURE_PARTS.ready`。 */
  const ready = active?.ready ?? false;
  const busy = phase.kind === "uploading";
  const canShoot = Boolean(attachments) && ready && !busy;

  /** 一张照片走完：预检 → 上传 → 端上框灯 → 发送。任一步失败都留在页上，不静默丢。 */
  const handleFile = async (file: File) => {
    if (!attachments) return;
    const problem = checkPendingAdd([], file);
    if (problem) {
      setPhase({ kind: "failed", name: file.name, reason: problem, file });
      return;
    }
    setPhase({ kind: "uploading", name: file.name });
    try {
      const [ref, detect] = await Promise.all([
        attachments.upload(file),
        // 端上框灯：开关关着或端没给就不跑；跑失败只当没框，照片照发（与对话层同一条纪律）。
        attachments.detect && onDeviceVisionEnabled() ? attachments.detect(file).catch(() => undefined) : Promise.resolve(undefined),
      ]);
      const pending: PendingAttachment = {
        id: ref.handle,
        kind: "image",
        name: file.name,
        bytes: file.size,
        contentType: file.type,
        status: "ready",
        ref,
        ...(detect ? { detect: { status: "done", result: detect } } : {}),
      };
      await onSend(ref.handle, readyDetections([pending]));
      setPhase({ kind: "idle" });
      onDone();
    } catch (err) {
      // 网关的错误码在这里换成人话；认不出的原样留着（见 data/attachmentFailure.ts）。
      setPhase({ kind: "failed", name: file.name, reason: explainAttachmentFailure(err instanceof Error ? err.message : String(err)), file });
    }
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void handleFile(file);
  };

  return (
    <div className="cap" role="dialog" aria-modal="true" aria-label="拍照问诊">
      <header className="cap-head">
        <button type="button" className="cap-head__close" onClick={onClose} aria-label="关闭">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        <h1 className="cap-head__title">拍照问诊</h1>
        {/* 右侧留空：「相册」挪到了底部操作条（2026-09-18 用户真机反馈「也需要可以直接相册图片上传」，
            顶栏那枚文字链太弱，找不着）。这里留一个占位保住三栏栅格的居中标题。 */}
        <span className="cap-head__spacer" aria-hidden="true" />
      </header>

      <div className="cap-parts" role="tablist" aria-label="拍哪里">
        {CAPTURE_PARTS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={part === p.id}
            className={`cap-part${part === p.id ? " is-active" : ""}`}
            onClick={() => setPart(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="cap-view" data-part={part}>
        <p className="cap-view__hint">{hint}</p>
        <div className="cap-view__frame" aria-hidden="true">
          <img className="cap-view__art" src={art} alt="" draggable={false} />
        </div>
        {phase.kind === "uploading" && (
          <div className="cap-view__status" role="status">
            <i className="cap-dot" aria-hidden="true" />
            正在上传 {phase.name}…
          </div>
        )}
        {phase.kind === "failed" && (
          <div className="cap-view__status is-failed" role="alert">
            <b>上传失败</b>
            <span>{phase.reason}</span>
            <span className="cap-view__actions">
              <button type="button" onClick={() => void handleFile(phase.file)}>
                重试
              </button>
              <button type="button" onClick={() => setPhase({ kind: "idle" })}>
                换一张
              </button>
            </span>
          </div>
        )}
      </div>

      <div className="cap-bar">
        {/*
         * 「从相册选」：不带 capture 的同款 input，同样在 onClick 的同步栈里点。
         * 与快门并排而不是缩在顶栏——已经拍好的照片直接传是常用路径，不该比拍一张更难找。
         */}
        <button
          type="button"
          className="cap-gallery"
          disabled={!canShoot}
          onClick={() => galleryInputRef.current?.click()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2.5" />
            <circle cx="8.5" cy="10" r="1.6" />
            <path d="M4 17l4.5-4.5 3 3 3.5-3.5L20 16" />
          </svg>
          从相册选
        </button>
        {/*
         * 快门：直接 click 那枚 capture 的 input——必须在 onClick 的同步栈里，不经 setState 后 effect。
         * 没有上传端口（浏览器预览）就禁用并在下面说明，不假装能拍。
         */}
        <button
          type="button"
          className="cap-shutter"
          aria-label="拍照"
          disabled={!canShoot}
          onClick={() => cameraInputRef.current?.click()}
        >
          <span className="cap-shutter__core" aria-hidden="true" />
        </button>
        <span className="cap-bar__spacer" aria-hidden="true" />
      </div>
      <p className={`cap-caption${ready ? "" : " cap-caption--wip"}`}>
        {!ready
          ? "功能开发中"
          : attachments
            ? "拍完直接发给暖暖，不用打字"
            : "浏览器预览没有上传通道；在手机上拍完直接发给暖暖"}
      </p>

      {/* iOS 对 capture="environment" 直开后置相机；桌面浏览器忽略它、落到文件框。 */}
      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" hidden onChange={onPick} data-testid="capture-camera" />
      <input ref={galleryInputRef} type="file" accept="image/*" hidden onChange={onPick} data-testid="capture-gallery" />
    </div>
  );
}
