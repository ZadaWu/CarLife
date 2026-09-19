/**
 * 指标格的文案与格式化：车机屏底状态栏（`StatusBar`）与手机底部胶囊（`EnergyCapsule`）共用。
 *
 * # 为什么单独一个文件，而不是留在 `StatusBar.tsx` 里
 *
 * `StatusBar.tsx` 顶上有七个 `import … from "../assets-hud/statusbar/*.png"`。
 * 常量与纯函数一旦住在那里，任何人**只要引一个字符串**就把整包 PNG 拖进自己的依赖图：
 *  - `EnergyCapsule`（只有手机在用）曾为了 `durationLabel` 引它，于是手机侧多了一条
 *    指向车机切图的边；
 *  - 测试更直接——Node 不认 `.png`，`import { METRIC_EMPTY }` 当场
 *    `ERR_UNKNOWN_FILE_EXTENSION`，于是这几个字符串**没法被测到真产物**
 *    （只能退回去扫源码文本，那就成了"守注释"）。
 *
 * 所以：纯文本与纯函数放这里，带素材的组件各自去引它。
 */

/** 没有数据时那一格的值。**不是省略号也不是「--」**：那两个符号读者得自己猜是什么意思。 */
export const METRIC_EMPTY = "暂无";

/**
 * 连不上服务时那一格的值（2026-09-11 用户走查）。
 *
 * 与 `METRIC_EMPTY` **必须是两句话**：一句说「服务在，这项没数据」，一句说「根本没连上」。
 * 合成一句就回到了改之前——两种状态长得一模一样，而右端那枚「数据更新中」还在说一件不真的事。
 */
export const METRIC_UNAVAILABLE = "服务暂不可用";

/** 「4 h 30 min」/「45 min」。 */
export function durationLabel(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} min`;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}
