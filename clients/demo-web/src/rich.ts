/**
 * 回答正文的最小富文本：段落、换行、**加粗**。
 *
 * 为什么不引 markdown 库：应答的系统提示词只允许模型用加粗这一种标记
 * （它是给语音播报写的，列表与标题念不出来），所以一个 20 行的切分器就是全集；
 * 为它引一个依赖，还要多过一道"引入新依赖"的变更单。
 * 为什么必须做：不渲染的话正文里满是裸的星号，看起来像出了故障。
 *
 * 纯函数、零 DOM，渲染在 App 里用 React 元素拼——**不走 innerHTML**，
 * 模型输出里即使混进标签也只会被当成文字显示。
 */
export interface Span {
  text: string;
  bold: boolean;
}

export function splitBold(line: string): Span[] {
  const out: Span[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) out.push({ text: line.slice(last, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last), bold: false });
  return out;
}

/** 流式途中会出现只到了一半的 `**`——没配对的星号原样留着，等下一个 delta 补齐。 */
export function paragraphs(text: string): Span[][][] {
  return text
    .split(/\n{2,}/)
    .filter((p) => p.trim().length > 0)
    .map((p) => p.split("\n").map(splitBold));
}
