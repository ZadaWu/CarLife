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
 *
 * # 连不上服务时，状态落在**每一格自己**身上，不挂一枚全局徽标
 *
 * 原来的做法是右端浮一句「数据更新中」+ 把所有数值压到 0.7 透明度（2026-09-11 前）。
 * 用户走查：mock 服务没连上时那句话是错的——它不是"正在更新"，是**根本没连上**；
 * 而各格照旧显示「暂无」，于是"这项没有数据"与"整条链路断了"长得一模一样。
 *
 * 现在：连不上时每一格在**值的位置**写「服务暂不可用」。三条理由——
 *  1. 它说的就是这一格现在为什么没数，不用去右端找一枚小字徽标；
 *  2. 「暂无」（服务在，这项没数据）与「服务暂不可用」（服务不在）从此分得开；
 *  3. 徽标浮在右端会与「开始行程」抢位，而那枚按钮是这条上唯一的主行动。
 *
 * ⚠️ 代价是**上一次的有效值不再留在屏幕上**（原来是留着 + 压暗）。这是用户定的取舍：
 * 一个不知多久以前的数字带着"当前值"的长相，比明说连不上更糟。
 *
 * 「我的座驾」那一格不吃这个开关：它的读数走车辆信号那一路（`summary.live`），
 * 自己就有「读不到」态与原因。两路各报各的，才叫"各自对应的状态"。
 */
import type { EnergySummary, TripLeg } from "@carlife/shared";

/*
 * 文案与格式化住在没有素材依赖的 `metric-text.ts`（那边的文件头写着为什么）。
 * 这里原样再导出一次，既有的 `import { durationLabel } from "@carlife/ui"` 不用改。
 */
import { METRIC_EMPTY, METRIC_UNAVAILABLE, durationLabel } from "./metric-text";

export { METRIC_EMPTY, METRIC_UNAVAILABLE, durationLabel };

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
  /**
   * 拉不到数据（`freshness.stale`：上一跳没连上网关 / 服务没起）。
   * 为 true 时四格指标的值位改写「服务暂不可用」，**不再浮一句「数据更新中」**（见文件头）。
   */
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

export function StatusBar({ summary, leg, stale, vehicle, onStart, startDisabled }: StatusBarProps) {
  const road = leg?.road;
  /* 连不上时四格一律走这一态；连得上才谈"这一格有没有数据"。 */
  const down = stale === true;
  return (
    <section className={`hud-statusbar${stale ? " is-stale" : ""}`} aria-label="出行状态栏" aria-readonly="true">
      <Vehicle summary={summary} vehicle={vehicle} />

      <span className="hud-statusbar__sep" aria-hidden="true" />

      <Metric
        icon={iconDistance}
        caption="预计里程"
        down={down}
        value={leg ? String(leg.distanceKm) : undefined}
        unit="km"
      />

      <span className="hud-statusbar__sep" aria-hidden="true" />

      <Metric
        icon={iconDuration}
        caption="预计用时"
        down={down}
        value={leg ? durationLabel(leg.durationMin) : undefined}
      />

      <span className="hud-statusbar__sep" aria-hidden="true" />

      <Metric
        icon={iconEnergy}
        caption="预计电量消耗"
        down={down}
        value={String(summary.requiredPercent)}
        unit="%"
      />

      <span className="hud-statusbar__sep" aria-hidden="true" />

      <Metric
        icon={iconRoad}
        caption="道路情况"
        down={down}
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

function Metric({
  icon,
  caption,
  value,
  unit,
  down,
}: {
  /** 定稿切出的图标（PNG 地址）。 */
  icon: string;
  caption: string;
  /** `undefined` = 这项现在没有数据，格位照留、值写「暂无」（见文件头）。 */
  value?: React.ReactNode;
  unit?: string;
  /** 连不上服务：值位改写「服务暂不可用」，**压过 `value`**——那时手上的值已经不知是多久以前的。 */
  down?: boolean;
}) {
  const empty = !down && value === undefined;
  return (
    <div className={`hud-statusbar__metric${empty ? " is-empty" : ""}${down ? " is-down" : ""}`}>
      {/* 图标一并压暗：只把数字变灰、图标照旧鲜亮，那一格看起来像"没加载出来"而不是"没有". */}
      <span className="hud-statusbar__glyph" aria-hidden="true">
        <img src={icon} alt="" draggable={false} />
      </span>
      <span className="hud-statusbar__text">
        <span className="hud-statusbar__caption">{caption}</span>
        {down ? (
          /*
           * `--down` 只改这一句话的字号（它有六个字，按 30 基准 px 排会顶到隔壁格），
           * **不碰 `.hud-statusbar__value` 本身**——正常数值的字号是定稿定的，不能被一个错误态带走。
           */
          <span className="hud-statusbar__value hud-statusbar__value--none hud-statusbar__value--down">
            {METRIC_UNAVAILABLE}
          </span>
        ) : empty ? (
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

