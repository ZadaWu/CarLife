/**
 * 提示词提权（TD-08 的那道门，2026-09-15 抽成 hook 供研发 / 业务两个视图共用）。
 *
 * # 两个视图一道门
 *
 * 提示词 ≈ 整段对话原文；`/console/replay/:id` 默认把 `text` 挖掉，只留长度，
 * 看原文走 `/console/replay/:id/reveal`——**每次都写审计，审计写不进去就拒绝放行**。
 * 业务视图里"这位专家收到什么任务"也是同一份提示词，所以走同一个 hook：
 * 各写一份就会有一份更宽，而更宽的那份就是绕过审计的后门。
 *
 * # 按 (agent, at) 对回
 *
 * reveal 返回的是整个会话的提示词；页面上的那一条靠 `agent` + 时刻定位——
 * 轨迹事件的 `at` 与 reveal 行的 `at` 是同一个落库时间戳。
 */

import { useCallback, useState } from "react";

import { api, ApiError } from "../../api";

export interface PromptRow {
  at: number;
  turnId?: string;
  agent: string;
  chars: number;
  text?: string;
  textOmitted?: boolean;
  truncated?: true;
}

export interface PromptReveal {
  revealed: boolean;
  busy: boolean;
  error: string | null;
  reveal: () => Promise<void>;
  /** 提权后按 (agent, at) 取原文；未提权或对不上时 undefined。 */
  textOf: (agent: string, at: number) => string | undefined;
}

export function usePromptReveal(sessionId: string): PromptReveal {
  const [rows, setRows] = useState<PromptRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reveal = useCallback(async (): Promise<void> => {
    if (!window.confirm("查看提示词原文将被记入审计（谁、何时、看了哪个会话）。继续？")) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ prompts: PromptRow[] }>(
        `/console/replay/${encodeURIComponent(sessionId)}/reveal`,
        {},
      );
      setRows(r.prompts);
    } catch (e) {
      // 审计不可用时提权被拒——这是设计（保护用户隐私），不是故障
      setError(
        e instanceof ApiError && e.code === "audit_unavailable"
          ? "审计不可用，已拒绝提权：没有留痕的查看不被允许。"
          : String(e),
      );
    } finally {
      setBusy(false);
    }
  }, [sessionId]);

  const textOf = useCallback(
    (agent: string, at: number): string | undefined =>
      rows?.find((x) => x.at === at && x.agent === agent)?.text,
    [rows],
  );

  return { revealed: rows !== null, busy, error, reveal, textOf };
}
