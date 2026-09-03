/**
 * M21 验收探针 —— 购车售前咨询（配置比较 / 贷款 / 保险）。
 *
 * # 它为什么不走网关
 *
 * 这个 Sprint 的判定几乎全在**编排层与工具层**：路由判到哪、配置表几行、
 * 月供多少、保费是不是区间、两处保险数字对不对得上。这些都不需要真实 LLM——
 * 起全套服务再问一句话，既慢又贵，而且模型的措辞会把"数据对不对"这件事搅浑。
 *
 * 所以这里用一个"只输出 [答]"的假应答流跑真图：**真路由、真工具、真数据**，
 * 只是不花钱在生成上。要验"模型说得对不对"是另一件事，见 `smoke:acp`。
 *
 * # 判据写在输出里
 *
 * 每一行前面的 ✓/✗ 就是判据本身。**不要只看它有没有跑完**——
 * 这个 Sprint 最容易骗过人的失败形态是"链路全通、数字是错的"。
 *
 * 前置：`corepack pnpm dev:start mock-dealer`（否则配置与价格拿不到，会明确报出来）。
 * RAGFlow 缺省时出处栏为空，**这是如实降级，不算失败**。
 */

import { createRagClient } from "../../../enterprise/backend/shared/rag/src/index";
import {
  createHttpDealerBackend,
  setDealerBackend,
  setRagClient,
} from "../../../enterprise/backend/shared/tools/src/index";
import { decideRoute } from "../../../enterprise/backend/agent-runtime/src/graph/route";
import { scopeCaveats } from "../../../enterprise/backend/agent-runtime/src/graph/subgraphs/buying";
import { buildChatGraph } from "../../../enterprise/backend/agent-runtime/src/graph/supervisor";
import type { Intent } from "../../../enterprise/backend/agent-runtime/src/graph/state";

