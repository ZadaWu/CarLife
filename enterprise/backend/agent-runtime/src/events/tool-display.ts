/**
 * 工具名 → 人话（FL-08 F-08-05）。
 *
 * # 为什么这张表在服务端，不在端上
 *
 * 放端上意味着**每加一个工具都要改两个端**，而漏改的表现是车主看到
 * `ragflow_retrieve` 这种函数名——它比什么都不显示更糟：一个不像话的字符串
 * 会让人以为是程序出错了。放这里，端上只管显示收到的字符串。
 *
 * # 为什么措辞是"正在…"而不是工具的 description
 *
 * `description` 是写给模型看的（"什么时候该调我"），里面全是判据与约束。
 * 车主要的是一句能对上等待的话。两者刻意不共用。
 *
 * # 没有兜底话术，只有兜底行为：**不发**
 *
 * 表里没有的工具不产生事件，而不是显示函数名、也不是编一句"正在查询"——
 * 后者在什么都没发生时就是一句用户无法证伪、只会照单全收的假话
 * （与旁路 L0 模板"匹配不到就返回 undefined"同一条纪律）。
 *
 * 真正防止漏配的是测试：`tool-display.test.ts` 断言 `TOOL_REGISTRY` 里
 * **每一个**工具都在这张表里。新增工具时红的是那条断言，不是线上的车主。
 */

/**
 * 措辞的两条约定：
 *  1. 一律"正在…"，因为它只在 `started` 时下发；
 *  2. **不带对象的具体值**（城市、车型、人名）——那些来自入参，
 *     而入参里有用户原文，进不了这条不走脱敏的通道（AC-44-10 同源）。
 */
export const TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  // ── 行程与出行 ────────────────────────────────────
  weather: "正在查天气",
  map_route: "正在算路线",
  poi_search: "正在找地点",
  route_audit: "正在核对路线顺序",
  transit_route: "正在查大交通",
  pretrip_items: "正在整理出行物品",
  destination_highlights: "正在上网找当地好吃好拍的",
  calendar: "正在写日程",
  trip_plan_commit: "正在保存行程",
  trip_plan_cancel: "正在取消行程",
  trip_plan_update: "正在更新行程",
  trip_plan_nav: "正在开始导航",
  trip_plan_list: "正在翻你的行程",
  trip_plan_query: "正在查这份行程",

  // ── 用车与能源 ────────────────────────────────────
  vehicle_profile: "正在读车辆档案",
  vehicle_profile_write: "正在更新车辆档案",
  usage_profile: "正在看你的用车习惯",
  energy_gap: "正在算续航够不够",
  refuel_log: "正在记补能记录",
  data_freshness: "正在核对数据新旧",
  charging: "正在找充电桩",
  refuel: "正在找加油站",
  ragflow_retrieve: "正在翻手册",

  // ── 座舱 ──────────────────────────────────────────
  cabin_status: "正在读车机状态",
  cabin_control: "正在调车内设置",
  cabin_child_mode: "正在切儿童模式",
  cabin_apply_preferences: "正在按你的习惯调好",
  cabin_media: "正在放音乐",
  member_preference_set: "正在记下这个习惯",
  vehicle_member: "正在查同行人档案",
  preference_recall: "正在回想你的偏好",
  // M30-01：分支交结论的动作。对车主而言它意味着"这部分查完了"，措辞照此。
  submit_hotels: "正在整理酒店候选",
  submit_tour_days: "正在整理每日安排",
  submit_transit: "正在整理大交通方案",
  submit_drive_draft: "正在整理自驾方案",
  // M66-01：出发导航规划的提交通道。
  submit_nav_plan: "正在整理出发导航方案",
  // M36-01：景区导览采集。web_search 的措辞不提"搜索引擎"——车主关心的是在查什么。
  web_search: "正在联网查攻略",
  submit_guide_spots: "正在整理必玩打卡点",
  submit_guide_access: "正在整理停车与补能",
  submit_guide_comfort: "正在整理休息与餐饮",

  // ── 购车与试驾 ────────────────────────────────────
  car_catalog: "正在查车型",
  trim_compare: "正在比配置",
  dealer_pricing: "正在问报价",
  dealer_stores: "正在找门店",
  dealer_slots: "正在看可约时段",
  test_drive_book: "正在约试驾",
  cost_calc: "正在算用车成本",
  loan_calc: "正在算贷款",
  insurance_quote: "正在算保费",
  // M41-03：售后维修与保险四工具
  repair_history: "正在查维修记录",
  repair_stations: "正在查维修站",
  repair_slots: "正在查进厂时段",
  repair_quote: "正在查维修报价单",
  insurance_policy: "正在查保单",
  insurance_precheck: "正在算理赔预检",

  // ── 售后与联系人 ──────────────────────────────────
  appointment: "正在约保养",
  contact_lookup: "正在查联系方式",
  contact_update: "正在更新联系方式",
};

/** 查不到就返回 undefined——**调用方据此不发事件**，见模块注释。 */
export function toolDisplayName(name: string): string | undefined {
  return TOOL_DISPLAY_NAMES[name];
}
