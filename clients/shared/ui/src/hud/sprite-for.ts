/**
 * POI 精灵按 `kind` 语义选图（M13-04 走查修正；M65-01 上提到 `clients/shared/ui`，两端共用）。
 *
 * 手机端此前按 `anchor`（落点）取图：接上真实行程后，第 2 天的景点落在 charge 位就顶着充电桩图标。
 * 两端只能有一份映射表——各存一份的表现是"同一条行程在车上和手机上图标不一样"。
 */
import type { HudSprites } from "./sprites";

/**
 * 图标按**语义**选精灵，不按锚位（M13-04 走查修正）。
 * 多日行程的站点按天序占环位——锚位只是落点，第 2 天的景点落在 charge 位
 * 不该顶着充电桩图标。精灵表的键历史上与锚位同名，这里做一次语义映射。
 */
export const KIND_SPRITE: Record<string, string> = {
  home: "home",
  // 品类级 POI：只按上游给出的语义分类取图；不根据地点名猜测。
  temple: "temple",
  heritage: "temple",
  historic_site: "temple",
  ancestral_temple: "temple",
  park: "park",
  leisure: "park",
  amusement_park: "amusement_park",
  amusement: "amusement_park",
  museum: "museum",
  exhibition: "museum",
  exhibition_hall: "museum",
  mountain: "mountain",
  wetland: "wetland",
  lake: "wetland",
  charging: "charge",
  charge: "charge",
  beach: "beach",
  old_town: "old_town",
  historic_district: "old_town",
  food: "food",
  restaurant: "food",
  hotel: "hotel",
  rest: "hotel",
  nature: "wetland",
  spot: "spot",
};

export function spriteFor(
  sprites: Pick<HudSprites, "poi">,
  node: { anchor: string; kind?: string },
): string {
  return sprites.poi[KIND_SPRITE[node.kind ?? ""] ?? "spot"] ?? sprites.poi.spot;
}

