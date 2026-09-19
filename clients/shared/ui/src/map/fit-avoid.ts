/**
 * 取景避让的横向配法（2026-09-16 走查第三轮：「有点偏右下…感觉歪着」）。
 *
 * `setFitView(overlays, immediately, avoid)` 把内容摆在「容器减掉四边让量」的正中，
 * 所以落点包围盒的水平中心是 `(左让 + 宽 - 右让) / 2`。行程详情抽屉压在右侧时，
 * 真正能看见的只有 `0 ~ 抽屉左缘` 这一块，它的中心是 `抽屉左缘 / 2`。
 *
 * 两者相等，解出来只有一个答案：**右让量 = 抽屉占宽 + 左让量**。
 * 多一分内容往左偏半分，少一分往右偏半分——前两版各偏一个方向，都是栽在这里：
 * 只顾着"让开抽屉"就一路加右让量，把内容推出了可见区的中心。
 *
 * 独立成纯函数就是为了让这条关系能被算术验证（`fit-avoid.test.ts` 里连着
 * `fitCenterX` 一起跑）：取景本身要浏览器里的 AMap，而这条配法一旦写歪，
 * 症状是"看着别扭"——最不容易在代码评审里被抓住的那一类。
 */
export function avoidXWithDrawer(
  drawerW: number,
  baseLeft: number,
  baseRight: number,
  gap: number,
): [left: number, right: number] {
  // 抽屉没开（手机端根本不挂它）→ 原样返回，行为与从前逐字一致。
  if (drawerW <= 0) return [baseLeft, baseRight];
  /*
   * 左右**同时**多让 gap：给名字胶囊留伸展余地（胶囊挂在落点上还会被 SPREAD_X
   * 往外推，实测右伸约 109 px），顺带把缩放再拉远一档——可用区越窄，
   * 同一批点塞进去所需的缩放就越小（走查：「缩放不要放那么大」）。
   * 只加右边的话居中就没了，见上面那段。
   */
  const left = baseLeft + gap;
  return [left, Math.max(baseRight, drawerW + left)];
}

/** 这套让量下，落点包围盒的水平中心会落在哪（`setFitView` 的几何，不是猜的）。 */
export function fitCenterX(width: number, left: number, right: number): number {
  return (left + width - right) / 2;
}
