/**
 * 定位授权 + 取一次位置。车机与手机**共用这一个 hook**，行为不会走岔。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  DEFAULT_LOCATION_CONSENT,
  type LocationConsent,
  type LocationFix,
  type LocationPrecision,
} from "@carlife/shared";

import { acquireRawFix } from "./acquire";
import {
  getLocationPort,
  publishLocationState,
  subscribeLocationState,
  type LocationSnapshot,
} from "./port";

export type LocationStatus = "loading" | "idle" | "locating" | "error";

export interface UseLocationResult {
  /** 端上状态读回来了没有。没读回来之前**不要渲染开关**——那一瞬间它显示的是默认值。 */
  ready: boolean;
  consent: LocationConsent;
  fix: LocationFix | null;
  status: LocationStatus;
  /** 上一次失败的原因，人话。成功一次即清。 */
  error: string | null;
  locate: () => Promise<LocationFix | null>;
  setEnabled: (enabled: boolean) => Promise<void>;
  setPrecision: (precision: LocationPrecision) => Promise<void>;
}

export interface UseLocationOptions {
  /**
   * 拿到授权后自动定位一次（默认 **true**）。
   *
   * 用户打开开关的意思就是"可以知道我在哪了"，还要他再点一次"定位"是多余的一步；
   * 而开关打开却什么都没发生，看起来像开关没生效。
   */
  locateOnEnable?: boolean;
}

export function useLocation(options: UseLocationOptions = {}): UseLocationResult {
  const { locateOnEnable = true } = options;
  const [snapshot, setSnapshot] = useState<LocationSnapshot | null>(null);
  const [status, setStatus] = useState<LocationStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  /** 卸载后不再 setState（定位是秒级的，用户很可能已经切走了）。 */
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void getLocationPort()
      .getState()
      .then((s) => {
        if (!alive.current) return;
        setSnapshot(s);
        setStatus("idle");
      })
      .catch(() => {
        if (!alive.current) return;
        // 读不到就按默认（关）呈现：**宁可显示"没开"也不要显示"开着"**——
        // 后者是在告诉用户一件没发生的事。
        setSnapshot({ consent: { ...DEFAULT_LOCATION_CONSENT }, viewport: null, lastFix: null });
        setStatus("idle");
      });
    /*
     * 别处（设置页 / HUD 按钮）改了状态就跟着变。
     *
     * 车机端切到设置页时 HUD 仍然挂着，所以"挂载时读一次"是不够的——
     * 少了这条订阅，用户在设置里刚打开定位，切回主页点定位按钮会被告知
     * "定位已停用，去设置里打开"，而他刚从那儿过来。
     */
    const unsubscribe = subscribeLocationState((next) => {
      if (alive.current) setSnapshot(next);
    });

    return () => {
      alive.current = false;
      unsubscribe();
    };
  }, []);

  const locate = useCallback(async (): Promise<LocationFix | null> => {
    const port = getLocationPort();
    const current = await port.getState();
    if (!current.consent.enabled) {
      if (alive.current) {
        setSnapshot(current);
        setError("定位已停用");
        setStatus("error");
      }
      return null;
    }
    if (alive.current) {
      setStatus("locating");
      setError(null);
    }
    try {
      const raw = await acquireRawFix(current.consent.precision);
      // 加工与落盘都在端口里（模糊粒度在那儿丢小数位）——这里只负责把结果拿回来。
      const fix = await port.recordFix(raw);
      publishLocationState({ ...current, lastFix: fix });
      if (alive.current) setStatus("idle");
      return fix;
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
      return null;
    }
  }, []);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      const next = await getLocationPort().setEnabled(enabled);
      publishLocationState(next);
      if (!alive.current) return;
      setError(null);
      setStatus("idle");
      if (enabled && locateOnEnable) await locate();
    },
    [locate, locateOnEnable],
  );

  const setPrecision = useCallback(
    async (precision: LocationPrecision) => {
      const next = await getLocationPort().setPrecision(precision);
      publishLocationState(next);
      if (!alive.current) return;
      // 粒度变了，屏幕上那个点也该跟着变——不重取的话，选了"精确"之后
      // 显示的还是刚才那个被取整过的坐标，看起来像没生效。
      if (next.consent.enabled) await locate();
    },
    [locate],
  );

  return {
    ready: snapshot !== null,
    consent: snapshot?.consent ?? DEFAULT_LOCATION_CONSENT,
    fix: snapshot?.lastFix ?? null,
    status,
    error,
    locate,
    setEnabled,
    setPrecision,
  };
}
