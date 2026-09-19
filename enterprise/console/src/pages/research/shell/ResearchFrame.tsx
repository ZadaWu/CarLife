/**
 * 研究面五页共用的壳（施工单 M82-08）。
 *
 * 自上而下：页头 → **观察总体条** → 「不代表市场」警示 → **四道硬门条** →
 * 工具条插槽 → 主体 → 底部说明 → 右侧证据栏。
 *
 * # 限制不能藏在页脚
 *
 * 观察总体与四道门是**常驻**的，不可折叠（方法本体 §16 / Brief P5）。
 * 把它们收进"数据说明"里，页面就会看起来像一个可以直接引用的结论页——
 * 而它不是：观察总体是已授权车主，不代表市场。
 */

import type { ReactNode } from "react";

import { gateTiles, metaBar, type Gates, type Population } from "./model";

export interface ResearchFrameProps {
  title: string;
  subtitle: string;
  population: Population;
  window: { from: number; to: number };
  codebookVersion: string;
  codebookLocked: boolean;
  gates: Gates;
  toolbar?: ReactNode;
  children: ReactNode;
  legend?: ReactNode;
  drawer?: ReactNode;
}

export function ResearchFrame(props: ResearchFrameProps): JSX.Element {
  const meta = metaBar(
    { population: props.population, window: props.window, codebookVersion: props.codebookVersion },
    props.codebookLocked,
  );
  const tiles = gateTiles(props.gates);

  return (
    <div className="page research-page">
      <h1>{props.title}</h1>
      <p className="page-sub">{props.subtitle}</p>

      {/* 观察总体条：三个分母各写各的，常驻不可折叠 */}
      <dl className="meta-bar research-meta">
        {meta.map((m) => (
          <div key={m.label}>
            <dt>{m.label}</dt>
            <dd>{m.value}</dd>
          </div>
        ))}
      </dl>

      <p className="banner-warn research-banner">
        观察总体为已授权车主，不代表市场总体 —— 本页结论一律为 Signal 级
      </p>

      {/* 四道硬门：只有降级/失败那块着色，通过的保持中性竖条 */}
      <div className="research-gates">
        {tiles.map((t) => (
          <div key={t.key} className={`audit-stat research-gate is-${t.tone}`}>
            <span className="research-gate-name">{t.name}</span>
            <strong className="research-gate-status">{t.statusText}</strong>
            <span className="research-gate-reason">{t.reason}</span>
          </div>
        ))}
      </div>

      {props.toolbar ? <div className="research-toolbar">{props.toolbar}</div> : null}

      <div className="research-body">
        <div className="research-main">
          {props.children}
          {props.legend ? <div className="wf-legend research-legend">{props.legend}</div> : null}
        </div>
        {props.drawer ? <aside className="drawer research-drawer">{props.drawer}</aside> : null}
      </div>
    </div>
  );
}
