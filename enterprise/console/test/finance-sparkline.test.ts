/**
 * 余额曲线的**防退化断言**。
 *
 * 一条画错的曲线不报错，它只是安静地讲另一个故事。这里逐条钉住三种"另一个故事"：
 *   ① 缺口被连成直线 → "这段时间在缓慢消耗"，而真相是"这段时间我们不知道"；
 *   ② 一个采样点被画成横线 → "余额没变"，而真相是"只测过一次"；
 *   ③ 恒定余额被压在图的顶/底 → "贴着上限 / 快见底了"，而真相是"一直没动"。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  axisTicks,
  buildSparkline,
  deltaLabel,
  deltaTitle,
  intervalLabel,
  nearestDot,
  pointTimeLabel,
  spanLabel,
  sparkAriaLabel,
  tickStep,
  windowFor,
  type FinanceHistory,
  type HistoryPoint,
} from "../src/pages/finance/history";

const H = 3_600_000;
/** 采样周期与服务端默认一致（10 分钟）。所有判据都从它推，不写死。 */
const STEP = 10 * 60_000;
const TO = Date.parse("2026-09-08T12:00:00Z");
const FROM = TO - 7 * 24 * H;
const OPTS = { from: FROM, to: TO, stepMs: STEP };

/** 从窗口起点往后连续 n 个采样点，值由 fn 给。 */
function run(n: number, fn: (i: number) => number, startStep = 0): HistoryPoint[] {
  return Array.from({ length: n }, (_, i) => ({ t: FROM + (startStep + i) * STEP, v: fn(i) }));
}

describe("缺口不许被连成直线", () => {
  it("连缺两个桶以上就断成两段", () => {
    const points = [...run(5, () => 50), ...run(5, () => 20, 20)]; // 中间空了 15 个周期
    const s = buildSparkline(points, OPTS);
    assert.ok(s);
    assert.equal(s.segments.length, 2, "停机那段必须断开，连起来等于替供应商编造它没说过的数字");
    assert.equal(s.gaps, 1);
  });

  it("只慢了一个桶（定时器被慢上游挤过边界）不算缺口——为它切碎反而掩盖真正的停机", () => {
    const points = [...run(3, () => 50), ...run(3, () => 49, 4)]; // 只空了 1 个桶
    const s = buildSparkline(points, OPTS);
    assert.ok(s);
    assert.equal(s.segments.length, 1);
    assert.equal(s.gaps, 0);
  });

  it("缺口阈值跟着 stepMs 走——服务端把周期调大，正常的间隔不许被当成缺口", () => {
    // 同一批点（间隔 1 小时），在 10 分钟周期下是缺口，在 1 小时周期下不是
    const hourly = Array.from({ length: 4 }, (_, i) => ({ t: FROM + i * H, v: 50 - i }));
    assert.equal(buildSparkline(hourly, OPTS)!.gaps, 3, "10 分钟周期下，隔 1 小时就是停机");
    assert.equal(
      buildSparkline(hourly, { ...OPTS, stepMs: H })!.gaps,
      0,
      "1 小时周期下，隔 1 小时是正常节奏——阈值写死就会在这里说假话",
    );
  });

  it("缺口两端的点都还在（断的是线不是数据）", () => {
    const s = buildSparkline([...run(2, () => 50), ...run(2, () => 20, 30)], OPTS);
    assert.ok(s);
    assert.equal(s.dots.length, 4);
  });

  it("点全是孤立的（网关开开停停）→ 缺口数不许算成 0，点也不许丢", () => {
    // 5 个点两两相隔 1 小时，10 分钟周期下每一处都是断裂，一段线都连不成
    const scattered = Array.from({ length: 5 }, (_, i) => ({ t: FROM + i * H, v: 50 - i }));
    const s = buildSparkline(scattered, OPTS);
    assert.ok(s);
    assert.equal(s.segments.length, 0, "确实一段都连不成");
    assert.equal(
      s.gaps,
      4,
      "缺口数要数「相邻两点的断裂」；按「线段数−1」算会得到 0，把「全是窟窿」报成「没有窟窿」",
    );
    assert.equal(s.orphans.length, 5, "连不成线的点要留成孤点由渲染层画出来，不能丢");
  });

  it("能连成线的点不进孤点表——否则同一个点被画两遍", () => {
    const s = buildSparkline([...run(4, () => 50), ...run(1, () => 20, 40)], OPTS);
    assert.ok(s);
    assert.equal(s.segments.length, 1);
    assert.equal(s.orphans.length, 1, "只有末尾那个落单的才是孤点");
    assert.equal(s.orphans[0].v, 20);
  });
});

