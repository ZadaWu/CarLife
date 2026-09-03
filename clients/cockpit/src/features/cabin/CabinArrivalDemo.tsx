/**
 * 暖暖出发动画 + 出发卡（0830 走查重排；原「暖暖出发演示」）。
 *
 * 编排全部走 WAAPI（`element.animate`），关键帧与字幕 cue 同出一份
 * `DEPARTURE_TIMELINE`（见 departure.ts 文件头——上一版两处手写时间漂掉的教训）。
 * CSS 只留静态样式与装饰性循环（轨道呼吸、钥匙摆动）。
 *
 * 动画收尾不再尬停：车驶离后滑入**出发卡**（目的地/今日路线/途径补能 +
 * 「开始导航」）。这颗钥匙由此从"演示按钮"升格为"出发入口"（设计决议
 * 2026-08-30）；纯看动画的路不保留，重播按钮留着就够了。
 */
import {
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AssistantState, TripPlanSnapshot } from "@carlife/shared";
import {
  CABIN_ARRIVAL_SPRITES,
  DepartureCard,
  Soundscape,
  departureArriveClip,
  departureWakeClip,
  departureBoardClip,
  departureDriveoffClip,
  departureClipSrc,
  useDepartureNav,
  warmDepartureClips,
  type NavPlanState,
  type OpenExternal,
  type ThemeName,
} from "@carlife/ui";
import { getLocationPort } from "@carlife/ui";

import {
  departureLayers,
  DEPARTURE_TIMELINE,
  DEPARTURE_CLIPS,
  CLIP_START,
  statusAt,
} from "./departure";
import { CUE_START, cuesBetween } from "./departure-audio";
import { currentOriginForNav, requestNavPlan } from "./nav-plan-api";
import { cuesForPolicy, decidePolicy, type SoundscapePolicy } from "./soundscape-policy";
import { readSoundscapePref } from "./soundscape-prefs";
import "./cabin-arrival.css";

interface CabinArrivalDemoProps {
  theme: ThemeName;
  /**
   * 出发卡的数据源：HUD 正在展示的那份行程（演示/真实同一入口）。
   * null/缺省 = 没有可出发的行程，卡上如实说，不编一份。
   */
  plan?: TripPlanSnapshot | null;
  /**
   * 助手此刻的五态。`speaking` 时音景全静——播报是功能，音景是装饰（M64-03）。
   *
   * 从 `HudScreen` 的 `snapshot.assistantState` 直接下来，不新建信号源。
   */
  assistantState?: AssistantState | null;
  /**
   * 界面音效开关。**缺省时读用户设置**（`soundscape-prefs`），传值只用于测试与强制关闭。
   *
   * 关掉时**根本不创建 `AudioContext`**，而不是把主增益设成 0——车机是长时运行设备，
   * 一个用户已经关掉的功能不该常驻一个音频上下文。
   */
  soundOn?: boolean;
}

function ClimateGlyph() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M13 12v22M6 19h14M8.5 14.5l9 9M17.5 14.5l-9 9" />
      <path d="M34 9v20a8 8 0 1 1-5 0V9a2.5 2.5 0 0 1 5 0Z" />
      <path d="M31.5 34.5h.1" />
    </svg>
  );
}

function SeatGlyph() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M14 28V18a5 5 0 0 1 10 0v10" />
      <path d="M24 28h8a5 5 0 0 1 5 5v3H14v-3a5 5 0 0 1 5-5h5Z" />
      <path d="M12 39h26M18 11c-2-2-2-4 0-6M25 11c-2-2-2-4 0-6" />
    </svg>
  );
}

function LightGlyph() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="8" />
      <path d="M24 5v6M24 37v6M5 24h6M37 24h6M10.6 10.6l4.2 4.2M33.2 33.2l4.2 4.2M37.4 10.6l-4.2 4.2M14.8 33.2l-4.2 4.2" />
    </svg>
  );
}

function MediaGlyph() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M10 26v-4M17 34V14M24 40V8M31 34V14M38 27v-5" />
    </svg>
  );
}

