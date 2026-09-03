/**
 * 会话的行程摘要（网关 `/console/sessions` 每行带的 `trip`）与它的一句话文案。
 * 纯模块：`index.tsx` 带 CSS import，node:test 里 import 不了，所以拆到这里测。
 */

export interface SessionTrip {
  planId: string;
  status: "confirmed" | "cancelled";
  destination: string;
  days: number;
  startDate?: string;
  endDate?: string;
  committedAt: string;
  /** 各天主题，列表上一眼看出"去哪玩"。 */
  themes: string[];
}

/**
 * 列表行与详情头上的行程一句话：`嘉兴 · 1 天 · 9/3 出发`。
 * 已取消的也显示——运营要看的正是"这条对话定过什么、后来怎么了"，藏掉等于改写历史。
 */
export function tripChipText(t: SessionTrip): string {
  const bits = [t.destination, `${t.days} 天`];
  if (t.startDate) {
    const [, m, d] = t.startDate.split("-");
    bits.push(`${Number(m)}/${Number(d)} 出发`);
  }
  return bits.join(" · ");
}
