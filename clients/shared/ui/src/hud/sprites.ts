/**
 * HUD 精灵注册表（施工单 M1-02；A3 从 clients/cockpit 移入本包，两端共享）
 *
 * 定稿截取的遗留资产与一组透明底品类 POI 都记录在 `src/assets-hud/README.md`。
 *
 * **为什么在 clients/shared/ui 而不是某个 app 里**：mobile 与 cockpit 都要用同一套精灵，
 * 留在 cockpit 里会逼 mobile 复制一份 9.9MB 资产，而两份美术资产必然漂移——
 * 定稿改图时只更新其中一份，另一端悄悄停在旧版。
 * 新的品类 POI 均为透明底白描边贴纸，因此可以安全地在 light / dark 两个主题间共用；
 * 旧的定稿截取 POI 仍保留在主题目录中，仅用于历史核验，禁止重新接入。
 */
import type { ThemeName } from "../themes";

import lightAssistant from "../assets-hud/light/assistant.png";
import lightAssistantWorking from "../assets-hud/light/assistant-working.png";
import lightHat from "../assets-hud/light/item-hat.png";
import lightSunscreen from "../assets-hud/light/item-sunscreen.png";
import lightWater from "../assets-hud/light/item-water.png";
import lightSun from "../assets-hud/light/icon-sun.png";

/*
 * M20-05 的五种天气图标。与 `icon-sun` 同规格（扁平小图标、透明底），
 * 两个主题共用——它们没有把卡面色烘焙进去。
 * **契约里的每个 `WeatherKind` 在这里都必须有图**：端上写的是
 * `sprites.weather[kind] ?? sprites.weather.sunny`，缺图不会报错，
 * 只会安静地显示成晴天。`clients/shared/ui/test/item-sprites.test.ts` 有一条对账守着。
 */
import iconCloudy from "../assets-hud/light/icon-cloudy.png";
import iconOvercast from "../assets-hud/light/icon-overcast.png";
import iconRain from "../assets-hud/light/icon-rain.png";
import iconSnow from "../assets-hud/light/icon-snow.png";
import iconHaze from "../assets-hud/light/icon-haze.png";

/*
 * M20-02 扩充的五件物品：雨伞 / 薄外套 / 墨镜 / 保温杯 / 口罩。
 * 与既有三件同规格（透明底、无描边、最长边 512），两个主题共用同一批文件——
 * 它们本来就没有把地图底色烘焙进去，分主题只会让两份资产漂移。
 */
import itemUmbrella from "../assets-hud/light/item-umbrella.png";
import itemJacket from "../assets-hud/light/item-jacket.png";
import itemSunglasses from "../assets-hud/light/item-sunglasses.png";
import itemThermos from "../assets-hud/light/item-thermos.png";
import itemMask from "../assets-hud/light/item-mask.png";

import darkAssistant from "../assets-hud/dark/assistant.png";
import darkAssistantWorking from "../assets-hud/dark/assistant-working.png";
import darkHat from "../assets-hud/dark/item-hat.png";
import darkSunscreen from "../assets-hud/dark/item-sunscreen.png";
import darkWater from "../assets-hud/dark/item-water.png";
import darkSun from "../assets-hud/dark/icon-sun.png";

// 暖暖上车动效专用的连续姿态。透明底且不带主题底色，两个主题共用。
// walk-a/b 是侧面向右的两帧步态（0830 生成，gpt-imagegen 技能出图）：
// a = 左腿在前，b = 右腿在前，交替播放构成走路循环。
import nuannuanIntroPlate from "../assets-hud/boarding/nuannuan-intro-plate.png";
// mid = 双脚交汇的过渡帧：A→mid→B→mid 四拍循环，比 A/B 两帧硬切自然一档（0830 走查②）。
// 爬进主驾 + 驾驶位坐姿（0830 走查③：上车要有"爬上正驾驶"的过程，人在车外坐着是错觉源）。
// 爬车第二帧（0830 走查修订：单帧位移像"贴图滑进去"，两帧才有蹬起进舱的动态）。

