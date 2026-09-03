/**
 * 对话层的会话历史列表（施工单 M28-01；M65-02 上提到 `clients/shared/ui`，两端共用）。
 *
 * 车机上是左栏，手机上折成顶部抽屉——排布由 `DialogScreen` 的 `railMode` 决定，
 * 本组件不知道自己在哪一端。
 *
 * # 为什么列表项显示的是标题而不是首句
 *
 * 首句在驾驶态里读不完——「帮我看看明天去杭州的路上会不会下雨顺便找个」
 * 一屏只装得下半句，而半句话在列表里长得都一样。标题是首轮结束后由旁路
 * 起的名字（≤15 字），拿不到时才回落到时间。
 *
 * # 懒加载而不是一次拉全
 *
 * 一次 20 条，触底再要下一页。车主的会话是**只增不减**的（软关闭一条都不删，
 * §7① 的取舍），跑一年之后一次拉全就是几千条——那时表现是"点开对话层要转半天圈"。
 *
 * # 「能不能接着聊」是列表这一侧算的
 *
 * 判据与服务端同一条（`closedAt` 为空 且 空闲未超阈值，严格大于）。
 * 不算这一下的话，点开一个躺了两天的会话会照常给出输入框，
 * 发出去才拿到 409、然后端上默默换成一个新会话——**车主以为自己在续上一段对话，
 * 实际是在一段空的新对话里说话**。
 */

import { useEffect, useRef } from "react";

import { IDLE_MS } from "./session-lifecycle";

export interface SessionBrief {
  sessionId: string;
  /** 旁路生成的标题；`null` = 还没起出来（首轮没跑完 / 生成失败）。 */
  title: string | null;
  createdAt: string;
  updatedAt: string;
  /** 软关闭时刻；`null` = 还没关。 */
  closedAt: string | null;
  messageCount: number;
}

/**
 * 这条会话还能不能接着说。
 *
 * **与 `enterprise/backend/gateway/src/http/index.ts` 的 `checkSessionUsable` 同一条判据**，
 * 包括边界方向（严格大于：正好卡在阈值上算没过期）。两处不一致的表现是
 * 端上给了输入框、服务端回 409。
 */
export function sessionResumable(s: SessionBrief, now: number, idleMs = IDLE_MS): boolean {
  if (s.closedAt !== null) return false;
  return now - new Date(s.updatedAt).getTime() <= idleMs;
}

/** 没有标题时的替代显示：**说时间，不编内容**。 */
function whenLabel(iso: string, now: number): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "未知时间";
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) return `今天 ${hm}`;
  const yesterday = new Date(now - 86400000).toDateString() === d.toDateString();
  if (yesterday) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/**
 * 「没占满一屏就再要一页」该不该触发。
 *
 * ⚠️ **列表没被布局时（`clientHeight === 0`）一律不要**——这一条是全部要害。
 *
 * 手机上会话历史是收起的抽屉（`<details>` 未展开），列表的 `clientHeight` 与
 * `scrollHeight` 都是 0，`0 <= 0` 成立于是请求下一页；`sessions` 一变 effect 重跑，
 * 再请求……一路翻到 `hasMore` 为 false 为止。2026-09-02 在 iPhone 13 上实测：
 * 每次进对话页都会把 **3901 条会话全量拉下来**（40 个来回），而界面上只显示一行
 * 「会话历史 · 3901」，看不出发生过任何事。
 *
 * 车机的左栏常驻可见，`clientHeight > 0`，行为与从前逐字一致。
 */
export function shouldPrefetchMore(
  box: { clientHeight: number; scrollHeight: number },
  loading: boolean,
  hasMore: boolean,
): boolean {
  if (loading || !hasMore) return false;
  if (box.clientHeight === 0) return false;
  return box.scrollHeight <= box.clientHeight;
}

export interface SessionListProps {
  sessions: SessionBrief[];
  /** 此刻屏幕上摊着的那条会话（可能是当前会话，也可能是正在回看的历史）。 */
  activeSessionId: string | null;
  /** 还有没有下一页。没有时不再触发加载，也不显示"加载中"。 */
  hasMore: boolean;
  loading: boolean;
  error?: string | null;
  onSelect: (s: SessionBrief) => void;
  onLoadMore: () => void;
  /**
   * 主动开一段新对话。不传就不渲染按钮（浏览器 mock 环境建不了会话）。
   *
   * 会话闲置 30 分钟会被服务端软关闭，此前唯一的主动出口是 HUD 层的「退下」——
   * 人已经站在对话层里想另起一段时，没有任何入口。
   */
  onNew?: () => void;
}

export function SessionList({
  sessions,
  activeSessionId,
  hasMore,
  loading,
  error,
  onSelect,
  onLoadMore,
  onNew,
}: SessionListProps) {
  const now = Date.now();
  const listRef = useRef<HTMLDivElement>(null);

  /*
   * 触底加载。**同时还有一道"没占满就再要一页"**（下面的 effect）：
   * 车机屏很高，20 条经常填不满一屏——填不满就永远滚不动，
   * 于是触底事件一次都不会来，列表卡在第一页而看起来像"只有这些"。
   */
  const onScroll = () => {
    const el = listRef.current;
    if (!el || loading || !hasMore) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) onLoadMore();
  };

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (!shouldPrefetchMore(el, loading, hasMore)) return;
    onLoadMore();
  }, [sessions, loading, hasMore, onLoadMore]);

  return (
    <aside className="dlg-sessions" aria-label="会话历史">
      <div className="dlg-sessions__head">
        <span>会话历史</span>
        {onNew && (
          <button
            type="button"
            className="dlg-sessions__new"
            onClick={onNew}
            aria-label="新建对话"
          >
            ＋ 新建对话
          </button>
        )}
      </div>
      <div className="dlg-sessions__list" ref={listRef} onScroll={onScroll}>
        {sessions.length === 0 && !loading && !error && (
          <div className="dlg-sessions__empty">还没有会话记录。</div>
        )}
        {sessions.map((s) => {
          const active = s.sessionId === activeSessionId;
          const resumable = sessionResumable(s, now);
          return (
            <button
              key={s.sessionId}
              type="button"
              className={`dlg-sessions__item ${active ? "is-active" : ""}`}
              aria-current={active ? "true" : undefined}
              onClick={() => onSelect(s)}
            >
              <span className="dlg-sessions__title">
                {s.title ?? whenLabel(s.updatedAt, now)}
              </span>
              <span className="dlg-sessions__meta">
                {whenLabel(s.updatedAt, now)}
                {/*
                  只标"已结束"，不标"进行中"。列表里绝大多数都是结束了的，
                  给每一条挂一个徽标等于没有徽标；而车主真正要分辨的是
                  "这条点进去还能不能接着说"。
                */}
                {!resumable && <span className="dlg-sessions__badge">已结束</span>}
              </span>
            </button>
          );
        })}
        {loading && <div className="dlg-sessions__hint">加载中…</div>}
        {/*
          出错**要说出来**，不能静默停在半页——静默的表现是"我的会话怎么少了",
          而那看起来像数据丢了。
        */}
        {error && <div className="dlg-sessions__hint dlg-sessions__hint--error">{error}</div>}
      </div>
    </aside>
  );
}