describe("一个点不是一条曲线", () => {
  it("单点连不成线段——调用方据此说「还在攒」而不是画一条横线", () => {
    const s = buildSparkline(run(1, () => 50), OPTS);
    assert.ok(s);
    assert.equal(s.dots.length, 1);
    assert.equal(s.segments.length, 0, "一个点画出来的横线会被读成「余额没变」");
  });

  it("一个点都没有时给 null，不画空图", () => {
    assert.equal(buildSparkline([], OPTS), null);
    assert.equal(buildSparkline([{ t: FROM - 5 * H, v: 9 }], OPTS), null, "窗口外的点不算数");
  });

  it("NaN 之类的脏值被剔掉，不参与极值", () => {
    const s = buildSparkline([{ t: FROM, v: Number.NaN }, ...run(2, () => 10, 1)], OPTS);
    assert.ok(s);
    assert.equal(s.dots.length, 2);
    assert.equal(s.min, 10);
  });
});

describe("纵轴", () => {
  it("恒定余额落在图的正中间——压在顶/底会被读成「贴着上限」或「快见底了」", () => {
    const s = buildSparkline(run(6, () => 50), OPTS);
    assert.ok(s);
    assert.equal(s.min, 50);
    assert.equal(s.max, 50);
    const mid = s.height / 2;
    for (const d of s.dots) assert.ok(Math.abs(d.y - mid) < 0.01, `y=${d.y} 应当在正中 ${mid}`);
  });

  it("余额为 0 也不除零", () => {
    const s = buildSparkline(run(3, () => 0), OPTS);
    assert.ok(s);
    for (const d of s.dots) assert.ok(Number.isFinite(d.y));
  });

  it("按本账户极值自适应：最高点在上、最低点在下，且都在画布内", () => {
    const s = buildSparkline(run(5, (i) => 100 - i * 10), OPTS);
    assert.ok(s);
    assert.equal(s.min, 60);
    assert.equal(s.max, 100);
    assert.ok(s.dots[0].y < s.dots[4].y, "余额高的点 y 更小（更靠上）");
    for (const d of s.dots) assert.ok(d.y >= 0 && d.y <= s.height, "点必须落在画布内");
  });
});

describe("横轴窗口按实际数据伸缩", () => {
  const hist = (series: Record<string, HistoryPoint[]>, to = TO): FinanceHistory => ({
    retentionDays: 7,
    stepMs: STEP,
    from: to - 7 * 24 * H,
    to,
    series: Object.fromEntries(
      Object.entries(series).map(([k, points]) => [k, { currency: "CNY", points }]),
    ),
    note: "",
  });

  it("冷启动只有半小时数据时，窗口不是 7 天而是下限 1 小时", () => {
    const points = [0, 1, 2, 3].map((i) => ({ t: TO - (3 - i) * 10 * 60_000, v: 50 }));
    const w = windowFor(hist({ deepseek: points }))!;
    assert.equal(w.span, H, "固定 7 天的话，这半小时会挤在最右边 0.3% 的宽度里，看起来就是没有曲线");
    assert.equal(w.to, TO, "右端永远是「现在」——曲线讲的是到此刻为止");
  });

  it("数据够长时按实际跨度走，且封顶 7 天", () => {
    assert.equal(windowFor(hist({ a: [{ t: TO - 5 * H, v: 1 }, { t: TO, v: 2 }] }))!.span, 5 * H);
    const long = [{ t: TO - 30 * 24 * H, v: 1 }, { t: TO, v: 2 }];
    assert.equal(windowFor(hist({ a: long }))!.span, 7 * 24 * H, "再长也没有数据，7 天封顶");
  });

  it("窗口取全部账户的并集——几张卡片共用一个横轴，否则同一个横坐标不是同一个时刻", () => {
    const w = windowFor(
      hist({
        deepseek: [{ t: TO - 5 * H, v: 1 }],
        aliyun: [{ t: TO - 30 * H, v: 2 }], // 最早的点在这家
      }),
    )!;
    assert.equal(w.span, 30 * H, "窗口要罩住最早的那个点，不能只看第一家");
  });

  it("一个点都没有时给 null——没有曲线就不该有横轴", () => {
    assert.equal(windowFor(hist({})), null);
    assert.equal(windowFor(hist({ a: [] })), null);
  });

  it("窗口是共用的，所以只在末尾有数据的账户其点确实靠右，而不是被拉满", () => {
    const win = { from: TO - 7 * 24 * H, to: TO, span: 7 * 24 * H };
    const s = buildSparkline(run(4, () => 30, 6 * 24 * 6), { ...OPTS, from: win.from, to: win.to });
    assert.ok(s);
    assert.ok(s.dots[0].x > 80, `只有末尾有数据时点应当靠右，实际 x=${s.dots[0].x}`);
  });
});

