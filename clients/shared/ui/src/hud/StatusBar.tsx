/**
 * 出行状态栏（新版 UI，定稿 `内部文档` 底部那一条）。
 *
 * 一条横贯屏底的白色圆角条：我的座驾（车图 + 续航条）· 预计里程 · 预计用时 · 预计电量消耗 ·
 * 道路情况 · 右端一枚大号「开始行程」。它接替了原来右下角的能量胶囊（`EnergyCapsule`）——
 * 那三个数（预计里程 / 剩余能量 / 预计需电量）原样搬进这里，只是摊开成一条。
 * `EnergyCapsule` 组件**没有删**：手机端仍在用。
 *
 * # 没有的数据占位说「暂无」，绝不摆一个编的数
 *
 * 定稿里画了「预计用时 4 h 30 min」「道路情况 城市道路 畅通」。快照契约里**没有**这两样：
 * 用时只在真实导航规划（`nav-plan`）回来时才有，路况现在哪儿都没有。
 *
 * 处理是**格位照留、值写「暂无」**（灰、比数字小一号）：这一条是常驻可见的仪表，
 * 各格随数据有无忽隐忽现会让人以为界面坏了，而定稿的版式本身就是五格。
 * 「暂无」与摆一个常数算出来的 "4 h 30 min" 是两回事——前者如实说没有，
 * 后者看起来和真的一模一样（与跟车顶栏 `NavBar`「没有 ETA 就不显示时间」同一条纪律：
 * 那里是**整块不显示**，这里因为要守版式改成显式的空态，两者都没有编数）。
 *
 * 剩余能量三支照 `EnergyCapsule` 的分法：电车 / 油车 / 读不到，各画各的，读不到就写「读不到」。
 * Brief §4：这条上不得出现 VIN、维修档案或任何车辆控制入口。
 */
import type { EnergySummary, TripLeg } from "@carlife/shared";

/*
 * 素材全部从设计定稿切出（`scripts/assets/extract-statusbar-assets.py`，源图是
 * 内部文档 的参考图，与 内部文档 两张定稿的底栏同源）：
 * 图标、电池形状、带高光倒角的「开始行程」按钮都不用 CSS/SVG 仿——仿出来总差一口气。
 * 按钮的文字是烧在图里的，所以它的可读名字在 aria-label 上。
 */
import carArt from "../assets-hud/statusbar/car.png";
import batteryShape from "../assets-hud/statusbar/battery.png";
import iconDistance from "../assets-hud/statusbar/icon-distance.png";
import iconDuration from "../assets-hud/statusbar/icon-duration.png";
import iconEnergy from "../assets-hud/statusbar/icon-energy.png";
import iconRoad from "../assets-hud/statusbar/icon-road.png";
import startButton from "../assets-hud/statusbar/start-button.png";

export interface StatusBarProps {
  summary: EnergySummary;
  /** 数据是否正在更新（弱网降级：保留最近有效值 + 标记，不空白）。 */
  stale?: boolean;
  /** 我的座驾：车型名与形象图。形象缺省时用定稿切出的白色 SUV 当版式占位（车型名那时不写）。 */
  vehicle?: { model?: string; art?: string };
  /**
   * 出发地 → 今天第一站的驾车规划（2026-09-11）：预计里程 / 预计用时 / 道路情况**三格只认它**。
   * 缺省时三格都显示「暂无」——`summary.distanceKm` 不再顶上去，那个数在真机上是 mock 快照里的常数。
   * `road.status` 是「拥堵」时那一格走红：红色纪律里它是被点名允许的两个判定之一。
   */
  leg?: TripLeg;
  /** 「开始行程」。不给就不渲染那枚按钮——组件不造一个点了没反应的按钮。 */
  onStart?: () => void;
  /** 「开始行程」是否可点（比如没有已确认的行程时仍渲染但置灰，文案由调用方定）。 */
  startDisabled?: boolean;
}

/** 低电/低油的告警阈值，与 `EnergyCapsule` 同值。 */
const LOW_PERCENT = 20;