function FamilyGlyph() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M24 5 39 11v10c0 10-6 17-15 22C15 38 9 31 9 21V11L24 5Z" />
      <circle cx="19" cy="21" r="3" />
      <circle cx="29" cy="22" r="2.5" />
      <path d="M14 31c1-4 8-4 10 0M25 31c1-3 6-3 8 0" />
    </svg>
  );
}

interface FunctionOrbProps {
  className: string;
  label: string;
  ringRef: RefObject<HTMLSpanElement>;
  children: ReactNode;
}

function FunctionOrb({ className, label, ringRef, children }: FunctionOrbProps) {
  return (
    <div className={`cabin-arrival__orb ${className}`} aria-label={label} role="img">
      <span ref={ringRef} className="cabin-arrival__orb-ring" aria-hidden="true" />
      {children}
    </div>
  );
}

/**
 * Tauri 端（车机/iPad 客户端）里 WKWebView 会静默吞掉 target=_blank——
 * 浏览器走查一切正常、真机点了没反应零报错（0830 实测）。所以 Tauri 环境
 * 把 opener 插件（iOS 是 UIApplication openURL，macOS 开默认浏览器）注入给出发卡；
 * 不在 Tauri 里就不注入，让 <a> 自己跳。
 */
function tauriOpener(): OpenExternal | undefined {
  if (!("__TAURI_INTERNALS__" in window)) return undefined;
  return (url) => invoke<void>("plugin:opener|open_url", { url });
}

