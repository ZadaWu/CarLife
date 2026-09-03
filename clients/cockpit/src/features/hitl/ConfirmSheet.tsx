/**
 * HITL 确认弹层（施工单 M13-05，FL-04 端上半程）。
 * 视觉依据 `内部文档` 与同目录的概念图。
 *
 * 盖在 App 层：确认常发生在语音场景，用户人在 HUD 层——弹在对话层等于没弹。
 * 明细逐行显示**具体内容**而不是动作名（F-04-02）；车机可读性走大字号。
 * 决策只有两个出口且都收敛到 onDecide——弹层自己不碰网络，也不做幂等判断
 * （幂等在网关 HitlRelay，重发在协议层就被识别）。
 *
 * 【为什么要解析文本】明细在协议里是人类可读字符串，而设计要的是天序时间线。
 * 解析只在显示层（`parseConfirm`），解析不出来的行原样显示——见该文件的三条边界。
 */

import type { PermissionRequest } from "@carlife/shared";
import { parseConfirm, scopeLabel, type TransitOption } from "./parseConfirm";

export interface ConfirmSheetProps {
  request: PermissionRequest;
  /** resume 发送中：双键禁用，防连点（连点本身也幂等，这只是手感）。 */
  busy?: boolean;
  /**
   * 确认没被接住时的告知（M13-12）。**有它就不显示两个出口**——
   * 这一屏已经不是"要不要做"，而是"刚才那次没生效"。
   * 静默收起是最糟的形态：车主以为定了。
   */
  notice?: string;
  onDismissNotice?: () => void;
  onDecide: (approved: boolean) => void;
}

/* ── 图标：一律内联 SVG，不引外部依赖（Brief §4） ───────────────── */

function IconAction() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="16" rx="3" />
      <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
      <path d="M9 14.5l2.2 2.2 4.3-4.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconPin() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z" />
      <circle cx="12" cy="10" r="2.6" />
    </svg>
  );
}

function IconBed() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3 18v-11M3 12h18v6M21 18v-4" />
      <path d="M7 12V9.5h5.5a3 3 0 0 1 3 3V12" />
    </svg>
  );
}

function IconPlane() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path
        d="M10.5 3.2a1.5 1.5 0 0 1 3 0V9l7.5 4.3v2.2l-7.5-2.2v4l2.5 1.8v1.7L12 19.9l-4 1.9v-1.7l2.5-1.8v-4L3 16.5v-2.2L10.5 9z"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconTrain() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="5" y="3.5" width="14" height="12.5" rx="3.5" />
      <path d="M5.5 10h13M9.5 20l-2 2M14.5 20l2 2M8 19.5h8" strokeLinecap="round" />
      <circle cx="9" cy="13" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="15" cy="13" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconCar() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3.5 16.5v-3.2l2-4.6A2 2 0 0 1 7.3 7.5h9.4a2 2 0 0 1 1.8 1.2l2 4.6v3.2" strokeLinejoin="round" />
      <path d="M3.5 13.5h17" strokeLinecap="round" />
      <path d="M4.5 16.5v1.6M19.5 16.5v1.6" strokeLinecap="round" />
      <circle cx="7.5" cy="16.4" r="1.3" />
      <circle cx="16.5" cy="16.4" r="1.3" />
    </svg>
  );
}

/**
 * 交通方式图标按文本判断；认不出就不给图标，**不拿飞机顶替火车**。
 *
 * 自驾排在最前面不是随手写的。服务端在"没有城际交通、建议自驾"时给的那句里
 * 仍然带着「航班」两个字（"没有城际火车或航班"），按飞机的判据一测就中——
 * 实测弹窗上出现过一枚飞机图标配着「不适用（同城短途）…自驾最优」的文字。
 * **图标和文字互相矛盾时，用户信的是图标**：扫一眼就是"要坐飞机"。
 * 自驾优先判掉这类否定式表述。
 */
function TransitIcon({ text }: { text: string }) {
  if (/自驾|驾车|开车|打车|taxi/i.test(text)) return <IconCar />;
  if (/飞机|航班|机场/.test(text)) return <IconPlane />;
  if (/高铁|动车|列车|火车|^[DGKZTC]\d/.test(text)) return <IconTrain />;
  return null;
}

/* ── 组件 ─────────────────────────────────────────────────────── */

/** 估算角标：源文本带（估算）才出现，是可信度标记不是装饰。 */
function EstimateTag() {
  return <span className="hitl-est">估算</span>;
}

function TransitRow({ option }: { option: TransitOption }) {
  return (
    <li className="hitl-transit__row">
      <span className="hitl-transit__icon" aria-hidden="true">
        <TransitIcon text={`${option.mode ?? ""}${option.text}`} />
      </span>
      <span className="hitl-transit__body">
        {option.mode && <span className="hitl-transit__mode">{option.mode}</span>}
        <span className="hitl-transit__text">{option.text}</span>
      </span>
      {option.estimated && <EstimateTag />}
    </li>
  );
}

