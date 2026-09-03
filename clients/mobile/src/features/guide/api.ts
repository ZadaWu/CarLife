/**
 * features/guide — 导览简报取数（施工单 M36-04）。
 *
 * 形态照 `features/ownership/api.ts`：JS 只封装 invoke，网络在 Rust
 * （`commands/profile.rs` 的 `get_guide_brief` → carlife-net）。
 * 浏览器走查形态（vite 直开 1420，无 Tauri 桥）回落 vite 的 `/v1` 代理——
 * 只在 dev 存在，release 客户端恒为 Tauri 环境。鉴权见 `devAuth`：
 * 走查者自己贴 token，原来硬编码的 `demo-token` 自 M48-02 起已被网关拒绝。
 */

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useRef, useState } from "react";

import { guideBriefIsEmpty, type GuideBriefResponse } from "@carlife/shared";

import { devFetch } from "../../devAuth";
import type { GuideScreenState } from "@carlife/ui";

export interface GuideRequestBody {
  spotName: string;
  city?: string;
  date?: string;
  selfDrive?: boolean;
  /** 「重新采集」：跳过服务端持久层，强制重采（2026-08-29）。 */
  force?: boolean;
}

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function requestGuideBrief(body: GuideRequestBody): Promise<GuideBriefResponse> {
  if (isTauriEnv()) {
    return JSON.parse(
      await invoke<string>("get_guide_brief", { bodyJson: JSON.stringify(body) }),
    ) as GuideBriefResponse;
  }
  const r = await devFetch("/v1/guide/brief", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { status: "failed" };
  return (await r.json()) as GuideBriefResponse;
}

/**
 * 导览页状态机：open(spot) → collecting → ready/failed；close 作废在途请求
 * （迟到结果按序号丢弃——旧请求的数据盖上新页面是最迷惑的一种错，同 cockpit）。
 */
export function useGuideBrief(context?: Omit<GuideRequestBody, "spotName">) {
  const [guide, setGuide] = useState<{ spot: string; state: GuideScreenState } | null>(null);
  const seqRef = useRef(0);
  const contextRef = useRef(context);
  contextRef.current = context;

  const open = useCallback((spotName: string, opts?: { force?: boolean }) => {
    const seq = ++seqRef.current;
    setGuide({ spot: spotName, state: { status: "collecting" } });
    void requestGuideBrief({
      spotName,
      selfDrive: true,
      ...contextRef.current,
      ...(opts?.force ? { force: true } : {}),
    })
      .catch(() => ({ status: "failed" }) as GuideBriefResponse)
      .then((resp) => {
        if (seqRef.current !== seq) return;
        setGuide((cur) =>
          cur && cur.spot === spotName
            ? {
                spot: spotName,
                state:
                  // 三支全空的"ready"按 failed 呈现（有重试钮），空栏目页不诚实。
                  resp.status === "ready" && resp.brief && !guideBriefIsEmpty(resp.brief)
                    ? { status: "ready", brief: resp.brief, cached: resp.cached }
                    : { status: "failed" },
              }
            : cur,
        );
      });
  }, []);

  const close = useCallback(() => {
    seqRef.current += 1;
    setGuide(null);
  }, []);

  return { guide, open, close };
}
