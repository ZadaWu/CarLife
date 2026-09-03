/**
 * 卡通助手英雄区（施工单 M1-02 静态形态，交互见 M1-03）
 *
 * Brief §3.4：左下角毛绒 AI 助手是界面的视觉 Key 和**唯一主交互**。
 *  - 含底座的英雄区约占 22–25% 画布宽、34–40% 画布高，主体大于任一地点缩略图；
 *  - 点击进入对话层，长按按住说话；
 *  - 音波仅在聆听/说话时轻度变化，不抢占地图或卡片；
 *  - 五态状态机，且**不显示模型思考过程**。
 */

// M2-01：AssistantState 唯一来源为 @carlife/shared（Rust 契约生成）；此处保留 re-export 兼容既有导入。
import type { AssistantState } from "@carlife/shared";
export type { AssistantState };

/**
 * 休息 / 办公——**与五态正交的另一根轴**（施工单 M22-03）。
 *
 * 五态说的是"这一刻在干什么"（听/想/说），这根轴说的是"在不在这段对话里"：
 * 没有进行中的会话就是休息，车主开口之后就是办公。**办公中仍然有那五态**。
 *
 * 塞进 `AssistantState` 是错的——它是 Rust 契约的生成物，而且两根轴会相乘（十种组合）。
 */
export type AssistantMode = "rest" | "work";

export interface AssistantDockProps {
  /** 助手精灵（按主题 + 天气服饰传入）。休息形象。 */
  sprite: string;
  /** 办公形象。缺省时 `mode="work"` 也只能退回休息图——**不硬凑**。 */
  workingSprite?: string;
  state: AssistantState;
  /** 休息 / 办公。未知值回落 `rest` 且不抛错（照 F-01-01 的边界纪律）。 */
  mode?: AssistantMode;
  /** 主提示语，默认「点击对话」。 */
  primaryLabel?: string;
  /** 次提示语，默认「长按说话」。 */
  secondaryLabel?: string;
  /** 供 M1-03 挂载点击/长按手势。 */
  gestureProps?: Record<string, unknown>;
  /**
   * 点一下助手会不会进对话层（默认 true）。
   *
   * 车机端传 false：触屏上「点一下」与「长按说话」抢同一块区域，press 稍短
   * 就翻去对话页，进对话因此收归底部导航的「对话」按钮独占。
   * **这个 prop 只管说法对不对**——真正的行为由 `useAssistantInteraction`
   * 收不收 `onOpenDialog` 决定；两处不一致的话，界面会写着一句做不到的事。
   */
  tapOpensDialog?: boolean;
  /**
   * 点一下会不会**打断**（施工单 M33-02，车机端传 true）。
   *
   * 与 `tapOpensDialog` **互斥**：一块区域只能有一个短按含义，
   * 所以 `tapOpensDialog` 为真时本 prop 被忽略（进对话优先——那是调用方
   * 显式要的行为，而打断是这块区域"顺便空着"时才捡起来的）。
   * 它只在 `speaking` / `thinking` 时改变提示语——其余状态点一下确实什么都不做，
   * 那时还写「点一下打断」就是一句做不到的指示（与 `tapOpensDialog` 同一条纪律）。
   */
  tapInterrupts?: boolean;
  /**
   * 点「退下」：结束这段对话。
   *
   * **不给回调就不渲染这个按钮**——组件不造一个点了没反应的按钮。
   */
  onDismiss?: () => void;
}

const STATE_TEXT: Record<AssistantState, string> = {
  idle: "点击对话",
  listening: "正在聆听…",
  thinking: "正在准备…",
  speaking: "正在回答…",
  alert: "有一条提醒",
};

/** 音波竖杠的 [x, 高度]，中间高两侧低；viewBox 24 高，居中对称。 */
const WAVE_BARS: ReadonlyArray<readonly [number, number]> = [
  [2, 8],
  [8, 14],
  [14, 20],
  [20, 14],
  [26, 8],
];