function CabinArrivalOverlay({
  theme,
  plan,
  runId,
  sound,
  assistantState,
  musicAudibleRef,
  navState,
  onCardVisible,
  onReplay,
  onClose,
}: CabinArrivalDemoProps & {
  runId: number;
  /** 出发卡露面时叫一声：导航规划的计时从这一刻起算（走查 2026-09-02）。 */
  onCardVisible: () => void;
  /** 出发导航规划的三态（M66-04），由外层 `useDepartureNav` 持有——重播（key 变）不该把它清掉。 */
  navState: NavPlanState;
  /** 音景门面；`null` = 这一轮不出声（开关关着、或 WebAudio 建不起来）。 */
  sound: Soundscape | null;
  /**
   * 车内音乐在不在放。用 ref 不用 prop：探测是点击后的一次异步 IPC，
   * 可能比第一帧晚到；ref 让 `tick` 每帧读到最新值，而不是把动画卡住等它。
   */
  musicAudibleRef: MutableRefObject<boolean>;
  onReplay: () => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState(DEPARTURE_TIMELINE.phases[0]!.status);
  const [stage, setStage] = useState<"playing" | "card">("playing");
  /*
   * 卡片一露面就把计时起点交出去（走查 2026-09-02）。
   *
   * 两条路径都走这里：动画自然放完，以及 `prefers-reduced-motion` 直接出卡。
   * 挂在 stage 上而不是各自调用，是因为后者迟早会漏掉其中一条——
   * 而漏掉的表现是"卡出来了，计时还从点击那一刻算"，看起来只是数字偏大。
   */
  useEffect(() => {
    if (stage === "card") onCardVisible();
  }, [stage, onCardVisible]);

  /*
   * 助手状态与音乐状态都要**每帧读最新值**，而 effect 的依赖是 [runId]——
   * tick 闭包里直接用 prop 的话，闭的是动画开始那一刻的值，
   * 于是"暖暖动画中途开口"这件事永远不会被看见。渲染期同步 ref 是最省的做法。
   */
  const assistantRef = useRef<AssistantState | null | undefined>(assistantState);
  assistantRef.current = assistantState;

  /* WAAPI 的挂点。名字与 departureLayers() 的 key 一一对应。 */
  const refs = {
    constellation: useRef<HTMLDivElement>(null),
    arriveClip: useRef<HTMLVideoElement>(null),
    wakeClip: useRef<HTMLVideoElement>(null),
    boardClip: useRef<HTMLVideoElement>(null),
    driveoffClip: useRef<HTMLVideoElement>(null),
    introNuannuan: useRef<HTMLImageElement>(null),
    wakeBand: useRef<HTMLSpanElement>(null),
    ringClimate: useRef<HTMLSpanElement>(null),
    ringLight: useRef<HTMLSpanElement>(null),
    ringSeat: useRef<HTMLSpanElement>(null),
    ringMedia: useRef<HTMLSpanElement>(null),
    ringFamily: useRef<HTMLSpanElement>(null),
  };

  useEffect(() => {
    // 减少动态：直接给结果（出发卡），不放 8 秒电影。
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStage("card");
      return;
    }
    const layers = departureLayers();
    const anims: Animation[] = [];
    for (const [key, keyframes] of Object.entries(layers)) {
      const el = refs[key as keyof typeof refs]?.current;
      if (!el) continue;
      anims.push(el.animate(keyframes, { duration: DEPARTURE_TIMELINE.total, fill: "both" }));
    }
    /*
     * 字幕、片子、收尾**全部由同一个时钟驱动**——那个时钟就是 WAAPI 动画自己的
     * `currentTime`，不是 setTimeout 的墙钟。
     *
     * 为什么不能用 setTimeout：页面进后台时 Chrome 冻结 WAAPI 的文档时钟，
     * 而 setTimeout 照跑。于是字幕一路走到「出发！」、画面还停在第一帧，
     * 回到前台后两者**永久错开**（0831 在走查面板里实测到，面板始终 hidden，
     * 字幕跑完全程而动画 currentTime 一直是 0）。车机 webview 息屏是同一个场景。
     * 这正是本文件开头那条教训的变体：两处各走一份时间，漂了没有任何报错。
     */
    const master = anims[0];
    const clips: [RefObject<HTMLVideoElement | null>, number, number][] = DEPARTURE_CLIPS.map(
      (c) => [
        refs[`${c.key}Clip` as "arriveClip"],
        CLIP_START[c.key],
        c.duration,
      ],
    );
    /** 片子允许落后/超前主时钟多少才纠正。太小会频繁 seek 导致卡顿。 */
    const DRIFT_TOLERANCE_S = 0.2;
    let raf = 0;
    /*
     * cue 的"已经放到哪"。**存在 effect 内部**而不是组件级 ref：
     * 这个 effect 的依赖是 [runId]，重播时整段重跑，prev 跟着回到 CUE_START——
     * 提到外面就得记得手动重置，而忘了重置的表现是"第二遍一个音都不响"。
     */
    let prevMs = CUE_START;
    /** 上一帧的形态。只在 full → 非 full 的那一次收铺底，不必每帧调。 */
    let prevPolicy: SoundscapePolicy = "full";
    const tick = () => {
      const ms = Number(master?.currentTime ?? 0);
      // setStatus 传相同字符串时 React 会自行短路，所以每帧调用不会造成额外渲染。
      setStatus(statusAt(ms));
      /*
       * 音景与字幕**同一个 ms、同一行数据**。cue 立即发，不预排——
       * 预排要用 AudioContext.currentTime，而那条时钟在页面进后台时不冻结
       * （上面那段注释讲的就是这件事，音频侧是它的第二个变体）。
       */
      const policy = decidePolicy({
        enabled: sound !== null,
        assistantState: assistantRef.current,
        musicAudible: musicAudibleRef.current,
      });
      /*
       * 形态一旦离开 full 就把铺底收掉——它是唯一持续出声的一路，
       * 剩下五个都是打完就了结的。收掉之后**不再恢复**：暖暖说完话再把风声
       * 重新拉起来，听起来像有人在旁边开关窗，比一直没有更怪。
       * `stop()` 幂等（M64-01 单测钉着），所以这里不必自己去记状态。
       */
      if (policy !== "full" && prevPolicy === "full") sound?.stop();
      prevPolicy = policy;
      /*
       * **不补放**：`cuesBetween` 只返回这一帧跨过的 cue，静音期间跨过的那些
       * 就是错过了。补放会让几个音在恢复的瞬间一起炸出来。
       */
      for (const c of cuesForPolicy(policy, cuesBetween(prevMs, ms))) sound?.fire(c);
      prevMs = ms;
      for (const [r, at, dur] of clips) {
        const v = r.current;
        if (!v) continue;
        const inWindow = ms >= at && ms < at + dur;
        if (!inWindow) {
          if (!v.paused) v.pause();
          continue;
        }
        const want = (ms - at) / 1000;
        if (Number.isFinite(v.duration) && Math.abs(v.currentTime - want) > DRIFT_TOLERANCE_S) {
          v.currentTime = Math.min(want, v.duration - 0.05);
        }
        // 自动播放被拦截时不要让整段动画卡住：吞掉 rejection，画面退化成"片子不动"，
        // 但上面的 currentTime 纠偏仍然会把它逐帧推着走。
        if (v.paused) void v.play().catch(() => {});
      }
      if (ms >= DEPARTURE_TIMELINE.total) {
        setStage("card");
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      anims.forEach((a) => a.cancel());
      clips.forEach(([r]) => r.current?.pause());
      // 三条退出路径（自然结束 / 用户点关闭 / 组件卸载）都会走到这里，
      // 也只有这里能同时覆盖三条。漏掉的表现是**风声一直响到重启客户端**，且不报错。
      sound?.stop();
    };
    // refs 是稳定的 ref 容器，不进依赖；重播靠 runId 重跑整段。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  return (
    <section
      className={`cabin-arrival${stage === "card" ? " is-card" : ""}`}
      data-theme={theme}
      aria-label="暖暖出发"
    >
      <div className="cabin-arrival__veil" aria-hidden="true" />
      <div ref={refs.constellation} className="cabin-arrival__constellation" aria-hidden="true">
        <span className="cabin-arrival__orbit cabin-arrival__orbit--outer" />
        <span className="cabin-arrival__orbit cabin-arrival__orbit--inner" />

        <FunctionOrb className="cabin-arrival__orb--climate" label="空调已设定" ringRef={refs.ringClimate}>
          <ClimateGlyph />
        </FunctionOrb>
        <FunctionOrb className="cabin-arrival__orb--seat" label="座椅舒适设置" ringRef={refs.ringSeat}>
          <SeatGlyph />
        </FunctionOrb>
        <FunctionOrb className="cabin-arrival__orb--light" label="氛围灯已设定" ringRef={refs.ringLight}>
          <LightGlyph />
        </FunctionOrb>
        <FunctionOrb className="cabin-arrival__orb--media" label="媒体设置" ringRef={refs.ringMedia}>
          <MediaGlyph />
        </FunctionOrb>
        <FunctionOrb className="cabin-arrival__orb--family" label="家庭模式" ringRef={refs.ringFamily}>
          <FamilyGlyph />
        </FunctionOrb>
      </div>

      {stage === "playing" && (
        <div className="cabin-arrival__headline" aria-live="polite">
          <span>暖暖出发</span>
          {/* key=status：换字时重放入场微动画（CSS cabin-status-in）。 */}
          <strong key={status}>{status}</strong>
        </div>
      )}

      {/*
       * 四段实拍片，铺满舞台按顺序硬切（见 departure.ts 的 DEPARTURE_CLIPS）。
       * 可见性由 WAAPI 驱动，播放位置由 rAF 从同一个动画时钟纠偏。
       * muted + playsInline 是自动播放的前提，preload=auto 避免切进去时黑一帧。
       *
       * src 走 departureClipSrc：HUD 露面时已把四段取进内存（见外层的 warmDepartureClips），
       * 这里拿到的是 blob: URL，每次「开始行程」/「重播」都不再发请求。
       * 预热还没完成（HUD 刚出来就点）时回退原 URL，行为与从前一样。
       *
       * 曾经这里有**五个** video——driveoff 写了两遍、同一个 ref。ref 只认最后那个，
       * 前一个永远 opacity:0 却照样把 430 KB 再拉一遍；走查网络面板数出 5 条 206 才看见。
       */}
      <video
        ref={refs.arriveClip}
        className="cabin-arrival__clip"
        src={departureClipSrc(departureArriveClip)}
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
      />
      <video
        ref={refs.wakeClip}
        className="cabin-arrival__clip"
        src={departureClipSrc(departureWakeClip)}
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
      />
      <video
        ref={refs.boardClip}
        className="cabin-arrival__clip"
        src={departureClipSrc(departureBoardClip)}
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
      />
      <video
        ref={refs.driveoffClip}
        className="cabin-arrival__clip"
        src={departureClipSrc(departureDriveoffClip)}
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
      />

      {/* 2600ms 硬切登场的暖暖：姿态与落点取自片子第 0 帧 */}
      <img
        ref={refs.introNuannuan}
        className="cabin-arrival__intro-nuannuan"
        src={CABIN_ARRIVAL_SPRITES.introPlate}
        alt=""
        aria-hidden="true"
      />


      {/* 唤醒光带：从她手边向外扫，两端渐隐、不落在任何一颗功能球上（见 departure.ts 的 wakeBand） */}
      <span ref={refs.wakeBand} className="cabin-arrival__wake-band" aria-hidden="true" />

      {/*
        出发卡是两端共用的组件（@carlife/ui departure/）。唤起高德在 Tauri 里经 opener 插件
        （能开哪些 URL 由 capabilities/default.json 钉死）；浏览器走查不注入，<a> 自己跳。
        `todayIso` 由这里给：卡片不读时钟（M64 红线在这一层同样成立）。
      */}
      {stage === "card" && (
        <DepartureCard
          plan={plan}
          navState={navState}
          onClose={onClose}
          openExternal={tauriOpener()}
          todayIso={new Date().toISOString().slice(0, 10)}
        />
      )}

      <div className="cabin-arrival__actions">
        <button type="button" className="cabin-arrival__replay" onClick={onReplay}>
          重播
        </button>
        <button type="button" className="cabin-arrival__close" onClick={onClose} aria-label="关闭出发流程">
          ×
        </button>
      </div>
    </section>
  );
}

/**
 * 挂钩上的车钥匙 —— 出发入口的卡通形态（M26 走查）。
 *
 * 上半是一截卡通车尾（尾窗 / 尾灯 / 车牌 / 排气），车牌就是按钮文案「开始行程」；
 * 钥匙经保险杠下的挂钩垂下来，钥匙圈以下整组轻摆——挂板本体不动，
 * 整块一起晃会看起来像挂板要从墙上掉下来。
 */
function CarKeyBoard() {
  return (
    <svg className="cabin-arrival-trigger__key" viewBox="0 0 150 172" aria-hidden="true" focusable="false">
      {/* 钥匙先画、车尾后画：挂钩要压在钥匙圈上才像「穿过圈」 */}
      <g className="cabin-arrival-trigger__swing">
        <circle className="cabin-key__ring" cx="75" cy="92" r="8.5" />
        <rect className="cabin-key__fob" x="59" y="101" width="32" height="44" rx="12" />
        <rect className="cabin-key__panel" x="66" y="107" width="18" height="11" rx="5" />
        <rect className="cabin-key__btn" x="66.5" y="124" width="17" height="5.5" rx="2.75" />
        <rect className="cabin-key__btn" x="66.5" y="131.5" width="17" height="5.5" rx="2.75" />
        {/* 钥匙齿只在一侧开齿：两侧对称会看起来像插销不像钥匙 */}
        <path className="cabin-key__blade" d="M69 145h12v8h-4v5h4v9H69z" />
      </g>

      {/* 车尾挂板：车顶弧线 → 尾窗 → 行李箱盖折线 → 两角尾灯 → 车牌 → 保险杠。
          尾灯必须在**左右两角**且压亮：没有它们这个轮廓会被读成一辆巴士。 */}
      <path
        className="cabin-car__body"
        d="M18 40C20 18 34 8 75 8s55 10 57 32l2 14c0 14-8 22-24 22H40c-16 0-24-8-24-22Z"
      />
      <path className="cabin-car__window" d="M44 14c8-3 54-3 62 0 5 2 8 8 8 14H36c0-6 3-12 8-14Z" />
      {/* 行李箱盖折线：一条弧线就够，让红色大块有"盖子"的结构感 */}
      <path className="cabin-car__crease" d="M30 36c14-4 76-4 90 0" />
      <rect className="cabin-car__lamp" x="20" y="42" width="26" height="11" rx="5.5" />
      <rect className="cabin-car__lamp" x="104" y="42" width="26" height="11" rx="5.5" />
      <rect className="cabin-car__plate" x="42" y="39" width="66" height="21" rx="5" />
      <text className="cabin-car__plate-text" x="75" y="55" textAnchor="middle">
        开始行程
      </text>
      <rect className="cabin-car__bumper" x="18" y="64" width="114" height="13" rx="6.5" />
      <circle className="cabin-car__pipe" cx="38" cy="70.5" r="3.6" />
      <circle className="cabin-car__pipe" cx="112" cy="70.5" r="3.6" />
      <path className="cabin-car__hook" d="M75 75v8" />
    </svg>
  );
}

/** HUD 上的出发入口；动效是本地展示，不发出车辆控制请求。 */
export function CabinArrivalDemo({ theme, plan, assistantState, soundOn }: CabinArrivalDemoProps) {
  const [open, setOpen] = useState(false);
  const [runId, setRunId] = useState(0);
  /**
   * 缓存的音景实例。`AudioContext` 是重对象，重播不该每次重建。
   *
   * **但它不是「这一轮要不要出声」的答案**——开关关掉之后这里仍然存着上一轮建的实例。
   * 这一轮用不用，由 `activeSound` 说了算（见它的说明）。
   */
  const soundRef = useRef<Soundscape | null>(null);
  /** `soundRef` 背后的上下文。复用前要看它的 `state`（见 `ensureSound`），`Soundscape` 不暴露它。 */
  const ctxRef = useRef<AudioContext | null>(null);
  /**
   * **这一轮**的音景。`null` = 这一轮不出声。
   *
   * 直接把 `soundRef.current` 传给 overlay 曾经是个 bug 且单测看不见：
   * 用户关掉开关后 `ensureSound()` 如实返回 null、点击那一下确实没响，
   * 而 overlay 拿到的是缓存里那个非 null 的实例，于是**动画里六个 cue 照样全响**。
   * 走查里逐拍验出来的（关掉开关后仍然 1buf/2osc/3osc/1osc+1buf/3osc）。
   */
  const [activeSound, setActiveSound] = useState<Soundscape | null>(null);
  /**
   * 车内音乐在不在放。
   *
   * **点击时问一次，不订阅、不轮询**：出发动画是 18.9 秒的一次性过程，中途音乐状态
   * 变了也不该改变已经在放的音景形态——半程换形态比全程用一种形态更怪。
   * 探测失败（浏览器走查、命令不存在）一律按 `false`：走查场景本来就没有音乐，
   * 按 true 处理会让走查时永远听不到完整音景，等于把这条链藏起来。
   */
  const musicAudibleRef = useRef(false);
  /*
   * 出发导航规划（M66-04）。请求在 `play()` 的同步栈里发出、与动画并行——等动画放完再发
   * 就是白白浪费 18.9 s。状态与墙钟都在 hook 里；本文件不读时钟。
   * 绑定车辆 vin 只用来取该车的常用人员，拿不到就按车主全部车辆（网关/runtime 兜底）。
   */
  const nav = useDepartureNav();
  const vinRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    void invoke<string>("bound_vin")
      .then((v) => {
        vinRef.current = v && v.trim() ? v.trim() : undefined;
      })
      .catch(() => {
        vinRef.current = undefined;
      });
  }, []);
  /*
   * 四段片子在 HUD 露面时就取进内存，之后每次「开始行程」/「重播」零请求。
   * 之前是 overlay mount 那一刻由 <video preload=auto> 自己去取：开发形态下
   * 每按一次钥匙就从 vite 拉一遍 1.4 MB（iPhone 上是走 Wi-Fi 拉 Mac），
   * 发布形态下也是每次重读一遍内嵌资源。永不 reject，所以不接错。
   */
  useEffect(() => {
    void warmDepartureClips();
  }, []);

  /**
   * 建（或复用）音景，并在**用户手势的同步调用栈里** resume。
   *
   * `AudioContext` 出生即 `suspended`，`resume()` 只有在手势栈里才被允许——
   * 等到 rAF 第一帧就晚了。这与旁边 `<video>` 的 `void v.play().catch(() => {})`
   * 是同一类平台闸门，处理方式也一样：**吞掉 rejection**，退化成"有画面没声音"，
   * 绝不让动画卡住。
   *
   * 关掉开关时直接返回 `null`：不建 ctx，而不是建了再静音（见 `soundOn` 的说明）。
   *
   * # 复用前必须看 `state`（iPad 真机 2026-09-02）
   *
   * 现象：装完第一次点有声；**用过一次长按说话或听过一次播报之后**，再点「开始行程」
   * 一声不响，动画照放。原因在 iOS：Rust 侧只要动过 `AVAudioSession`（PTT / 唤醒把类别
   * 切成 playAndRecord、rodio 放 TTS），WebKit 就把页面里的 AudioContext 置成
   * interrupted（`state` 不再是 `running`），**不会自己恢复**；而上一版这里只要
   * `soundRef.current` 在就直接复用，六个 cue 全排在一个不出声的上下文上，没有任何报错。
   *
   * 修法是**重建而不是 resume**：录音会话把采样率改成 48k 之后，旧上下文 `resume()`
   * 会兑现却照样无声（WebKit 的老毛病），重建一个才干净。重建只发生在"不在 running"
   * 那一次，正常重播仍然复用。旧的必须 `close()`——iOS 对同时存在的 AudioContext 有个
   * 位数的上限，不关的话换几次之后 `new AudioContext()` 直接抛。
   * 与首建一样，这一步也必须在点击的同步栈里，所以它住在 `ensureSound` 而不是 effect。
   */
  const ensureSound = (): Soundscape | null => {
    // 缺省读用户设置；显式传 false 用于强制关闭（测试与将来的场景开关）。
    if (!(soundOn ?? readSoundscapePref())) return null;
    if (soundRef.current && ctxRef.current?.state === "running") return soundRef.current;
    // 有旧的但不在 running（interrupted / suspended / closed）：关掉，下面重建。
    if (ctxRef.current) {
      void ctxRef.current.close?.().catch(() => {});
      ctxRef.current = null;
      soundRef.current = null;
    }
    try {
      const Ctor = typeof AudioContext === "function" ? AudioContext : null;
      if (!Ctor) return null;
      const ctx = new Ctor();
      void ctx.resume?.().catch(() => {});
      ctxRef.current = ctx;
      soundRef.current = new Soundscape(ctx);
    } catch {
      // WebAudio 建不起来就是不出声，不是故障——动画照常。
      ctxRef.current = null;
      soundRef.current = null;
    }
    return soundRef.current;
  };

  const play = () => {
    const sound = ensureSound();
    setActiveSound(sound);
    /*
     * 钥匙串轻响不在 cue 表里：它响在点击这一刻，那时动画还没开始。
     * 它同样要过闸——暖暖正在说话时按下钥匙，也不该有声音。
     * 音乐那一格用**上一次探测的结果**：这一次的探测才刚发出去，
     * 而 `jingle` 在降级形态里本来就保留，两种取值下它都会响。
     */
    const policy = decidePolicy({
      enabled: sound !== null,
      assistantState,
      musicAudible: musicAudibleRef.current,
    });
    for (const c of cuesForPolicy(policy, ["jingle"])) sound?.fire(c);
    /*
     * 探测是一次 IPC，几毫秒；第一帧 rAF 在 16ms 之后，通常已经回来了。
     * 但**不保证**——所以结果写进 ref 由 `tick` 每帧读，而不是让动画等它。
     * 万一晚到且答案是"音乐在放"，那一帧的形态会从 full 落到 minimal，
     * 上面 `tick` 里的 `prevPolicy` 判定会把已经起来的铺底收掉。
     */
    void invoke<boolean>("music_is_audible")
      .then((v) => {
        musicAudibleRef.current = v;
      })
      .catch(() => {
        musicAudibleRef.current = false;
      });
    // 规划请求与动画同一个手势发出（M66-04）：起点由定位端口给，网关补常住地。
    nav.start(async () => {
      const origin = await currentOriginForNav(getLocationPort());
      return requestNavPlan({ ...(origin ? { origin } : {}), ...(vinRef.current ? { vin: vinRef.current } : {}) });
    });
    setRunId((id) => id + 1);
    setOpen(true);
  };

  return (
    <>
      <button
        type="button"
        className="cabin-arrival-trigger"
        onClick={play}
        aria-label="开始行程"
      >
        <CarKeyBoard />
      </button>
      {open ? (
        <CabinArrivalOverlay
          key={runId}
          theme={theme}
          plan={plan}
          runId={runId}
          sound={activeSound}
          assistantState={assistantState}
          musicAudibleRef={musicAudibleRef}
          navState={nav.state}
          onCardVisible={nav.markVisible}
          onReplay={play}
          onClose={() => {
            nav.reset();
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
