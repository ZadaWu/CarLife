/**
 * 官方警报代码表的本地查表（施工单 M80-10）。
 *
 * # 为什么是查表，不是检索
 *
 * `VCFRONT_a004` 是**精确键**，不是一句话。2026-09-10 真跑 turn-3cf7fe2a 实测：一张警报页 5 条代码，
 * 把代码与标题一起拼进向量检索词后整条查询被稀释，回来的是软件更新、洗车模式、月检清单——
 * 而其中 `APP_w009` 明明就在库里。精确键就该精确查。
 *
 * 与图标目录（`icon-catalog.ts`）同一条纪律：**含义与措施只能来自厂商的表**，模型不产出这些。
 * 区别只在图标要靠向量召回 + 闸门（形状认不准），代码是抄下来的字符串，对上就是对上。
 *
 * # 查不到是确定的答案
 *
 * 官方只公布了它选择公布的那一部分（126 条）。查不到时返回 null，下游必须说
 * 「这条代码手册里没有收录」——**这与"这次没检索到"完全不同**，后者会让人以为再试一次就有了。
 *
 * 表由 `corepack pnpm kb:alerts` 生成，落在 `data/kb-src/alerts/tesla-alerts.json`。
 * 取不到文件（容器里没挂 data/）就整个不启用，观察层照常读屏幕上的字，只是没有官方那一段。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface AlertCatalogEntry {
  /** 收录了这条代码的车型（`["Model 3", "Model Y"]`）。 */
  models: string[];
  /** 手册里记的屏幕文字，可能与车主那台车的固件版本略有出入。 */
  title: string;
  meaning: string[];
  action: string[];
}

export interface AlertCatalog {
  source: string;
  fetchedAt: string;
  size: number;
  /** 查不到返回 null——调用方据此说「手册里没有收录」。 */
  lookup(code: string): AlertCatalogEntry | null;
}

interface RawCatalog {
  source?: string;
  fetchedAt?: string;
  entries?: Record<string, AlertCatalogEntry>;
}

export const ALERT_CATALOG_FILE = "tesla-alerts.json";

/**
 * 从 `<root>/tesla-alerts.json` 读表。文件不在、读坏了都返回 null（不抛）——
 * 这一层是增强不是必需，缺了只是少一段官方解释，不该挡启动。
 */
export function loadAlertCatalog(root: string): AlertCatalog | null {
  const file = join(root, ALERT_CATALOG_FILE);
  if (!existsSync(file)) return null;
  let raw: RawCatalog;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as RawCatalog;
  } catch {
    return null;
  }
  const entries = raw.entries ?? {};
  const size = Object.keys(entries).length;
  if (size === 0) return null;
  return {
    source: raw.source ?? "未知来源",
    fetchedAt: raw.fetchedAt ?? "",
    size,
    // 代码大小写在屏幕上是固定的（`APP_w009`），但抄写时大小写偶有出入——按大写归一比对，别为这个漏一条。
    lookup(code) {
      const want = code.trim().toUpperCase();
      for (const [k, v] of Object.entries(entries)) if (k.toUpperCase() === want) return v;
      return null;
    },
  };
}
