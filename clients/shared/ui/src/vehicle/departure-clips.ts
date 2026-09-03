/**
 * 出发动画的四段实拍片（0831 拆分版）。
 *
 * 原本是两段（上车 6s + 驶离 2.5s），前 3 秒的"车驶来"和"唤醒"用立绘摆关键帧。
 * 拆成四段之后整条动画全部由视频承担，立绘那套连同它的比例/地平线问题一起退休。
 *
 * **四段是一条链**：每段的起始帧都取自上一段的**末帧**，所以构图天然连续，
 * 切点处车位、尺寸、机位、背景全都对得上。想替换其中任意一段，都必须重新
 * 从它上一段的末帧生成，不能单独换——否则接缝立刻穿帮。
 *
 * 与 `profile-characters.ts` 的立绘同属"车主形象素材"，所以放在同一层导出。
 * 它们**不是**按车型分发的素材：片子里演的是暖暖和这一台车，换车型不会换片。
 *
 * 片子怎么来的、片内节拍怎么量的，见 clients/cockpit 的 departure.ts 文件头。
 */
import arriveClip from "../assets-hud/boarding/departure-1-arrive.mp4";
import wakeClip from "../assets-hud/boarding/departure-2-wake.mp4";
import boardClip from "../assets-hud/boarding/departure-3-board.mp4";
import driveoffClip from "../assets-hud/boarding/departure-4-driveoff.mp4";

import { createClipCache } from "./departure-clip-cache";

/** ① 车头朝前自右驶入，2.9s 停稳。3.42s */
export const departureArriveClip: string = arriveClip;

/** ② 暖暖走到车旁、举手保持；车内透出暖光回应。4.63s */
export const departureWakeClip: string = wakeClip;

/** ③ 走到驾驶门、开门、爬进驾驶位、关门点灯。6.04s */
export const departureBoardClip: string = boardClip;

/** ④ 车头朝前向左驶离。3.42s（片尾车未完全出画，由出发卡淡入盖掉） */
export const departureDriveoffClip: string = driveoffClip;

/** 四段的源 URL，按播放顺序。预热用它，别在别处再列一份。 */
export const DEPARTURE_CLIP_SRCS: readonly string[] = [
  departureArriveClip,
  departureWakeClip,
  departureBoardClip,
  departureDriveoffClip,
];

/*
 * 进程内缓存（见 departure-clip-cache.ts 文件头）：片子一次进程只取一次，
 * 之后 <video> 吃 blob: URL——开发形态下不再每次「开始行程」都从 vite 拉 1.4 MB，
 * 发布形态下重播也不再重读内嵌资源。
 */
const cache = createClipCache();

/**
 * 把四段片子取进内存。**在 HUD 露面时调**，不要等到点击——点击那一刻再取，
 * 第一帧就得等下载（iPhone 走 Wi-Fi 拉 Mac 的 vite 时肉眼可见）。
 * 幂等、永不 reject；失败的段下次再试。
 */
export function warmDepartureClips(): Promise<void> {
  return cache.warm(DEPARTURE_CLIP_SRCS);
}

/** `<video src>` 用这个：已缓存 → blob: URL；否则原 URL（行为与没有缓存时一样）。 */
export function departureClipSrc(src: string): string {
  return cache.resolve(src);
}
