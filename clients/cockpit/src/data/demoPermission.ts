/**
 * 「确认弹窗演示」固定快照（devbar 专用，与 `demoTripPlan` 同款取向）。
 *
 * 存在的唯一理由：确认弹层只在真实动作触发时出现一瞬，浏览器里没有 Tauri invoke
 * 也就没有那条链路——这是弹层版式能被走查（横屏/竖屏/双主题）的唯一路径。
 *
 * 明细的**字符串形状必须与服务端 `commitDisclosures` 一致**：端上的结构化解析
 * 认的就是这个形状，演示数据自己长一个样，走查过了不代表真链路对。
 *
 * # 文案逐字照抄定稿，不加「演示」后缀
 *
 * 同 `demoVehicleProfile` 的取向（M14-14）：只有内容与定稿逐字相同，
 * `ui-diff.py` 量出来的差异才**全是版式差异**。给每行都缀上「（演示）」
 * 会让每一条都长四个字，换行位置随之变化——那时分不清是版式错了还是字数不同。
 * "这是演示数据"由入口保证：只有 `?hitl=demo` 与 devbar 开关能取到它，
 * Tauri 窗口不带 query，真实中断永远优先（见 App.tsx）。
 */
import type { PermissionRequest } from "@carlife/shared";

/**
 * `?hitl=demo`：直接弹出确认层并隐藏 devbar，供截图脚本按定稿尺寸出图
 * （同 `?profile=demo` 先例，M14-14）。Tauri 窗口不带 query，真实链路一字不变。
 */
export function isHitlDemo(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("hitl") === "demo";
}

export const DEMO_PERMISSION: PermissionRequest = {
  interruptId: "demo-interrupt",
  action: "trip_plan_commit",
  title: "需要你确认：trip_plan_commit",
  scope: "trip",
  details: [
    { label: "动作", value: "确认多天行程并保存：广州 4天" },
    {
      label: "第1天 番禺乐园日",
      value:
        "长隆欢乐世界-北门广场、长隆欢乐世界-森林神庙；住 NOGO城景公寓(汉溪长隆地铁站店) 约280-450/晚（估算）",
    },
    {
      label: "第2天 天河科普日",
      value: "广东科学中心、正佳极地海洋世界；住 NOGO城景公寓(汉溪长隆地铁站店) 约280-450/晚（估算）",
    },
    {
      label: "第3天 荔湾人文日",
      value: "陈家祠堂、永庆坊、沙面岛；住 锦江之星(西华路彩虹桥地铁站店) 约200-350/晚（估算）",
    },
    {
      label: "第4天 珠江地标日",
      value: "广州塔、海心沙广场；住 广州柏悦酒店 约900-1600/晚（估算）",
    },
    /*
     * 大交通只列这次要走的那一种（`selectedTransit`，当前默认飞机）。
     * 演示夹具跟着服务端的输出形状走——夹具自己多列两行的话，
     * 走查过的版式与真链路给出的就不是同一个。
     */
    {
      label: "大交通",
      value: "飞机：约2-2.5小时，约600-1200元/人（估算），具体航班以购票平台为准",
    },
  ],
  disclosure: [],
};