export function AssistantDock({
  sprite,
  workingSprite,
  state,
  mode = "rest",
  primaryLabel,
  secondaryLabel,
  gestureProps,
  tapOpensDialog = true,
  tapInterrupts = false,
  onDismiss,
}: AssistantDockProps) {
  const wave = state === "listening" || state === "speaking";
  // idle 的默认主提示与"点一下会怎样"绑死：tapOpensDialog=false 时还写
  // 「点击对话」就是一句做不到的指示——车主会照着点，然后什么都不发生。
  const idleLabel = tapOpensDialog ? STATE_TEXT.idle : "长按说话";
  /*
   * 她正在说 / 正在想，而这台端上点一下就是打断（M33-02）——把这件事写出来。
   * 不写的话，"点一下能让她停"是一个只有读过代码的人才知道的功能。
   */
  const interruptible =
    tapInterrupts && !tapOpensDialog && (state === "speaking" || state === "thinking");
  /*
   * 次行默认是「长按说话」。tapOpensDialog=false 时主行已经是这句，
   * 再来一遍就是同一句话说两次——那时默认收掉，调用方仍可显式覆盖。
   */
  const secondary = secondaryLabel ?? (tapOpensDialog ? "长按说话" : "");
  // 未知值回落 rest：这个 prop 会从 App 层的派生值传下来，
  // 传错一个字符串不该让整屏 HUD 白掉（F-01-01 的边界纪律）。
  const working = mode === "work";
  // 办公图没给就退回休息图——**不硬凑**。少一张图的后果只是形象没变，
  // 而 `<img src={undefined}>` 会在角色位置留一个碎图标。
  const shown = working && workingSprite ? workingSprite : sprite;
  // 只在办公中、且真有人接这个动作时才渲染按钮。
  const dismissable = working && typeof onDismiss === "function";

  return (
    <div className="hud-assistant" data-state={state} data-mode={working ? "work" : "rest"}>
      <div
        className="hud-assistant__hero"
        role="button"
        tabIndex={0}
        aria-label={
          tapOpensDialog
            ? `${STATE_TEXT[state]}，点击进入对话，长按说话`
            : interruptible
              ? `${STATE_TEXT[state]}，点一下打断，长按说话`
              : `${STATE_TEXT[state]}，长按说话`
        }
        {...gestureProps}
      >
        {/* 定稿的「放大镜」底环：一圈亮环 + 内侧柔光，把角色从地图上摘出来。
            没有它时角色直接压在路网上，浅色底图下轮廓会糊掉。 */}
        <span className="hud-assistant__halo" aria-hidden="true" />
        {/* draggable=false 与 hud.css 的 -webkit-user-drag 双保险：长按后拖走精灵图的那条路两头都堵上。 */}
        <img className="hud-assistant__sprite" src={shown} alt="" aria-hidden="true" draggable={false} />

        {/*
         * 「退下」：结束这段对话（M22-03）。
         *
         * 贴在底环右上角。**`stopPropagation` 不能省**——它套在 hero 里面，
         * 而 hero 自己挂着"点击进入对话 / 长按说话"的手势：不拦住的话，
         * 点退下会顺带把对话层拉起来，车主看到的是"我想收尾，它却把聊天打开了"。
         */}
        {dismissable && (
          <button
            type="button"
            className="hud-assistant__dismiss"
            aria-label="退下，结束这段对话"
            /*
             * **整个 pointer 序列都要拦，不能只拦 pointerdown**（iPad 走查）。
             *
             * 事件顺序是 pointerdown → pointerup → click。原来只拦了 down，
             * 于是 up 冒泡到 hero，hero 的手势在 pointerup 上判"短按 = 进对话"，
             * 一进对话本按钮就被卸载——**后面那个 click 永远送不到**，
             * `onDismiss` 一次都没跑过。车主看到的是"我想收尾，它打开了聊天，
             * 而且会话还是旧的"，两个症状其实是同一个根因。
             */
            onClick={(e) => {
              e.stopPropagation();
              onDismiss!();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
          >
            退下
          </button>
        )}
      </div>

      <div
        className="hud-card hud-assistant__card"
      >
        {/* 两行文案在卡内**水平居中**（定稿 §3.4）。音波不参与这个居中——
            它绝对定位贴右边，否则 flex 行会把文字挤到左侧，看起来像没对齐。 */}
        <span className="hud-assistant__primary">
          {primaryLabel ??
            (state === "idle"
              ? idleLabel
              : interruptible
                ? (
                    <>
                      {STATE_TEXT[state]}
                      {/* 「点一下打断」是操作提示不是状态：缩小、变灰，
                          不与状态文案抢同一视觉级（aria-label 不受影响）。 */}
                      <span className="hud-assistant__hint">（点一下打断）</span>
                    </>
                  )
                : STATE_TEXT[state])}
        </span>
        {/* 次行为空时连分隔线一起收掉：一条底下没有内容的横线看着像没加载完 */}
        {secondary !== "" && (
          <>
            <div className="hud-assistant__rule" />
            <span className="hud-assistant__secondary">{secondary}</span>
          </>
        )}

        <span className={`hud-assistant__wave${wave ? " is-active" : ""}`} aria-hidden="true">
          <svg className="hud-assistant__wave-icon" viewBox="0 0 34 24" aria-hidden="true" focusable="false">
            {/* 音波：中间高两侧低的对称波形（定稿的语音标识）。
                竖杠数量与高度差是它读起来像"声音"而不像"信号格"的原因，
                改动时保持对称、保持圆头。 */}
            {WAVE_BARS.map(([x, h], i) => (
              <rect
                key={x}
                x={x}
                y={12 - h / 2}
                width="3"
                height={h}
                rx="1.5"
                style={{ animationDelay: `${i * 0.09}s` }}
              />
            ))}
          </svg>
        </span>
      </div>
    </div>
  );
}
