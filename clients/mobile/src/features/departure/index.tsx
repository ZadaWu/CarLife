/**
 * features/departure — 手机端的「开始行程」（2026-09-02；对齐车机 M66-04 出发卡，M65-01 表第 31 项的去向）。
 *
 * 车机上点钥匙先放 18.9 秒出发动画再滑入出发卡；手机上**没有动画**——点「开始行程」直接从底部升起
 * 同一张卡（`@carlife/ui` 的 `DepartureCard`，两端一字一样）。动画是车机的实拍片与音景（M64），
 * 刻意不搬：手机不是长时运行的展示面，车主掏出手机是要立刻进导航。
 *
 * 规划请求在卡片打开的那一刻发出，并**立刻**标记"卡片露面"：车机上计时从动画放完起算，
 * 手机上卡一出来车主就在等了，秒数与 60 s 降级都从这一刻算。墙钟仍只在 `useDepartureNav` 里。
 */

import { useEffect } from "react";

import type { TripPlanSnapshot } from "@carlife/shared";
import { DepartureCard, currentOriginForNav, getLocationPort, useDepartureNav } from "@carlife/ui";

import { requestNavPlan, tauriOpener } from "./api";

export interface MobileDepartureProps {
  /** HUD 正在展示的那份行程（演示/真实同一入口）。null = 没有可出发的行程，卡上如实说。 */
  plan: TripPlanSnapshot | null | undefined;
  /** 当前这辆车：规划按它的常用人员算；没有就按车主全部车辆（网关兜底）。 */
  vin?: string;
  onClose: () => void;
}

export function MobileDeparture({ plan, vin, onClose }: MobileDepartureProps) {
  const nav = useDepartureNav();
  useEffect(() => {
    // 起点由定位端口给，网关补常住地；与车机 `play()` 里那一段同款。
    nav.start(async () => {
      const origin = await currentOriginForNav(getLocationPort());
      return requestNavPlan({ ...(origin ? { origin } : {}), ...(vin ? { vin } : {}) });
    });
    nav.markVisible();
    // 关掉出发卡：作废在途请求、回 idle——下次打开是新的一轮。
    return () => nav.reset();
    // nav.* 全是稳定引用（useCallback []）；vin 变了不重发——那是换车，卡也该关掉重开。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mobile-depart" role="presentation">
      <button type="button" className="mobile-depart__backdrop" aria-label="关闭出发卡" onClick={onClose} />
      <DepartureCard
        plan={plan}
        navState={nav.state}
        onClose={onClose}
        openExternal={tauriOpener()}
        todayIso={new Date().toISOString().slice(0, 10)}
      />
    </div>
  );
}

export { requestNavPlan } from "./api";
