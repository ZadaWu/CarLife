/**
 * 情绪 × 任务地图 `/research/emotion-job-map`（施工单 M82-09，Brief `emotion-job-map.brief.md`）。
 *
 * # 六种情绪不给六种颜色
 *
 * 本控制台的颜色是**状态**的语言（绿=正常 / 黄=需注意 / 红=失败）。给情绪配六个色相，
 * 读者要先分辨"这个绿是情绪分类还是系统正常"（Brief P1）。所有节点同一 `tone`，
 * 视图模型里有单测钉住。
 *
 * # 「复合」与「判不出」是两个真实节点
 *
 * 判不出是一个真实的观察结果——它说的是"这批语料里有一成的话短到看不出情绪"，
 * 对采集方式是有用的反馈。藏起来会让情绪分布看着比实际干净（Brief P4）。
 * 两者在左列底部**与上面六类之间有分隔**，且不参与占比分母。
 *
 * # 结果列不按效价上色
 *
 * Brief §3⑥ 的结果列有六个类目（已解决 / 部分解决 / 未解决 / 被安全门拒绝 …）并各配一色。
 * 快照里**没有这六个类目**，只有每条链的 `resolvedRate` 一个连续值。
 * 把连续值切成三档上色需要我们自己定切点，而那个切点不在数据里——
 * 所以这一列是单色条 + 百分比，切点缺位如实写在说明里。
 */

import { useMemo, useState } from "react";

import { ResearchFrame } from "../shell/ResearchFrame";
import { Unavailable } from "../shell/Unavailable";
import { useSnapshot } from "../shell/useSnapshot";
import { EmotionMap } from "./EmotionMap";
import { emotionJobView, type EmotionJobData } from "./model";

/** 窄口提示的原话（Brief §3⑤，常驻不可折叠）。 */
const NARROW_NOTE =
  "情绪证据在车内场景系统性偏弱：驾驶中表达少、ASR 转写丢失语气、" +
  "强表达有一部分被内容安全前置拦下。本页分布不可与社媒情绪分布直接比较。";

export function EmotionJobMapPage(): JSX.Element {
  const state = useSnapshot<EmotionJobData>("emotion-job-map");
  const [selected, setSelected] = useState(0);

  const view = useMemo(
    () => (state.kind === "ready" ? emotionJobView(state.snapshot.data) : null),
    [state],
  );

  if (state.kind === "unavailable") return <Unavailable code={state.code} />;
  if (state.kind === "loading")
    return <div className="page"><h1>情绪 × 任务地图</h1><p className="page-sub">读取中…</p></div>;
  if (state.kind === "computing")
    return <div className="page"><h1>情绪 × 任务地图</h1><p className="page-sub">快照还在算，稍后刷新。</p></div>;
  if (state.kind === "error")
    return <div className="page"><h1>情绪 × 任务地图</h1><p className="page-sub">读取失败：{state.message}</p></div>;
  if (!view) return <div className="page" />;

  const snap = state.snapshot;
  const link = view.top[selected];

  return (
    <ResearchFrame
      title="情绪 × 任务地图"
      subtitle="带着什么情绪来 → 想完成什么任务 → 这条链最后解决了多少"
      population={snap.population}
      window={snap.window}
      codebookVersion={snap.codebookVersion}
      codebookLocked={snap.gates.measurement.status === "pass"}
      gates={snap.gates}
      toolbar={
        <>
          <span className="uz-seg is-active">情绪体系：六类 + 复合 + 判不出</span>
          <span className="uz-seg">人群：全部车主</span>
          <span className="uz-seg">来源：全部来源</span>
        </>
      }
      legend={
        <>
          <span><b>连接带粗细</b>：该「任务 → 情绪」链的去重轮次，按最大值归一化，是刻度不是数字</span>
          <span><b>占比</b>：各列节点的 n 来自快照。<b>复合与判不出不进情绪占比的分母</b></span>
          <span><b>结果列</b>：该链的 `resolvedRate`（该轮算解决了的比例），口径同重要度×表现度的表现度轴</span>
          <span><b>结果列不着色</b>：快照只有一个连续解决率，没有「已解决 / 部分解决 / 被安全门拒绝」这些类目，切档上色的切点得我们自己编</span>
          <span><b>情绪不做正负二分</b>：极性会压平焦虑、期待与混合体验</span>
          <span><b>抑制</b>：低于 10 台车的链已在快照里清空，本页共 {view.suppressedFlows} 条</span>
        </>
      }
      drawer={
        <div className="rm-drawer">
          <div className="rm-drawer-title"><strong>情绪体系与图示含义</strong></div>
          <div className="rm-drawer-sec">
            <h4>八个位置</h4>
            <p className="rm-dim">
              六类情绪按左列固定位置排；<b>复合</b>（同一句里两种情绪都成立）与
              <b>判不出</b>（话太短或只有指令）在分隔线以下单列，不并入六类。
              本窗复合 {view.mixed} 轮、判不出 {view.uncertain} 轮。
            </p>
          </div>
          {link ? (
            <>
              <div className="rm-drawer-sec">
                <h4>选中链路</h4>
                <p className="rm-drawer-claim">
                  {link.jobLabel} → {link.emotionLabel}：{link.n} 条证据，强度均值 {link.intensityMean.toFixed(2)}，
                  解决率 {Math.round(link.resolvedRate * 100)}%。
                </p>
              </div>
              <div className="rm-drawer-sec">
                <h4>强度是模型判定</h4>
                <p className="rm-dim">
                  强度不是自评量表，是编码模型对单句给的分。缺席时记 0 而不是补一个中位数——没记就是没记。
                </p>
              </div>
            </>
          ) : null}
          <div className="rm-drawer-sec">
            <h4>典型原声</h4>
            <p className="rm-dim">
              按主题取原声要主题聚类，而本部署没有配 DASHSCOPE_API_KEY，主题还没算出来。
              逐条证据可在「证据」接口按场景 / 反例筛选，每条只出脱敏派生文本。
            </p>
          </div>
          <div className="rm-drawer-sec">
            <h4>允许用途</h4>
            <p className="rm-dim">内部排序 · 原声已本地脱敏 · 禁止对外展示原文 · 回放记入操作审计</p>
          </div>
        </div>
      }
    >
      {/* 窄口提示：紧接工具条，常驻（Brief §3⑤ / C6） */}
      <p className="banner-warn ej-narrow">{NARROW_NOTE}</p>

      <EmotionMap
        jobs={view.jobs}
        emotions={view.emotions}
        flows={view.top}
        selected={selected}
        onSelect={setSelected}
      />

      <h3 className="ipa-h3">情绪 × 任务 Top 关联</h3>
      <table className="rm-table">
        <thead>
          <tr>
            <th className="rm-idx">#</th>
            <th>任务</th>
            <th>情绪</th>
            <th>证据数</th>
            <th>强度均值</th>
            <th>解决率</th>
          </tr>
        </thead>
        <tbody>
          {view.top.map((f, i) => (
            <tr
              key={`${f.job}|${f.emotion}`}
              className={i === selected ? "is-selected" : undefined}
              onClick={() => setSelected(i)}
            >
              <td className="rm-idx">{i + 1}</td>
              <td>{f.jobLabel}</td>
              <td>{f.emotionLabel}</td>
              <td className="rm-nn">{f.n.toLocaleString("zh-CN")}</td>
              <td className="rm-nn">{f.intensityMean.toFixed(2)}</td>
              <td className="rm-nn">{Math.round(f.resolvedRate * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ResearchFrame>
  );
}
