/**
 * 取一份镜头快照（施工单 M82-08）。
 *
 * 三种结局要分开：**有数据** / **服务不可用（两分型）** / **还在算**。
 * 合成一个 `loading | error` 会让"这个部署没启用研究面"和"接口挂了"
 * 长成同一张脸。
 */

import { useEffect, useState } from "react";

import { api, ApiError } from "../../../api";
import type { SnapshotEnvelope } from "./model";

export type SnapshotState<D> =
  | { kind: "loading" }
  /** 快照还没算出来（上游 202）——不是错误，刷新一下就有。 */
  | { kind: "computing" }
  | { kind: "unavailable"; code: string }
  | { kind: "ready"; snapshot: SnapshotEnvelope<D> }
  | { kind: "error"; message: string };

export function useSnapshot<D>(lens: string): SnapshotState<D> {
  const [state, setState] = useState<SnapshotState<D>>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });

    api
      .get<{ snapshot?: SnapshotEnvelope<D>; status?: string }>(`/console/research/snapshots/${lens}`)
      .then((body) => {
        if (!alive) return;
        if (body.snapshot) setState({ kind: "ready", snapshot: body.snapshot });
        else setState({ kind: "computing" });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (err instanceof ApiError) {
          // 503 的两个 code 原样带给页面，由它说成两句话。
          if (err.status === 503) {
            setState({ kind: "unavailable", code: err.code });
            return;
          }
          setState({ kind: "error", message: `${err.status} ${err.code}` });
          return;
        }
        setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      });

    return () => {
      alive = false;
    };
  }, [lens]);

  return state;
}