// 品类级 POI：一套透明底贴纸覆盖两个主题，避免把地图底色烘焙进精灵。
import poiTemple from "../assets-hud/poi-temple.png";
import poiPark from "../assets-hud/poi-park.png";
import poiAmusementPark from "../assets-hud/poi-amusement-park.png";
import poiMuseum from "../assets-hud/poi-museum.png";
import poiMountain from "../assets-hud/poi-mountain.png";
import poiWetland from "../assets-hud/poi-wetland.png";
import poiBeach from "../assets-hud/poi-beach.png";
import poiOldTown from "../assets-hud/poi-old-town.png";
import poiFood from "../assets-hud/poi-food.png";
import poiHotel from "../assets-hud/poi-hotel.png";
import poiCharge from "../assets-hud/poi-charge.png";
import poiHome from "../assets-hud/poi-home.png";
import poiSpot from "../assets-hud/poi-spot.png";

export interface HudSprites {
  poi: Record<string, string>;
  /** 休息中：没有进行中的会话（M22-02/03）。 */
  assistant: string;
  /**
   * 办公中：车主开口之后（M22-02/03）。
   *
   * 与 `assistant` **同画布、同基线、同内容框**——两套在同一个 CSS 盒子里互换，
   * 尺寸对不上时切换那一下会「跳」。归一化的判据见 M22-02 验收 §5。
   */
  assistantWorking: string;
  items: Record<string, string>;
  weather: Record<string, string>;
}

/** 座舱“暖暖上车”流程的同角色连续姿态，不用运行时生成角色图。 */
export const CABIN_ARRIVAL_SPRITES = {
  /** 从上车片第 0 帧抠出来的暖暖：进场段淡入用，与片子首帧像素一致。 */
  /*
   * 出发动画 0831 改成四段实拍片之后，暖暖的九张立绘（走路三帧、伸手、爬入两帧、
   * 坐姿、驾驶、踏入）就没有消费方了。它们的 import 已经摘掉——留着不会报错，
   * 但 vite 照样会把这 5MB 打进车机端的包。PNG 本身仍在 assets-hud/boarding/ 下，
   * 将来要回退到立绘方案直接加回 import 即可。
   */
  introPlate: nuannuanIntroPlate,
} as const;

/** 天气图标。**每个 `WeatherKind` 都必须在这里有图**，理由见上面 import 处的注释。 */
const WEATHER_SPRITES_SHARED = {
  cloudy: iconCloudy,
  overcast: iconOvercast,
  rain: iconRain,
  snow: iconSnow,
  haze: iconHaze,
};

/**
 * 行前物品贴纸。key 取值域是 `@carlife/shared` 的 `PRETRIP_ITEMS`——
 * **契约里有的 key 这里可以还没有图**（贴纸是渐进补齐的），
 * 那种 key 由 `HudScreen` 在组装时过滤掉，不渲染一个空框。
 */
const ITEM_SPRITES_SHARED = {
  umbrella: itemUmbrella,
  jacket: itemJacket,
  sunglasses: itemSunglasses,
  thermos: itemThermos,
  mask: itemMask,
};

/**
 * 语义化行程品类 -> 透明 POI 图。`spot` 是未知或未映射品类的唯一兜底，
 * 不根据地点名称猜测图标，避免长尾景点造成视觉风格与语义漂移。
 */
const CATEGORY_POI_SPRITES: Record<string, string> = {
  temple: poiTemple,
  park: poiPark,
  amusement_park: poiAmusementPark,
  museum: poiMuseum,
  mountain: poiMountain,
  wetland: poiWetland,
  beach: poiBeach,
  old_town: poiOldTown,
  food: poiFood,
  hotel: poiHotel,
  charge: poiCharge,
  home: poiHome,
  spot: poiSpot,
};

export const SPRITES: Record<ThemeName, HudSprites> = {
  light: {
    poi: CATEGORY_POI_SPRITES,
    assistant: lightAssistant,
    assistantWorking: lightAssistantWorking,
    items: { hat: lightHat, sunscreen: lightSunscreen, water: lightWater, ...ITEM_SPRITES_SHARED },
    weather: { sunny: lightSun, ...WEATHER_SPRITES_SHARED },
  },
  dark: {
    poi: CATEGORY_POI_SPRITES,
    assistant: darkAssistant,
    assistantWorking: darkAssistantWorking,
    items: { hat: darkHat, sunscreen: darkSunscreen, water: darkWater, ...ITEM_SPRITES_SHARED },
    weather: { sunny: darkSun, ...WEATHER_SPRITES_SHARED },
  },
};
