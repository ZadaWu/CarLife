/**
 * 会话检索的筛选参数（「会话与对话」页与演示大屏的选择器**共用同一份**）。
 *
 * # 为什么是纯函数，而且必须有测试
 *
 * 这里只有一件会错的事：**把人选的那一天换算成时间点**。
 * `<input type="date">` 给的是 `2026-08-31` 这样的日期串，而接口要的是时间点。
 * 直接 `new Date("2026-08-31")` 按规范是 **UTC 零点**——东八区的人选了 8-31，
 * 实际筛的是北京时间 8-31 08:00 起，白天前八小时的会话全被切掉，
 * 而界面上只写着"8-31 起"，没有任何地方能看出来差了八小时。
 *
 * 更要命的是"止"那一侧：把 `2026-08-31` 当成 `lte` 的边界，
 * 等于"截到 8-31 零点"——**选了 8-31 却看不到 8-31 当天的任何会话**。
 * 这类错在演示现场表现为"这一天什么都没有"，而其实是筛错了。
 *
 * 所以两侧都在**本地时区**上取整天：起 = 当天 00:00:00.000，止 = 当天 23:59:59.999。
 * 人选日期时想的就是本地的那一天。
 */

/** 日期串（`YYYY-MM-DD`）→ 本地当天 00:00:00.000 的 ISO 时间点；空串返回 undefined。 */
export function dayStartIso(day: string): string | undefined {
  const parts = splitDay(day);
  if (!parts) return undefined;
  const [y, m, d] = parts;
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

/** 日期串 → 本地当天 23:59:59.999 的 ISO 时间点；空串返回 undefined。 */
export function dayEndIso(day: string): string | undefined {
  const parts = splitDay(day);
  if (!parts) return undefined;
  const [y, m, d] = parts;
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}

function splitDay(day: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // 不接受 2026-13-40 这种：`new Date` 会把它顺延成另一天，而人以为筛的是自己填的那天。
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const probe = new Date(y, mo - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return null;
  return [y, mo, d];
}

export interface SessionFilters {
  /** 归属账号，精确。 */
  userId?: string;
  /** 会话 id，**精确定位**（接口按等值查，不是模糊搜）。 */
  sessionId?: string;
  /** 标题，模糊。**没起名的会话一条都不会命中**（标题是首轮之后才生成的）。 */
  title?: string;
  /** 起始日（`YYYY-MM-DD`，本地时区当天 00:00 起）。按会话**创建时间**筛。 */
  since?: string;
  /** 截止日（`YYYY-MM-DD`，本地时区当天 23:59:59.999 止）。 */
  until?: string;
}

/**
 * 拼查询串。空白一律当没填——`trim()` 后为空的条件不进 URL，
 * 否则一个只按了空格的输入框会变成一条真实的筛选条件。
 */
export function sessionQuery(
  f: SessionFilters,
  extra: Record<string, string> = {},
): URLSearchParams {
  const q = new URLSearchParams(extra);
  const put = (k: string, v?: string): void => {
    const t = v?.trim();
    if (t) q.set(k, t);
  };
  put("userId", f.userId);
  put("sessionId", f.sessionId);
  put("title", f.title);
  put("since", f.since ? dayStartIso(f.since) : undefined);
  put("until", f.until ? dayEndIso(f.until) : undefined);
  return q;
}

/** 有没有任何筛选条件（决定「清空」按钮出不出现、空态说哪一句）。 */
export function hasFilters(f: SessionFilters): boolean {
  return [f.userId, f.sessionId, f.title, f.since, f.until].some((v) => Boolean(v?.trim()));
}
