/**
 * 真实地图行程模式与跟车模式的入参（M13-06 / M31-03；M65-01 上提到 `clients/shared/ui`，两端共用）。
 * 两端的 HUD 屏幕组件各自接收这一份，不各写一份——各写的表现是手机端永远少一个字段。
 */
import type { NavTripProgress, TripMapStop } from "../map";

/** 真实地图行程模式（M13-06）：有它就用真实标注替换装饰生活环。 */
export interface HudTripMapProps {
  stops: TripMapStop[];
  /** 全程总览带天徽标，单日不带。 */
  showDayBadge: boolean;
  /** 单日视图闭环：酒店出发 → 景点 → 回酒店（放行李/寄存的场景语义）。 */
  closeLoop: boolean;
  /** 行程身份：换行程时收回镜头否决权（AmapTripLayer.planKey，M27-04）。 */
  planKey?: string;
  /** 顶部切换：全程 / 第X天（单日行程只有全程，一个 tab 就不渲染条）。 */
  tabs: Array<{ label: string; value: "all" | number }>;
  active: "all" | number;
  onSelect: (v: "all" | number) => void;
  /** 真实地图起不来（无 key/离线）时回落装饰概览。 */
  onFallback?: (reason: string) => void;
  /** 点击景点标记 → 景区导览页（M36-03）。只对 kind=spot 触发（AmapTripLayer 保证）。 */
  onStopClick?: (stop: TripMapStop) => void;
  /**
   * 导览已就绪的景点名（`/v1/guide/jobs` 里 state=ready 的行，见 readyGuideSpots）。
   * 命中的景点胶囊挂「✓ 导览」角标——主页上一眼看出哪些点开有导览可看。
   * 缺省/空 = 一个都不标。
   */
  guidedSpots?: string[];
  /** 跟车模式（M31-03）。缺省 = 只看行程，不跟车。 */
  nav?: HudNavProps;
  /**
   * 住宿策略说明（M34-02，来自快照的 day.lodging）：换酒店日/到达日各一条。
   * 缺省/空数组 = 不渲染——旧行程与连住行程没有这条横幅。
   */
  lodgingNotes?: Array<{ day: number; strategy: "checkin-midday" | "checkin-evening"; note?: string }>;
}

/** 策略的人话标签（M34-02）。note 是模型写的自由文本，标签是结构化字段的固定翻译。 */
export const LODGING_LABEL: Record<"checkin-midday" | "checkin-evening", string> = {
  "checkin-midday": "中午入住",
  "checkin-evening": "傍晚入住",
};

/** 跟车模式（M31-03）：顶栏 + 车标 + 镜头跟随的全部入参。 */
export interface HudNavProps {
  /** 这次导航的身份；变化 = 重新起跑（AmapTripLayer.navKey）。 */
  key: string;
  /**
   * 演示倍速。**大于 1 时顶栏恒显「演示车速 ×N」**——车并没有真的在那个位置，
   * 不标出来就是让人以为它是真的（与坐标「不标不猜」同一条红线）。
   */
  speedup: number;
  /** 进度上抛：到站播报这类要出声的事由外层做，本组件只管显示。 */
  onProgress?: (p: NavTripProgress) => void;
  /** 顶栏「结束导航」。 */
  onEnd?: () => void;
}

