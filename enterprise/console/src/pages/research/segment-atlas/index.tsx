/**
 * 人群分群图谱 `/research/segment-atlas`（施工单 M82-09，Brief `segment-atlas.brief.md`）。
 *
 * # 五张卡同色
 *
 * 参考稿给每群一个身份色，本控制台不这么做——颜色是状态的语言
 * （沿用 `/usage` 页"不给每张卡一个身份色"的既有判断）。关系图的圆也无填充色差，
 * 只有大小与位置是变量。
 *
 * # 抑制态是设计对象，不是异常态
 *
 * 第 5 张卡整卡压暗 + 一块 `.banner-warn`，六行明细清空。它要看起来是
 * "按规矩留白"，不是"加载失败"：群名与样本数仍在（**存在这件事本身不是秘密**），
 * 秘密的是里面有谁。
 *
 * # 「最小群体」只能调大
 *
 * 允许调小等于给"把阈值降到能看见这一小撮人"留了一个入口，而那正是小单元抑制
 * 要防的事。输入夹到 `MIN_CELL_FLOOR`，单测钉住。调大只再收紧本页显示——
 * 真正的硬抑制发生在算快照时，页面改不了它，说明条里写了这句。
 */

import { useMemo, useState } from "react";

import { ResearchFrame } from "../shell/ResearchFrame";
import { Unavailable } from "../shell/Unavailable";
import { useSnapshot } from "../shell/useSnapshot";
import { AtlasGraph } from "./AtlasGraph";
import {
  clampMinCell,
  MIN_CELL_FLOOR,
  segmentAtlasView,
  type SegmentAtlasData,
  type SegmentCard,
} from "./model";

const METHOD_LABEL: Record<string, string> = { "behavior-kmeans-k5": "行为变量聚类（k-means，k=5）" };

const ROW_LABELS: Array<[keyof NonNullable<SegmentCard["rows"]>, string]> = [
  ["task", "核心任务"],
  ["constraint", "关键约束"],
  ["alternative", "当前替代"],
  ["value", "价值点"],
  ["behavior", "关键行为"],
];

function Card({ card, on, onClick }: { card: SegmentCard; on: boolean; onClick: () => void }): JSX.Element {
  return (
    <article
      className={`uz-card sa-card is-${card.status}${card.kind === "suppressed" ? " is-suppressed" : ""}${on ? " is-on" : ""}`}
      onClick={onClick}
    >
      <div className="uz-head">
        <span className="uz-name">{card.name}</span>
        <span className={`uz-chip sa-verify sa-verify--${card.status}`}>{card.statusLabel}</span>
      </div>
      <div className="uz-hero">
        <span className="uz-hero-num">{card.size}</span>
        <span className="uz-hero-unit">台（{Math.round(card.pct * 100)}%）</span>
      </div>

      {card.kind === "suppressed" ? (
        <p className="banner-warn sa-note">{card.note}</p>
      ) : (
        <>
          <dl className="sa-rows">
            {ROW_LABELS.map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                {/* 关键行为是一串标准化坐标，压小压暗——它给的是形状，不是逐个读的数 */}
                <dd className={key === "behavior" ? "sa-vec" : undefined}>
                  {card.rows ? String(card.rows[key] ?? "—") : "—"}
                </dd>
              </div>
            ))}
            <div>
              <dt>可触达性</dt>
              <dd>
                {card.rows ? `${Math.round((card.rows.reach.value ?? 0) * 100)}%` : "—"}
                {/* 实测 / 估算两者不可混比，所以角标必显 */}
                <span className="uz-chip sa-reach">{card.rows?.reach.kind === "measured" ? "实测" : "估算"}</span>
              </dd>
            </div>
          </dl>
          <div className="sa-tags">
            {card.tags.map((t) => (
              <span key={t} className="uz-chip">{t}</span>
            ))}
          </div>
        </>
      )}
    </article>
  );
}

