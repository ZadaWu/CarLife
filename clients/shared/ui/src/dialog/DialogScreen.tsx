/**
 * 对话层（施工单 M2-05 F-03-03；M3-07 补齐 F-03-07 / F-03-09）。
 *
 * 数据由 App 统一管理（桥接订阅单点）：本组件是纯呈现——
 * 消息列表（缓存优先渲染 + 回源校正后替换）+ 流式气泡 + 自动滚动。
 * 车机可读性走 cockpit token。
 *
 * 滚动语义（F-03-07）：贴底时新消息自动跟随；用户上翻后**不打扰**，
 * 改为浮出"有新消息"提示，点击回到最新——上翻是明确的阅读意图，
 * 自动滚回去等于把人从正在看的地方拽走。
 *
 * 文字输入（F-03-09）：**全产品唯一输入框**就在这里。
 * HUD 层没有输入框（US-01 AC-01-1），M2-05 的静态断言仍然成立。
 *
 * M65-02 上提到 `clients/shared/ui`，两端共用同一份。唯一的端差异是会话历史栏的**排布**
 * （`railMode`）：车机横屏放左栏，手机竖屏放不下左栏，折成顶部抽屉。组件其余部分一字不分叉——
 * 两端各写一份对话页的结局是手机端永远少几样（M65 走查：滚动纪律、已中断标记、发送失败告知）。
 */

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { AttachmentRef, ChatMessage } from "@carlife/shared";

import { SessionList, type SessionBrief } from "./SessionList";
import { AttachmentStrip, type AttachmentLoader } from "./AttachmentStrip";
import { checkPendingAdd, durationHint, formatBytes, kindOfMime, readyHandles, type PendingAttachment } from "./attachments";

export interface StreamingTurn {
  turnId: string;
  text: string;
}

export interface DialogScreenProps {
  messages: ChatMessage[];
  streaming: StreamingTurn | null;
  connection: "online" | "reconnecting" | "unknown";
  /**
   * 发送文字消息；未提供时不渲染输入框（如浏览器 mock 环境）。
   * `attachments`（M80-03）：本轮要绑的附件句柄（已上传）；没有附件时不传，老调用点签名不变。
   */
  onSendText?: (content: string, attachments?: string[]) => Promise<void>;
  /**
   * 附件（M80-03，F-09-07 / F-09-09）。
   *  - `load`：按引用取原件（Rust 侧带令牌），两端都传——气泡里的缩略图与视频播放靠它；
   *  - `upload`：选择并上传，**只有手机端传**——车机行车态不选文件（FL-06），不传就没有添加按钮。
   * 整个不传（浏览器 mock 环境）时气泡里只显示「📷 照片」占位，不假装有图。
   */
  attachments?: {
    load: AttachmentLoader;
    upload?: (file: File) => Promise<AttachmentRef>;
  };
  /** 播报总开关（F-02-12）；未提供时不渲染 */
  broadcast?: { enabled: boolean; onToggle: () => void | Promise<void> };
  /**
   * 本轮比过车型时给一句去向（M15-05）。
   *
   * 车机**不做对比矩阵**——`prompts/buying.md` 的硬约束是
   * 「不要摆大表格，车主在车里念不完」。这是驾驶态的取舍，不是功能缺失。
   */
  buyingHint?: boolean;
  /**
   * 工具进展一句话（FL-08 F-08-05），如"正在查天气"。null = 没有进展可说。
   *
   * **null 时什么都不显示**，不要垫一句"正在思考"——那是一句用户无法证伪、
   * 只会照单全收的话（与旁路 L0"匹配不到就返回 undefined"同一条纪律）。
   */
  progress?: string | null;
  /**
   * 左侧会话历史（M28-01）。**不传就不渲染这一栏**——浏览器 mock 环境与
   * 演示态没有会话列表可拉，硬渲染一个空栏只会让屏幕上多一块永远空着的地方。
   */
  sessions?: {
    items: SessionBrief[];
    hasMore: boolean;
    loading: boolean;
    error?: string | null;
    onSelect: (s: SessionBrief) => void;
    onLoadMore: () => void;
    /** 主动开一段新对话（M28 后补）：会话被闲置软关闭后，对话层内要有自己的出口。 */
    onNew?: () => void;
  };
  /**
   * 正在回看一段**已结束**的历史会话（M28-01）。
   *
   * 回看态下输入框整个不渲染：置灰的输入框仍然在邀请人打字，
   * 而这条会话服务端已经不收消息了。给的是一条出口（回到当前对话），不是一个禁用态。
   */
  viewing?: { sessionId: string; onExit: () => void } | null;
  /** 当前会话 id（M28-01）：列表高亮用。回看态下高亮走 `viewing`。 */
  currentSessionId?: string | null;
  /**
   * 本轮失败/超时分支的人话清单（M37-01，F-13-03）。
   *
   * 非空时渲染"部分结果"横幅——真相源是 `update.branch` 的结构化 status，
   * **不是**应答正文里有没有提到失败。空数组/不传都不渲染（没有失败不立牌子）。
   * 应答结束后横幅**保留**到下一轮开始：它标注的是"这轮答案缺了什么"，
   * 跟着答案一起被阅读才有意义。
   */
  branchFaults?: ReadonlyArray<{ agent: string; text: string }>;
  /**
   * 会话历史栏的排布（M65-02）。`side`（默认）= 左栏，车机横屏；
   * `drawer` = 顶部可折叠抽屉，手机竖屏。只在传了 `sessions` 时有意义。
   */
  railMode?: "side" | "drawer";
}

