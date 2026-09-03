/**
 * 进程入口（施工单 M19-01）。
 *
 * 与 `index.ts` 分开是为了让测试能 `import { createDealerServer }` 而**不触发监听**——
 * 用 `import.meta.url === process.argv[1]` 之类的自启判断在 tsx/ESM 下路径形态不稳，
 * 分文件是这里唯一不会哪天悄悄失效的做法。
 */
import { createDealerServer } from "./index";
import { MODELS, STORES } from "./store";

const PORT = Number(process.env.MOCK_DEALER_PORT ?? 8792);

createDealerServer().listen(PORT, () => {
  // **数字要打出来**：种子没加载成功时，"起来了"和"起来了但是空的"看起来一样。
  console.log(`[mock-dealer] listening on :${PORT} (stores=${STORES.length}, models=${MODELS.length})`);
});
