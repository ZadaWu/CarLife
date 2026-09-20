/**
 * 魔搭创空间的落地页（ACR-048 → ACR-049 改版）。
 *
 * 它只做一件事：把访客送进两端的真界面。
 *
 * 早先这里是一个自己做的试用对话页——那时两端的界面还进不了浏览器，只能拿一个
 * 聊天框代替。ACR-049 的传输垫片落地之后它就多余了：与其让人在一个"为演示而做的
 * 页面"里体验，不如直接给产品本身。留着两个东西反而让人以为那个聊天框才是产品。
 *
 * 页面上只有两张入口卡，截图就是卡面——访客看到的是"这个界面长什么样"，
 * 点下去进的就是它。早先入口下面还挂着试用提示与实拍两节，入口反而被挤成了两行字。
 *
 * 对话、语音、确认卡那些能力都在 `/mobile/` 与 `/cockpit/` 里，走的是两端自己的代码。
 */

import { config } from "./config.ts";

const SURFACES = [
  {
    key: "cockpit",
    href: "pad.html",
    title: "车机端",
    shot: "/showcase/screenshot-cockpit.jpg",
    detail: "HUD、地图与行程、助手形象。左下角「长按说话」，说完松手即可。",
  },
  {
    key: "mobile",
    href: "phone.html",
    title: "手机端",
    shot: "/showcase/screenshot-mobile.jpg",
    detail: "拍照问诊、对话、车辆档案。拍一张仪表盘，不用打字。",
  },
];

export default function App() {
  return (
    <div className="app landing">
      {config.notice ? <div className="notice">{config.notice}</div> : null}

      <header>
        <h1>CarLife</h1>
        <span className="tagline">面向车主全生命周期的用车智能体</span>
        <span className="build" title="镜像构建时间">{config.buildId}</span>
      </header>

      <main>
        <div className="surfaces">
          {SURFACES.map((s) => (
            <a key={s.key} className={`surface surface-${s.key}`} href={s.href}>
              <span className="shot">
                <img src={s.shot} alt={`${s.title}界面`} />
              </span>
              <span className="meta">
                <strong>{s.title}</strong>
                <span className="cta">点击进入 →</span>
              </span>
              <span className="detail">{s.detail}</span>
            </a>
          ))}
        </div>
      </main>
    </div>
  );
}
