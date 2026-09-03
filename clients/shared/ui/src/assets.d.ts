/**
 * 图片资产的模块声明。
 *
 * `clients/shared/ui` 以 TS 源码被各 app 的 vite 消费，vite 会把这些 import 变成 URL 字符串；
 * 但 `tsc --noEmit`（本包自己的 typecheck）不认识 png，需要这份声明。
 * 放在包内而不是各 app 的 vite-env.d.ts 里：资产现在属于本包，
 * 声明跟着资产走，别的包引用时不必各自再声明一遍。
 */
declare module "*.png" {
  const src: string;
  export default src;
}
declare module "*.svg" {
  const src: string;
  export default src;
}
declare module "*.webp" {
  const src: string;
  export default src;
}
declare module "*.mp4" {
  const src: string;
  export default src;
}
