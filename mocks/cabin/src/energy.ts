/**
 * 剩余电量 / 剩余油量的仿真（能量遥测）。
 *
 * # 它是遥测，不是设置——所以不进 changes 流水
 *
 * 变更流水记录的是「有人把空调调到了 26 度」这类**设置动作**，后台按它回答
 * "谁在什么时候改了什么"。电量每分钟都在变，若也推进流水，一晚上就把 500 条
 * 环形缓冲全部挤成「batteryPercent 63 → 62」，真正的设置历史反而被冲走。
 * 所以能量走独立端点（`GET /vehicles/:id/energy`），只有当前值，没有历史。
 *
 * # 变化是"读时推进"，不是后台定时器
 *
 * 每次读取时按距上次读取流逝的时间把仿真向前推。没有人看的车不耗 CPU，
 * 而看的人**每次都看到新值**——这正是"仿真变化"要买的东西。进程重启后
 * `asOf` 随快照恢复，停机期间的流逝照常补算：停一晚上回来，电掉了就是掉了。
 *
 * # 确定性：同一辆车永远从同一个值出发
 *
 * 初值与车型的动力形式都从 FNV-1a 哈希推导（与 capabilities 的合成同一纪律，
 * 零 Math.random）。随机初值的坏处在能力表那边写过一遍：重启后换个数，
 * 现象是"数据不稳"，排查方向完全不指向随机数。
 *
 * # 演示节奏优先于物理真实
 *
 * 真车巡航掉电约 15%/小时，演示里三分钟看不出任何变化。这里刻意加速到
 * 行驶约 1.2%/分钟（80 分钟见底），让"它真的在变"用肉眼可见。速率写死成
 * 常量并如实注释——这是仿真参数，不是对真车的断言。
 * 循环闭环：电低了自动进充电、充到 90% 继续开；油低了跳加油——
 * 演示车永远不会死在 0% 上不来。
 */

/** 词汇与 CarLife 档案侧的 `VehicleEnergyType` 一致（bev 纯电 / phev 插混 / icev 燃油）。
 *  只是同一串字符串——本服务不 import 那个包（隔离纪律）。 */
export type EnergyType = "bev" | "phev" | "icev";

export type EnergyMode = "driving" | "charging";

export interface EnergyState {
  energyType: EnergyType;
  /** 0~100；icev 没有。 */
  batteryPercent?: number;
  /** 0~100；bev 没有。 */
  fuelPercent?: number;
  mode: EnergyMode;
  /** 上次推进到的时刻（epoch ms）。 */
  asOf: number;
}

/** 对外返回的形状：在内部状态之上补上续航（读时按满量程折算，不落盘）。 */
export interface EnergyView {
  energyType: EnergyType;
  battery?: { percent: number; rangeKm: number; charging: boolean };
  fuel?: { percent: number; rangeKm: number };
  mode: EnergyMode;
  asOf: string;
}

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 车型 → 动力形式。种子车型（特斯拉系）是纯电；种子外按名字哈希分布：
 * 一半纯电、三成燃油、两成插混——让"油量"这条路径不用专门造车就能演示到。
 */
export function energyTypeForModel(model: string): EnergyType {
  if (/model\s*[3sxy]/i.test(model)) return "bev";
  const r = fnv(`energy:${model}`) % 10;
  return r < 5 ? "bev" : r < 8 ? "icev" : "phev";
}

/** 满量程续航（km）。按车型确定性合成，只用于把百分比折算成"还能跑多远"。 */
function fullRanges(model: string): { battery: number; fuel: number } {
  const h = fnv(`range:${model}`);
  return { battery: 420 + (h % 180), fuel: 550 + ((h >>> 8) % 250) };
}

/** 仿真速率（%/分钟）。演示节奏，见文件头。 */
const DRAIN_BATTERY = 1.2;
const DRAIN_FUEL = 0.5;
const CHARGE_RATE = 2.5;
/** 电低于此进充电桩；充到 CHARGE_UNTIL 拔枪继续开。 */
const BATTERY_LOW = 10;
const CHARGE_UNTIL = 90;
/** 油低于此跳加油（加油是几分钟的事，仿真为瞬时跳变）。 */
const FUEL_LOW = 8;
const FUEL_REFILL = 96;

export function initEnergy(vehicleId: string, model: string, now: number): EnergyState {
  const type = energyTypeForModel(model);
  const h = fnv(`init:${vehicleId}:${model}`);
  const battery = 45 + (h % 50); // 45~94：从"够用但看得见消耗"出发
  const fuel = 40 + ((h >>> 8) % 55);
  return {
    energyType: type,
    batteryPercent: type === "icev" ? undefined : battery,
    fuelPercent: type === "bev" ? undefined : fuel,
    mode: "driving",
    asOf: now,
  };
}

