/**
 * 建档向导的纯逻辑（施工单 M14-05）。与 UI 分离，便于单测与两端复用。
 *
 * 校验规则与网关 `validateUpsert` 一致（Brief §2 表格）——两侧都做：
 * 端上给即时反馈，服务端是最后一道门。
 */

export type EnergyChoice = "bev" | "phev" | "icev" | "unknown";

export const ENERGY_CHOICES: Array<{ key: EnergyChoice; label: string; note?: string }> = [
  { key: "bev", label: "纯电" },
  { key: "phev", label: "插电混动" },
  { key: "icev", label: "燃油" },
  // "不确定"是合法状态（Brief §2）：不知道就是不知道，不暗示任何默认答案。
  { key: "unknown", label: "不确定", note: "之后可以在档案里补充" },
];

export interface WizardDraft {
  brand?: string;
  model?: string;
  modelYear?: number;
  /** 走了"找不到我的车"兜底时为 true——建档后档案标注目录外车型。 */
  offCatalog?: boolean;
  energy?: EnergyChoice;
  odometerKm?: number;
  /** 购车时间：只采集到月（Brief §2 步骤 4，避免无效精度）。 */
  purchaseYear?: number;
  purchaseMonth?: number;
}

export const WIZARD_STEPS = ["车型", "动力形式", "表显里程", "购车时间"] as const;

/** 逐步校验；返回错误文案或 null（可前进）。文案就是给用户看的，不是错误码。 */
export function validateStep(step: number, d: WizardDraft): string | null {
  switch (step) {
    case 0:
      if (!d.model?.trim()) return "请选择车型（可以搜索，找不到时走下方入口）";
      if (!d.modelYear) return "请选择年款";
      return null;
    case 1:
      // 必须主动选（含"不确定"）——默认不选，不暗示任何答案。
      return d.energy ? null : "请选择动力形式；不确定就选「不确定」";
    case 2:
      if (d.odometerKm === undefined || Number.isNaN(d.odometerKm)) return "请填写表显里程";
      if (d.odometerKm < 0) return "里程不能是负数";
      if (d.odometerKm > 2_000_000) return "这个里程明显超出合理范围，请确认表显读数";
      return null;
    case 3: {
      if (!d.purchaseYear || !d.purchaseMonth) return "请选择购车年月";
      const now = new Date();
      const picked = d.purchaseYear * 100 + d.purchaseMonth;
      const cur = now.getFullYear() * 100 + (now.getMonth() + 1);
      if (picked > cur) return "购车时间不能在未来";
      if (d.modelYear && d.purchaseYear < d.modelYear - 1) {
        return `购车时间早于 ${d.modelYear} 年款上市时间，请确认`;
      }
      return null;
    }
    default:
      return null;
  }
}

/** 组装 `POST /v1/vehicles` 请求体。调用前四步必须全部通过校验。 */
export function draftToCreateBody(d: WizardDraft): {
  model: string;
  modelYear: number;
  purchasedAt: number;
  odometerKm: number;
  energyType?: string;
} {
  return {
    // **不拼品牌前缀**（M14-07）。`Vehicle.model` 同时是检索侧的车型限定键，
    // 而 `documentMatchesModel` 是子串/边界匹配：存 "特斯拉 Model Y" 会让
    // `ModelY_车主手册.md` 一篇都匹配不到，于是这辆有资料的车反而被判成没资料。
    // 实测过。目录里的 model 就是那个键，原样落库。
    model: d.offCatalog ? `${d.model!.trim()}（目录外）` : d.model!.trim(),
    modelYear: d.modelYear!,
    // 只采集到月 → 取当月 1 号（服务端存 ms；精度语义在 Brief 定死）
    purchasedAt: Date.UTC(d.purchaseYear!, d.purchaseMonth! - 1, 1),
    odometerKm: d.odometerKm!,
    // "不确定" → 不传字段：undefined 是真实状态，不是待填的空缺。
    energyType: d.energy === "unknown" ? undefined : d.energy,
  };
}
