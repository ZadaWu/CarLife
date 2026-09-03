/**
 * 真实地图行程模式的判定（M13-06 起在车机 App.tsx；M65-01 手机端抽成纯函数）。
 *
 * 四个条件缺一样都回落装饰概览：确认过、今天在行程里、有真实坐标、高德没报废。
 * 判据本身在 `@carlife/shared`（`tripDayIndex` / `tripPlanHasCoords`），端上不自己判——
 * 两处各写一份的表现是"车机说在行程里、手机说没有"。
 */
import { tripDayIndex, tripPlanHasCoords, type TripPlanSnapshot } from "@carlife/shared";

export function tripActiveFor(args: {
  plan: TripPlanSnapshot | null;
  amapFailed: boolean;
  /** YYYY-MM-DD */
  today: string;
}): boolean {
  const { plan } = args;
  return (
    !args.amapFailed &&
    plan !== null &&
    plan.status === "confirmed" &&
    tripDayIndex(plan, args.today) !== null &&
    tripPlanHasCoords(plan)
  );
}
