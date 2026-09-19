/**
 * 情绪 × 任务地图的视图模型（施工单 M82-09）。**纯函数。**
 *
 * # 六种情绪不给六种颜色
 *
 * 类目靠位置与标签区分（Brief 判断 1）。给情绪上色的后果是"焦虑=红、信任=绿"
 * 这种读法悄悄成立，而它是我们自己加的判断，不在数据里。
 * 所以视图模型给每个节点同一个 `tone`，并有单测断言它们全相等。
 *
 * # `mixed` / `uncertain` 是两个真实节点，不是脚注
 *
 * 判不出是一个真实的观察结果——它说的是"这批语料里有一成的话短到看不出情绪"，
 * 那对采集方式是有用的反馈。藏起来会让情绪分布看着比实际干净。
 */

export interface EmotionJobData {
  jobs: Array<{ code: string; label: string; n: number }>;
  emotions: Array<{ code: string; label: string; n: number }>;
  flows: Array<{
    job?: string;
    emotion?: string;
    n?: number;
    intensityMean?: number;
    resolvedRate?: number;
    suppressed?: boolean;
    reason?: string;
  }>;
  mixed: number;
  uncertain: number;
}

/** 所有节点共用的色调——**不给类目上色**，单测断言全相等。 */
export const NODE_TONE = "accent" as const;

export interface EmotionNode {
  code: string;
  label: string;
  n: number;
  tone: typeof NODE_TONE;
  /** `mixed` / `uncertain` 也在这份清单里，标出来但不排除。 */
  outOfGrid: boolean;
}

export interface EmotionFlow {
  job: string;
  emotion: string;
  /** 中文名。快照给的是码，节点清单里带着名——查表，不另起一份对照。 */
  jobLabel: string;
  emotionLabel: string;
  n: number;
  intensityMean: number;
  resolvedRate: number;
}

export interface EmotionJobView {
  jobs: EmotionNode[];
  emotions: EmotionNode[];
  flows: EmotionFlow[];
  /** 被抑制的格数——它们不进 flows，但要在说明里报出来。 */
  suppressedFlows: number;
  mixed: number;
  uncertain: number;
  /** Top 关联表，按 n 降序。 */
  top: EmotionFlow[];
}

const OUT_OF_GRID = new Set(["mixed", "uncertain"]);

export function emotionJobView(data: EmotionJobData, topN = 8): EmotionJobView {
  const jobLabels = new Map(data.jobs.map((j) => [j.code, j.label]));
  const emotionLabels = new Map(data.emotions.map((e) => [e.code, e.label]));

  const flows: EmotionFlow[] = data.flows
    .filter((f) => !f.suppressed && f.job && f.emotion)
    .map((f) => ({
      job: String(f.job),
      emotion: String(f.emotion),
      jobLabel: jobLabels.get(String(f.job)) ?? String(f.job),
      emotionLabel: emotionLabels.get(String(f.emotion)) ?? String(f.emotion),
      n: f.n ?? 0,
      intensityMean: f.intensityMean ?? 0,
      resolvedRate: f.resolvedRate ?? 0,
    }));

  const node = (x: { code: string; label: string; n: number }): EmotionNode => ({
    ...x,
    tone: NODE_TONE,
    outOfGrid: OUT_OF_GRID.has(x.code),
  });

  return {
    jobs: data.jobs.map(node),
    emotions: data.emotions.map(node),
    flows,
    suppressedFlows: data.flows.filter((f) => f.suppressed).length,
    mixed: data.mixed,
    uncertain: data.uncertain,
    top: [...flows].sort((a, b) => b.n - a.n).slice(0, topN),
  };
}