export function ConfirmSheet({ request, busy = false, notice, onDismissNotice, onDecide }: ConfirmSheetProps) {
  const view = parseConfirm(request.details, request.title);
  const scope = scopeLabel(request.scope);
  // 天序时间线与大交通同时在场才分左右两栏；否则单栏，避免右侧空出一大块。
  const split = view.days.length > 0 && view.transit !== undefined;

  return (
    <div className="hitl-backdrop" role="dialog" aria-modal="true" aria-label={view.title}>
      <div className="hitl-sheet">
        {/* 竖屏抽屉把手；横屏由 CSS 隐藏。 */}
        <div className="hitl-grip" aria-hidden="true" />

        <header className="hitl-head">
          <span className="hitl-head__icon" aria-hidden="true">
            <IconAction />
          </span>
          <h2 className="hitl-head__title">{view.title}</h2>
          {/* 两枚胶囊装在一起：竖屏要它们整组换到第二行，而不是一枚跟着标题、
              另一枚孤零零掉下去（拆开时实测就是这个结果）。 */}
          {(view.subject || scope) && (
            <div className="hitl-head__pills">
              {view.subject && <span className="hitl-pill hitl-pill--subject">{view.subject}</span>}
              {scope && <span className="hitl-pill hitl-pill--scope">{scope}</span>}
            </div>
          )}
        </header>

        <div className={`hitl-body${split ? " hitl-body--split" : ""}`}>
          {(view.days.length > 0 || view.rows.length > 0) && (
            <section className="hitl-plan">
              {view.days.map((d) => (
                <article className="hitl-day" key={d.day}>
                  <div className="hitl-day__badge">{d.day}</div>
                  <div className="hitl-day__main">
                    {d.theme && <div className="hitl-day__theme">{d.theme}</div>}
                    {d.spots.length > 0 && (
                      <ul className="hitl-chips">
                        {d.spots.map((s, i) => (
                          <li className="hitl-chip" key={i}>
                            <span className="hitl-chip__icon" aria-hidden="true">
                              <IconPin />
                            </span>
                            {s}
                          </li>
                        ))}
                      </ul>
                    )}
                    {d.stay && (
                      <div className="hitl-stay">
                        <span className="hitl-stay__icon" aria-hidden="true">
                          <IconBed />
                        </span>
                        {/* 连住同店同价折叠成一句（Brief §3.2）——重复四遍同一个
                            酒店名，扫读时反而看不出"这四晚住的是同一家"。 */}
                        {d.stay.sameAsPrevious ? (
                          <span className="hitl-stay__same">同前一晚</span>
                        ) : (
                          <>
                            <span className="hitl-stay__name">{d.stay.name}</span>
                            {d.stay.price && <span className="hitl-stay__price">{d.stay.price}</span>}
                            {d.stay.estimated && <EstimateTag />}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </article>
              ))}

              {/* 结构化不了的明细原样显示——版式退化好过内容失真。 */}
              {view.rows.map((d, i) => (
                <div className="hitl-detail" key={i}>
                  <span className="hitl-detail__label">{d.label}</span>
                  <span className="hitl-detail__value">{d.value}</span>
                </div>
              ))}
            </section>
          )}

          {view.transit && (
            <aside className="hitl-transit">
              <h3 className="hitl-transit__title">大交通</h3>
              <ul className="hitl-transit__list">
                {view.transit.options.map((o, i) => (
                  <TransitRow option={o} key={i} />
                ))}
              </ul>
              {view.transit.note && <p className="hitl-transit__note">{view.transit.note}</p>}
            </aside>
          )}
        </div>

        {/*
         * 将提供给门店的信息（M15-04，F-26-09 / AC-15-7）。
         *
         * **必须独立成块并带标题**，不能混进上面的动作明细：
         * 那几行的性质和"门店地址"完全不同——一个是"这次动作是什么"，
         * 一个是"我的哪些信息要发出去"。混排的结果是用户根本不会注意到后者。
         *
         * 值来自服务端（`describeDisclosure` 已掩码），**端上不自己拼**：
         * 两处各拼一份时，用户看到的和实际发出去的会对不上。
         */}
        {request.disclosure.length > 0 && (
          <section className="hitl-disclosure">
            <div className="hitl-disclosure__title">将提供给门店的信息</div>
            <div className="hitl-details">
              {request.disclosure.map((d, i) => (
                <div className="hitl-detail" key={i}>
                  <span className="hitl-detail__label">{d.label}</span>
                  <span className="hitl-detail__value">{d.value}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {notice && <p className="hitl-notice">{notice}</p>}

        <footer className="hitl-actions">
          {notice ? (
            <button type="button" className="hitl-btn hitl-btn--approve" onClick={onDismissNotice}>
              知道了
            </button>
          ) : (
          <>
          <button
            type="button"
            className="hitl-btn hitl-btn--reject"
            disabled={busy}
            onClick={() => onDecide(false)}
          >
            拒绝
          </button>
          <button
            type="button"
            className="hitl-btn hitl-btn--approve"
            disabled={busy}
            onClick={() => onDecide(true)}
          >
            确认
          </button>
          </>
          )}
        </footer>
      </div>
    </div>
  );
}
