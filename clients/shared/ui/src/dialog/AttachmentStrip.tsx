/**
 * 气泡里的附件条（施工单 M80-03，F-09-09 / F-03-08）：照片缩略图、视频播放器。
 *
 * # 原件经 Rust 侧取，WebView 只拿 blob URL
 *
 * `<img src>` / `<video src>` 加不了 Authorization 头，而令牌不进 WebView（§2.2 C2）。
 * 所以 `load(ref)` 由端上注入（Tauri 命令 → 字节 → Blob），这里只负责"什么时候取、取来放哪"：
 *  - 照片：进入视口就取（一张几百 KB）；
 *  - 视频：**点了才取**（几十 MB；两周前的那段视频不该在翻历史时就被拉下来），取到后用原生 `<video controls>` 放，
 *    `playsInline` 让 iOS 不全屏接管。
 *
 * blob URL 按句柄缓存在模块级 Map：同一段视频翻上翻下不重复拉；`URL.revokeObjectURL` 在页面卸载时统一放掉。
 * 没有 `load`（浏览器 mock 环境）时只显示占位标签，不假装有图。
 */

import { useEffect, useRef, useState } from "react";
import type { AttachmentRef } from "@carlife/shared";

import { attachmentLabel } from "./attachments";

export type AttachmentLoader = (ref: AttachmentRef) => Promise<Blob>;

const urlCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

async function objectUrlFor(ref: AttachmentRef, load: AttachmentLoader): Promise<string> {
  const hit = urlCache.get(ref.handle);
  if (hit) return hit;
  const pending = inflight.get(ref.handle);
  if (pending) return pending;
  const p = load(ref)
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      urlCache.set(ref.handle, url);
      return url;
    })
    .finally(() => inflight.delete(ref.handle));
  inflight.set(ref.handle, p);
  return p;
}

/** 测试与卸载用：放掉所有 blob URL。 */
export function releaseAttachmentUrls(): void {
  for (const url of urlCache.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* 非浏览器环境 */
    }
  }
  urlCache.clear();
}

function useObjectUrl(ref: AttachmentRef, load: AttachmentLoader | undefined, enabled: boolean): { url: string | null; error: string | null; loading: boolean } {
  const [url, setUrl] = useState<string | null>(() => urlCache.get(ref.handle) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!enabled || !load || url) return;
    setLoading(true);
    setError(null);
    objectUrlFor(ref, load)
      .then((u) => {
        if (alive.current) setUrl(u);
      })
      .catch((e) => {
        if (alive.current) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
  }, [enabled, load, ref, url]);
  return { url, error, loading };
}

function ImageTile({ item, load }: { item: AttachmentRef; load?: AttachmentLoader }) {
  const [open, setOpen] = useState(false);
  const { url, error, loading } = useObjectUrl(item, load, Boolean(load));
  const label = attachmentLabel(item);
  if (!load) return <span className="dlg-att__chip">📷 {label}</span>;
  if (error) return <span className="dlg-att__chip dlg-att__chip--error">📷 {label}（取不到：{error}）</span>;
  if (!url) return <span className="dlg-att__chip">📷 {loading ? "加载中…" : label}</span>;
  return (
    <>
      <button type="button" className="dlg-att__thumb" onClick={() => setOpen(true)} aria-label={`查看${label}`}>
        <img src={url} alt={item.filename ?? label} loading="lazy" />
      </button>
      {open && (
        <div className="dlg-att__lightbox" role="dialog" aria-label="查看照片" onClick={() => setOpen(false)}>
          <img src={url} alt={item.filename ?? label} />
          <span className="dlg-att__lightbox-hint">点击任意处关闭</span>
        </div>
      )}
    </>
  );
}

function VideoTile({ item, load }: { item: AttachmentRef; load?: AttachmentLoader }) {
  const [wanted, setWanted] = useState(false);
  const { url, error, loading } = useObjectUrl(item, load, wanted);
  const label = attachmentLabel(item);
  if (!load) return <span className="dlg-att__chip">🎬 {label}</span>;
  if (error) return <span className="dlg-att__chip dlg-att__chip--error">🎬 {label}（取不到：{error}）</span>;
  if (!url) {
    return (
      <button type="button" className="dlg-att__video-placeholder" onClick={() => setWanted(true)} disabled={loading} aria-label={`播放${label}`}>
        <span className="dlg-att__play" aria-hidden="true">{loading ? "…" : "▶"}</span>
        <span>{loading ? "正在取视频…" : label}</span>
      </button>
    );
  }
  return (
    <video className="dlg-att__video" src={url} controls playsInline preload="metadata" aria-label={label}>
      {/* 原生控制器：播放 / 暂停 / 进度 / 音量，两端一致；不自造播放器。 */}
    </video>
  );
}

export function AttachmentStrip({ items, load }: { items: readonly AttachmentRef[]; load?: AttachmentLoader }) {
  if (items.length === 0) return null;
  return (
    <div className="dlg-att" data-testid="attachment-strip">
      {items.map((it) =>
        it.kind === "video" ? <VideoTile key={it.handle} item={it} load={load} /> : it.kind === "image" ? <ImageTile key={it.handle} item={it} load={load} /> : <span key={it.handle} className="dlg-att__chip">📎 {attachmentLabel(it)}</span>,
      )}
    </div>
  );
}