/*
 * 播报开关的喇叭。原来这里是 emoji 🔊 / 🔇——**emoji 由系统字体渲染，是彩色的**，
 * 压在琥珀描边胶囊上像贴了一张贴纸，定稿画的是与文字同色的线稿
 * （design-system.md §6：图标 24 网格、线宽 2、圆端点，仓库不引图标库，一律内联 SVG）。
 */
function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg className="dlg-toggle__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M4 9.5h3.2L12 5.5v13l-4.8-4H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {on ? (
        <>
          <path d="M15.6 9.2a4 4 0 0 1 0 5.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M18.4 6.6a7.8 7.8 0 0 1 0 10.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </>
      ) : (
        <path d="M16 9.5l5 5m0-5l-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      )}
    </svg>
  );
}

function Bubble({ role, source, attachments, load, children }: {
  role: "user" | "assistant";
  source?: "text" | "voice";
  /** 用户消息随轮带的附件引用（M80-03）；助手消息没有。 */
  attachments?: AttachmentRef[] | null;
  load?: AttachmentLoader;
  children: React.ReactNode;
}) {
  return (
    <div className={`dlg-row dlg-row--${role}`}>
      {/*
        「语音」在气泡**外面**、贴着气泡上沿——两端定稿都是这么画的
        （`内部文档` 与 `内部文档`）。
        它说的是"这条消息是怎么进来的"，不是车主说出口的内容；混在气泡里第一行，
        读起来就像那句话是以「语音」两个字开头的。
      */}
      {source === "voice" && <span className="dlg-bubble__tag">语音</span>}
      <div className={`dlg-bubble dlg-bubble--${role}`}>
        {attachments && attachments.length > 0 && <AttachmentStrip items={attachments} load={load} />}
        {children}
      </div>
    </div>
  );
}

/** 读视频时长（毫秒）——只为提示"超过 1 分钟只看前 60 秒"；读不到就算了，不阻止发送。 */
function probeDuration(file: File): Promise<number | undefined> {
  if (typeof document === "undefined" || !file.type.startsWith("video/")) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (ms?: number) => {
      URL.revokeObjectURL(url);
      resolve(ms);
    };
    const timer = setTimeout(() => done(undefined), 4000);
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      clearTimeout(timer);
      done(Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : undefined);
    };
    v.onerror = () => {
      clearTimeout(timer);
      done(undefined);
    };
    v.src = url;
  });
}