describe("横轴刻度", () => {
  it("1 小时窗口给到 6 格——这正是「最短 1 小时」那条下限的由来", () => {
    assert.equal(tickStep(H), 10 * 60_000);
    const ticks = axisTicks({ from: TO - H, to: TO, span: H });
    assert.equal(ticks.length, 7, "6 格 = 7 个边界标签");
    // 不写死标签文字：TO 是 UTC 时刻，刻度按**本地**整点排，写死会绑死时区
    for (let i = 1; i < ticks.length; i += 1) {
      assert.equal(ticks[i].t - ticks[i - 1].t, 10 * 60_000, "相邻刻度必须正好隔一个采样周期");
    }
    assert.ok(ticks.every((k) => /^\d{2}:\d0$/.test(k.label)), "1 小时窗口里全是时刻，不出日期");
  });

  it("刻度数封在 7 个以内、且不少于 4 个——梯子上不许有窟窿", () => {
    // 逐档扫一遍真实会出现的跨度，包括"刚跑过一小时"这种梯子最容易漏的地方
    const spans = [
      H, 70 * 60_000, 76 * 60_000, 100 * 60_000, 2 * H, 3 * H, 5 * H, 8 * H,
      12 * H, 18 * H, 24 * H, 30 * H, 2 * 24 * H, 3 * 24 * H, 5 * 24 * H, 7 * 24 * H,
    ];
    for (const span of spans) {
      const n = axisTicks({ from: TO - span, to: TO, span }).length;
      // 上界 7：标签 5 个字符 ≈ 30px，270px 宽的曲线上第 8 个就开始叠字。
      // 判据要盯**格数 ≤ 6**——写成"格数 ≤ 7"会漏出 8 个标签，正是这条测试拦下过的。
      assert.ok(n <= 7, `跨度 ${(span / H).toFixed(1)}h 给了 ${n} 个刻度，会叠字`);
      assert.ok(
        n >= 4,
        `跨度 ${(span / H).toFixed(1)}h 只给了 ${n} 个刻度——梯子在这里有窟窿，横轴退化成几个孤零零的标签`,
      );
    }
  });

  it("刻度落在本地整点上，不是 epoch 整点", () => {
    const to = Date.parse("2026-09-02T11:37:00+08:00");
    const ticks = axisTicks({ from: to - 6 * H, to, span: 6 * H });
    for (const k of ticks) {
      assert.equal(new Date(k.t).getMinutes(), 0, `刻度 ${k.label} 没落在整点上`);
    }
  });

  it("日期只在本地零点那一格出现——每格都带日期会叠字，一格都不带则跨天分不清哪个 14:00", () => {
    const to = Date.parse("2026-09-02T06:00:00+08:00");
    const ticks = axisTicks({ from: to - 12 * H, to, span: 12 * H });
    const dated = ticks.filter((k) => /^\d{2}-\d{2}$/.test(k.label));
    assert.equal(dated.length, 1, "12 小时窗口里正好跨一次零点");
    assert.equal(new Date(dated[0].t).getHours(), 0);
  });

  it("两端的标签改成左/右对齐，否则会被卡片裁掉半截", () => {
    const ticks = axisTicks({ from: TO - H, to: TO, span: H });
    assert.ok(ticks.every((k) => (k.x < 8 ? k.anchor === "start" : true)));
    assert.ok(ticks.every((k) => (k.x > 92 ? k.anchor === "end" : true)));
  });
});

describe("悬浮取点", () => {
  const s = buildSparkline(run(8, (i) => 50 - i), OPTS)!;

  it("取离光标最近的采样点", () => {
    assert.equal(nearestDot(s.dots, s.dots[3].x + 0.01)?.t, s.dots[3].t);
    assert.equal(nearestDot(s.dots, -50)?.t, s.dots[0].t, "光标在左侧外时给第一个点");
    assert.equal(nearestDot(s.dots, 999)?.t, s.dots[7].t, "光标在右侧外时给最后一个点");
  });

  it("没有点时给 null，不抛", () => {
    assert.equal(nearestDot([], 10), null);
  });

  it("气泡里的时间带日期——七天的图上只写「14:20」根本不知道是哪天", () => {
    assert.match(pointTimeLabel(Date.parse("2026-09-03T14:20:00")), /^09-03 14:20$/);
  });

  it("分钟位如实取自采样点：写死 :00 会让同一小时的六个点显示成同一个时刻", () => {
    const labels = [0, 10, 20, 30, 40, 50].map((m) =>
      pointTimeLabel(Date.parse(`2026-09-03T14:${String(m).padStart(2, "0")}:00`)),
    );
    assert.equal(new Set(labels).size, 6, "同一小时里的六个采样点必须显示成六个不同的时刻");
    assert.deepEqual(labels.at(-1), "09-03 14:50");
  });
});

