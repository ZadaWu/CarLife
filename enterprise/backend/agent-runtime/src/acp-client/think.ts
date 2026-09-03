/**
 * 模型思考时长的分段（施工单 TD-08 追加，F-44-04）。
 *
 * # 为什么必须记它：链路上最贵的一段此前是**纯空白**
 *
 * 实测一次应答 27442ms，摊开是：
 *
 * ```
 * +0     ~ +1610    acp.session_new       1610ms
 * +1610  ~ +17474   空白 15864ms          ← 没有任何事件
 * +17474 ~ +18153   5× tool.weather        679ms
 * +18153 ~ +24351   空白  6198ms          ← 没有任何事件
 * +24351 ~ +27442   生成 251 个字         3091ms
 * ```
 *
 * 两段空白共 22 秒，占全轮 80%。它们不是网络等待也不是框架开销——
 * pi 跑的是**推理模型**（`~/.pi/agent/models-store.json` 里两个 DeepSeek V4 都是
 * `reasoning: true`），那 22 秒是模型在思考。而 `agent_thought_chunk` 被
 * `connection.ts` 直接丢弃（FL-03 F-03-04：思考过程的**展示**归后续），
 * 于是最贵的一段在轨迹里既不是事件也不是耗时。
 *
 * **展示内容是产品决策，记录时长不是。** 这里只记时长与片数，一个字不留。
 *
 * # 为什么按"间隔"分段，而不是一段到底
 *
 * 一轮里模型会思考多次：想 → 调工具 → 拿到结果再想。记成一整段的话，
 * 它会横跨中间的工具调用，读起来像"思考和工具在并行"，而实际是交替的。
 *
 * 分段判据只能靠时间间隔——工具调用走的是另一条 HTTP 通道，这里看不见它。
 * 阈值取在两个数量级之间：推理 token 是连续流，片与片之间是毫秒到几十毫秒；
 * 而一次工具往返实测 550~680ms。400ms 落在中间，两边都留着一倍以上的余量。
 */

/** 一片思考的到达时刻与字数。**不留内容。** */
export interface ThoughtTick {
  at: number;
  chars: number;
}

export interface ThinkBurst {
  startedAt: number;
  endedAt: number;
  chunks: number;
  chars: number;
}

/**
 * 分段阈值。见文件头：远大于片间隔（毫秒级），远小于一次工具往返（数百毫秒）。
 */
export const THINK_GAP_MS = 400;

/**
 * 把连续到达的思考片切成若干段。
 *
 * 单片也算一段（`startedAt === endedAt`，时长 0）——**它确实发生过**，
 * 丢掉的话"模型只想了一下"和"模型完全没想"在轨迹上会长得一样。
 */
export function splitThinkBursts(
  ticks: readonly ThoughtTick[],
  gapMs: number = THINK_GAP_MS,
): ThinkBurst[] {
  if (ticks.length === 0) return [];

  const bursts: ThinkBurst[] = [];
  let cur: ThinkBurst | undefined;

  for (const t of ticks) {
    if (cur && t.at - cur.endedAt <= gapMs) {
      cur.endedAt = t.at;
      cur.chunks += 1;
      cur.chars += t.chars;
      continue;
    }
    cur = { startedAt: t.at, endedAt: t.at, chunks: 1, chars: t.chars };
    bursts.push(cur);
  }

  return bursts;
}
