/**
 * 手册目录里那 28 枚指示灯图标，端上按 `symbolId` 取。
 *
 * # 为什么不是再画一套
 *
 * 观察层认出来的名称和级别本来就来自**手册图标目录**（M71），而那份目录里每个符号
 * 都存着一张图（`data/kb-src/icons/tesla-model3/<symbolId>.png`，M78-01 拿它做成对核验）。
 * 端上再画一套"像的"，等于让同一个符号在两个地方各有一个真相源——而且画出来的那套
 * 迟早与手册对不上，偏偏这一屏的全部价值就是"你看到的这个灯，手册里叫它什么"。
 *
 * 这里的文件是那份原图 `sips -Z 96` 缩出来的，逐字同名，别手动改名：
 * `lamp-assets.test.ts` 按文件名对表，改了名就是端上少一枚图标而不报错。
 *
 * # 一枚例外：`fog_lamp_front`
 *
 * 目录的表里有它，图片抽取时漏了（`fog_lamp_rear` 在，前雾灯不在）。这一枚的形状取自
 * 评测集里的合成图（`evals/vision-observe/datasets/synth-tesla01/icons/`）抠底后的字形，
 * 颜色换成手册那支绿（`low_beam.png` 量出来的 `rgb(0,248,0)`）——**同一屏里 28 枚灯必须是一套**，
 * 一枚发灰的混在里面比缺一枚更显眼。手册那张图补回来时，直接覆盖这个文件即可。
 *
 * # 取不到就不画
 *
 * `lampArt()` 返回 `undefined` 时，`LampGlyph` 回落到按颜色着色的三角块。
 * 没有这个回落的话，手册目录里新增一个符号就会在观察卡上留一个破图。
 */

import absFault from "./assets/lamps/abs_fault.png";
import airbagWarning from "./assets/lamps/airbag_warning.png";
import autoHighBeamActive from "./assets/lamps/auto_high_beam_active.png";
import autoHighBeamStandby from "./assets/lamps/auto_high_beam_standby.png";
import batteryCold from "./assets/lamps/battery_cold.png";
import batteryLow from "./assets/lamps/battery_low.png";
import brakeBoosterFault from "./assets/lamps/brake_booster_fault.png";
import brakeSystemFault from "./assets/lamps/brake_system_fault.png";
import chargingPlugged from "./assets/lamps/charging_plugged.png";
import doorOpen from "./assets/lamps/door_open.png";
import escActive from "./assets/lamps/esc_active.png";
import escOff from "./assets/lamps/esc_off.png";
import fogLampFront from "./assets/lamps/fog_lamp_front.png";
import fogLampRear from "./assets/lamps/fog_lamp_rear.png";
import highBeam from "./assets/lamps/high_beam.png";
import lowBeam from "./assets/lamps/low_beam.png";
import parkingBrakeFault from "./assets/lamps/parking_brake_fault.png";
import parkingBrakeOn from "./assets/lamps/parking_brake_on.png";
import parkingLights from "./assets/lamps/parking_lights.png";
import pedestrianWarningPaused from "./assets/lamps/pedestrian_warning_paused.png";
import powerLimited from "./assets/lamps/power_limited.png";
import ready from "./assets/lamps/ready.png";
import regenLimited from "./assets/lamps/regen_limited.png";
import seatbeltUnfastened from "./assets/lamps/seatbelt_unfastened.png";
import systemFault from "./assets/lamps/system_fault.png";
import systemOverheat from "./assets/lamps/system_overheat.png";
import tpmsWarning from "./assets/lamps/tpms_warning.png";
import vehicleHold from "./assets/lamps/vehicle_hold.png";

/** `symbolId` → 图片 URL。键逐字等于手册图标目录里的 `symbol_id`。 */
const LAMP_ART: Readonly<Record<string, string>> = {
  abs_fault: absFault,
  airbag_warning: airbagWarning,
  auto_high_beam_active: autoHighBeamActive,
  auto_high_beam_standby: autoHighBeamStandby,
  battery_cold: batteryCold,
  battery_low: batteryLow,
  brake_booster_fault: brakeBoosterFault,
  brake_system_fault: brakeSystemFault,
  charging_plugged: chargingPlugged,
  door_open: doorOpen,
  esc_active: escActive,
  esc_off: escOff,
  fog_lamp_front: fogLampFront,
  fog_lamp_rear: fogLampRear,
  high_beam: highBeam,
  low_beam: lowBeam,
  parking_brake_fault: parkingBrakeFault,
  parking_brake_on: parkingBrakeOn,
  parking_lights: parkingLights,
  pedestrian_warning_paused: pedestrianWarningPaused,
  power_limited: powerLimited,
  ready: ready,
  regen_limited: regenLimited,
  seatbelt_unfastened: seatbeltUnfastened,
  system_fault: systemFault,
  system_overheat: systemOverheat,
  tpms_warning: tpmsWarning,
  vehicle_hold: vehicleHold,
};

/** 手册里有这枚图标就给出来；没有（或压根没对上符号）返回 undefined，由调用方回落。 */
export function lampArt(symbolId: string | null | undefined): string | undefined {
  return symbolId ? LAMP_ART[symbolId] : undefined;
}

/** 仅供守卫测试：端上带了哪些符号。 */
export const LAMP_SYMBOL_IDS: ReadonlyArray<string> = Object.keys(LAMP_ART);
