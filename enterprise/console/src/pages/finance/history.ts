/**
 * 余额曲线的几何计算，与渲染分开——理由同 model.ts：**为了能被断言**。
 *
 * 一条画错的曲线不会报错，它只会安安静静地讲一个不同的故事。这一页最怕的
 * 三件事都发生在这个文件里：
 *   ① **缺口被连成直线**。网关停了一天，两端一连，看起来像"这一天在缓慢消耗"，
 *      而真相是"这一天我们什么都不知道"。缺口必须断开。
 *   ② **纵轴的放大倍数没被说出来**。曲线是自适应缩放的（不从 0 起），
 *      余额从 50.06 掉到 50.02 也能画成一道陡坡。所以极值必须显示在旁边，
 *      让人一眼知道这道坡对应多少钱。
 *   ③ **一个点也当曲线画**。只有一个采样点时连不成线，画出来的是一条
 *      横平的假象——"余额没变"，而事实是"只测过一次"。
 *   ④ **横轴动态缩放却不说自己有多长**。窗口按实际数据从 1 小时伸缩到 7 天，
 *      两条外形一模一样的曲线可能一条讲的是一小时、另一条讲的是一星期。
 *      所以有刻度这件事不是装饰，是这个缩放能成立的前提。
 */

/** 服务端给的一个采样点。`t` 是整点桶起点的 epoch ms。 */
export interface HistoryPoint {
  t: number;
  v: number;
}

export interface HistorySeries {
  currency: string;
  points: HistoryPoint[];
}