export function DialogScreen({
  messages,
  streaming,
  connection,
  onSendText,
  attachments,
  broadcast,
  buyingHint,
  progress,
  sessions,
  viewing,
  currentSessionId,
  branchFaults,
  railMode = "side",
}: DialogScreenProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [hasNew, setHasNew] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  /** 选好 / 在传 / 传好的附件（M80-03）。发送成功后清空并释放预览 URL。 */
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [pickError, setPickError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef(attachments?.upload);
  uploadRef.current = attachments?.upload;

  const patchPending = (id: string, patch: Partial<PendingAttachment>) =>
    setPending((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  /** 起一次上传；失败留在列表里给「重试」，不静默丢（F-09-05）。 */
  const startUpload = (item: PendingAttachment, file: File) => {
    const upload = uploadRef.current;
    if (!upload) return;
    patchPending(item.id, { status: "uploading", error: undefined });
    upload(file)
      .then((ref) => patchPending(item.id, { status: "ready", ref }))
      .catch((err) => patchPending(item.id, { status: "failed", error: err instanceof Error ? err.message : String(err) }));
  };
  const fileOf = useRef(new Map<string, File>());

  const onPickFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    setPickError(null);
    let current = pending;
    for (const file of files) {
      const problem = checkPendingAdd(current, file);
      if (problem) {
        setPickError(problem);
        continue;
      }
      const kind = kindOfMime(file.type);
      if (!kind) continue;
      const item: PendingAttachment = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind,
        name: file.name,
        bytes: file.size,
        contentType: file.type,
        status: "uploading",
        previewUrl: typeof URL !== "undefined" && kind === "image" ? URL.createObjectURL(file) : undefined,
      };
      fileOf.current.set(item.id, file);
      current = [...current, item];
      setPending(current);
      startUpload(item, file);
      if (kind === "video") void probeDuration(file).then((ms) => patchPending(item.id, { durationMs: ms }));
    }
  };

  const removePending = (id: string) => {
    setPending((prev) => {
      const it = prev.find((p) => p.id === id);
      if (it?.previewUrl) URL.revokeObjectURL(it.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
    fileOf.current.delete(id);
  };

  const scrollToBottom = () => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottom.current = true;
    setHasNew(false);
  };

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (stickToBottom.current) setHasNew(false);
  };

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    } else if (messages.length > 0) {
      // 上翻期间来了新消息：提示而不是抢滚动
      setHasNew(true);
    }
  }, [messages, streaming?.text]);

  const handles = readyHandles(pending);
  // 有附件时允许不打字（车主常常只发一张照片）；没附件时仍要有字。所有附件传好才能发。
  const canSend = !sending && handles !== null && (draft.trim() !== "" || handles.length > 0);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const content = draft.trim();
    if (!onSendText || !canSend) return;
    setSending(true);
    setSendError(null);
    try {
      await onSendText(content, handles && handles.length ? handles : undefined);
      setDraft("");
      for (const p of pending) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      fileOf.current.clear();
      setPending([]);
      scrollToBottom();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  // 高亮的是"屏幕上此刻摊着的那条"：回看时是被回看的那条，否则是当前会话。
  const activeSessionId = viewing?.sessionId ?? currentSessionId ?? null;

  const rail = sessions ? (
    <SessionList
      sessions={sessions.items}
      activeSessionId={activeSessionId}
      hasMore={sessions.hasMore}
      loading={sessions.loading}
      error={sessions.error}
      onSelect={sessions.onSelect}
      onLoadMore={sessions.onLoadMore}
      onNew={sessions.onNew}
    />
  ) : null;
  const drawer = rail !== null && railMode === "drawer";

  return (
    <div className={`dlg-screen ${sessions ? "has-rail" : ""} ${drawer ? "dlg-screen--drawer" : ""}`}>
      {drawer ? (
        /*
         * 抽屉默认收起：手机上进对话层是为了看当前这段，列表是"要换一段"时才打开的。
         * 用原生 <details>——与 M40-03 采集进度折叠节同款，不引状态、不引依赖。
         */
        <details className="dlg-rail dlg-rail--drawer">
          <summary className="dlg-rail__summary">
            会话历史{sessions && sessions.items.length > 0 ? ` · ${sessions.items.length}` : ""}
          </summary>
          {rail}
        </details>
      ) : (
        rail
      )}
      <div className="dlg-main">
      {connection === "reconnecting" && (
        <div className="dlg-banner">连接中断，正在恢复…</div>
      )}
      {/*
        购车对比只在手机端有页面（M15-05）。
        **车机刻意不做对比矩阵**：`prompts/buying.md` 的硬约束是
        「不要摆大表格——车主在车里，念不完」。这里只给一句去向，
        不是功能缺失，是驾驶态的取舍。
      */}
      {buyingHint && <div className="dlg-banner dlg-banner--info">详细的车型对比已同步到手机端</div>}
      {/*
        部分结果标识（M37-01，F-13-03）：结构化事件驱动，不依赖应答正文提没提。
        逐条列服务端给的人话（"酒店安排超时未返回"），不加工不合并——
        加工出的概括（"部分信息缺失"）反而回答不了"缺的是哪块"。
      */}
      {branchFaults && branchFaults.length > 0 && (
        <div className="dlg-banner" role="status" data-testid="branch-faults">
          部分结果：{branchFaults.map((f) => f.text).join("；")}
        </div>
      )}
      {broadcast && (
        <div className="dlg-toolbar">
          <button
            type="button"
            className={`dlg-toggle ${broadcast.enabled ? "is-on" : ""}`}
            onClick={() => void broadcast.onToggle()}
            aria-pressed={broadcast.enabled}
          >
            <SpeakerIcon on={broadcast.enabled} />
            {broadcast.enabled ? "播报开启" : "播报关闭"}
          </button>
        </div>
      )}
      <div className="dlg-list" ref={listRef} onScroll={onScroll}>
        {messages.length === 0 && !streaming && (
          <div className="dlg-empty">还没有对话。回到主页长按助手说话试试。</div>
        )}
        {messages.map((m) => (
          <Bubble key={m.messageId} role={m.role} source={m.source} attachments={m.role === "user" ? m.attachments : null} load={attachments?.load}>
            {m.content}
            {/*
              被打断的那半句（M33-01 的 `cancelled` 字段，M33-02 显示出来）。
              **气泡不删**：车主已经听见这半句了，删掉会让刷新前后不一致；
              但不标一下的话，它读起来像是助手好端端地把话说了一半。
              纯离线（端上 SQLite 缓存）读不到这个字段，那时它就是一条普通消息——
              已知限制，见 M33-01 验收 §7。
            */}
            {m.cancelled ? <span className="dlg-cancelled">（已中断）</span> : null}
          </Bubble>
        ))}
        {streaming && streaming.text.length > 0 && (
          <Bubble role="assistant">
            {streaming.text}
            <span className="dlg-cursor" aria-hidden="true" />
          </Bubble>
        )}
        {/*
          工具进展（F-08-05）。**排在流式气泡之后**：它讲的是"接下来还在做什么"，
          放在已出的文字前面会读成"这句话之前发生的事"。

          不是气泡：它不是助手说的话，也不进历史。样式上刻意弱于正文——
          十几秒里跳三四句进度，做得和回答一样重会把真正的回答淹掉。
        */}
        {progress && (
          <div className="dlg-progress" role="status" aria-live="polite">
            <span className="dlg-progress__dot" aria-hidden="true" />
            {progress}
          </div>
        )}
      </div>

      {hasNew && (
        <button type="button" className="dlg-newmsg" onClick={scrollToBottom}>
          有新消息 ↓
        </button>
      )}

      {/*
        历史回看（M28-01）。**不渲染置灰的输入框**：置灰的输入框还在邀请人打字，
        而这条会话服务端已经不收消息了。这里给的是一条出口，不是一个禁用态。
      */}
      {viewing && (
        <div className="dlg-input dlg-input--viewing">
          <span className="dlg-viewing__note">这段对话已结束，只能回看</span>
          <button type="button" onClick={viewing.onExit}>回到当前对话</button>
        </div>
      )}
      {!viewing && onSendText && pending.length > 0 && (
        /*
         * 待发附件条（M80-03）。每项自己的状态：传着 / 传好 / 失败（带重试）。
         * 视频超过 1 分钟只提示不拦——服务端只看前 60 秒并会如实说明。
         */
        <div className="dlg-pending" data-testid="pending-attachments">
          {pending.map((p) => (
            <div key={p.id} className={`dlg-pending__item dlg-pending__item--${p.status}`}>
              {p.previewUrl ? <img src={p.previewUrl} alt={p.name} /> : <span className="dlg-pending__icon" aria-hidden="true">{p.kind === "video" ? "🎬" : "📷"}</span>}
              <span className="dlg-pending__meta">
                <span className="dlg-pending__name">{p.name}</span>
                <span className="dlg-pending__state">
                  {p.status === "uploading" ? "上传中…" : p.status === "ready" ? formatBytes(p.bytes) : `失败：${p.error ?? "未知错误"}`}
                </span>
                {p.kind === "video" && durationHint(p.durationMs) && <span className="dlg-pending__hint">{durationHint(p.durationMs)}</span>}
              </span>
              {p.status === "failed" && (
                <button type="button" onClick={() => { const f = fileOf.current.get(p.id); if (f) startUpload(p, f); }}>重试</button>
              )}
              <button type="button" className="dlg-pending__remove" onClick={() => removePending(p.id)} aria-label={`移除${p.name}`}>×</button>
            </div>
          ))}
        </div>
      )}
      {!viewing && onSendText && (
        <form className="dlg-input" onSubmit={submit}>
          {attachments?.upload && (
            <>
              {/*
                系统文件选择器（M80-03）：iOS 的 WKWebView 对 accept=image/*,video/* 会弹「拍照 / 相册 / 文件」，
                不需要相机插件；选出的视频由系统按导出质量转码，60 秒通常 15–40 MB。
              */}
              <input ref={fileInputRef} type="file" accept="image/*,video/*" multiple hidden onChange={onPickFiles} data-testid="attachment-picker" />
              <button type="button" className="dlg-attach" onClick={() => fileInputRef.current?.click()} disabled={sending} aria-label="添加照片或视频" title="添加照片或视频">
                📎
              </button>
            </>
          )}
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={pending.length ? "说说想问什么（可不填）" : "打字输入…（驾驶中请用语音）"}
            disabled={sending}
            aria-label="文字输入"
          />
          <button type="submit" disabled={!canSend}>
            {sending ? "发送中" : "发送"}
          </button>
        </form>
      )}
      {pickError && <div className="dlg-banner dlg-banner--error">{pickError}</div>}
      {sendError && <div className="dlg-banner dlg-banner--error">发送失败：{sendError}</div>}
      </div>
    </div>
  );
}
