/**
 * 行程变化摘要弹层（施工单 M72-04 建于车机；M75-01 上提到 `@carlife/ui`，两端共用一份）。
 * 设计：内部文档
 *
 * 列表卡上点带点的那程 → 这一屏：左「原计划」/ 右「现在」，按天分组，每条变化一行。
 * 两个出口：「知道了」（把这份核查标成已看过，点熄灭）与「让暖暖调整」（把一句结构化的话
 * 发进会话，后面全是既有链路：无草案装载 → 粘性细化 → 确认弹窗 → `trip_plan_update`）。
 *
 * # 这一屏不改行程
 *
 * HUD Brief §2：有后果的操作进对话层，保留 Guard + HITL。弹层只做到「看懂 + 选方向」，
 * 「让暖暖调整」也只是替车主说一句话——改不改、改成什么，仍经确认弹窗。
 *
 * # 样式自带（`trip-review.css`），不再靠车机的 `.hitl-*`
 *
 * 车机版靠 cockpit `styles.css` 的 `.hitl-*` 外壳；手机端没有那一族（它的确认弹窗是另一套类名）。
 * 上提后弹层只用 `trip-review__*`，数值照抄车机 `.hitl-sheet/.hitl-head/.hitl-pill/.hitl-btn`——
 * 车机像素不变，竖屏自然得到抽屉形态（贴底、顶部圆角、把手）。
 *
 * # 行驶中不弹
 *
 * 由页面层决定（`canAdjust` 与是否打开都在 App）：跟车时只留列表上的点，停车后再看。
 */

import { adjustPrompt, type TripPlanListEntry, type TripReviewChange } from "@carlife/shared";

export interface TripReviewSheetProps {
  entry: TripPlanListEntry;
  /** ack 发送中：双键禁用。 */
  busy?: boolean;
  /** Tauri 且非行驶中才有「让暖暖调整」；浏览器走查里不渲染那个按钮。 */
  canAdjust?: boolean;
  onAck: () => void;
  onAdjust?: (prompt: string) => void;
  onClose: () => void;
}

/** 按天分组，给弹层用；`day` 缺省的（整程级）归到 0。 */
export function groupChangesByDay(changes: readonly TripReviewChange[]): Array<{ day: number; items: TripReviewChange[] }> {
  const map = new Map<number, TripReviewChange[]>();
  for (const c of changes) {
    const key = c.day ?? 0;
    const list = map.get(key) ?? [];
    list.push(c);
    map.set(key, list);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([day, items]) => ({ day, items }));
}

/** 「核查于 9/8 06:10」——用本地时间，车主看的是端上的钟。 */
export function reviewedAtLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `核查于 ${d.getMonth() + 1}/${d.getDate()} ${hh}:${mi}`;
}

const KIND_LABEL: Record<TripReviewChange["kind"], string> = {
  weather: "天气",
  alarm: "预警",
  route: "出发路线",
};

export function TripReviewSheet({ entry, busy = false, canAdjust = false, onAck, onAdjust, onClose }: TripReviewSheetProps) {
  const review = entry.review;
  if (!review) return null;
  const groups = groupChangesByDay(review.changes);
  const critical = review.severity === "critical";

  return (
    <div className="trip-review" role="dialog" aria-modal="true" aria-label="行程有变化">
      <div className={`trip-review__sheet${critical ? " is-critical" : ""}`}>
        <div className="trip-review__grip" aria-hidden="true" />
        <header className="trip-review__head">
          <span className="trip-review__icon" aria-hidden="true">
            <IconChange />
          </span>
          <h2 className="trip-review__title">{critical ? "行程有重要变化" : "行程有变化"}</h2>
          <div className="trip-review__pills">
            <span className="trip-review__pill trip-review__pill--subject">
              {entry.plan.destination} · {entry.plan.days} 天
            </span>
            <span className="trip-review__pill trip-review__pill--scope">{reviewedAtLabel(review.reviewedAt)}</span>
          </div>
        </header>

        <section className="trip-review__body" aria-label="变化明细">
          <div className="trip-review__cols" aria-hidden="true">
            <span>原计划</span>
            <span>现在</span>
          </div>
          {groups.map((g) => (
            <article className="trip-review__day" key={g.day}>
              {g.day > 0 ? (
                <div className="trip-review__badge">{g.day}</div>
              ) : (
                <div className="trip-review__badge trip-review__badge--all">全</div>
              )}
              <ul className="trip-review__items">
                {g.items.map((c, i) => (
                  <li className={`trip-review__item${c.severity === "critical" ? " is-critical" : ""}`} key={`${c.kind}-${i}`}>
                    <span className="trip-review__kind">{KIND_LABEL[c.kind]}</span>
                    <span className="trip-review__before">{c.before}</span>
                    <span className="trip-review__arrow" aria-hidden="true">
                      →
                    </span>
                    <span className="trip-review__after">{c.after}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </section>

        <footer className="trip-review__actions">
          <button type="button" className="trip-review__btn trip-review__btn--later" disabled={busy} onClick={onClose}>
            稍后再看
          </button>
          {canAdjust && onAdjust && (
            <button
              type="button"
              className="trip-review__btn trip-review__btn--adjust"
              disabled={busy}
              onClick={() => onAdjust(adjustPrompt(entry.planId, review.changes))}
            >
              让暖暖调整
            </button>
          )}
          <button type="button" className="trip-review__btn trip-review__btn--ack" disabled={busy} onClick={onAck}>
            知道了
          </button>
        </footer>
      </div>
    </div>
  );
}

function IconChange() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 7h11l-3-3M20 17H9l3 3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="19" cy="7" r="1.6" />
      <circle cx="5" cy="17" r="1.6" />
    </svg>
  );
}
