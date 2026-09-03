/**
 * 维修条目分类词表（施工单 M41-02）。
 *
 * 判定权在本服务：预检入参只给条目名，事故/磨损/保养三类由词表匹配。
 * 词表**刻意保守**——未命中归 unknown 且不赔、原因如实说"无法判定"，
 * 宁可少赔也不把保养算成事故（模拟系统给出一个错误的"能报销"，
 * 比如实说"判定不了"危害大得多）。规则确定：同输入永远同输出，无随机。
 */

export type ItemCategory = "accident" | "wear" | "maintenance" | "unknown";

/** 事故类：碰撞/钣喷/玻璃——车损险的正经覆盖面。 */
const ACCIDENT_WORDS = ["钣金", "喷漆", "保险杠", "翼子板", "车门", "玻璃", "碰撞", "剐蹭", "划痕", "大灯", "后视镜"];

/** 磨损类：随用随耗，车损险不赔。 */
const WEAR_WORDS = ["轮胎", "刹车片", "雨刮", "电瓶", "蓄电池", "灯泡"];

/** 保养类：周期性项目，车损险不赔。 */
const MAINTENANCE_WORDS = ["机油", "机滤", "滤芯", "滤清器", "保养", "换位", "四轮定位", "刹车油", "冷却液", "变速箱油", "火花塞", "检查", "检修", "清洗"];

export function classifyItem(name: string): ItemCategory {
  // 事故词优先：`前保险杠喷漆修复` 同时含"保险杠"（事故）与"修复"，
  // 事故特征更具体，先匹配它。
  if (ACCIDENT_WORDS.some((w) => name.includes(w))) return "accident";
  if (WEAR_WORDS.some((w) => name.includes(w))) return "wear";
  if (MAINTENANCE_WORDS.some((w) => name.includes(w))) return "maintenance";
  return "unknown";
}

export const CATEGORY_REASONS: Record<ItemCategory, string> = {
  accident: "事故损伤类，在车损险覆盖范围内",
  wear: "自然磨损类，不在车损险范围",
  maintenance: "保养类项目，不在车损险范围",
  unknown: "无法判定条目性质（模拟系统词表未覆盖），按不赔处理",
};
