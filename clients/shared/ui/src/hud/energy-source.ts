/**
 * 剩余电量 / 剩余油量的轮询源（M27；M65-01 上提到 `clients/shared/ui`，两端共用）。
 *
 * # 为什么单独一路，不塞进 HUD 行程轮询
 *
 * 行程 60 秒一轮，因为它"分钟级、由一次确认触发"。能量是**连续量**：
 * 车机侧读时推进仿真，读得越勤看到的变化越连贯。两者节奏不同、失败语义也不同
 * （行程拉不到 → 收起卡片；能量拉不到 → 中段显示"读不到"，其余照常），
 * 合成一路会让任一侧的失败污染另一侧。
 *
 * # 车机离线不是错误，是一种读数
 *
 * 网关对离线回 502 + `{state:"offline"}`，Rust 侧刻意把 502 的响应体带回来
 * （`fetch_vehicle_energy`）。所以这里**先解析 state，再谈异常**——
 * 把离线当异常处理会丢掉网关给的原因，端上只能显示一句"失败"。
 *
 * # 读不到时保留上一次读数吗？不保留
 *
 * HUD 别处的降级纪律是"保留最近有效值 + 标记 stale"，那适用于**慢变量**
 * （行程、天气）。电量是快变量：离线三分钟后那个 63% 已经不成立，
 * 继续显示它等于用一个过期数字冒充当前状态。所以直接切 `unavailable`。
 */

import type { LiveEnergy } from "@carlife/shared";

/** 网关 `GET /v1/vehicles/:vin/energy` 的响应形状（三态 + 分动力形式）。 */
interface EnergyBody {
  state: "bound" | "offline" | "unbound" | "unconfigured";
  reason?: string;
  energyType?: "bev" | "phev" | "icev";
  battery?: { percent: number; rangeKm: number; charging: boolean };
  fuel?: { percent: number; rangeKm: number };
}

/**
 * 响应 → 屏幕上那一段。
 *
 * **插混（phev）两样都有**，取电量：它日常以电驱为主，且"还能开多远"这个问题
 * 上电量先见底。油量在档案页看得到，HUD 一段位置放不下两个指标。
 */
export function toLiveEnergy(body: EnergyBody): LiveEnergy {
  if (body.state !== "bound") {
    return { kind: "unavailable", reason: body.reason ?? "这会儿读不到车辆能量" };
  }
  if (body.battery) {
    return {
      kind: "battery",
      percent: body.battery.percent,
      rangeKm: body.battery.rangeKm,
      charging: body.battery.charging,
    };
  }
  if (body.fuel) {
    return { kind: "fuel", percent: body.fuel.percent, rangeKm: body.fuel.rangeKm };
  }
  // bound 却两样都没有：车机说不清这辆车烧什么。不替它选一个。
  return { kind: "unavailable", reason: "车机没有报告这辆车的能量指标" };
}

/**
 * `?energy=battery|fuel|low|charging|offline`：浏览器走查用的固定读数（M27）。
 *
 * 与 `?profile=demo` / `?hitl=demo` 同一条先例。理由是这一段有**五种长相**，
 * 而浏览器里没有网关那一路，走查只能看到"没接入"那一种——五分之四的版式
 * 从来没被人看过，其中就包括"读不到"和"低电告警"这两个最要命的。
 */
export function demoEnergy(): LiveEnergy | undefined {
  if (typeof window === "undefined") return undefined;
  const v = new URLSearchParams(window.location.search).get("energy");
  switch (v) {
    case "battery":
      return { kind: "battery", percent: 63, rangeKm: 285, charging: false };
    case "charging":
      return { kind: "battery", percent: 41, rangeKm: 186, charging: true };
    case "low":
      return { kind: "battery", percent: 12, rangeKm: 54, charging: false };
    case "fuel":
      return { kind: "fuel", percent: 48, rangeKm: 322 };
    case "offline":
      return { kind: "unavailable", reason: "车机离线，这会儿读不到电量/油量" };
    default:
      return undefined;
  }
}

export interface EnergyPollerOptions {
  /** 轮询间隔，默认 15s——够看出变化，又不至于把网关当秒表打。 */
  intervalMs?: number;
  /** 拉取原样 JSON。**由端注入**（Tauri 里是 `invoke("fetch_vehicle_energy")`），本包不认识 Tauri。 */
  fetchEnergyJson: (vin: string) => Promise<string>;
}

export interface EnergyPoller {
  stop(): void;
}

/**
 * 起一路轮询。`vin` 为空即不启动——**没有选中车辆时不显示任何能量读数**，
 * 也不显示"读不到"：那会把"你还没建档"说成"车机坏了"。
 */
export function startEnergyPolling(
  vin: string | null,
  onEnergy: (e: LiveEnergy | undefined) => void,
  opts: EnergyPollerOptions,
): EnergyPoller {
  if (!vin) {
    onEnergy(undefined);
    return { stop() {} };
  }
  const intervalMs = opts.intervalMs ?? 15_000;
  const fetchJson = opts.fetchEnergyJson;
  let alive = true;

  const pull = async () => {
    try {
      const body = JSON.parse(await fetchJson(vin)) as EnergyBody;
      if (alive) onEnergy(toLiveEnergy(body));
    } catch (err) {
      // 网络层就断了（网关都没连上）——同样不许沿用旧数字。
      if (alive) onEnergy({ kind: "unavailable", reason: String(err) });
    }
  };

  void pull();
  const timer = setInterval(() => void pull(), intervalMs);
  return {
    stop() {
      alive = false;
      clearInterval(timer);
    },
  };
}
