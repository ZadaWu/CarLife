/**
 * POI 品类——HUD 卡通贴纸的语义键（对齐 `clients/shared/ui/src/assets-hud/poi-*.png`，
 * 品类清单与判据见该目录 README「当前品类 POI」表）。
 *
 * # 分类来源是高德 type 字段，不是地点名
 *
 * 分类只依据 poi_search 返回的 `type`（中文层级类目，如「风景名胜;风景名胜;寺庙道观」）
 * 与 `typecode`。**禁止按地点名猜品类**——名字里带「山」的可能是商场，
 * 猜错一次贴错图，用户对整面 HUD 的真实性观感就塌了。类目覆盖不到的一律落
 * `spot`（通用景点贴纸）：宁可通用，不可张冠李戴（与坐标「不标不猜」同一条红线）。
 *
 * 推论：高德类目分不出的品类（山岳、古镇——它们在高德里多半是「国家级景点」）
 * 现阶段就是产出不了，对应贴纸等类目数据源丰富后才会出现。这是接受的代价。
 */

/** 与贴纸文件一一对应（下划线 ↔ 文件名连字符，如 amusement_park ↔ poi-amusement-park.png）。 */
export const POI_KINDS = [
  "home",
  "temple",
  "park",
  "amusement_park",
  "museum",
  "mountain",
  "wetland",
  "beach",
  "old_town",
  "food",
  "hotel",
  "charge",
  "spot",
] as const;

export type PoiKind = (typeof POI_KINDS)[number];

/**
 * type 字段关键词 → 品类。按特异性排序：**先窄后宽**——
 * 「湿地公园」同时命中「湿地」与「公园」，湿地必须在前。
 * 关键词只匹配高德类目文本，不匹配 POI 名称（见文件头）。
 */
const TYPE_RULES: ReadonlyArray<readonly [RegExp, PoiKind]> = [
  [/充电站/, "charge"],
  [/寺庙|道观|教堂|清真寺|寺院/, "temple"],
  [/博物馆|纪念馆|美术馆|展览馆|陈列馆|科技馆|天文馆|档案馆/, "museum"],
  [/海滩|海滨浴场/, "beach"],
  [/游乐场|游乐园|主题公园|水上乐园|欢乐世界|度假乐园/, "amusement_park"],
  [/湿地/, "wetland"],
  [/动物园|植物园|水族馆|公园|广场/, "park"],
  [/餐饮/, "food"],
  [/住宿服务|宾馆|酒店|旅馆|民宿|度假村|客栈/, "hotel"],
  // 类目只到「风景名胜/国家级景点」这种粒度时，如实落通用景点。
  [/风景名胜|旅游景点|观景点|世界遗产/, "spot"],
];

/**
 * typecode 前缀兜底——type 文本缺失时仍可分大类。
 * 只收录类目表里确定无歧义的前缀（高德《POI 分类编码表》）：
 * 0111 充电站 / 05 餐饮 / 10 住宿 / 1101 公园广场 / 1401 博物馆。
 */
const TYPECODE_RULES: ReadonlyArray<readonly [string, PoiKind]> = [
  ["0111", "charge"],
  ["1101", "park"],
  ["1401", "museum"],
  ["05", "food"],
  ["10", "hotel"],
];

/** 高德 POI → 贴纸品类。类目覆盖不到 → "spot"（通用景点，不猜）。 */
export function classifyAmapPoi(poi: { type?: string; typecode?: string }): PoiKind {
  const type = poi.type ?? "";
  for (const [re, kind] of TYPE_RULES) {
    if (re.test(type)) return kind;
  }
  const code = poi.typecode ?? "";
  for (const [prefix, kind] of TYPECODE_RULES) {
    if (code.startsWith(prefix)) return kind;
  }
  return "spot";
}
