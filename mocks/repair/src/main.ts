/**
 * 进程入口（施工单 M41-01）。
 *
 * 与 `index.ts` 分开的理由同 mock-dealer：测试要能 import 工厂而不触发监听。
 */
import { createRepairServer } from "./index";
import { STATIONS, HISTORY, SEED_QUOTES } from "./store";

const PORT = Number(process.env.MOCK_REPAIR_PORT ?? 8797);

createRepairServer().listen(PORT, () => {
  // 数字要打出来：种子没加载成功时，"起来了"和"起来了但是空的"看起来一样。
  console.log(
    `[mock-repair] listening on :${PORT} (stations=${STATIONS.length}, history=${HISTORY.length}, quotes=${SEED_QUOTES.length})`,
  );
});
