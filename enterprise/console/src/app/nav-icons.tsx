/**
 * 侧边导航的图标集（M3-01 壳层的视觉优化）。
 *
 * # 为什么给一份图标
 *
 * 十三条纯文字菜单在扫视时**每一条的视觉重量都一样**——找"用量与成本"和
 * 找"操作审计"要花同样的时间，因为唯一的线索是读完那几个字。
 * 一枚 16px 的单色图标把"认字"变成"认形状"，重复访问的人第二次就不再读字了。
 *
 * # 为什么是线性单色、不是彩色
 *
 * 后台是工具（M3-01）：颜色在这套界面里是**状态**的语言（绿=正常、黄=需注意、
 * 红=失败）。给菜单项上色会让它和状态色抢同一套语义，读者得先分辨
 * "这个绿是分类还是正常"。所以图标一律 `currentColor`，颜色只跟随选中态。
 *
 * 尺寸/描边与 `styles.css` 里的 `.nav-icon` 对齐，改这里也要改那边。
 */

const P = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** 键与 `Layout.tsx` 的 `NavItem.to` 一一对应；缺图标不报错，只是没图标（见 NavIcon）。 */
const PATHS: Record<string, JSX.Element> = {
  // 系统配置：推子
  "/config": (
    <>
      <path d="M3 6h10M17 6h4M3 12h4M11 12h10M3 18h8M15 18h6" {...P} />
      <circle cx="15" cy="6" r="2" {...P} />
      <circle cx="9" cy="12" r="2" {...P} />
      <circle cx="13" cy="18" r="2" {...P} />
    </>
  ),
  // 系统状态：心跳
  "/system": <path d="M3 12h4l2.5-7 4 14L16 12h5" {...P} />,
  // 内容安全策略：盾
  "/guard": (
    <>
      <path d="M12 3l7 3v6c0 4.2-2.9 7.8-7 9-4.1-1.2-7-4.8-7-9V6z" {...P} />
      <path d="M9 12l2 2 4-4" {...P} />
    </>
  ),
  // 会话与对话：气泡
  "/sessions": <path d="M4 5h16v11H9l-5 4z" {...P} />,
  // 账号：人形
  "/identity/users": (
    <>
      <circle cx="12" cy="8" r="4" {...P} />
      <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" {...P} />
    </>
  ),
  // 车辆与授权：车 + 钥匙孔（谁能开这辆车）
  "/identity/vehicles": (
    <>
      <path d="M3 15v-3l2-5h14l2 5v3" {...P} />
      <path d="M3 15h18M5 15v2M19 15v2" {...P} />
      <circle cx="12" cy="12" r="1.6" {...P} />
      <path d="M12 13.6v2" {...P} />
    </>
  ),
  // 终端设备：手机
  "/identity/devices": (
    <>
      <rect x="7" y="2.5" width="10" height="19" rx="2" {...P} />
      <path d="M10.5 18.5h3" {...P} />
    </>
  ),
  // 记忆浏览：叠层
  "/memory": (
    <>
      <path d="M12 3l9 5-9 5-9-5z" {...P} />
      <path d="M3 13l9 5 9-5M3 17l9 5 9-5" {...P} />
    </>
  ),
  // 客户座舱：车
  "/cabin": (
    <>
      <path d="M4 16v-3l2-5h12l2 5v3" {...P} />
      <path d="M4 16h16M6 16v2M18 16v2" {...P} />
      <circle cx="8" cy="13" r="1.4" {...P} />
      <circle cx="16" cy="13" r="1.4" {...P} />
    </>
  ),
  // 操作审计：带勾的清单
  "/audit": (
    <>
      <path d="M6 4h12v16H6z" {...P} />
      <path d="M9 9l1.6 1.6L14 7M9 15h6" {...P} />
    </>
  ),
  // 用量与成本：柱状图
  "/usage": <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" {...P} />,
  // 财务：钱包
  "/finance": (
    <>
      <path d="M3 7h15a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" {...P} />
      <path d="M3 7l12-3 1.5 3" {...P} />
      <circle cx="17" cy="13" r="1.2" {...P} />
    </>
  ),
  // 轨迹回放：路径上的点
  "/trace": (
    <>
      <path d="M5 18c6 0 4-12 10-12" {...P} />
      <circle cx="5" cy="18" r="2" {...P} />
      <circle cx="17" cy="6" r="2" {...P} />
    </>
  ),
  // Workflow：分支
  "/workflow": (
    <>
      <circle cx="6" cy="6" r="2" {...P} />
      <circle cx="6" cy="18" r="2" {...P} />
      <circle cx="18" cy="12" r="2" {...P} />
      <path d="M6 8v8M8 6h4a4 4 0 014 4M8 18h4a4 4 0 004-4" {...P} />
    </>
  ),
  // 知识库：书
  "/knowledge": (
    <>
      <path d="M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3z" {...P} />
      <path d="M5 17a3 3 0 013-3h11" {...P} />
    </>
  ),
  // 评测任务：带勾的记分板（一张卡、一个勾）
  "/evals": (
    <>
      <path d="M5 4h14v16H5z" {...P} />
      <path d="M9 4V2h6v2" {...P} />
      <path d="M8.5 13l2.5 2.5 4.5-5" {...P} />
    </>
  ),
  // 基线报告：文档 + 基准线（底部一条粗横线代表"对照物"）
  "/evals/baseline": (
    <>
      <path d="M6 3h9l4 4v14H6z" {...P} />
      <path d="M15 3v4h4" {...P} />
      <path d="M9 12h6M9 15h6" {...P} />
      <path d="M8 19h8" {...P} strokeWidth={2.4} />
    </>
  ),
  // 演示大屏：显示器
  "/demo": (
    <>
      <path d="M3 5h18v11H3z" {...P} />
      <path d="M9 20h6M12 16v4" {...P} />
    </>
  ),
};

/** 没有对应图标时渲染空占位——**保持缩进对齐**，缺一个图标不该让那一行整体左移。 */
export function NavIcon({ to }: { to: string }): JSX.Element {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
      {PATHS[to] ?? null}
    </svg>
  );
}
