/**
 * `LocationPort` 的 Tauri 实现：把 `@carlife/ui` 的读写口接到 Rust 侧
 * `carlife_core::location`（落盘在 app 数据目录的 `location.json`）。
 *
 * # 这一层只做两件事
 *
 * 1. **invoke**——`clients/shared/ui` 不 import `@tauri-apps/api`（它要能在 tsc /
 *    node:test / 浏览器里编译），所以适配器必须住在端里；
 * 2. **时间戳换算**——Rust 侧存 epoch 毫秒（那个 crate 不依赖 chrono，
 *    而自己拼一个假的 ISO 串比不写时间更糟），TS 侧契约是 ISO。换算就这一处。
 *
 * 判断、加工、权限门**都不在这里**：模糊化与"未授权拒绝记录"在 Rust 里，
 * 这层漏抄一行也不会削弱它们。车机端有一份镜像文件，两端逐字一致。
 */
import { invoke } from "@tauri-apps/api/core";
import type { LocationPort, LocationSnapshot, RawLocationFix } from "@carlife/ui";
import { normalizeViewport, type LocationFix, type LocationPrecision, type MapViewport } from "@carlife/shared";

/** Rust 侧的形状（serde camelCase）。只声明我们真正读的字段。 */
interface RustFix {
  lat: number;
  lon: number;
  accuracyM: number;
  precision: LocationPrecision;
  source: string;
  atMs: number;
}
interface RustViewport {
  lat: number;
  lon: number;
  zoom: number;
  atMs?: number | null;
}
interface RustState {
  consent: { enabled: boolean; precision: LocationPrecision; decidedAtMs?: number | null };
  viewport?: RustViewport | null;
  lastFix?: RustFix | null;
}

function iso(ms?: number | null): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function toFix(f: RustFix | null | undefined): LocationFix | null {
  if (!f) return null;
  return {
    lat: f.lat,
    lon: f.lon,
    accuracyM: f.accuracyM,
    precision: f.precision,
    // Rust 侧 source 是自由字符串（它不该为了一个展示标签定义枚举）；
    // 认不出来的值原样带过去，UI 那边显示原文而不是猜一个。
    source: f.source as LocationFix["source"],
    at: iso(f.atMs) ?? new Date().toISOString(),
  };
}

function toSnapshot(s: RustState): LocationSnapshot {
  return {
    consent: { enabled: s.consent.enabled, precision: s.consent.precision, decidedAt: iso(s.consent.decidedAtMs) },
    viewport: normalizeViewport(s.viewport ? { ...s.viewport, at: iso(s.viewport.atMs) } : null),
    lastFix: toFix(s.lastFix),
  };
}

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 不在 Tauri 里（浏览器走查）返回 `undefined`——上层会退回 localStorage 版端口，
 * 那一版是真能用的，不是空壳。
 */
export function createTauriLocationPort(): LocationPort | undefined {
  if (!isTauriEnv()) return undefined;
  return {
    async getState() {
      return toSnapshot(await invoke<RustState>("get_location_state"));
    },
    async setEnabled(enabled: boolean) {
      return toSnapshot(await invoke<RustState>("set_location_enabled", { enabled }));
    },
    async setPrecision(precision) {
      return toSnapshot(await invoke<RustState>("set_location_precision", { precision }));
    },
    async recordFix(raw: RawLocationFix) {
      // 未授权时 Rust 侧直接 Err，invoke 会 reject——这正是我们要的那道门。
      const fix = await invoke<RustFix>("record_location_fix", {
        lat: raw.lat,
        lon: raw.lon,
        accuracyM: raw.accuracyM,
        source: raw.source,
      });
      return toFix(fix) as LocationFix;
    },
    async getViewport() {
      const v = await invoke<RustViewport | null>("get_map_viewport");
      return normalizeViewport(v ? { ...v, at: iso(v.atMs) } : null);
    },
    async saveViewport(viewport: MapViewport) {
      const v = await invoke<RustViewport>("set_map_viewport", {
        lat: viewport.lat,
        lon: viewport.lon,
        zoom: viewport.zoom,
      });
      return normalizeViewport({ ...v, at: iso(v.atMs) });
    },
  };
}
