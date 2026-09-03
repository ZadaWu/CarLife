/**
 * 监听状态指示与麦克风总开关（施工单 M4-07，F-02-08）。
 *
 * 【它是隐私承诺的可见载体，不是装饰】（M3-07 约束 3）
 * 三态必须由**采集层的真实状态**驱动——`state` 由 Rust 侧 `VoiceSession::state()`
 * 经桥接层 emit 上来，**本组件不自己维护任何监听状态**。
 * 一个"显示没在听、实际在听"的指示灯比没有指示灯更糟；
 * 宁可延迟 200ms 亮起，也不能在没采集时亮着。
 *
 * 【为什么总开关必须常驻 HUD】
 * F-02-08 要求它"始终可见，不能藏进二级菜单"——用户需要能随时确认"它现在没在听"，
 * 而不是点三层菜单去查。这条与"HUD 要克制"有张力，取舍结果是：
 * 关闭态用显眼的样式常驻，开启态弱化为小圆点。
 */

import type { CSSProperties } from "react";

/** 与 Rust 侧 `ListenState` 一一对应（`clients/shared/rust/carlife-media/src/listen.rs`）。 */
export type ListenState = "idle" | "listening" | "uploading";

/** 与 Rust 侧 `ListenMode` 一一对应。 */
export type ListenMode = "ptt" | "always-on";

export interface MicIndicatorProps {
  /** 采集层的真实状态——**不接受由页面推断出来的值**。 */
  state: ListenState;
  /** 麦克风总开关。关闭时 `state` 恒为 idle，本组件据此显示"未在监听"。 */
  micEnabled: boolean;
  mode: ListenMode;
  onToggleMic?: (next: boolean) => void;
  /**
   * 语音唤醒链路降级中（M25-04，AC-52-9）：ASR 故障时唤醒失效必须像坏了的样子，
   * 不能显示"在听"却什么都听不进。长按 push-to-talk 不受它影响，文案里说清。
   */
  degraded?: boolean;
  /** 车机变体走 cockpit 主题 token（§2.3 大字号），不分叉组件。 */
  size?: "default" | "cockpit";
  /**
   * 形态（M26 走查）：`pill` 带文案常驻，`icon` 只有一枚喇叭图标。
   *
   * 车机 HUD 上这枚开关贴在暖暖身侧，那里没有一条横向文案的位置；
   * 但 F-02-08 的"始终可见"要求的是**状态可辨**，不是必须有字：
   * 有声/静音两张图形本身就把"它现在听不听得见"说清楚了。
   * 文案没有丢——它进了 `aria-label` 与 `title`，读屏与悬停都拿得到。
   */
  variant?: "pill" | "icon";
  className?: string;
  style?: CSSProperties;
}

const LABEL: Record<ListenState, string> = {
  idle: "未在收音",
  listening: "正在收音",
  uploading: "处理中",
};

export function MicIndicator({
  state,
  micEnabled,
  mode,
  onToggleMic,
  degraded = false,
  size = "default",
  variant = "pill",
  className,
  style,
}: MicIndicatorProps) {
  // 总开关关闭时，无论上游给什么状态都显示"已关闭"——
  // 这是第一顺位判断，与 Rust 侧 `VoiceSession::state()` 的取向一致。
  // 降级排第二顺位：开着但链路坏了，比"未在收音"更要紧的事实。
  const effective: ListenState | "off" | "degraded" = !micEnabled
    ? "off"
    : degraded
      ? "degraded"
      : state;

  const text =
    effective === "off"
      ? "麦克风已关闭"
      : effective === "degraded"
        ? "语音唤醒不可用（长按可用）"
        : `${LABEL[effective]}${mode === "always-on" ? "（常驻监听）" : ""}`;

  // 图标形态：静音（关闭 / 降级）画带斜杠的喇叭，其余画带声波的喇叭。
  // 判据与文案同源——不另起一套状态判断，否则会出现"图标静音、文案在听"。
  const muted = effective === "off" || effective === "degraded";

  return (
    <button
      type="button"
      className={[
        "carlife-mic",
        `carlife-mic--${effective}`,
        `carlife-mic--${size}`,
        `carlife-mic--${variant}`,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
      aria-live="polite"
      aria-label={text}
      title={text}
      // 关闭态用 pressed 语义暴露给读屏，隐私状态对无障碍用户同样可感知
      aria-pressed={!micEnabled}
      onClick={() => onToggleMic?.(!micEnabled)}
    >
      {variant === "icon" ? (
        <SpeakerGlyph muted={muted} />
      ) : (
        <>
          <span className="carlife-mic__dot" aria-hidden="true" />
          <span className="carlife-mic__text">{text}</span>
        </>
      )}
    </button>
  );
}

/** 喇叭图标：有声（两道声波）/ 静音（一道斜杠）。描边样式由 CSS 给。 */
function SpeakerGlyph({ muted }: { muted: boolean }) {
  return (
    <svg className="carlife-mic__glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {/* 喇叭本体：音箱 + 号角，两态共用，保证切换时形状不跳 */}
      <path d="M3.2 9.4h3.4l4.9-4.1a.6.6 0 0 1 1 .5v12.4a.6.6 0 0 1-1 .5l-4.9-4.1H3.2a.7.7 0 0 1-.7-.7v-3.8a.7.7 0 0 1 .7-.7Z" />
      {muted ? (
        // 静音：斜杠画在号角右侧，不与本体交叠——交叠时小尺寸下会糊成一团
        <path d="M16.6 9.6 21.4 14.4M21.4 9.6 16.6 14.4" />
      ) : (
        <>
          <path d="M15.9 9.2a4 4 0 0 1 0 5.6" />
          <path d="M18.6 6.5a7.8 7.8 0 0 1 0 11" />
        </>
      )}
    </svg>
  );
}