export function SegmentAtlasPage(): JSX.Element {
  const state = useSnapshot<SegmentAtlasData>("segment-atlas");
  const [minCell, setMinCell] = useState(MIN_CELL_FLOOR);
  const [selected, setSelected] = useState<string | null>(null);

  const view = useMemo(
    () => (state.kind === "ready" ? segmentAtlasView(state.snapshot.data, minCell) : null),
    [state, minCell],
  );

  if (state.kind === "unavailable") return <Unavailable code={state.code} />;
  if (state.kind === "loading")
    return <div className="page"><h1>人群分群图谱</h1><p className="page-sub">读取中…</p></div>;
  if (state.kind === "computing")
    return <div className="page"><h1>人群分群图谱</h1><p className="page-sub">快照还在算，稍后刷新。</p></div>;
  if (state.kind === "error")
    return <div className="page"><h1>人群分群图谱</h1><p className="page-sub">读取失败：{state.message}</p></div>;
  if (!view) return <div className="page" />;

  const snap = state.snapshot;
  const validated = view.cards.filter((c) => c.status === "validated").length;
  const drafts = view.cards.filter((c) => c.status === "draft").length;
  const suppressed = view.cards.filter((c) => c.kind === "suppressed").length;

  return (
    <ResearchFrame
      title="人群分群图谱"
      subtitle="按行为变量分出的车主类别；未经外部验证的群标 draft，不进候选池"
      population={snap.population}
      window={snap.window}
      codebookVersion={snap.codebookVersion}
      codebookLocked={snap.gates.measurement.status === "pass"}
      gates={snap.gates}
      toolbar={
        <>
          <span className="uz-seg is-active">分群方法：{METHOD_LABEL[view.method] ?? view.method}</span>
          <span className="uz-seg">数据源：全部来源</span>
          <label className="sa-mincell">
            最小群体
            <input
              type="number"
              min={MIN_CELL_FLOOR}
              step={1}
              value={minCell}
              onChange={(e) => setMinCell(clampMinCell(Number(e.target.value), MIN_CELL_FLOOR))}
            />
            台车
          </label>
          <span className="rm-dim">下限 {MIN_CELL_FLOOR}，只能调大</span>
        </>
      }
      legend={
        <>
          <span><b>分群变量</b>：日均里程、路况构成、长途占比、补能 SOC、低温敏感度、共用成员数、语音占比。<b>不含人口属性</b></span>
          <span><b>外部验证</b>：文本相似不等于人群。未用外部变量验证的群标 <b>draft</b>，不进候选池</span>
          <span><b>可触达性</b>：`实测` 为真实推送回执，`估算` 为综合评估，<b>两者不可混比</b></span>
          <span><b>最小群体 {minCell} 台车</b>：低于阈值不显示明细，避免小单元再识别</span>
          <span><b>调大只收紧本页显示</b>：真正的硬抑制在算快照时按服务端 RESEARCH_MIN_CELL_VEHICLES 做，页面改不了它</span>
          <span><b>相似度</b>：标准化行为质心的余弦，<b>可以是负数</b>；关系图只画最强的几条，其余看对比表</span>
        </>
      }
      drawer={
        <div className="rm-drawer">
          <div className="rm-drawer-title"><strong>分群方法</strong></div>
          <ol className="sa-method">
            <li>先按<b>行为变量</b>聚类，不用文本——文本相似不等于人群（§18.6）</li>
            <li>再用语义标注命名：名字只是标签，不是分群依据</li>
            <li>最后用<b>外部变量</b>验证：验不过的只能是 draft</li>
          </ol>
          <div className="rm-drawer-sec">
            <h4>方法元数据</h4>
            <dl className="sa-meta">
              <div><dt>数据源</dt><dd>行为 + 语料</dd></div>
              <div><dt>样本</dt><dd>{snap.population.vehicles} 台</dd></div>
              <div><dt>分群数</dt><dd>{view.cards.length} 类</dd></div>
              <div><dt>状态</dt><dd>已验证 {validated} · draft {drafts} · 抑制 {suppressed}</dd></div>
              <div><dt>最后更新</dt><dd>{new Date(snap.window.to).toISOString().slice(0, 10)}</dd></div>
            </dl>
          </div>
          <div className="rm-drawer-sec">
            <h4>核心洞察</h4>
            <ol className="sa-insights">
              <li>本窗 {view.cards.length} 群<b>全部未过外部验证</b>：外部变量只有解决率代理一个，区分不出人群</li>
              <li>可触达性全为<b>估算</b>：本部署还没有真实推送回执，别把它当实测读</li>
              <li>
                最小的一群样本不足，<b>本期不做结论</b>
                {(() => {
                  const s = view.cards.find((c) => c.kind === "suppressed");
                  return s ? `（${s.name}，${s.size} 台）` : "";
                })()}
              </li>
            </ol>
          </div>
          <div className="rm-drawer-sec">
            <h4>允许用途</h4>
            <p className="rm-dim">内部排序 · 群不可对外命名发布 · 抑制群不出明细 · 回放记入操作审计</p>
          </div>
        </div>
      }
    >
      <div className="sa-body">
        <div className="sa-cards">
          {view.cards.map((c) => (
            <Card key={c.id} card={c} on={c.id === selected} onClick={() => setSelected(c.id)} />
          ))}
        </div>
        <AtlasGraph nodes={view.nodes} edges={view.edges} selected={selected} onSelect={setSelected} />
      </div>

      <h3 className="ipa-h3">分群对比</h3>
      <table className="rm-table">
        <thead>
          <tr>
            <th className="rm-idx">#</th>
            <th>人群</th>
            <th>核心任务</th>
            <th>样本</th>
            <th>当前替代</th>
            <th>可触达性</th>
            <th>外部验证</th>
            <th>标签</th>
          </tr>
        </thead>
        <tbody>
          {view.cards.map((c, i) => (
            <tr
              key={c.id}
              className={`${c.status === "validated" ? "" : "sa-row--dim"}${c.id === selected ? " is-selected" : ""}`}
              onClick={() => setSelected(c.id)}
            >
              <td className="rm-idx">{i + 1}</td>
              <td>
                {c.name}
                <span className={`uz-chip sa-verify sa-verify--${c.status}`}>{c.statusLabel}</span>
              </td>
              <td className="mono">{c.rows?.task ?? "—"}</td>
              <td className="rm-nn">{c.size} 台（{Math.round(c.pct * 100)}%）</td>
              <td>{c.rows?.alternative ?? "—"}</td>
              <td className="rm-nn">
                {c.rows ? `${Math.round((c.rows.reach.value ?? 0) * 100)}%` : "—"}
                {c.rows ? <span className="uz-chip sa-reach">{c.rows.reach.kind === "measured" ? "实测" : "估算"}</span> : null}
              </td>
              <td>
                {c.kind === "suppressed" ? "样本不足" : (
                  <>
                    <span className={c.externalOk ? "sa-ok" : "sa-warn"}>{c.externalOk ? "✓" : "⚠"}</span> {c.externalText}
                  </>
                )}
              </td>
              <td className="rm-dim">{c.tags.join(" · ") || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ResearchFrame>
  );
}
