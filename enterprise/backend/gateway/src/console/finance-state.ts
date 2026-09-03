/**
 * 财务快照的落盘（形态照抄 mocks/cabin/src/persistence.ts）。
 *
 * 为什么要落盘：余额与账单的缓存原本只活在路由闭包里，而开发机的网关
 * 天天 `dev:restart`——每重启一次，下次开页就要全量打五家上游（其中高德
 * 那条探针还消耗当日额度）。落了盘，重启后页面能立刻给出"上一次看到的样子"，
 * 再在后台换新。
 *
 * 为什么不进 Postgres：这是**缓存不是账本**。丢了毫无损失（下次采集就有），
 * 为它建表、迁移、走 prisma 是拿对待业务数据的成本对待一份可再生的副本。
 * `var/` 是仓里运行时状态的既有位置（mock-cabin 的车辆状态就在那）。
 *
 * 安全前提：快照里没有任何密钥——finance.test.ts 有"响应里不得出现密钥"的
 * 断言守着，这里落的就是那个响应。若将来有人往快照里塞了凭据，先红的是那条测试。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { FinanceBillPage } from "./finance-providers";
import type { FinanceSnapshot } from "./finance";

/** 结构变了就升版本；旧版文件按空白处理，不做迁移——缓存不值得迁移。 */
const STATE_VERSION = 1;

export interface FinanceState {
  version: number;
  snapshot: { at: number; snapshot: FinanceSnapshot } | null;
  bills: Record<string, { at: number; page: FinanceBillPage }>;
}

export function emptyState(): FinanceState {
  return { version: STATE_VERSION, snapshot: null, bills: {} };
}

/** 默认路径相对 cwd 解析（与 mock-cabin 同约定）；环境变量可改。惰性读，避开 env-timing 不变量。 */
export function defaultStateFile(): string {
  return resolve(process.env.CARLIFE_FINANCE_STATE_FILE ?? "var/finance-cache.json");
}

export function loadState(file: string): FinanceState {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    // 首次启动没有文件是正常的，其它读取错误要说出来
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[finance] 读取快照失败，按空白启动：${String(err)}`);
    }
    return emptyState();
  }
  try {
    const parsed = JSON.parse(raw) as FinanceState;
    if (parsed?.version !== STATE_VERSION || typeof parsed.bills !== "object" || parsed.bills === null) {
      return emptyState();
    }
    return parsed;
  } catch (err) {
    // 坏文件不能让网关起不来，但也不能装作没事：改名留证，下次启动是干净的空白。
    const broken = `${file}.broken-${Date.now()}`;
    try {
      renameSync(file, broken);
      console.warn(`[finance] 快照损坏（${String(err)}），已另存为 ${broken}，按空白启动`);
    } catch {
      console.warn(`[finance] 快照损坏且无法改名（${String(err)}），按空白启动`);
    }
    return emptyState();
  }
}

/**
 * 先写临时文件再改名——进程在写一半时被杀（dev:stop 就是 kill）不该留下半个 JSON。
 * 写失败只告警不抛：落盘是锦上添花，不能让"磁盘满了"挡住余额查询本身。
 */
export function saveState(file: string, state: FinanceState): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, file);
  } catch (err) {
    console.warn(`[finance] 快照落盘失败（不影响本次查询）：${String(err)}`);
  }
}