let failed = 0;
const check = (ok: boolean, line: string): void => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${line}`);
};

const dealerUrl = process.env.MOCK_DEALER_URL ?? "http://127.0.0.1:8792";
setDealerBackend(createHttpDealerBackend(dealerUrl));

if (process.env.RAGFLOW_BASE_URL && process.env.RAGFLOW_API_KEY) {
  setRagClient(
    createRagClient({
      baseUrl: process.env.RAGFLOW_BASE_URL,
      apiKey: process.env.RAGFLOW_API_KEY,
      datasetIds: {
        "vehicle-manuals": process.env.RAGFLOW_DATASET_VEHICLE_MANUALS ?? "",
        "repair-kb": process.env.RAGFLOW_DATASET_REPAIR_KB ?? "",
        "car-catalog": process.env.RAGFLOW_DATASET_CAR_CATALOG ?? "",
      },
    }),
  );
} else {
  console.log("ⓘ 无 RAGFLOW_*：出处栏会是空的。**这是如实降级，不算失败**。\n");
}

const intent = (goal: string): Intent => ({ goal, constraints: [], context: "", riskBoundary: "" });

console.log("【判定 1 / 2 / 5】路由：这几句到不到得了购车顾问");
for (const [text, expect] of [
  ["Model Y 这几个配置差在哪", "buying"],
  ["顶配和低配差多少", "buying"],
  // 这一句曾被判到用车助手——去翻一辆他还没买的车的说明书。
  ["长续航版值不值多花两万", "buying"],
  ["保险一年多少", "buying"],
  ["Model Y 五年下来一共花多少", "buying"],
  // 反向红线：这两句必须**留在原处**。
  ["我这车续航掉得快", "ownership"],
  ["保养一次多少钱", "service"],
] as const) {
  const r = decideRoute(intent(text), text);
  check(r.agent === expect, `${r.agent.padEnd(10)} ${text}`);
}

const graph = buildChatGraph(
  async function* () {
    yield "[答]";
  },
  { enableIntent: false },
);
const run = (threadId: string, content: string) =>
  graph.invoke(
    { messages: [{ role: "user", content }] },
    { configurable: { thread_id: threadId, userId: "u1", emit: { onDelta: () => {} } } },
  );

const s = await run(
  `m21-${process.pid}`,
  "Model Y 这几个配置差在哪，首付八万分36期月供多少，保险一年多少，五年下来一共花多少",
);

console.log("\n【判定 1】配置摊开");
check((s.trimPlan?.rows.length ?? 0) === 4, `Model Y 摊开 ${s.trimPlan?.rows.length ?? 0} 个配置（应当 4）`);
for (const r of s.trimPlan?.rows ?? []) {
  console.log(`      ${r.trim}：${r.priceCny} 元 / ${r.rangeKm}km / ${r.seats}座`);
}

console.log("\n【判定 5】配置级事实真的被填了（这条曾经是假绿的）");
const trimSpecs = s.buyingPlan?.candidates?.[0]?.trimSpecs ?? [];
check(trimSpecs.length > 0, `候选带 ${trimSpecs.length} 条 trimSpecs——为 0 就说明座位判定又在走车型级回落`);
const seatItem = s.insurancePlan?.quote.items.find((i) => i.key === "passenger");
check(
  /5 座/.test(seatItem?.label ?? ""),
  `座位险按「${seatItem?.label ?? "—"}」算——按 6 座就是把 Model Y L 的属性顶给了整款车`,
);

console.log("\n【判定 6 / 7】贷款");
const b = s.loanPlan?.breakdown;
check(b !== undefined, "产生了 loanPlan");
check(
  b?.annualRate.source === "assumed" && b.equalInstallment.monthlyPayment.low < b.equalInstallment.monthlyPayment.high,
  `原话没给利率 → 利率来源 ${b?.annualRate.source}，月供是区间 ${b?.equalInstallment.monthlyPayment.low}~${b?.equalInstallment.monthlyPayment.high}`,
);
check(
  (b?.equalPrincipal.totalInterest.low ?? Infinity) < (b?.equalInstallment.totalInterest.low ?? 0),
  "等额本金总利息低于等额本息",
);

console.log("\n【判定 8】保险分项与区间");
const q = s.insurancePlan?.quote;
check((q?.items.length ?? 0) >= 6, `${q?.items.length ?? 0} 个分项`);
check(
  (q?.items ?? []).filter((i) => i.key.startsWith("thirdParty")).length === 3,
  "三者险按 100 / 200 / 300 万三档分别给",
);
check(q?.usable === true && q.total !== undefined, `合计是区间 ${q?.total?.low}~${q?.total?.high}`);
for (const i of q?.items ?? []) console.log(`      ${i.label}：${i.amount.low}~${i.amount.high}`);

console.log("\n【判定 9】同一轮里保险口径唯一");
const mid = q?.total ? Math.round((q.total.low + q.total.high) / 2) : undefined;
check(
  s.costPlan?.breakdown.assumptions.insuranceFirstYear === mid,
  `五年成本的首年保险 ${s.costPlan?.breakdown.assumptions.insuranceFirstYear} = 分项合计中位 ${mid}`,
);

console.log("\n【判定 4】无人民币报价不换算");
const ct = await run(`m21-ct-${process.pid}`, "选车：Cybertruck 这几个配置差在哪");
const leaked = JSON.stringify(ct.trimPlan?.rows ?? []).match(/\d{5,}/);
check(!leaked, leaked ? `输出里冒出了金额 ${leaked[0]}` : "配置行里没有任何人民币金额");
check(
  (ct.trimPlan?.unpricedModels.length ?? 0) > 0,
  ct.trimPlan?.unpricedModels?.[0]?.note ?? "没有如实说明无人民币报价",
);

console.log("\n【判定 11】行情侧护栏（这几句必须仍然答不了）");
for (const t of ["落地价多少", "裸车价能谈到多少", "现在有优惠吗", "有现车吗", "现在贷款利率多少", "上牌费多少"]) {
  check(scopeCaveats(t).length > 0, `答不了：${t}`);
}
console.log("【判定 11 反面】算术侧必须放行");
for (const t of ["首付八万月供多少", "分36期每月还多少", "保险一年多少"]) {
  check(scopeCaveats(t).length === 0, `放行：${t}`);
}

console.log(
  failed === 0
    ? "\n✅ 全部判据通过。剩下的第 12 条（购车页人工走查）这里验不了，见 内部文档"
    : `\n❌ ${failed} 条判据没过。**不要只看它跑完了**——这个 Sprint 最容易骗过人的失败形态是"链路全通、数字是错的"。`,
);
process.exit(failed === 0 ? 0 : 1);