export interface FinanceHistory {
  retentionDays: number;
  /**
   * 采样间隔（服务端给，默认 10 分钟）。缺口判据、空态文案、气泡里的时间格式
   * 全部由它推出来。**在这边写死一份就是等着两边不一致**——服务端把周期从
   * 10 分钟调成 30 分钟，页面会继续说"每 10 分钟采样一次"，还会把正常的
   * 采样间隔当成缺口画断。
   */
  stepMs: number;
  /** 服务端保留窗口的左端（now - 7 天）。页面的窗口不会伸到它左边去。 */
  from: number;
  /** 服务端的"现在"。窗口的右端永远是它——曲线讲的永远是"到此刻为止"。 */
  to: number;
  series: Record<string, HistorySeries>;
  note: string;
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
/** 横轴最短 1 小时：10 分钟一采时正好 6 格，再窄刻度就密得没法看了。 */
export const MIN_SPAN_MS = HOUR_MS;
/** 横轴最长 7 天：与服务端的保留窗口一致，再长也没有数据。 */
export const MAX_SPAN_MS = 7 * DAY_MS;

export interface TimeWindow {
  from: number;
  to: number;
  span: number;
}

/**
 * 横轴窗口：**按实际有多少数据伸缩**，夹在 [1 小时, 7 天]。
 *
 * 为什么要动态：固定 7 天的话，冷启动那半小时的数据全挤在最右边 0.3% 的宽度里，
 * 看起来就是"没有曲线"。
 *
 * 为什么**所有卡片共用一个窗口**，而不是各缩各的：
 * 各缩各的之后，两张并排的卡片上同一个横坐标不再是同一个时刻，"这两家是不是
 * 同时开始掉的"这种最常问的问题就再也没法用眼睛回答——而且它不会报错，
 * 只是安静地误导。冷启动时几家的数据量本来就一样（同一个定时器采的），
 * 共用窗口一样能解决挤在右边的问题。
 *
 * 一个点都没有时给 `null`：那种情况根本没有曲线可画，也就不该有横轴。
 *
 * `extraEarliest` 是同一张卡上**其它图**的最早时刻（吞吐柱状图的第一个桶）：
 * 它们与余额曲线共用横轴，窗口就得把它们也装进去——否则吞吐图比余额历史早开始
 * 记的那几天会被裁掉，而且不报错。
 */
export function windowFor(
  history: Pick<FinanceHistory, "from" | "to" | "series">,
  extraEarliest: number[] = [],
): TimeWindow | null {
  let earliest = Number.POSITIVE_INFINITY;
  for (const series of Object.values(history.series)) {
    for (const p of series.points) {
      if (Number.isFinite(p.v) && p.t < earliest) earliest = p.t;
    }
  }
  for (const t of extraEarliest) {
    if (Number.isFinite(t) && t < earliest) earliest = t;
  }
  if (!Number.isFinite(earliest)) return null;

  const to = history.to;
  const span = Math.min(Math.max(to - earliest, MIN_SPAN_MS), MAX_SPAN_MS);
  // 不越过服务端保留窗口的左端——那边没有数据，画出来是一段永远空着的轴。
  const from = Math.max(to - span, history.from);
  return { from, to, span: to - from };
}

/**
 * 刻度间隔。从下面这把梯子里挑**第一个能让格数 ≤ 6 的**。
 *
 * 6 格 = 最多 7 个标签。刻度文字是 `HH:MM` / `MM-DD`，都是 5 个字符（约 30px），
 * 卡片最窄 300px 时曲线宽约 270px，7 个标签正好排得开，再多就开始叠字。
 * 注意是**格数**不是标签数：n 格有 n+1 个边界，判据写成 ≤7 格就会漏出 8 个标签。
 * 1 小时窗口正好落在 10 分钟这一档（6 格 / 6~7 个标签），与"最短 1 小时"那条约束配套。
 */
const TICK_LADDER = [
  10 * 60_000,
  // 15 分钟这一档是补窟窿的：刚跑过一小时（比如 76 分钟）时，10 分钟给 7.6 格太密、
  // 30 分钟只剩 2 格太疏，横轴一下子从"读得出分钟"退化成"三个标签"。
  15 * 60_000,
  30 * 60_000,
  HOUR_MS,
  2 * HOUR_MS,
  3 * HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  DAY_MS,
  2 * DAY_MS,
  7 * DAY_MS,
];

export function tickStep(span: number): number {
  return TICK_LADDER.find((s) => span / s <= 6) ?? TICK_LADDER[TICK_LADDER.length - 1];
}

export interface AxisTick {
  t: number;
  /** 与 dots 同坐标系（0~width） */
  x: number;
  label: string;
  /** 文字贴边会被卡片裁掉，两端的标签改成左/右对齐 */
  anchor: "start" | "middle" | "end";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 刻度。落在**本地时间**的整点上，不是 epoch 的整点。
 *
 * 差别在 UTC+5:30 这类半小时时区：按 epoch 对齐的话"每小时"刻度会全部落在 :30，
 * 看着就不像刻度。DST 切换那天会有一格宽窄不均，这个代价接受——
 * 补偿它要引入一整套日历运算，而这是一张 270px 宽的缩略图。
 */
export function axisTicks(win: TimeWindow, width = 100): AxisTick[] {
  const step = tickStep(win.span);
  const offsetOf = (t: number): number => -new Date(t).getTimezoneOffset() * 60_000;

  const ticks: AxisTick[] = [];
  const off = offsetOf(win.from);
  let t = Math.ceil((win.from + off) / step) * step - off;
  // 上限是安全网：step 万一算成 0 或负数，这里也不会转成死循环
  for (let guard = 0; t <= win.to && guard < 32; guard += 1, t += step) {
    const d = new Date(t);
    // 日期只在**它变化的那一刻**（本地零点）出现，其余写时刻——
    // 每个刻度都带日期会叠字，一个都不带则跨天的窗口分不清哪个 14:00。
    const midnight = d.getHours() === 0 && d.getMinutes() === 0;
    const label =
      midnight || step >= DAY_MS
        ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
        : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const x = ((t - win.from) / (win.span || 1)) * width;
    ticks.push({
      t,
      x: Math.round(x * 100) / 100,
      label,
      anchor: x < width * 0.08 ? "start" : x > width * 0.92 ? "end" : "middle",
    });
  }
  return ticks;
}

/** 横轴跨度的人话说法，给角标用（"近 7 天"）。 */
export function spanLabel(span: number): string {
  const hours = span / HOUR_MS;
  if (hours < 48) return `近 ${Math.max(1, Math.round(hours))} 小时`;
  return `近 ${Math.round(span / DAY_MS)} 天`;
}

export interface SparkDot {
  /** 视口坐标，viewBox 为 `0 0 width height` */
  x: number;
  y: number;
  t: number;
  v: number;
}

export interface Sparkline {
  /** 折线，一段一条——中间断开的地方就是没有采样的小时 */
  segments: string[];
  /** 与 segments 一一对应的填充区域 */
  areas: string[];
  dots: SparkDot[];
  /**
   * 两侧都断开、连不进任何线段的孤点。
   *
   * 它们必须被画出来（画成点），不能因为"连不成线"就丢掉：采样周期细到 10 分钟
   * 之后，一台开开停停的网关很容易产出一串彼此不相邻的点——丢掉的话图上一片空白，
   * 而角标却说着"5 个采样点"，等于告诉人"有数据但我不给你看"。
   */
  orphans: SparkDot[];
  /** 纵轴实际映射的域（极值相等时人为撑开，见下） */
  lo: number;
  hi: number;
  min: number;
  max: number;
  first: number;
  last: number;
  /** last - first。注意它是**窗口内**的变化，不是"充值了多少" */
  delta: number;
  /**
   * 时间上不连续的处数。
   *
   * 数的是**相邻两点之间的断裂**，不是"线段数减一"。后者在所有点都彼此孤立时
   * 会算出 0（一段都连不成），把"全是窟窿"报成"一个窟窿都没有"——这一页最不该
   * 犯的那种错：不报错，只是安静地说反话。
   */
  gaps: number;
  width: number;
  height: number;
}

export interface SparkOptions {
  from: number;
  to: number;
  stepMs: number;
  width?: number;
  height?: number;
  /** 上下留白，给线宽和端点圆点用 */
  pad?: number;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 把采样点摆成一条可画的折线。
 *
 * 横轴用 `windowFor()` 算出的**全页共用**窗口（按实际数据在 1 小时~7 天之间伸缩），
 * **不按各账户自己的首末点缩放**——每张卡片各缩各的话，两条曲线上同一个横坐标
 * 不是同一个时刻，卡片之间就没法对着看了。
 *
 * 纵轴反过来，按本账户的极值自适应：从 0 起的话，余额 50 掉到 45 在 32px 高的
 * 图里只有 3 个像素，等于什么都没画。代价是放大倍数不定——所以调用方必须把
 * `min`/`max` 显示出来（见文件头 ②）。
 *
 * 返回 `null` = 一个点都没有，调用方该说"还没有历史"而不是画一张空图。
 */
export function buildSparkline(points: HistoryPoint[], opts: SparkOptions): Sparkline | null {
  const width = opts.width ?? 100;
  const height = opts.height ?? 32;
  const pad = opts.pad ?? 3;

  const inWindow = points
    .filter((p) => Number.isFinite(p.v) && p.t >= opts.from && p.t <= opts.to)
    .sort((a, b) => a.t - b.t);
  if (inWindow.length === 0) return null;

  const values = inWindow.map((p) => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);

  // 余额一直没变（很常见：没跑任何请求的一夜）。此时上下人为撑开，
  // 线落在正中间——把它压在图的顶端或底端会被读成"贴着上限/见底了"。
  let lo = min;
  let hi = max;
  if (hi - lo < 1e-9) {
    const spread = Math.max(Math.abs(hi) * 0.05, 1);
    lo = hi - spread;
    hi = hi + spread;
  }

  const span = opts.to - opts.from || 1;
  const inner = height - pad * 2;
  const dots: SparkDot[] = inWindow.map((p) => ({
    x: round(((p.t - opts.from) / span) * width),
    y: round(pad + (1 - (p.v - lo) / (hi - lo)) * inner),
    t: p.t,
    v: p.v,
  }));

  /*
   * 缺口判据：相邻两点间隔超过 2.5 个采样周期就断开。
   * 为什么不是"只要缺一个桶就断"——定时器偶尔会被慢上游挤过一个桶边界，
   * 于是 dt 变成 2 个周期；那不是停机，为它把曲线切碎反而掩盖了真正的停机。
   * 2.5 个周期以上（连缺两个桶）才是真的没在跑。
   */
  const gapMs = opts.stepMs * 2.5;
  const segments: string[] = [];
  const areas: string[] = [];
  const orphans: SparkDot[] = [];
  let gaps = 0;
  let run: SparkDot[] = [dots[0]];

  const flush = (): void => {
    // 一个点连不成线，但它是真采到的数——留成孤点，由渲染层画个点出来。
    if (run.length < 2) {
      if (run.length === 1) orphans.push(run[0]);
      run = [];
      return;
    }
    const d = run.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
    segments.push(d);
    areas.push(`${d} L${run[run.length - 1].x} ${height} L${run[0].x} ${height} Z`);
    run = [];
  };

  for (let i = 1; i < dots.length; i += 1) {
    if (dots[i].t - dots[i - 1].t > gapMs) {
      gaps += 1;
      flush();
      run = [dots[i]];
    } else {
      run.push(dots[i]);
    }
  }
  flush();

  return {
    segments,
    areas,
    dots,
    orphans,
    lo,
    hi,
    min,
    max,
    first: values[0],
    last: values[values.length - 1],
    delta: values[values.length - 1] - values[0],
    gaps,
    width,
    height,
  };
}

/** 悬浮时离光标最近的那个采样点。`x` 与 dots 同坐标系。 */
export function nearestDot(dots: SparkDot[], x: number): SparkDot | null {
  if (dots.length === 0) return null;
  let best = dots[0];
  let bestD = Math.abs(dots[0].x - x);
  for (const d of dots) {
    const dist = Math.abs(d.x - x);
    if (dist < bestD) {
      best = d;
      bestD = dist;
    }
  }
  return best;
}

/**
 * 悬浮气泡里的时间。
 *
 * **带日期**——七天的图上只写"14:20"，看的人根本不知道是哪天。
 * **分钟位如实取自采样点**，不能像早先那样写死 `:00`：采样周期一旦细于一小时，
 * 写死的分钟会让同一小时里的六个点显示成同一个时刻，而它们的余额各不相同。
 */
export function pointTimeLabel(t: number): string {
  const d = new Date(t);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/**
 * 采样周期的人话说法，给空态文案用（"每 10 分钟采样一次"）。
 * 由 `stepMs` 推出来而不是写死，理由见 `FinanceHistory.stepMs` 上的注释。
 */
export function intervalLabel(stepMs: number): string {
  const min = Math.round(stepMs / 60_000);
  if (min < 60) return `${min} 分钟`;
  const h = min / 60;
  return Number.isInteger(h) ? `${h} 小时` : `${min} 分钟`;
}

/**
 * 窗口内的净变化。
 *
 * 用"净变"这个词是有讲究的：中间充过值又花掉的话，它跟"花了多少"完全是两回事。
 * 早先写的是"较首个采样点 −10.99"，语义更足但太长——横轴加了刻度行之后，
 * 带缺口角标的那张卡会把角标挤到第二行，卡片比邻居高出一截。
 * 完整口径挪进 `deltaTitle()` 的悬浮说明，不丢。
 */
export function deltaLabel(spark: Sparkline): string {
  const d = spark.delta;
  if (Math.abs(d) < 0.005) return "净变持平";
  return `净变 ${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(2)}`;
}

/** 净变的完整口径。别省——"净变"两个字挡不住有人把它读成消耗额。 */
export const deltaTitle =
  "窗口内第一个采样点到最新采样点的净变化。中间充过值又花掉的话，它与「这段时间花了多少」不是一回事。";

/**
 * 给屏幕阅读器的一句话。悬浮气泡它读不到，所以这里得把要点说全。
 * **跨度必须念出来**：横轴是伸缩的，不说的话"一条向下的曲线"可能是一小时也可能是一星期。
 */
export function sparkAriaLabel(spark: Sparkline, currency: string, span: number): string {
  const parts = [
    `${spanLabel(span)}余额曲线`,
    `${spark.dots.length} 个采样点`,
    `最低 ${spark.min.toFixed(2)}`,
    `最高 ${spark.max.toFixed(2)} ${currency}`,
    deltaLabel(spark),
  ];
  if (spark.gaps > 0) parts.push(`有 ${spark.gaps} 处缺口未采集`);
  return parts.join("，");
}