describe("旁注的措辞", () => {
  it("说的是「净变」不是「花了多少」——中间充过值的话两者完全不同", () => {
    const down = buildSparkline(run(3, (i) => 50 - i * 5), OPTS)!;
    assert.equal(deltaLabel(down), "净变 −10.00");
    const flat = buildSparkline(run(3, () => 50), OPTS)!;
    assert.equal(deltaLabel(flat), "净变持平");
    assert.ok(!/消耗|花费/.test(deltaLabel(down)), "不得把净变化说成消耗额");
    // 角标短了，完整口径就必须在别处说全——"净变"两个字挡不住有人读成消耗额
    assert.match(deltaTitle, /净变化/);
    assert.match(deltaTitle, /不是一回事/);
  });

  it("跨度必须能被念出来——横轴是伸缩的，「一条向下的曲线」可能是一小时也可能是一星期", () => {
    assert.equal(spanLabel(H), "近 1 小时");
    assert.equal(spanLabel(30 * H), "近 30 小时");
    assert.equal(spanLabel(7 * 24 * H), "近 7 天");
    const s = buildSparkline(run(4, () => 50), OPTS)!;
    assert.match(sparkAriaLabel(s, "CNY", 7 * 24 * H), /^近 7 天余额曲线/);
  });

  it("采样周期的人话说法跟着 stepMs——空态里那句「每 N 采样一次」不许写死", () => {
    assert.equal(intervalLabel(10 * 60_000), "10 分钟");
    assert.equal(intervalLabel(H), "1 小时");
    assert.equal(intervalLabel(90 * 60_000), "90 分钟", "不整除小时的就老实说分钟");
  });

  it("无障碍标签把极值与缺口都说出来——悬浮气泡屏幕阅读器读不到", () => {
    const s = buildSparkline([...run(3, () => 50), ...run(3, () => 20, 40)], OPTS)!;
    const label = sparkAriaLabel(s, "CNY", 7 * 24 * H);
    assert.match(label, /最低 20\.00/);
    assert.match(label, /最高 50\.00 CNY/);
    assert.match(label, /1 处缺口/);
  });
});

describe("页面接线的防退化", () => {
  const raw = readFileSync(join(process.cwd(), "src/pages/finance/index.tsx"), "utf8");
  const src = raw
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  // 同样先剥注释：Sparkline.tsx 的文件头正解释了"SVG 的 circle 会被拉成椭圆"，
  // 不剥的话下面那条规则会被这句说明本身弄红（filler-note 那条踩过同一个坑）。
  const spark = readFileSync(join(process.cwd(), "src/pages/finance/Sparkline.tsx"), "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

  it("曲线只画在有确切余额的卡片上——判据与大数字同一个 showsAmount", () => {
    assert.ok(
      /showsAmount\(a\) \? \(\s*<BalanceSparkline/.test(src),
      "曲线的渲染条件必须是 showsAmount(a)：高德 exact=false 画上线等于把「查不到」画成「一直没变」",
    );
  });

  it("横轴窗口由页面算一次发给每张卡，不是各卡自己算", () => {
    assert.ok(
      /const spanWindow = useMemo\(\(\) => \(history \? windowFor\(history\) : null\)/.test(src),
      "窗口必须在页面层算一次——各卡自己算的话，同一个横坐标不再是同一个时刻",
    );
    assert.ok(src.includes("window={spanWindow}"), "算出来的窗口要真的发下去");
  });

  it("空态文案从 stepMs 推，不写死「每小时」", () => {
    assert.ok(!/每小时/.test(spark), "写死周期的话，服务端一调周期页面就在说假话");
    assert.ok(spark.includes("intervalLabel(history.stepMs)"), "空态文案必须由采样周期推出来");
  });

  it("历史是并行拉的，且失败不往页面顶上顶红字", () => {
    assert.ok(src.includes('/console/finance/history'), "历史请求不见了");
    assert.ok(!src.includes("setError") || !/history[\s\S]{0,200}setError/.test(src), "曲线拉不到不该让整页报错");
  });

  it("圆点是 HTML 不是 SVG——非等比缩放会把 <circle> 拉成椭圆", () => {
    assert.ok(!/<circle/.test(spark), "改回 SVG circle 会在拉伸的 viewBox 里变成椭圆");
    assert.ok(spark.includes('vectorEffect="non-scaling-stroke"'), "少了它线会被横向拉粗变形");
  });
});
