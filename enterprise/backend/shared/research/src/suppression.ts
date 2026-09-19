/**
 * 小单元抑制（施工单 M82-01，总览已定决策 7）。
 *
 * # 抑制的是"能不能指认到人"，不是"数字准不准"
 *
 * 一个格里只有 3 台车时，问题不是统计不显著（那只要标注就行），
 * 而是**把这一格与另一格交叉一下就能认出是谁**。所以抑制必须清空明细，
 * 只留一句原因——留着明细、只把数字打灰，等于没抑制。
 *
 * 阈值默认 10 台车（`RESEARCH_MIN_CELL_VEHICLES`），边界是 `>=`：
 * 正好 10 台不抑制。这条边界写进单测，因为"大于还是不小于"这种差一位
 * 在界面上看不出来，只会让 10 台的那一格时有时无。
 */

import type { MaybeSuppressed, SuppressedCell } from "./types";

/** 默认阈值。与 `RESEARCH_MIN_CELL_VEHICLES` 的缺省值同源，改一处要改两处。 */
export const DEFAULT_MIN_CELL_VEHICLES = 10;

/** 待抑制的格：本体 + 这一格覆盖多少台车。 */
export interface CellWithVehicles<T> {
  cell: T;
  vehicles: number;
}

export function suppressionReason(vehicles: number, minVehicles: number): string {
  return `小单元抑制：这一格只覆盖 ${vehicles} 台车，低于阈值 ${minVehicles}`;
}

export function suppressedCell(vehicles: number, minVehicles: number): SuppressedCell {
  return { suppressed: true, reason: suppressionReason(vehicles, minVehicles) };
}

/**
 * 逐格判定。**返回的被抑制格里没有任何原始字段**——
 * 这是"清空明细"这条要求的实现处，别改成 `{ ...cell, suppressed: true }`。
 */
export function suppressCells<T extends object>(
  cells: readonly CellWithVehicles<T>[],
  minVehicles: number = DEFAULT_MIN_CELL_VEHICLES,
): Array<MaybeSuppressed<T>> {
  return cells.map(({ cell, vehicles }) =>
    vehicles >= minVehicles
      ? ({ ...cell, suppressed: false } as MaybeSuppressed<T>)
      : (suppressedCell(vehicles, minVehicles) as MaybeSuppressed<T>),
  );
}

/** 类型守卫，界面侧判"这一格要不要渲染成灰块"。 */
export function isSuppressed<T>(cell: MaybeSuppressed<T>): cell is SuppressedCell {
  return (cell as SuppressedCell).suppressed === true;
}
