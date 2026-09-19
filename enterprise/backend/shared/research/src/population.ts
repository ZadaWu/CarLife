/**
 * 观察总体（施工单 M82-01）。
 *
 * 页面顶栏常驻的那三个数就是这个函数（analysis.md §5：**不藏进页脚**）。
 * 它同时是每张镜头的分母来源——`n/N` 的 `N` 不能是"我算了几条"，
 * 必须是"这个窗里一共有多少"，否则筛得越狠数字看起来越漂亮。
 */

import type { Population } from "./types";

/** 只要三个键；话语单元与行为单元都能喂进来。 */
export interface PopulationUnit {
  userId: string;
  vin: string | null;
  turnId?: string | null;
}

/**
 * 去重口径（**页面顶栏那三个数的定义，改这里就是改口径**）：
 *
 *  - `owners`   按 `user_id` 去重。一人多车只算一个车主。
 *  - `vehicles` 按 `vin` 去重，**`null` 不计**——"不知道是哪台车"不是一台车。
 *               POC 期有 vin 为空的行程，把它们算成一台"空车"会虚高。
 *  - `turns`    按 `turn_id` 去重，行为单元没有轮次因而不计入。
 *               这是**话语**的分母：拿它当"全部证据数"会让行为证据凭空消失。
 */
export function populationOf(units: readonly PopulationUnit[]): Population {
  const owners = new Set<string>();
  const vehicles = new Set<string>();
  const turns = new Set<string>();

  for (const u of units) {
    owners.add(u.userId);
    if (u.vin) vehicles.add(u.vin);
    if (u.turnId) turns.add(u.turnId);
  }

  return { owners: owners.size, vehicles: vehicles.size, turns: turns.size };
}
