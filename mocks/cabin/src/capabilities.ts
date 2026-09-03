/**
 * 车型能力档案：这辆车的舒适域有什么、各到几档。
 *
 * 两条来源，优先级同 mock-dealer 的门店合成（M19-07 同一套哲学）：
 *
 *  1. **种子优先。** `data/models.json` 是演示主力车型的手工档案。
 *  2. **种子之外按车型名确定性合成。** 车主的车可能是任何车型，种子外一律报
 *     "不支持这款车"的话，看起来像功能坏了，其实是数据没铺开。合成必须确定：
 *     同一个车型名永远得到同一份能力表——不确定的话，用户第一轮看到
 *     "这车有座椅通风"，进程重启后就没了，现象是"设置丢了"，排查方向
 *     完全不指向随机数。
 *
 * 能力表描述的是**设备**，不是人：几温区、加热几档、有没有香氛。
 * 谁坐在哪、谁喜欢多少度，属于 CarLife Agent 侧的偏好体系，本服务一概不知道
 * ——这是设计边界，不是没做完。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

export type SeatZone = "driver" | "passenger" | "rearLeft" | "rearRight";
export type ClimateZone = "cabin" | "driver" | "passenger" | "rear";
export type AmbientZone = "front" | "rear";
export type MediaZone = "cabin" | "rear";

export interface SeatCapability {
  /** 0 = 无此功能；3 = 支持 1~3 档。 */
  heatingLevels: number;
  ventilationLevels: number;
  /** 至少含 "off"；只有 "off" 即无按摩。 */
  massageModes: string[];
}

export interface CabinCapabilities {
  model: string;
  source: "seed" | "synthesized";
  climate: {
    /** ["cabin"] 单温区 / ["driver","passenger"] 双温区 / 再加 "rear" 三温区。 */
    zones: ClimateZone[];
    tempRangeC: [number, number];
    tempStepC: number;
    /** 风量 0~fanLevels。 */
    fanLevels: number;
    hasSync: boolean;
  };
  seats: Record<SeatZone, SeatCapability>;
  ambientLight: {
    zones: AmbientZone[];
    modes: string[];
    brightnessRange: [number, number];
  };
  media: {
    zones: MediaZone[];
    sources: string[];
    volumeRange: [number, number];
  };
  fragrance: { present: boolean; intensities: string[]; scents: string[] };
  childMode: { zones: SeatZone[] };
}

type SeedProfile = Omit<CabinCapabilities, "source">;

function load(): SeedProfile[] {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, "models.json"), "utf8")) as Record<string, unknown>;
  const rows = raw.models;
  if (!Array.isArray(rows) || rows.length === 0) {
    // 空种子起得来但查不到任何东西，而"起来了"与"起来了但是空的"看起来一样。
    throw new Error("[mock-cabin] models.json 的 models 为空——种子没加载成功");
  }
  return rows as SeedProfile[];
}

export const SEED_MODELS: SeedProfile[] = load();

/** FNV-1a。合成的全部"个性"都来自它——没有任何 Math.random。 */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const MEDIA_SOURCES = ["music", "radio", "podcast", "kids", "off"];
const MASSAGE_FULL = ["off", "wave", "pulse"];
const FRAGRANCE_INTENSITIES = ["off", "low", "mid", "high"];
const FRAGRANCE_SCENTS = ["forest", "ocean", "citrus"];

function synthesize(model: string): CabinCapabilities {
  const h = fnv(model);

  const zoneKind = h % 3;
  const climateZones: ClimateZone[] =
    zoneKind === 0 ? ["cabin"] : zoneKind === 1 ? ["driver", "passenger"] : ["driver", "passenger", "rear"];

  const frontVent = ((h >>> 2) & 1) === 1 ? 3 : 0;
  const rearHeat = ((h >>> 3) & 1) === 1 ? 2 : 0;
  const massage = ((h >>> 4) & 3) === 0 ? MASSAGE_FULL : ["off"];
  const hasFragrance = ((h >>> 6) & 1) === 1;
  const rearMedia = ((h >>> 7) & 1) === 1;
  const rearAmbient = ((h >>> 8) & 1) === 1;
  const tempStep = ((h >>> 9) & 1) === 1 ? 0.5 : 1;

  const frontSeat: SeatCapability = { heatingLevels: 3, ventilationLevels: frontVent, massageModes: massage };
  const rearSeat: SeatCapability = { heatingLevels: rearHeat, ventilationLevels: 0, massageModes: ["off"] };

  return {
    model,
    source: "synthesized",
    climate: { zones: climateZones, tempRangeC: [17, 33], tempStepC: tempStep, fanLevels: 5, hasSync: climateZones.length > 1 },
    seats: { driver: frontSeat, passenger: { ...frontSeat }, rearLeft: rearSeat, rearRight: { ...rearSeat } },
    ambientLight: {
      zones: rearAmbient ? ["front", "rear"] : ["front"],
      modes: ["static", "breathe", "music"],
      brightnessRange: [0, 100],
    },
    media: {
      zones: rearMedia ? ["cabin", "rear"] : ["cabin"],
      sources: MEDIA_SOURCES,
      volumeRange: [0, 100],
    },
    fragrance: hasFragrance
      ? { present: true, intensities: FRAGRANCE_INTENSITIES, scents: FRAGRANCE_SCENTS }
      : { present: false, intensities: [], scents: [] },
    childMode: { zones: ["rearLeft", "rearRight"] },
  };
}

/** 种子优先，种子外确定性合成。任何车型名都拿得到能力表——这是"任意车型可调用"的落点。 */
export function capsForModel(model: string): CabinCapabilities {
  const seed =
    SEED_MODELS.find((m) => m.model === model) ??
    SEED_MODELS.find((m) => m.model.toLowerCase() === model.toLowerCase());
  if (seed) return { ...seed, source: "seed" };
  return synthesize(model);
}
