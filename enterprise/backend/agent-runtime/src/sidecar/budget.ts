/**
 * 旁路的节奏参数（施工单 M18-03 建立，M18-09 瘦身）。
 *
 * # 这里**只管节奏，不管什么时候该收摊**
 *
 * M18-03~08 期间这里还有 `maxPerTurn`（条数上限）与 `maxTotalMs`（总时长上限），
 * 立它们的理由是"卡住的 turn 配上持续的垫场会让用户更晚发现出问题了"。
 *
 * M18-09 走查把这个职责划回去了：**turn 会不会结束是会话超时的事**。
 * 旁路的生命周期本来就绑在 turn 上（`closePair` 挂在 `turn-runner.run()` 的
 * `finally`，正常收口 / 异常 / 取消都会走到），turn 一结束节拍就停。
 * 在这里再设一个天花板是重复造闸，而且那个闸的值（20 秒）正常等待就会撞上——
 * 实测主 agent 的 fan-out 汇聚超时是 60 秒，一次长等待轻松超过 20 秒。
 *
 * 所以现在只剩两个时间参数：多久算静默、两句之间隔多久。
 */

export interface SidecarConfig {
  /**
   * 静默多久算"该说句话了"。
   *
   * ⚠️ **1500 是单样本初值，不是结论**（架构 §13-14 要求 P50~P90 之间）。
   * 依据：2026-08-13 两轮实测里 `guard.input` 在 225~287ms 结束、
   * `acp.session_new` 在 1580~1875ms 结束——1500ms 落在两者之间。
   */
  silenceMs: number;

  /**
   * 两句之间隔多久。**从上一句估算播完的时刻算起**（M18-09 约束 1）。
   *
   * 按"发出时刻"算是个真 bug：M18-08 之前每句才 9 个字（约 2 秒），
   * 4000ms 的间隔大于播报时长所以没暴露；第 1 句变成 40 多字（约 8 秒）之后，
   * 第 4 秒就会发出第 2 句**把第 1 句掐掉**——用户听到的是半句。
   *
   * ⚠️ **它不是"每隔这么久说一句"，是"上一句念完之后再等这么久"。**
   * 所以调小它并不会让说话变密到互相打断——播报时长那一段永远在前面顶着。
   * 走查把它定到 500ms：等待期本来就该是满的，句与句之间只留一口气的停顿。
   */
  minGapMs: number;

  /**
   * 每个字的播报时长估算，用来推算"这句什么时候念完"。
   *
   * 服务端拿不到端上的播完回执，也**不该为此加一条上行通道**——
   * M18-04 刚把 filler 定成不留痕的瞬时事件，加回执等于把它变成有状态的东西。
   * 中文 TTS 约 4~5 字/秒，实测第 1 句 45~49 字对应 9~10 秒，200ms/字 吻合。
   *
   * ⚠️ **它是节奏提示，不是保障**（M18-09 走查第六轮）。
   * `minGapMs` 还是 4000 时它兼着做保障：4 秒余量兜得住估算误差。
   * 走查把间隔定到 500ms 之后余量没了，估算短一点就是一刀——
   * 端上 `speak_filler` 会把正在播的那句掐掉，用户听到半句。
   *
   * 真正的保障已经挪到端上（`tts::filler_slot`）：**正在播就等它播完**，
   * 因为只有端上知道真相。这里估得准一点只是让节奏好看，估偏了不会再截断。
   */
  speechMsPerChar: number;

  /**
   * 重新判定的节拍（施工单 M18-08）。
   *
   * span 是**完成时**才落的——实测 `tool.ragflow_retrieve` 单跳占 3.8 秒，
   * 检索正在跑的那几秒轨迹侧一个事件都没有，纯事件驱动根本不会被唤起。
   *
   * 它只重新判定，**不制造内容**：内容仍然只来自模板/生成器，
   * 无可映射信号时 tick 多少次都是零输出。
   */
  tickMs: number;
}

const DEFAULTS: SidecarConfig = {
  silenceMs: 1500,
  /*
   * 走查定值（2026-08-14）。此前是 4000（走查区间 3000~5000 取中），
   * 实测下来那个停顿在车里听着像"它说完了"，于是每句之间都要重新等一下。
   * 因为间隔是从**念完**起算的，500ms 不会造成句子互相打断（见字段注释）。
   */
  minGapMs: 500,
  speechMsPerChar: 200,
  tickMs: 700,
};

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * 现取而不是模块级快照：`env-timing` 不变量要求非入口模块不在模块级读
 * `process.env`（否则 `.env` 改了不生效，而这种故障没有任何症状）。
 */
export function sidecarConfig(): SidecarConfig {
  return {
    silenceMs: num("SIDECAR_SILENCE_MS", DEFAULTS.silenceMs),
    minGapMs: num("SIDECAR_MIN_GAP_MS", DEFAULTS.minGapMs),
    speechMsPerChar: num("SIDECAR_SPEECH_MS_PER_CHAR", DEFAULTS.speechMsPerChar),
    tickMs: num("SIDECAR_TICK_MS", DEFAULTS.tickMs),
  };
}

export function sidecarDefaults(): SidecarConfig {
  return { ...DEFAULTS };
}

/** 这句话大概要念多久。上限判定与预生成都靠它。 */
export function estimateSpeechMs(text: string, cfg: SidecarConfig): number {
  return [...text].length * cfg.speechMsPerChar;
}

/**
 * 生成失败/被拒之后，多久才允许再打一次模型。
 *
 * **刻意不复用 `minGapMs`。** 那两个数是两件事：
 * 一个是"说话的节奏"（用户体感），一个是"重试的退避"（花钱与限流）。
 * 早先它们共用一个值，`minGapMs` 从 4000 调到 500 时退避跟着塌成半秒——
 * 表现是被过滤器拒一次之后，节拍每响一下就重打一次模型，
 * 而用户侧毫无异常：他只是听不到 L1，全程都是 L0 模板话。
 *
 * 取 `max(minGapMs, 2000)`：节奏可以任意调快，退避有地板。
 */
export function genRetryMs(cfg: SidecarConfig): number {
  return Math.max(cfg.minGapMs, 2000);
}
