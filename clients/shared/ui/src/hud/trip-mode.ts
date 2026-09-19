/**
 * 真实地图行程模式的判定（M13-06 起在车机 App.tsx；M65-01 手机端抽成纯函数；
 * 2026-09-16 上提到 `clients/shared/ui`，两端共用一份）。
 *
 * 缺一个条件都回落装饰概览：确认过、这一程该上地图、有真实坐标、高德没报废。
 * 判据本身在 `@carlife/shared`（`tripDayIndex` / `tripPlanHasCoords`），端上不自己判——
 * 两处各写一份的表现是"车机说在行程里、手机说没有"。
 */
import { tripDayIndex, tripPlanHasCoords, type TripPlanSnapshot } from "@carlife/shared";

export function tripActiveFor(args: {
  plan: TripPlanSnapshot | null;
  amapFailed: boolean;
  /** YYYY-MM-DD */
  today: string;
  /**
   * 这一程是车主在行程列表里**点出来的**（2026-09-16 走查）。
   *
   * 选中态下不再看"今天在不在行程里"：点开一份已结束的行程，要的就是那一程的路线，
   * 而它恒过期——原来的判据让地图停在装饰概览上（假的五个点位），看起来像地图坏了。
   * 未选中时这一条仍要守：默认那份如果已经走完，画它等于把上个月的行程一直挂在屏幕上。
   */
  selected?: boolean;
}): boolean {
  const { plan } = args;
  return (
    !args.amapFailed &&
    plan !== null &&
    plan.status === "confirmed" &&
    (args.selected === true || tripDayIndex(plan, args.today) !== null) &&
    tripPlanHasCoords(plan)
  );
}
