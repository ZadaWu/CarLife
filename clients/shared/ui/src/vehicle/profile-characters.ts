/**
 * 车型 / 人员 → 卡通形象（施工单 M14-09）。
 *
 * # 匹配不到就不给图
 *
 * 素材只覆盖知识库真实收录的 4 款车与主线家庭的 4 位成员
 * （见 `assets-profile/README.md`）。**匹配不到时返回 undefined**，
 * 由调用方画一个中性占位——拿别款车的图顶替，用户会以为系统认得这辆车；
 * 拿别人的脸顶替更糟，那是在给一个真实的人安一张不是他的面孔。
 *
 * 车型按 `Vehicle.model` 精确匹配（与检索侧同一个键，见 vehicle-catalog.ts）。
 * 人员按 `relation` 匹配——`displayName` 是用户自己写的自由文本（"妈"/"老妈"/"周慧珍"
 * 都可能），拿它做键必然漏；`relation` 虽然也是自由文本，但取值集中得多。
 * 关系还要**过一道性别闸**（`person-art-match.ts`）：性别对不上宁可不给图，
 * 派一张性别相反的脸比没有脸糟得多。
 */

import cybertruckDark from "../assets-profile/vehicles/tesla-cybertruck-dark.png";
import cybertruckLight from "../assets-profile/vehicles/tesla-cybertruck-light.png";
import malibuDark from "../assets-profile/vehicles/chevrolet-malibu-2017-dark.png";
import malibuLight from "../assets-profile/vehicles/chevrolet-malibu-2017-light.png";
import model3Dark from "../assets-profile/vehicles/tesla-model-3-dark.png";
import model3Light from "../assets-profile/vehicles/tesla-model-3-light.png";
import modelYDark from "../assets-profile/vehicles/tesla-model-y-dark.png";
// front（0830 走查③）：**主驾门**敞开、露出驾驶座与方向盘——上车动画演的是
// "爬上正驾驶"，后门开着会把叙事带偏成"上后排"。v2（后门开）与 v1 保留作对照，不再引用。
import modelYDoorOpenLight from "../assets-profile/vehicles/tesla-model-y-light-door-open-front.png";
import modelYLitLight from "../assets-profile/vehicles/tesla-model-y-light-lit.png";
import modelYRearRight from "../assets-profile/vehicles/tesla-model-y-light-rear-right.png";
import modelYLight from "../assets-profile/vehicles/tesla-model-y-light.png";

import daughterDark from "../assets-profile/people/daughter-lin-xiaoman-dark.png";
import daughterLight from "../assets-profile/people/daughter-lin-xiaoman-light.png";
import motherDark from "../assets-profile/people/mother-zhou-huizhen-dark.png";
import motherLight from "../assets-profile/people/mother-zhou-huizhen-light.png";
import ownerDark from "../assets-profile/people/owner-lin-xiangdong-dark.png";
import ownerLight from "../assets-profile/people/owner-lin-xiangdong-light.png";
import sonDark from "../assets-profile/people/son-boy-dark.png";
import sonLight from "../assets-profile/people/son-boy-light.png";
import spouseDark from "../assets-profile/people/spouse-wife-dark.png";
import spouseLight from "../assets-profile/people/spouse-wife-light.png";

import { personArtKey, type PersonArtKey } from "./person-art-match";

export type CharacterTheme = "light" | "dark";

interface Pair {
  light: string;
  dark: string;
}

const pick = (p: Pair, theme: CharacterTheme) => (theme === "dark" ? p.dark : p.light);

/** 车型名 → 形象。键就是 `Vehicle.model`，与检索侧限定用的是同一个字符串。 */
const VEHICLE_ART: Record<string, Pair> = {
  "Model 3": { light: model3Light, dark: model3Dark },
  "Model Y": { light: modelYLight, dark: modelYDark },
  Cybertruck: { light: cybertruckLight, dark: cybertruckDark },
  // 素材是 2017 款；`迈锐宝` 各年款外形接近，且这是风格化插画不是工程图。
  // 年款不参与匹配——按年款细分会让 2018 款直接没有图，那是更差的结果。
  迈锐宝: { light: malibuLight, dark: malibuDark },
};

export function vehicleCharacter(model: string | undefined, theme: CharacterTheme): string | undefined {
  if (!model) return undefined;
  const art = VEHICLE_ART[model.trim()];
  return art ? pick(art, theme) : undefined;
}

/**
 * 进入座舱动效用的第二车辆状态。
 *
 * 只在已定稿的 Model Y 演示中提供：缺少对应素材时返回 undefined，
 * 调用端应保持闭门状态，不能用 CSS 拼一个脱离车身的“假车门”。
 */
export function vehicleDoorOpenCharacter(model: string | undefined): string | undefined {
  return model?.trim() === "Model Y" ? modelYDoorOpenLight : undefined;
}

/**
 * 大灯点亮的侧视状态（出发动画「准备出发」一拍：关门即点灯）。
 * 与 door-open 同一条规矩：只有 Model Y 有素材，匹配不到返回 undefined，
 * 调用端保持普通闭门状态，不能拿 CSS 光晕硬造一对大灯。
 */
export function vehicleLitCharacter(model: string | undefined): string | undefined {
  return model?.trim() === "Model Y" ? modelYLitLight : undefined;
}

/**
 * 朝画面右上驶离的车尾 3/4 状态（出发动画收尾）。
 * 素材由后左 3/4 视角镜像而来（原图朝左上），Tesla 车尾近似对称、镜像不穿帮；
 * 侧视图直接缩小退场的旧收尾像"贴图被拖走"，这一张才是"车开走了"。
 */
export function vehicleRearCharacter(model: string | undefined): string | undefined {
  return model?.trim() === "Model Y" ? modelYRearRight : undefined;
}

/**
 * 形象 key → 贴图。**选哪个 key 的规则不在这里**，在 `person-art-match.ts`——
 * 那边不 import png，才跑得了单测（选错脸是这批素材里唯一会出错还没人报错的部分）。
 */
const PERSON_ART: Record<PersonArtKey, Pair> = {
  owner: { light: ownerLight, dark: ownerDark },
  spouse: { light: spouseLight, dark: spouseDark },
  mother: { light: motherLight, dark: motherDark },
  daughter: { light: daughterLight, dark: daughterDark },
  son: { light: sonLight, dark: sonDark },
};

/**
 * 按关系取形象。匹配不到、或性别与素材对不上时返回 undefined，调用方画称呼首字。
 */
export function personCharacter(
  person: { relation?: string; displayName?: string },
  theme: CharacterTheme,
): string | undefined {
  const key = personArtKey(person);
  return key ? pick(PERSON_ART[key], theme) : undefined;
}

/** 没有形象时的占位字符：称呼首字。空称呼给"·"，不给问号（那像出错了）。 */
export function characterInitial(displayName: string | undefined): string {
  const s = displayName?.trim();
  return s ? [...s][0]! : "·";
}
