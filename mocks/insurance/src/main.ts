/**
 * 进程入口（施工单 M41-02）。与 index.ts 分开的理由同 mock-dealer/mock-repair。
 */
import { createInsuranceServer, POLICIES } from "./index";

const PORT = Number(process.env.MOCK_INSURANCE_PORT ?? 8798);

createInsuranceServer().listen(PORT, () => {
  // 数字要打出来：种子没加载成功时，"起来了"和"起来了但是空的"看起来一样。
  console.log(`[mock-insurance] listening on :${PORT} (policies=${POLICIES.length})`);
});
