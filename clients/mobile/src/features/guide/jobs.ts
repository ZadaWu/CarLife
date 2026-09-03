/**
 * features/guide — 导览采集任务面取数（施工单 M40-03，数据面 ACR-008）。
 *
 * 形态照本目录 `api.ts`：JS 只封装 invoke（网络在 Rust），浏览器走查回落 `/v1` 代理。
 * 节流与乐观是 `@carlife/ui` 的共享纯逻辑（jobs-logic）——与车机一字一样。
 */

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

import type { GuideJobsResponse, GuideJobsStatus } from "@carlife/shared";
import { GUIDE_JOBS_POLL_MS, applyGuideFetchOptimistic, shouldPollGuideJobs } from "@carlife/ui";

import { devFetch } from "../../devAuth";

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function fetchJobs(): Promise<GuideJobsStatus | null> {
  const raw = isTauriEnv()
    ? await invoke<string>("get_guide_jobs")
    : await (
        await devFetch("/v1/guide/jobs")
      ).text();
  return (JSON.parse(raw) as GuideJobsResponse).jobs ?? null;
}

async function postTrigger(spotName: string): Promise<void> {
  if (isTauriEnv()) {
    await invoke<string>("trigger_guide_job", { bodyJson: JSON.stringify({ spotName }) });
  } else {
    await devFetch("/v1/guide/jobs/trigger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spotName }),
    });
  }
}

/**
 * `active` = 面板此刻可见（HUD 层、导览页关着）。不可见不拉不轮——
 * 手机端切到对话/档案时后台任务照跑，回来首拉自然对上。
 */
export function useGuideJobs(active: boolean) {
  const [jobs, setJobs] = useState<GuideJobsStatus | null>(null);
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    if (busyRef.current) return; // 上一发未归不叠发
    busyRef.current = true;
    try {
      setJobs(await fetchJobs());
    } catch {
      // 轮询面不出声：拿不到保持上一份
    } finally {
      busyRef.current = false;
    }
  }, []);

  // 首拉：面板重新可见时刷一次
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  // 节流轮询：可见 + 有在途任务才 10s 一轮（共享规则，总览约束 1）
  useEffect(() => {
    if (!active || !shouldPollGuideJobs(jobs)) return;
    const t = setInterval(() => void refresh(), GUIDE_JOBS_POLL_MS);
    return () => clearInterval(t);
  }, [active, jobs, refresh]);

  const fetchSpot = useCallback(
    (spotName: string) => {
      // 乐观置 pending（按了要有反应）；真相以响应后的刷新为准
      setJobs((cur) => (cur ? applyGuideFetchOptimistic(cur, spotName) : cur));
      void postTrigger(spotName)
        .catch(() => {}) // 失败由下一拍刷新如实纠正
        .finally(() => void refresh());
    },
    [refresh],
  );

  return { jobs, fetchSpot, refresh };
}
