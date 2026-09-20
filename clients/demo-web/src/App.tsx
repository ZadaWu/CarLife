/**
 * 魔搭创空间的落地页（ACR-048 → ACR-049 改版）。
 *
 * 它只做一件事：把访客送进两端的真界面。
 *
 * 早先这里是一个自己做的试用对话页——那时两端的界面还进不了浏览器，只能拿一个
 * 聊天框代替。ACR-049 的传输垫片落地之后它就多余了：与其让人在一个"为演示而做的
 * 页面"里体验，不如直接给产品本身。留着两个东西反而让人以为那个聊天框才是产品。
 *
 * 对话、语音、确认卡那些能力都在 `/mobile/` 与 `/cockpit/` 里，走的是两端自己的代码。
 */

import { config } from "./config.ts";

const SURFACES = [
  {
    href: "pad.html",
    title: "车机端",
    lead: "点击可以体验",
    detail: "HUD、地图与行程、助手形象。对话入口是左下角「长按说话」——车机没有键盘，说完松手即可。",
  },
  {
    href: "phone.html",
    title: "手机端",
    lead: "点击可以体验",
    detail: "功能入口页、对话、拍照问诊、车辆档案。可以打字，也可以按住说话。",
  },
];

const HIGHLIGHTS = [
  ["它认识你这辆车", "问「我这车续航掉得快正常吗」，回答里会出现这辆车的里程、实测续航、日均行驶——不是任何人问都一样的通用答案。"],
  ["动手之前先问你", "说「把车里的儿童模式打开」，它会先弹确认卡：要做什么、影响哪里、要把你的哪些信息发出去，点同意才执行。"],
  ["一句话办三件事", "说「下周末带父母去杭州自驾，顺路把保养做了，再去 4S 店挑辆新车试驾」，行程、保养、试驾会被拆成三条线同时推进。"],
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
        <p className="lead">
          下面两个入口打开的是<strong>车机端与手机端本身的界面</strong>——与原生应用同一套代码，
          只是网络那一层从设备上的 Rust 换成了浏览器直连服务端。
          常驻唤醒、车辆信号这类只能在设备上做的能力，界面会如实显示不可用。
        </p>

        <div className="surfaces">
          {SURFACES.map((s) => (
            <a key={s.href} className="surface" href={s.href}>
              <strong>{s.title}</strong>
              <span className="cta">{s.lead} →</span>
              <span className="detail">{s.detail}</span>
            </a>
          ))}
        </div>

        <section className="highlights">
          <h2>进去之后值得试的三件事</h2>
          <dl>
            {HIGHLIGHTS.map(([title, body]) => (
              <div key={title}>
                <dt>{title}</dt>
                <dd>{body}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="showcase">
          <h2>原生应用的实拍</h2>
          <div className="shots">
            <figure>
              <img src="/showcase/screenshot-cockpit.jpg" alt="车机端界面" loading="lazy" />
              <figcaption>车机端 · HUD 与语音助手</figcaption>
            </figure>
            <figure>
              <img src="/showcase/screenshot-mobile.jpg" alt="手机端界面" loading="lazy" />
              <figcaption>手机端</figcaption>
            </figure>
          </div>
          <figure className="wide">
            <img src="/showcase/compound-intent-lanes.png" alt="复合意图的分叉与汇合示意" loading="lazy" />
            <figcaption>「一句话办三件事」背后：意图拆成主任务与副任务，分叉成几条 lane 并行求解，再汇合成一段回答</figcaption>
          </figure>
          <p className="links">源码与文档见本页上方的「文件」。</p>
        </section>
      </main>
    </div>
  );
}
