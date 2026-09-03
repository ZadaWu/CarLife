/**
 * 底部导航（施工单 M2-05，F-01-06；M33-05 加第四项）。
 *
 * 四入口：HUD ⇄ 对话 ⇄ 档案 ⇄ 设置；HUD 默认选中（US-01 AC-01-1）。
 * 车机热区与字号走 cockpit 主题 token（FL-06），组件不含硬编码色值。
 *
 * ⚠️ **cockpit 与 mobile 共用这一个组件**（`clients/mobile/src/app/index.tsx`）。
 * 「设置」由 `showSettings` 显式打开，**默认关**——默认开的话，任何一个还没有
 * 设置页的端都会长出一个点进去是空白的 tab。
 *
 * 手机端在定位授权落地时打开了它（那一页要能停用 / 开启定位、选模糊还是精确，
 * 这些必须在用户自己手上那块屏里改）。默认值仍然是关：这条约束是给**下一个新端**的。
 */

export type NavView = "hud" | "dialog" | "profile" | "settings";

export interface BottomNavProps {
  active: NavView;
  onSelect: (view: NavView) => void;
  /** 档案/设置尚未落地时置为 true（占位不可点）。 */
  profileDisabled?: boolean;
  /**
   * 显示第四项「设置」（M33-05）。**默认 false**——见文件头。
   *
   * 类型层的坑：`NavView` 加了成员之后，不传本 prop 的调用方的 `onSelect`
   * 仍然接受 `"settings"`，但那个值**永远不会被产生**。所以判据是：
   * 先有那一页，再打开这个开关；只加分支不打开开关的话，那段分支是死代码。
   */
  showSettings?: boolean;
}

const ITEMS: Array<{ key: NavView; label: string }> = [
  { key: "hud", label: "主页" },
  { key: "dialog", label: "对话" },
  { key: "profile", label: "档案" },
  { key: "settings", label: "设置" },
];

export function BottomNav({
  active,
  onSelect,
  profileDisabled = true,
  showSettings = false,
}: BottomNavProps) {
  const items = showSettings ? ITEMS : ITEMS.filter((i) => i.key !== "settings");
  return (
    <nav className="hud-bottom-nav" aria-label="主导航">
      {items.map((item) => {
        const disabled = item.key === "profile" && profileDisabled;
        return (
          <button
            key={item.key}
            type="button"
            className={`hud-bottom-nav__item${active === item.key ? " is-active" : ""}`}
            aria-current={active === item.key ? "page" : undefined}
            disabled={disabled}
            onClick={() => onSelect(item.key)}
          >
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
