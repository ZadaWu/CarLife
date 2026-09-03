/**
 * domain/vehicle — 车辆领域模型（FL-34 F-34-02）。
 *
 * `contracts` 是端云契约的唯一真相源（§10 要点 6）。
 *
 * # 与 `enterprise/backend/shared/memory` 的关系：这里是契约，那里是存储实现
 *
 * `@carlife/memory` 的 `VehicleStore` / `VehicleProfile` 是**服务端存储侧**的形态，
 * 与 prisma 行结构贴合。本文件是**端云共享**的那一份：端上要渲染车辆卡片、
 * 售后要展示维修历史，两边都需要同一套字段名与语义。
 *
 * 两者字段刻意保持一致（`VehicleProfile` 与本文件的 `Vehicle` 同构），
 * 但**不互相 import**：`contracts` 不能依赖 memory（依赖方向是
 * 服务/端 → shared），而 memory 也不该被端上打包进去。
 * 一致性靠 `Vehicle` 与 `VehicleProfile` 的字段同名同义来保证——
 * 改一处必须改另一处，这是 F-34-02「端上与服务端无重复类型定义」还没能
 * 完全达成的部分，收口方案见文件末尾。
 *
 * # 端上拿不到什么
 *
 * HUD 契约（`domain/hud.ts`）**刻意不含 VIN 与维修档案**。本文件定义它们，
 * 是给对话层与售后页用的——那两处用户已经明确在查自己的车。
 * HUD 是常驻可见的界面，两者的暴露面不同，不能混用同一套类型。
 */

/** 保养记录。`items` 是自由文本描述，不做结构化——门店给的就是一句话。 */
export interface MaintenanceRecord {
  /** 发生时间（Unix epoch 毫秒）。 */
  at: number;
  odometerKm: number;
  items: string;
  /**
   * 门店或来源。
   *
   * **用户自述要标注出来**：它与门店记录的可信度不同，而这条记录会被当作
   * 与修理厂争议时的依据（F-23-11）。
   */
  source: string;
}

/** 维修记录。与保养分开：一个是周期性的，一个是故障驱动的，查询场景不同。 */
export interface RepairRecord {
  at: number;
  odometerKm: number;
  /** 故障描述。 */
  issue: string;
  /** 处理方式。 */
  resolution: string;
  source: string;
}

/**
 * 车辆档案（④车辆档案，§7 表）。
 *
 * **强一致、不衰减、事件驱动**——它不进 Mem0，因此不受 §7 衰减层影响。
 * "上次保养是什么时候"这类问题必须答得准，衰减掉一条保养记录是不可接受的。
 */
export interface Vehicle {
  /** VIN 即主键：一辆车全局唯一，不另造 id。 */
  vin: string;
  ownerId: string;
  model: string;
  modelYear: number;
  /** 购车时间（Unix epoch 毫秒）。 */
  purchasedAt: number;
  /** 当前里程；由⑥流水推进或用户上报。**只前进不后退**。 */
  odometerKm: number;
  /**
   * 厂商标称保养周期（公里）。
   *
   * 可缺失：**缺失时下游按通用值并明确标注**（F-17-09），不假装知道。
   */
  maintenanceIntervalKm?: number;
  maintenance: MaintenanceRecord[];
  repairs: RepairRecord[];
  updatedAt: number;
}

/**
 * 一人多车时的默认车（F-23-09）。
 *
 * 当前车辆 id 随图状态传递，**各工具不自行推断"我的车"是哪辆**——
 * 推断出错的表现是"查了别的车的手册还带着出处"，比查不到更难发现。
 */
export interface VehicleRef {
  vin: string;
  isDefault: boolean;
}

/** VIN 长度（ISO 3779）。校验实现在 `@carlife/memory` 的 `isValidVin`。 */
export const VIN_LENGTH = 17;

/** 保养周期缺失时的通用回落值（公里）。用它算出的结论**必须标注为通用值**。 */
export const DEFAULT_MAINTENANCE_INTERVAL_KM = 10_000;

/*
 * 收口方案（未做）：F-34-02 要求端上与服务端无重复类型定义。
 * 当前 `@carlife/memory` 仍有一份同构的 `VehicleProfile`——它比本文件早落地，
 * 且 `enterprise/backend/shared/db` 的仓储直接实现了它的接口。
 * 让 memory 改为 `import type { Vehicle } from "@carlife/shared"` 是正确方向，
 * 但会改动 db 仓储与两处测试的类型来源，属独立改动，不在本次范围内。
 */
