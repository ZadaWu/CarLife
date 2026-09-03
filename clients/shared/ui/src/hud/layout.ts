/**
 * HUD 布局基准（施工单 M1-02）
 *
 * 定稿是 16:9 固定构图，真实车机分辨率不定。所有坐标以设计基准像素声明，
 * 由 HudStage 等比缩放到实际视口——等比缩放而非拉伸（Brief §1）。
 */

export const DESIGN_WIDTH = 1672;
export const DESIGN_HEIGHT = 941;
export const DESIGN_RATIO = DESIGN_WIDTH / DESIGN_HEIGHT;

/** 精灵在设计基准中的落位（中心点 + 显示宽度），与定稿图一致。 */
export interface SpritePlacement {
  cx: number;
  cy: number;
  width: number;
}

/**
 * 生活环节点锚点。顺序固定：家(出发) → ① → ② → ③ → ④（Brief §3.1），
 * 顺序不可变更；节点内容随真实计划变化并重新编号。
 */
export const NODE_ANCHORS: Record<string, SpritePlacement> = {
  home: { cx: 256, cy: 248, width: 272 },
  park: { cx: 658, cy: 139, width: 307 },
  charge: { cx: 991, cy: 323, width: 197 },
  rest: { cx: 874, cy: 606, width: 252 },
  wetland: { cx: 541, cy: 529, width: 282 },
};

/**
 * 序号/名称标签中心相对**节点中心**的纵向偏移，单位为设计基准像素。
 *
 * 必须用设计基准像素而非百分比：各 POI 精灵高度不同，用百分比会让每个标签
 * 偏到不同位置（实测偏下 68–73px）。数值取自定稿中各标签胶囊的中心。
 */
export const LABEL_OFFSET_Y: Record<string, number> = {
  home: 132,
  park: 129,
  charge: 103,
  rest: 107,
  wetland: 122,
};

/**
 * 琥珀轨迹分段：家 → ① → ② → ③ → ④，仅表达行程时间顺序，非道路导航。
 *
 * 各段端点刻意伸入相邻岛屿基座内部——轨迹 z-index 低于节点，会被岛屿盖住，
 * 从而形成"轨迹从岛屿下方穿过"的连续观感；若端点停在岛屿外会留下明显断口。
 */
export const RING_SEGMENTS: string[] = [
  // 家 → ① 亲子乐园
  "M 262 316 C 392 272 448 220 655 208",
  // ① → ② 充电站
  "M 655 208 C 792 218 858 268 988 366",
  // ② → ③ 休息区（右侧大回环）
  "M 988 366 C 1124 430 1148 566 1024 622 C 972 646 918 652 872 652",
  // ③ → ④ 湿地公园
  "M 872 652 C 772 668 668 632 541 578",
];

/**
 * 助手英雄区：**按高度驱动，宽度由精灵比例自动跟随**。
 *
 * 为什么不按宽度设定：助手精灵已从定稿的圆形徽章（比例 1.14）换成全身像
 * （887×1150，比例 0.771）。若继续锁宽 380，高度会被撑到 493，顶边侵入
 * 「出发」徽标 134px 并压住房子。锁高之后，任何比例的精灵都不会向上越界。
 *
 * 不遮挡不变量（对所有车机比例成立）：
 *   bottom + height ≤ 941 − 出发徽标底边(407) − 安全余量(12) = 522
 * 推导：设 unit = min(vw/1672, vh/941)。
 *   · 比例 ≥ 16:9 时场景铺满高度，助手顶 −房子/徽标底 = (941 − bottom − height − 407)·unit；
 *   · 比例 < 16:9 时场景垂直居中下移，间隙 = vw·[1/(2r) + (534 − bottom − height)/1672]，
 *     在 r = 1.7768 取最小值，与上式同解。
 * 故只要满足该式，横屏/条形屏/竖屏全部不遮挡。
 *
 * 取 height = 344（占画布 36.6% 高，落在 Brief §3.4 的 34–40% 区间内），
 * bottom = 175 → 175 + 344 = 519 ≤ 522 ✓
 *
 * ⚠️ Brief §3.4 同时要求宽度占 22–25%。全身精灵比例 0.771 下，
 * 宽度仅约 15.9%——两项无法同时满足（需比例≈1.0–1.3 才行，即原圆形徽章）。
 * 此处以"不遮挡房子与出发徽标"为优先，宽度项已偏离，需设计确认。
 */
export const ASSISTANT_HERO_HEIGHT = 344;
/** 不遮挡不变量的上界，供回归测试断言。 */
export const ASSISTANT_CLEARANCE_LIMIT = 522;

export const ASSISTANT_PLACEMENT = { height: ASSISTANT_HERO_HEIGHT };

/** 「点击对话 / 长按说话」提示卡。 */
export const ASSISTANT_CARD = { x: 26, y: 736, width: 390, height: 150 };

/**
 * 悬浮层（提示卡 / 能量胶囊 / 助手）相对**视口边缘**的偏移，单位为设计基准像素。
 *
 * 为什么锚在视口而不是场景：车机屏比例从 0.63（竖屏）到 2.67（条形屏）不等。
 * 若悬浮层跟着 16:9 场景走，条形屏上两侧会空出大片，卡片挤在中间；锚到视口边缘后，
 * 宽屏自然向两侧展开，16:9 上则与定稿完全重合（因为此时场景宽 == 视口宽）。
 * 数值由定稿坐标换算：如提示卡右边缘 1640 → 距右 1672-1640 = 32。
 */
export const EDGE_ANCHORS = {
  tips: { right: 32, top: 112, width: 462, height: 578 },
  energy: { right: 32, bottom: 79, width: 664, height: 108 },
  assistantCard: { left: 26, bottom: 55, width: 390, height: 150 },
  /**
   * 助手主体：以**水平中心**对齐「点击对话」卡中心（26 + 390/2 = 221），
   * 而非锁左边缘 —— 宽度随精灵比例变化时仍保持居中。
   */
  assistantHero: { centerX: 221, bottom: 175 },
} as const;

/** 保留原始设计坐标，供回归比对与文档引用。 */
export const TIPS_CARD = { x: 1178, y: 112, width: 462, height: 578 };
export const ENERGY_CAPSULE = { x: 976, y: 754, width: 664, height: 108 };
