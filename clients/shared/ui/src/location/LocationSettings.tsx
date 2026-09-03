/**
 * 「定位」设置组。**车机端与手机端共用这一个组件**——同一个用户在两块屏上
 * 对同一件事的授权界面必须长得一样、说的话一样，否则"我在手机上关过了"
 * 与"车机上还开着"就会同时成立。
 *
 * 三件事，从上到下：
 *  1. 用不用定位（总开关，默认关）；
 *  2. 用哪一档（模糊 / 精确）——**开着才出现**，关着的时候它没有意义；
 *  3. 现在拿到的是什么（坐标、精度、来源、时间）+ 手动再取一次。
 *
 * 第 3 项不是装饰：模糊定位与精确定位的差别肉眼看不见，把**实际交出去的那个
 * 坐标**摆在页面上，用户才有办法确认"模糊"真的是模糊的。
 */
import { useCallback } from "react";

import type { LocationFix, LocationPrecision } from "@carlife/shared";

import { hasNativeLocationPort } from "./port";
import { useLocation } from "./useLocation";

export interface LocationSettingsProps {
  /** 定位成功后回调（把地图挪过去、或提示一声）。 */
  onLocated?: (fix: LocationFix) => void;
  className?: string;
}

const PRECISION_COPY: Record<LocationPrecision, { label: string; hint: string }> = {
  coarse: {
    label: "模糊定位",
    hint: "只知道你在哪个片区（约 1 公里），够用来看天气、找附近的服务，但不知道你停在哪。",
  },
  precise: {
    label: "精确定位",
    hint: "米级位置，导航与「我旁边的充电桩」这类要它。随时可以改回模糊。",
  },
};

const SOURCE_LABEL: Record<string, string> = {
  gps: "卫星定位",
  network: "网络定位",
  ip: "按网络出口估算（城市级）",
  manual: "手动指定",
};

function formatFix(fix: LocationFix): string {
  // 小数位跟着粒度走：模糊坐标写成 6 位小数会让人以为它很准，
  // 而它后面几位本来就是我们取整补上的 0。
  const digits = fix.precision === "precise" ? 5 : 2;
  return `${fix.lat.toFixed(digits)}, ${fix.lon.toFixed(digits)}`;
}

function formatWhen(iso: string): string {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? "" : t.toLocaleString("zh-CN", { hour12: false });
}

export function LocationSettings({ onLocated, className }: LocationSettingsProps) {
  const loc = useLocation();

  const locateNow = useCallback(async () => {
    const fix = await loc.locate();
    if (fix) onLocated?.(fix);
  }, [loc, onLocated]);

  const toggle = useCallback(() => {
    void loc.setEnabled(!loc.consent.enabled).then(() => {
      // 打开开关会自动定位一次（useLocation 的默认行为），把结果带给调用方，
      // 让地图当场挪过去——否则用户看到的是"开了，然后什么都没发生"。
    });
  }, [loc]);

  // 端上状态还没读回来：**整组不渲染**。渲染的话那一瞬间显示的是默认值（关），
  // 用户会看到开关自己从关跳到开（与设置页对 Tauri 偏好的处理同一条纪律）。
  if (!loc.ready) return null;

  const { consent, fix, status, error } = loc;

  return (
    <div className={`cloc${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        className={`cloc-toggle${consent.enabled ? " is-on" : ""}`}
        role="switch"
        aria-checked={consent.enabled}
        onClick={toggle}
      >
        <span className="cloc-toggle__text">
          <span className="cloc-toggle__label">使用定位</span>
          <span className="cloc-toggle__hint">
            {consent.enabled
              ? "地图会停在你附近，附近的加油站、充电桩、门店才找得准。"
              : "关闭后不再获取你的位置，已经取到的也会一并删掉。地图仍然可以用，只是停在上次你自己拖到的地方。"}
          </span>
        </span>
        <span className="cloc-toggle__knob" aria-hidden="true" />
      </button>

      {consent.enabled && (
        <div className="cloc-precision" role="radiogroup" aria-label="定位精度">
          {(["coarse", "precise"] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={consent.precision === p}
              className={`cloc-choice${consent.precision === p ? " is-on" : ""}`}
              onClick={() => void loc.setPrecision(p)}
            >
              <span className="cloc-choice__label">{PRECISION_COPY[p].label}</span>
              <span className="cloc-choice__hint">{PRECISION_COPY[p].hint}</span>
            </button>
          ))}
        </div>
      )}

      {consent.enabled && (
        <div className="cloc-status">
          <div className="cloc-status__line">
            {status === "locating" ? (
              <span className="cloc-status__value">正在定位…</span>
            ) : fix ? (
              <>
                <span className="cloc-status__value">{formatFix(fix)}</span>
                <span className="cloc-status__meta">
                  {`±${Math.round(fix.accuracyM)} 米 · ${SOURCE_LABEL[fix.source] ?? fix.source}`}
                  {formatWhen(fix.at) ? ` · ${formatWhen(fix.at)}` : ""}
                </span>
              </>
            ) : (
              <span className="cloc-status__meta">还没有取到位置</span>
            )}
          </div>
          <button
            type="button"
            className="cloc-action"
            onClick={() => void locateNow()}
            disabled={status === "locating"}
          >
            {fix ? "重新定位" : "立即定位"}
          </button>
        </div>
      )}

      {/* 失败要说出来。定位失败最常见的原因（系统里没给这个 App 权限、
          车库里收不到卫星）用户自己能处理，闷着不说他只会以为功能坏了。 */}
      {error && status === "error" && <p className="cloc-error">定位失败：{error}</p>}

      {!hasNativeLocationPort() && (
        <p className="cloc-note">
          浏览器走查：这里的选择存在当前浏览器里，装到车机 / 手机上才会存进设备本身。
        </p>
      )}
    </div>
  );
}
