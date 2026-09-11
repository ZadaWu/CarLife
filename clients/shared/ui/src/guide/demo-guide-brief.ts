/**
 * 导览页的**版式截图入口**（`?guide=demo`），与 `?profile=demo` / `?hitl=demo` 同一类。
 *
 * 住在共享包：两端共用同一个 `GuideScreen`，演示数据也是同一份。
 *
 * 为什么需要它：真实简报要经网关 → runtime → 联网检索，冷启实测约 50 秒，浏览器走查里
 * 拿不到（没有车辆凭证，网关直接 401）。于是导览页的 **ready 态在走查里根本进不去**，
 * 只能看到「未查到」——改完版式没有任何地方可以验。
 *
 * **数据自带「（演示）」字样**，与 `DEMO_TRIP_PLAN` 同一条纪律：截图里的内容一眼看得出
 * 不是真查来的。出处一律留空——`GuideSpotItem.source` 只有过了全等校验才允许有值，
 * 编一个 URL 进去等于把那道校验绕过去（见 `guide.ts` 该字段的注释）。
 */
import type { GuideBrief } from "@carlife/shared";

export function isGuideDemo(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("guide") === "demo";
}

export const DEMO_GUIDE_BRIEF: GuideBrief = {
  spot: "广州塔（演示）",
  city: "广州",
  selfDrive: true,
  access: {
    parking: [],
    charging: [],
    refuel: [],
    arrivalAdvice: "自驾从赤岗塔路进，塔下停车场约 300 个车位，节假日建议 10 点前到（演示）",
  },
  spots: [
    { name: "一层观光大厅（演示）", kind: "spot", reason: "先取票，人少时直接上塔" },
    { name: "107 层白云星空观景平台（演示）", kind: "spot", reason: "玻璃地板在这一层，恐高的绕外圈走" },
    { name: "488 米摩天轮（演示）", kind: "spot", reason: "单圈约 20 分钟，需另购票" },
    { name: "433 米户外旋转餐厅（演示）", kind: "spot", reason: "下午茶时段人最少" },
    { name: "塔底花城广场（演示）", kind: "photo", reason: "灯光秀 19:45 开始，广场东侧视野最好" },
    { name: "二层纪念品店（演示）", kind: "spot", reason: "下塔顺路，不用折返" },
  ],
  routeOrderSource: "editorial",
  transportAdvice: "塔内高速电梯 + 步行，全程无需摆渡车（演示）",
  comfort: [
    { kind: "food", name: "433 旋转餐厅（演示）", note: "人均 300 元起，需提前订" },
    { kind: "rest", name: "107 层休息区（演示）", note: "有座位，可以等日落" },
    { kind: "toilet", name: "每层电梯厅旁（演示）", note: "107 层的最干净" },
    { kind: "pitfall", name: "塔下扫码票（演示）", note: "比官方渠道贵，且不能改签" },
    { kind: "pitfall", name: "傍晚上塔排队（演示）", note: "17:30–19:00 最挤，能错开就错开" },
  ],
  caveats: ["这是版式截图用的演示数据，不是真实检索结果。"],
  findings: [],
  branchSources: { access: "missing", spots: "missing", comfort: "missing" },
  sourcesVerified: { matched: 0, claimed: 0 },
  generatedAt: new Date().toISOString(),
};
