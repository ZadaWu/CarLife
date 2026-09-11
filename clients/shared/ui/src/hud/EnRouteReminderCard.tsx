/**
 * 途中提醒卡（施工单 M77-06，F-62-09；设计依据 `内部文档` §3.4）。
 *
 * 两类两种重量：停靠提前提醒 = 白卡 + 「知道了」；连续驾驶提醒 = alert 卡（琥珀光晕、三角叹号）+
 * 「不用」/「好，去歇会」。**不用红**——红只给拥堵与读不到。收起后是一枚胶囊「下一站 X · N km」。
 * 卡上没有任何导航操作：「怎么走」交给出发卡的导航交接。
 */
import type { ReminderDensity } from "./en-route-reminders";
import type { EnRouteCard } from "./en-route-controller";
import { distanceText } from "@carlife/shared";

export interface EnRouteReminderCardProps {
  card: EnRouteCard;
  density?: ReminderDensity;
  /** 播报总开关关着 / 低档只卡：右上角画喇叭加斜线。 */
  muted?: boolean;
  onAck: () => void;
  onRestDecision?: (accept: boolean) => void;
}

function IconTriangle() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.5L21.5 20H2.5z" />
      <path d="M12 9.5v5M12 17.2v.3" />
    </svg>
  );
}
function IconSpeaker({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9.5v5h3.5L13 19V5L7.5 9.5z" />
      {muted ? <path d="M16 9l5 6M21 9l-5 6" /> : <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />}
    </svg>
  );
}

export function EnRouteReminderCard({ card, density = "normal", muted = false, onAck, onRestDecision }: EnRouteReminderCardProps) {
  const isRest = card.reminder.kind === "rest";
  const silent = muted || card.gate === "card-only" || (density === "low" && !isRest);
  if (card.collapsed) {
    const label =
      card.reminder.kind === "stop"
        ? `下一站 ${card.reminder.stopName} · ${distanceText(card.reminder.remainingM)}`
        : card.text.headline;
    return (
      <button type="button" className="hud-reminder-pill" onClick={onAck} aria-label={label}>
        {label}
      </button>
    );
  }
  return (
    <aside className={`hud-reminder${isRest ? " is-alert" : ""}`} role={isRest ? "alert" : "status"} aria-live={isRest ? "assertive" : "polite"}>
      <span className={`hud-reminder__speaker${silent ? " is-muted" : ""}`} aria-hidden="true">
        <IconSpeaker muted={silent} />
      </span>
      <div className="hud-reminder__body">
        <div className="hud-reminder__headline">
          {isRest && (
            <span className="hud-reminder__icon" aria-hidden="true">
              <IconTriangle />
            </span>
          )}
          {card.text.headline}
        </div>
        {card.text.body && <div className="hud-reminder__text">{card.text.body}</div>}
        {card.text.caption && <div className="hud-reminder__caption">{card.text.caption}</div>}
      </div>
      <div className="hud-reminder__actions">
        {isRest ? (
          <>
            <button type="button" className="hud-reminder__btn" onClick={() => onRestDecision?.(false)}>
              不用
            </button>
            <button type="button" className="hud-reminder__btn is-primary" onClick={() => onRestDecision?.(true)}>
              好，去歇会
            </button>
          </>
        ) : (
          <button type="button" className="hud-reminder__btn" onClick={onAck}>
            知道了
          </button>
        )}
      </div>
    </aside>
  );
}
