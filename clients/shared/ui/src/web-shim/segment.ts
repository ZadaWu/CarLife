/**
 * 播报文本的分段（ACR-049，移植自 `clients/cockpit/src-tauri/src/tts/segment.rs`）。
 *
 * # 为什么要切
 *
 * 整段送去合成、合成完才起播的话，车主要干等。那边真跑拟合出来的式子是：
 *
 *     合成耗时 ≈ 723 ms + 30.3 ms × 字数
 *
 * 我在浏览器里实测一段约 250 字的回答，合成 8.4 秒——正好落在这条线上。
 * 回答的字早就出完了，声音才开始。
 *
 * # 档位是算出来的，不是拍的
 *
 * 每一段都要单付一次 723 ms 固定开销，所以"首段越短越好"是错的。
 * 中文播报约 4.5 字/秒（222 ms 一个字），段 N 要赶在段 N-1 播完前合成好：
 *
 *     723 + 30.3·len(N) < 222·len(N-1)
 *
 * 代进去：8 字首段配 64 字次段会断 888 ms（听得出来的"卡一下"），
 * 12 字配 32 字余 970 ms。所以次段夹一个缓冲档，第三段起才放开到 64。
 *
 * 切的是**送去合成的单位**，不是句子学意义上的句子。
 */

const FIRST_MIN = 12;
const FIRST_MAX = 24;
const RAMP_MAX = 32;
const REST_MAX = 64;
const TAIL_MIN = 8;

const isCjkTerminator = (c: string) => "。！？；…．｡".includes(c);
const isSoftBreak = (c: string) => "，、：,:—".includes(c);

/**
 * ASCII 句末标点该不该切——**这是有歧义的那一类**，要看前后。
 * 不看的话会切出洋相，而且都是中文播报里真会出现的形状：
 * `3.5 小时` 切成「三」「五小时」、`example.com` 域名读一半。
 */
function asciiTerminates(chars: string[], i: number): boolean {
  const c = chars[i];
  if (c === "!" || c === "?" || c === ";") return true;
  if (c !== ".") return false;
  const prevDigit = i > 0 && /[0-9]/.test(chars[i - 1]);
  const next = chars[i + 1];
  return !prevDigit && (next === undefined || /\s/.test(next));
}

const capFor = (done: number) => (done === 0 ? FIRST_MAX : done === 1 ? RAMP_MAX : REST_MAX);
const floorFor = (done: number) => (done === 0 ? FIRST_MIN : TAIL_MIN);
const hardCap = (done: number) => capFor(done) + FIRST_MAX;

/**
 * 从缓冲里取出**已经完整**的段，返回剩下的尾巴。
 * `done` 是这一轮已经切出去几段——档位按它升。
 */
export function takeComplete(buf: string, done: number): { segments: string[]; rest: string } {
  const chars = [...buf];
  const segments: string[] = [];
  let segStart = 0;
  let consumed = 0;

  for (let i = 0; i < chars.length; i++) {
    const n = i - segStart + 1;
    const idx = done + segments.length;
    const cut =
      ((isCjkTerminator(chars[i]) || asciiTerminates(chars, i)) && n >= floorFor(idx)) ||
      (isSoftBreak(chars[i]) && n >= capFor(idx)) ||
      n >= hardCap(idx);
    if (cut) {
      const seg = chars.slice(segStart, i + 1).join("").trim();
      if (seg) segments.push(seg);
      segStart = i + 1;
      consumed = i + 1;
    }
  }
  return { segments, rest: chars.slice(consumed).join("") };
}

/** 整段切完（收口时用，尾巴太短就并进前一段——免得最后蹦出两个字）。 */
export function splitForSpeech(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if ([...trimmed].length <= FIRST_MAX) return [trimmed];
  const { segments, rest } = takeComplete(trimmed, 0);
  const out = [...segments];
  if (rest.trim()) out.push(rest.trim());
  if (out.length >= 2 && [...out[out.length - 1]].length < TAIL_MIN) {
    const tail = out.pop()!;
    out[out.length - 1] += tail;
  }
  return out;
}

/**
 * 把 markdown 记号从播报文本里剥掉（移植自 `cockpit/src-tauri/src/tts/mod.rs`
 * 的 `strip_markdown_for_speech`）。
 *
 * 模型的回答带 `**加粗**`、`- 列表` 这类记号——屏幕上渲染没问题，但 TTS 会把
 * `**` 逐字读成「星星」。提示词里"适合语音播报"的要求挡不住它（原生端实测照写），
 * 所以在**唯一的播报入口**用代码剥，不赌模型守规矩。
 *
 * 只删记号不动内容：链接保留可读文字，列表符换成停顿。
 * **必须在分段之前调用**——先切会把成对记号切散，`**` 的两半落进不同段就剥不掉了。
 */
export function stripMarkdownForSpeech(text: string): string {
  const lines = text.split("\n").map((line) =>
    line
      .trimStart()
      // 行首的标题 / 引用 / 列表记号
      .replace(/^#+/, "")
      .replace(/^>+/, "")
      .replace(/^[-*+]+/, "")
      .trimStart(),
  );
  let s = lines.join("\n").replace(/\*\*/g, "").replace(/__/g, "").replace(/`/g, "");
  s = s.replace(/[*_]/g, "");
  // [文字](链接) → 文字
  return s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}
