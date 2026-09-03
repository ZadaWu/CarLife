/**
 * 车机状态落盘（原子 JSON 快照，零依赖）。
 *
 * # 为什么破例：它不是"我们的数据"，是这辆车自己的
 *
 * 本服务的立身之本是「假装成别人家的车机」，`index.ts` 开头那三条硬约束里原本
 * 有一条是「状态落进程内存重启即清」。现在放宽这一条，另外两条不动——
 * **不引 `@carlife/*`、不连 PG/Redis/MinIO**。落的是一个本地文件，和车机把设置
 * 写进自己的 NVM 是同一回事；真车重启之后空调不会回到出厂 22 度。
 *
 * 演示降级不受影响：kill 掉进程仍然是连接被拒，助手仍然要如实说「车机没连上」。
 * 落盘只改变**它回来之后**的样子——回来还是那辆车，而不是一辆全新的空车。
 *
 * # 必须整份存，只存 changes 是错的
 *
 * 车辆本身也在内存里（`vehicles` Map）。只把变更流水存下来的话，重启后
 * `VEH-000001` 根本不存在，上游 `withVehicle()` 会当成 `vehicle_not_found`
 * 重新造一辆车、拿到新 id——**旧流水就此成为一份没有车的孤儿记录**，
 * 后台按 VIN 查过去只会看到空的。所以快照里连发号器 (`vehicleSeq` /
 * `changeSeq`) 一起存：id 不能重号，seq 不能倒流。
 *
 * # 为什么是 JSON 文件而不是 SQLite
 *
 * 数据量是「几辆车 × 几百条流水」，访问形态是「启动读一次、变更整份写」——
 * 索引和事务在这里买不到任何东西，而 `node:sqlite` 会把这个服务和 Node 版本
 * 绑得更死。JSON 还有一个演示期真实用得上的好处：出问题时能直接 `cat` 出来看。
 *
 * 写入用「临时文件 + rename」：rename 在同一文件系统上是原子的，
 * 所以断电/被 kill 最多丢掉最后一次防抖窗口内的变更，**不会留下半个文件**
 * 让下次启动读到一辆状态残缺的车。
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** 快照格式版本。形状不兼容地改动时 +1，`load` 会拒绝并从空白开始（而不是读出畸形对象）。 */
export const SNAPSHOT_VERSION = 1;

export interface Snapshot {
  version: number;
  savedAt: string;
  /** 车辆发号器——不存的话重启后会把 VEH-000001 发给第二辆车。 */
  vehicleSeq: number;
  /** 变更序号——后台按 seq 排序与去重，倒流会让时间线错乱。 */
  changeSeq: number;
  vehicles: unknown[];
}

/**
 * 落盘目标。
 *
 * - `CABIN_PERSIST=off` → 完全不落盘（**测试用**：用例之间靠 `__resetAll()` 隔离，
 *   落盘会让它们互相污染，还会在仓库里留下垃圾文件）。
 * - `CABIN_DATA_FILE` → 显式路径（容器里指到挂载卷）。
 * - 默认 `var/mock-cabin-state.json`，相对**当前工作目录**解析。
 *
 * 刻意不放进 `data/`：那里是随镜像一起发布的种子数据（`models.json`），
 * 往上挂卷会把种子盖掉。运行时状态与种子数据分开放，挂载才不会互相干扰。
 */
const DISABLED = process.env.CABIN_PERSIST === "off";
const FILE = DISABLED ? null : resolve(process.env.CABIN_DATA_FILE ?? "var/mock-cabin-state.json");

/** 启动日志要打出来——默认路径跟着 cwd 走，"存到哪去了"不该靠猜。 */
export function snapshotPath(): string | null {
  return FILE;
}

export function load(): Snapshot | null {
  if (!FILE) return null;
  let raw: string;
  try {
    raw = readFileSync(FILE, "utf8");
  } catch (err) {
    // 首次启动没有文件是正常的，其它读取错误要说出来
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[mock-cabin] 读取快照失败，按空白启动：${String(err)}`);
    }
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Snapshot;
    if (parsed?.version !== SNAPSHOT_VERSION) {
      console.warn(`[mock-cabin] 快照版本 ${parsed?.version} 与本版 ${SNAPSHOT_VERSION} 不符，按空白启动`);
      return null;
    }
    if (!Array.isArray(parsed.vehicles)) return null;
    return parsed;
  } catch (err) {
    /*
     * 坏文件不能让服务起不来——车机起不来在演示里等同于"这功能是假的"。
     * 但也不能装作没事：改名留证，下次启动就是干净的空白。
     */
    const broken = `${FILE}.broken-${Date.now()}`;
    try {
      renameSync(FILE, broken);
      console.warn(`[mock-cabin] 快照损坏（${String(err)}），已另存为 ${broken}，按空白启动`);
    } catch {
      console.warn(`[mock-cabin] 快照损坏且无法改名（${String(err)}），按空白启动`);
    }
    return null;
  }
}

/** 防抖窗口：一次 apply 会连着推很多条 change，逐条写盘是纯浪费。 */
const DEBOUNCE_MS = 200;

let timer: NodeJS.Timeout | null = null;
let build: (() => Snapshot) | null = null;

/**
 * 标记"状态变了"。真正的写入延后合并，进程退出时兜底 flush。
 * 传的是**取快照的函数**而不是快照本身——防抖期间还会有新的变更，
 * 到期时现取才拿得到最终态。
 */
export function markDirty(snapshot: () => Snapshot): void {
  if (!FILE) return;
  build = snapshot;
  if (timer) return;
  // unref：这个定时器不该拖着进程不让退出（测试里尤其明显）
  timer = setTimeout(flush, DEBOUNCE_MS);
  timer.unref?.();
}

/** 立刻写盘（防抖到期、或进程要退出了）。同步写——退出钩子里没有 await 可用。 */
export function flush(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!FILE || !build) return;
  const snapshot = build();
  const tmp = `${FILE}.tmp`;
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(tmp, JSON.stringify(snapshot), "utf8");
    renameSync(tmp, FILE); // 原子替换：读者要么看到旧的完整快照，要么看到新的
  } catch (err) {
    console.warn(`[mock-cabin] 写入快照失败：${String(err)}`);
    try {
      unlinkSync(tmp);
    } catch {
      /* 清不掉临时文件不值得再报一次错 */
    }
  }
}

/**
 * 退出前兜底。
 *
 * `exit` 事件对 `process.exit()` 与自然退出有效，但**信号杀进程时不会触发**，
 * 而容器停服正是 SIGTERM——所以两者都要挂。信号处理器只做 flush 再退出，
 * 不改变退出语义（`dev:restart` 与 `docker stop` 都依赖它照常死掉）。
 */
export function installExitHooks(): void {
  if (!FILE) return;
  process.on("exit", flush);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      flush();
      process.exit(0);
    });
  }
}
