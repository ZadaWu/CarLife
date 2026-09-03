// domain — 领域模型入口
//
// hud 是**端上常驻可见**那一档，暴露面最窄（不含 VIN、维修档案、精确地址）；
// vehicle/trip/user 是对话层与后台用的完整领域模型。
// 两者刻意不合并：HUD 拿到 VIN 类型就迟早会有人渲染它。
export * from "./hud";
export * from "./poi-kind";
export * from "./vehicle";
export * from "./vehicle-catalog";
export * from "./vehicle-member";
export * from "./trip";
export * from "./trip-plan";
export * from "./guide";
// 出发导航方案（M66-01）：「开始行程」那一下的产物，不落库、不碰 trip-plan 的 nav 字段。
export * from "./nav-plan";
export * from "./user";
// 车-人-设备的账户关系（M48-01）：角色是 (人, 车) 这一对的属性，不是人的属性。
export * from "./identity";
// 可见域与权限矩阵（M48-06）：矩阵是数据不是散在各处的 if——改一格就有用例红。
export * from "./visibility";
// 垫场话文案（M18-07）：agent-runtime 生成它，enterprise/console 由 phase 还原它。
export * from "./filler";
export * from "./cabin-preference";
// 事实补录询问的槽位契约（M26-03，§4.6）：问事实与问授权是两件事。
export * from "./elicitation";
// 定位授权与地图视图：两者刻意同文件，分界见 location.ts 文件头。
export * from "./location";