/** 「4 h 30 min」/「45 min」。 */
export function durationLabel(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} min`;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}

export function StatusBar({ summary, leg, stale, vehicle, onStart, startDisabled }: StatusBarProps) {
  const road = leg?.road;
  return (
    <section className={`hud-statusbar${stale ? " is-stale" : ""}`} aria-label="出行状态栏" aria-readonly="true">
      <Vehicle summary={summary} vehicle={vehicle} />

      <span className="hud-statusbar__sep" aria-hidden="true" />

      <Metric icon={iconDistance} caption="预计里程" value={leg ? String(leg.distanceKm) : undefined} unit="km" />

      <span className="hud-statusbar__sep" aria-hidden="true" />

      <Metric
        icon={iconDuration}
        caption="预计用时"
        value={leg ? durationLabel(leg.durationMin) : undefined}
      />

      <span className="hud-statusbar__sep" aria-hidden="true" />

      <Metric icon={iconEnergy} caption="预计电量消耗" value={String(summary.requiredPercent)} unit="%" />

      <span className="hud-statusbar__sep" aria-hidden="true" />

      <Metric
        icon={iconRoad}
        caption="道路情况"
        value={
          road ? (
            <>
              {road.label}{" "}
              <span className={road.status === "拥堵" ? "hud-statusbar__jam" : road.status === "缓行" ? "hud-statusbar__slow" : "hud-statusbar__ok"}>
                {road.status}
              </span>
            </>
          ) : undefined
        }
      />

      {stale && <span className="hud-statusbar__stale">数据更新中</span>}

      {onStart && (
        <button
          type="button"
          className="hud-statusbar__start"
          onClick={onStart}
          disabled={startDisabled}
          aria-label="开始行程"
        >
          {/* 定稿切出的整枚按钮（含纸飞机与文字），文字在 aria-label 里。 */}
          <img src={startButton} alt="" aria-hidden="true" draggable={false} />
        </button>
      )}
    </section>
  );
}

/** 没有数据时那一格的值。**不是省略号也不是「--」**：那两个符号读者得自己猜是什么意思。 */
export const METRIC_EMPTY = "暂无";

function Metric({
  icon,
  caption,
  value,
  unit,
}: {
  /** 定稿切出的图标（PNG 地址）。 */
  icon: string;
  caption: string;
  /** `undefined` = 这项现在没有数据，格位照留、值写「暂无」（见文件头）。 */
  value?: React.ReactNode;
  unit?: string;
}) {
  const empty = value === undefined;
  return (
    <div className={`hud-statusbar__metric${empty ? " is-empty" : ""}`}>
      {/* 图标一并压暗：只把数字变灰、图标照旧鲜亮，那一格看起来像"没加载出来"而不是"没有". */}
      <span className="hud-statusbar__glyph" aria-hidden="true">
        <img src={icon} alt="" draggable={false} />
      </span>
      <span className="hud-statusbar__text">
        <span className="hud-statusbar__caption">{caption}</span>
        {empty ? (
          <span className="hud-statusbar__value hud-statusbar__value--none">{METRIC_EMPTY}</span>
        ) : (
          <span className="hud-statusbar__value">
            {value}
            {unit && <span className="hud-statusbar__unit"> {unit}</span>}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * 我的座驾：车图 + 能量条 + 续航。
 *
 * 三支各画各的（同 `EnergyCapsule.LiveMetric`）：电车报续航公里，油车报续航公里但图标换油枪，
 * 读不到就写「读不到」且不画条——写 0% 会被当成"快没电了"。
 * 没有实时读数（`live` 缺省）时退回快照里的 `batteryPercent`，只报百分比不报公里——
 * 公里数只有实时读数才有，不从百分比乘一个常数算出来。
 */
function Vehicle({ summary, vehicle }: { summary: EnergySummary; vehicle?: StatusBarProps["vehicle"] }) {
  const live = summary.live;
  const unavailable = live?.kind === "unavailable";
  const fuel = live?.kind === "fuel";
  const percent = live && live.kind !== "unavailable" ? live.percent : summary.batteryPercent;
  const low = !unavailable && percent <= LOW_PERCENT;
  const charging = live?.kind === "battery" && live.charging;
  const rangeKm = live && live.kind !== "unavailable" ? live.rangeKm : undefined;

  return (
    <div className="hud-statusbar__vehicle" title={unavailable ? live.reason : undefined}>
      {/*
        车图：有档案形象用档案形象（那是车主自己的车）；没有时用定稿里那辆白色 SUV 当占位。
        ⚠️ 它只是版式占位，不是"认出了这辆车"——所以旁边的车型名只在真有档案时才写。
      */}
      <img
        className={`hud-statusbar__car${vehicle?.art ? "" : " hud-statusbar__car--placeholder"}`}
        src={vehicle?.art ?? carArt}
        alt=""
        aria-hidden="true"
        draggable={false}
      />
      <span className="hud-statusbar__text">
        <span className="hud-statusbar__caption hud-statusbar__caption--strong">
          我的座驾{vehicle?.model ? ` · ${vehicle.model}` : ""}
        </span>
        {unavailable ? (
          <span className="hud-statusbar__value hud-statusbar__value--none">读不到</span>
        ) : (
          <span className="hud-statusbar__range">
            {/* 电池：定稿切出的形状做遮罩，按电量从左往右填色——满电时与定稿逐像素一样。 */}
            <span
              className={`hud-statusbar__gauge${low ? " is-low" : ""}${fuel ? " is-fuel" : ""}`}
              role="img"
              aria-label={`${fuel ? "剩余油量" : "剩余电量"} ${Math.round(percent)}%`}
              style={{
                WebkitMaskImage: `url(${batteryShape})`,
                maskImage: `url(${batteryShape})`,
                ["--gauge-pct" as string]: `${Math.max(6, Math.min(100, percent))}%`,
              }}
            >
              {charging && <span className="hud-statusbar__gauge-charging">⚡</span>}
            </span>
            <span className="hud-statusbar__value">
              {rangeKm !== undefined ? (
                <>
                  续航 {rangeKm}
                  <span className="hud-statusbar__unit"> km</span>
                </>
              ) : (
                <>
                  {fuel ? "剩余油量" : "剩余电量"} {Math.round(percent)}
                  <span className="hud-statusbar__unit"> %</span>
                </>
              )}
            </span>
          </span>
        )}
      </span>
    </div>
  );
}

