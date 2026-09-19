/**
 * 运行时配置。
 *
 * 值来自 `/config.js`——容器启动时由 `infra/modelscope/entrypoint.sh` 按创空间
 * 设置页的环境变量生成。**仓库里没有任何一处写死上游地址或演示口令**：
 * 前者由容器内 nginx 反代掉（页面只发同源 `/v1/*`），后者是运行时注入。
 *
 * 开发期 `/config.js` 不存在（404），回落到下面的默认值，配合 vite 的 proxy 打本机网关。
 */

declare global {
  interface Window {
    __CARLIFE_DEMO__?: { demoUser?: string; demoPassword?: string; notice?: string; buildId?: string };
  }
}

const injected = typeof window === "undefined" ? undefined : window.__CARLIFE_DEMO__;

export const config = {
  /** 演示账号。公开演示的账号本来就是公开的——它的安全性靠账号本身的权限与限流，不靠藏。 */
  demoUser: injected?.demoUser ?? "demo",
  demoPassword: injected?.demoPassword ?? "carlife-dev",
  /** 顶部提示条，用来写"这是演示环境"之类的话；留空则不显示。 */
  notice: injected?.notice ?? "",
  /**
   * 构建指纹（镜像构建时间）。显示在界面角落，为的是**一张截图就能认出跑的是哪一版**。
   * 平台的状态接口在滚动更新时一直是 Running，判断不了新版生效没有——
   * 两次排查都卡在这上面。开发期没有它，显示 dev。
   */
  buildId: injected?.buildId ?? "dev",
};