/**
 * 把仿真从 `state.asOf` 推进到 `now`，返回新状态（不改入参）。
 *
 * 按分钟步进而不是闭式解：充电/加油的模式切换发生在中途，闭式解要把
 * 分段折算全写对才不出错，而这里最多补算几千步（一晚上 ≈ 480 步），
 * 循环便宜得多也好读得多。上限 7 天：更久的停机没有演示意义，
 * 补算几万步只是发热。
 */
export function advanceEnergy(state: EnergyState, now: number): EnergyState {
  const next: EnergyState = { ...state };
  let minutes = Math.max(0, (now - state.asOf) / 60_000);
  minutes = Math.min(minutes, 7 * 24 * 60);
  while (minutes > 0) {
    const step = Math.min(minutes, 1);
    minutes -= step;
    if (next.mode === "charging") {
      next.batteryPercent = Math.min(CHARGE_UNTIL, (next.batteryPercent ?? 0) + CHARGE_RATE * step);
      if (next.batteryPercent >= CHARGE_UNTIL) next.mode = "driving";
    } else {
      if (next.batteryPercent !== undefined) {
        next.batteryPercent = Math.max(0, next.batteryPercent - DRAIN_BATTERY * step);
        if (next.batteryPercent <= BATTERY_LOW) next.mode = "charging";
      }
      if (next.fuelPercent !== undefined) {
        next.fuelPercent = Math.max(0, next.fuelPercent - DRAIN_FUEL * step);
        if (next.fuelPercent <= FUEL_LOW) next.fuelPercent = FUEL_REFILL;
      }
    }
  }
  next.asOf = now;
  return next;
}

/** 演示控制的入参（`POST /vehicles/:id/energy`）：只认这三个字段，越界报错不夹。 */
export interface EnergyOverride {
  batteryPercent?: number;
  fuelPercent?: number;
  mode?: EnergyMode;
}

/**
 * 应用演示覆盖。与 apply 的"越界夹到边界"不同，这里**越界直接拒**：
 * 调用方是演示操作者不是模型，传 120% 是笔误不是意图，夹成 100 会掩盖它。
 */
export function overrideEnergy(state: EnergyState, o: EnergyOverride, now: number): EnergyState {
  const next = advanceEnergy(state, now);
  for (const [key, cap] of [["batteryPercent", "电量"], ["fuelPercent", "油量"]] as const) {
    const v = o[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || Number.isNaN(v) || v < 0 || v > 100) {
      throw new RangeError(`${cap}必须在 0~100 之间，收到 ${String(v)}`);
    }
    if (next[key] === undefined) {
      throw new RangeError(`这辆车（${next.energyType}）没有${cap}这个指标`);
    }
    next[key] = v;
  }
  if (o.mode !== undefined) {
    if (o.mode !== "driving" && o.mode !== "charging") throw new RangeError(`mode 只认 driving/charging`);
    if (o.mode === "charging" && next.batteryPercent === undefined) {
      throw new RangeError("燃油车没有充电模式");
    }
    next.mode = o.mode;
  }
  return next;
}

/** 落盘的旧状态灌回：形状认得出才收，认不出就按初值重来（与能力表的灌回同一纪律）。 */
export function rehydrateEnergy(raw: unknown, vehicleId: string, model: string, now: number): EnergyState {
  const fresh = initEnergy(vehicleId, model, now);
  if (!raw || typeof raw !== "object") return fresh;
  const r = raw as Record<string, unknown>;
  if (r.energyType !== fresh.energyType) return fresh; // 车型的动力形式变了：代码是真相源
  const pct = (v: unknown): number | undefined =>
    typeof v === "number" && v >= 0 && v <= 100 ? v : undefined;
  return {
    energyType: fresh.energyType,
    batteryPercent: fresh.batteryPercent === undefined ? undefined : pct(r.batteryPercent) ?? fresh.batteryPercent,
    fuelPercent: fresh.fuelPercent === undefined ? undefined : pct(r.fuelPercent) ?? fresh.fuelPercent,
    mode: r.mode === "charging" ? "charging" : "driving",
    asOf: typeof r.asOf === "number" && r.asOf > 0 && r.asOf <= now ? r.asOf : now,
  };
}

export function viewEnergy(state: EnergyState, model: string): EnergyView {
  const ranges = fullRanges(model);
  const round1 = (v: number) => Math.round(v * 10) / 10;
  return {
    energyType: state.energyType,
    battery:
      state.batteryPercent === undefined
        ? undefined
        : {
            percent: round1(state.batteryPercent),
            rangeKm: Math.round((state.batteryPercent / 100) * ranges.battery),
            charging: state.mode === "charging",
          },
    fuel:
      state.fuelPercent === undefined
        ? undefined
        : { percent: round1(state.fuelPercent), rangeKm: Math.round((state.fuelPercent / 100) * ranges.fuel) },
    mode: state.mode,
    asOf: new Date(state.asOf).toISOString(),
  };
}
