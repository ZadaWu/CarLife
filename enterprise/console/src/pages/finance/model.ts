/**
 * 财务页的判断逻辑，与渲染分开。
 *
 * 抽出来不是为了整洁，是为了**能被断言**：这一页最容易悄悄退化的三处判断
 * 都在这里——默认选中谁、空表格是哪一种空、合计该不该算。
 * 三条里任何一条错了，页面都照样渲染得好好的，只是说的话不再是真的
 * （记忆浏览页就这么把"未接线"和"0 条"合并成过一句谎话，见 memory-page.test.ts）。
 */

export type FinanceStatus = "ok" | "unconfigured" | "failed";
export type FinanceLevel = "ok" | "warn" | "danger";
export type BillsStatus = "ok" | "unsupported" | "unconfigured" | "failed";

export interface FinanceAccount {
  id: string;
  label: string;
  kind: "balance" | "subscription" | "quota";
  status: FinanceStatus;
  amount?: number;
  currency?: string;
  exact: boolean;
  level?: FinanceLevel;
  detail: Array<{ label: string; value: string }>;
  note?: string;
  consoleUrl: string;
  durationMs: number;
  error?: string;
  billsSupported?: boolean;
}

export interface FinanceSnapshot {
  checkedAt: string;
  cached: boolean;
  /** stored=1 快路径给的"上次的样子"——页面要标出来它不是现查的。 */
  stored?: boolean;
  ttlMs: number;
  thresholds: { warnCny: number; dangerCny: number };
  accounts: FinanceAccount[];
  note: string;
}

export interface FinanceBill {
  period: string;
  item: string;
  amount?: number;
  currency: string;
  status?: string;
  note?: string;
  link?: string;
}

export interface FinanceBillPage {
  accountId: string;
  status: BillsStatus;
  rows: FinanceBill[];
  coverage: string;
  note?: string;
  error?: string;
  consoleUrl: string;
  durationMs: number;
  cached?: boolean;
  stored?: boolean;
}

/**
 * 默认落在**第一个账单可查**的账户上。
 * 默认选一家查不了的，首屏就是一张空表，看的人第一反应是"这功能坏了"。
 */
export function defaultAccountId(accounts: FinanceAccount[]): string | null {
  return (accounts.find((a) => a.billsSupported) ?? accounts[0])?.id ?? null;
}

/**
 * 空表格是哪一种空。四种成因长得一模一样，处置动作完全不同：
 *   unsupported  这家压根没有账单接口   → 去控制台人工看
 *   unconfigured 没配凭据               → 去填环境变量
 *   failed       调用失败               → 看报错
 *   none         接口通、确实没花钱     → 什么都不用做
 * 合并成一句"暂无数据"就是把线索抹掉。
 */
export function emptyKind(page: FinanceBillPage): BillsStatus | "none" {
  return page.status === "ok" ? "none" : page.status;
}

export interface BillsTotal {
  total: number;
  currency: string;
  pricedCount: number;
  unpricedCount: number;
  /** 币种不一（人民币账单里混进美元订阅）时不给合计——加起来的数没有意义。 */
  mixedCurrency: boolean;
}

export function billsTotal(rows: FinanceBill[]): BillsTotal {
  // 金额缺省的行（RAGFlow 那种"金额见 Stripe 发票"）**不能当 0 加进去**：
  // 那会让合计看起来很精确，实际漏掉了一整笔。
  const priced = rows.filter((r) => r.amount !== undefined);
  return {
    total: priced.reduce((sum, r) => sum + (r.amount ?? 0), 0),
    currency: priced[0]?.currency ?? "CNY",
    pricedCount: priced.length,
    unpricedCount: rows.length - priced.length,
    mixedCurrency: new Set(priced.map((r) => r.currency)).size > 1,
  };
}

/**
 * 大数字位置放不了金额时写什么。
 * 刻意**不写"已读取"**——读到了却不给数字，看的人只会以为页面坏了；
 * 要说的是"这家根本就没有余额这个口径"，那是事实不是故障。
 */
export function amountFallback(a: FinanceAccount): string {
  if (a.status === "unconfigured") return "未配置凭据";
  if (a.status === "failed") return "读取失败";
  return a.kind === "subscription" ? "订阅制 · 无余额口径" : "余量不可查（见下）";
}

/** 有确切金额才显示大数字；`exact=false`（高德）任何时候都不许渲染成数字。 */
export function showsAmount(a: FinanceAccount): boolean {
  return a.status === "ok" && a.exact && a.amount !== undefined;
}

export function levelClass(a: FinanceAccount): string {
  if (a.status === "unconfigured") return "fin-card--muted";
  if (a.status === "failed" || a.level === "danger") return "fin-card--danger";
  if (a.level === "warn") return "fin-card--warn";
  return "fin-card--ok";
}

/**
 * 快照的年龄，给"上次快照 · N 分钟前"用。
 * 时间倒挂（服务器时钟快于本机）按"刚刚"处理——给人看负数只会引发误报。
 */
export function ageLabel(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "刚刚";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}
