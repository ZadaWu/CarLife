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

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ChatMessage } from "@carlife/shared";

import { SessionList, type SessionBrief } from "./SessionList";

export interface StreamingTurn {
  turnId: string;
  text: string;
}

export interface DialogScreenProps {
  messages: ChatMessage[];
  streaming: StreamingTurn | null;
  connection: "online" | "reconnecting" | "unknown";
  /** 发送文字消息；未提供时不渲染输入框（如浏览器 mock 环境） */
  onSendText?: (content: string) => Promise<void>;
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

function Bubble({ role, source, children }: {
  role: "user" | "assistant";
  source?: "text" | "voice";
  children: React.ReactNode;
}) {
  return (
    <div className={`dlg-row dlg-row--${role}`}>
      <div className={`dlg-bubble dlg-bubble--${role}`}>
        {source === "voice" && <span className="dlg-bubble__tag">语音</span>}
        {children}
      </div>
    </div>
  );
}

export function DialogScreen({
  messages,
  streaming,
  connection,
  onSendText,
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

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const content = draft.trim();
    if (!content || !onSendText || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await onSendText(content);
      setDraft("");
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
            {broadcast.enabled ? "🔊 播报开启" : "🔇 播报关闭"}
          </button>
        </div>
      )}
      <div className="dlg-list" ref={listRef} onScroll={onScroll}>
        {messages.length === 0 && !streaming && (
          <div className="dlg-empty">还没有对话。回到主页长按助手说话试试。</div>
        )}
        {messages.map((m) => (
          <Bubble key={m.messageId} role={m.role} source={m.source}>
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
      {!viewing && onSendText && (
        <form className="dlg-input" onSubmit={submit}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="打字输入…（驾驶中请用语音）"
            disabled={sending}
            aria-label="文字输入"
          />
          <button type="submit" disabled={sending || draft.trim() === ""}>
            {sending ? "发送中" : "发送"}
          </button>
        </form>
      )}
      {sendError && <div className="dlg-banner dlg-banner--error">发送失败：{sendError}</div>}
      </div>
    </div>
  );
}
