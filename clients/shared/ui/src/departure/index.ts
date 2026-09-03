/**
 * 出发卡（两端共用，2026-09-02 从 cockpit `features/cabin` 上提）。
 *
 * 车机端：18.9 秒出发动画放完滑入这张卡；手机端：点「开始行程」直接从底部升起这张卡。
 * 卡本身一字一样——目的地 / 今日路线 / 途径补能 / 导航方案 / 「开始导航」；
 * 差别只在外面那层怎么摆它（各端 css 覆盖 `.cabin-depart-card` 的落位）。
 */
export * from "./logic";
export { DepartureCard, type DepartureCardProps } from "./DepartureCard";
