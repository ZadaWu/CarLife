/**
 * 切片预处理：把 MinerU 转出的 markdown 整理成**适合被切**的形状（施工单 M8-01 补）。
 *
 * # 为什么不能全交给 RAGFlow
 *
 * RAGFlow 的 HTTP API 只暴露 `chunk_token_num` 与 `delimiter` 两个旋钮，
 * overlap 与 parent-child 都只在后台 UI/Pipeline 里（infiniflow/ragflow#12307、#13857）。
 * 而手册类语料最要命的问题不是块长，是**块丢了"我在哪一节"**：
 *
 *     按住按钮 3 秒，直到指示灯闪烁。
 *
 * 这一块检索命中了也没用——按哪个按钮？实测线上语料 22% 的块短于 50 token，
 * 中位数 108（正好是 RAGFlow 默认的 `chunk_token_num=128`），
 * 落在客服问答推荐区间 256~512 的只有 12%。
 *
 * # 这里做四件事
 *
 * 1. **面包屑**：每个切片单元开头带上 `文档 › 章 › 节`，让块自己说清出处。
 * 2. **过短的并进邻居**：低于 `minTokens` 的节独立成块只会是噪声。
 * 3. **过长的按段落切开并留 overlap**：RAGFlow 给不了 overlap，就在这里给——
 *    边界上被切断的那句话，两侧都留一份。
 * 4. **表格整块不切**：`<table>` 视为原子。半张表检索命中就是误导，
 *    因为**它看起来是完整答案**。
 *
 * 输出仍是合法 markdown，RAGFlow 照常解析；单元之间靠空行分隔，
 * 单元长度贴着 `chunk_token_num` 设计，让它基本不需要再切。
 */

/** `<table>` 到 `</table>` 之间视为原子块。 */
const TABLE_BLOCK = /<table[\s\S]*?<\/table>/gi;
const HEADING = /^(#{1,6})\s+(.*)$/;

/**
 * 粗略 token 估计。
 *
 * **不追求准**——它只用来决定"该合并还是该切开"，量级对了就够。
 * 引入真 tokenizer 会把 enterprise/backend/shared/rag 绑到某个模型的分词器上，
 * 而我们同时用 DeepSeek 与 Qwen，两者分词并不一致。
 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[　-〿一-鿿＀-￯]/g) ?? []).length;
  const rest = text.replace(/[　-〿一-鿿＀-￯]/g, " ");
  const words = (rest.match(/\S+/g) ?? []).length;
  return Math.round(cjk + words * 1.3);
}

export interface ChunkPrepOptions {
  /** 文档标题，面包屑的第一级。 */
  title: string;
  /** 单元目标长度。设成略小于 `chunk_token_num`，让 RAGFlow 基本不用再切。 */
  targetTokens?: number;
  /** 低于此长度的节并进邻居——独立成块只会是噪声。 */
  minTokens?: number;
  /** 切开长节时的重叠比例（RAGFlow 给不了 overlap，在这里给）。 */
  overlapRatio?: number;
}

interface Block {
  kind: "heading" | "table" | "text";
  level: number;
  text: string;
  tokens: number;
}

/**
 * 把小表格摊成文本行。
 *
 * **RAGFlow 在 `<table>` 边界处切块**，实测 Cybertruck_Specifications 里
 * 含表格的 26 块**没有一块带上面包屑**——它落在表外，被切掉了。
 * 同时这些表大多只有两三行，于是中位块长只有 31 token。
 *
 * 摊成文本后它们能和上下文一起打包，也就跟着带上了面包屑。
 * **只摊小表**：大表的行列对齐本身是信息，摊平会丢。
 *
 * 转换是逐格搬运，不合并、不改写——`<td>GVWR</td><td>3,948 kg</td>`
 * 变成 `GVWR：3,948 kg`，没有任何一处是推断出来的。
 */
export function tableToText(html: string): string {
  const rows = [...html.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) =>
    [...m[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((c) => c[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim())
      .filter((c) => c.length > 0),
  );
  return rows
    .filter((cells) => cells.length > 0)
    .map((cells) => (cells.length === 2 ? `${cells[0]}：${cells[1]}` : cells.join(" | ")))
    .join("\n");
}

/** 小到该摊平的门槛。再大就保留表格形态——行列对齐本身是信息。 */
const TABLE_FLATTEN_MAX_TOKENS = 160;

/** 拆成块序列，`<table>` 整块保留。 */
function toBlocks(md: string): Block[] {
  const out: Block[] = [];
  let last = 0;
  const push = (raw: string): void => {
    for (const para of raw.split(/\n{2,}/)) {
      const t = para.trim();
      if (!t) continue;
      const h = HEADING.exec(t);
      if (h) {
        out.push({ kind: "heading", level: h[1].length, text: h[2].trim(), tokens: estimateTokens(h[2]) });
      } else {
        out.push({ kind: "text", level: 0, text: t, tokens: estimateTokens(t) });
      }
    }
  };
  for (const m of md.matchAll(TABLE_BLOCK)) {
    push(md.slice(last, m.index));
    last = m.index + m[0].length;
    const flat = tableToText(m[0]);
    // **空表直接丢**：MinerU 会把版面上的分隔框识别成表格，产出
    // `<tr><td></td><td></td></tr>` 这种一个字都没有的块。它检索得到、
    // 占一个位置、信息量为零。
    if (flat.length === 0) continue;
    const tokens = estimateTokens(m[0]);
    if (tokens <= TABLE_FLATTEN_MAX_TOKENS) {
      out.push({ kind: "text", level: 0, text: flat, tokens: estimateTokens(flat) });
    } else {
      out.push({ kind: "table", level: 0, text: m[0], tokens });
    }
  }
  push(md.slice(last));
  return out;
}

/** `文档 › 章 › 节`。层级只留到三级——再深的标题在面包屑里帮不上忙，只占长度。 */
function breadcrumb(title: string, stack: readonly string[]): string {
  return `> ${[title, ...stack.slice(0, 3)].filter(Boolean).join(" › ")}`;
}

/**
 * 按句末标点切开一段长文本，每片不超过 `target`，片与片之间留 `overlap` 的重叠。
 *
 * 切不动的整句（比整片还长）**原样保留而不硬切**：从中间截断一句话，
 * 两半都读不通，而检索照样会命中——那正是我们这一轮在消灭的东西。
 */
export function splitLongText(text: string, target: number, overlap: number): string[] {
  const sentences = text.split(/(?<=[。！？；.!?;])\s*/).filter((s) => s.trim().length > 0);
  const out: string[] = [];
  let cur: string[] = [];
  let curTokens = 0;
  for (const s of sentences) {
    const t = estimateTokens(s);
    if (curTokens + t > target && cur.length > 0) {
      out.push(cur.join(""));
      // 回卷若干句作为重叠：边界上被切断的那句，两侧各留一份。
      const carry: string[] = [];
      let carried = 0;
      for (let i = cur.length - 1; i >= 0 && carried < overlap; i -= 1) {
        carry.unshift(cur[i]);
        carried += estimateTokens(cur[i]);
      }
      cur = carry;
      curTokens = carried;
    }
    cur.push(s);
    curTokens += t;
  }
  if (cur.length > 0) out.push(cur.join(""));
  return out;
}

/**
 * 主入口：整理 markdown 供 RAGFlow 切分。
 *
 * 返回的仍是 markdown。每个切片单元形如：
 *
 *     > 迈锐宝用户手册 › 座椅和保护装置 › 前排座椅
 *
 *     ### 座椅调节
 *
 *     按住按钮 3 秒，直到指示灯闪烁。
 */
export function prepareMarkdownForChunking(md: string, opts: ChunkPrepOptions): string {
  const target = opts.targetTokens ?? 480;
  const min = opts.minTokens ?? 120;
  const overlap = Math.round(target * (opts.overlapRatio ?? 0.15));

  const blocks = toBlocks(md);
  const stack: string[] = [];
  const units: string[] = [];

  // 当前累积单元：内容 + 它所属的面包屑。
  let buf: string[] = [];
  let bufTokens = 0;
  let bufCrumb = breadcrumb(opts.title, []);

  const flush = (): void => {
    if (buf.length === 0) return;
    units.push(`${bufCrumb}\n\n${buf.join("\n\n")}`);
    buf = [];
    bufTokens = 0;
  };

  for (const b of blocks) {
    if (b.kind === "heading") {
      // 标题换节。**只有攒够 minTokens 才断开**——否则一串小标题会切出一堆
      // 只有标题没有内容的块，那比块太长更糟：它们检索命中率高而信息量为零。
      if (bufTokens >= min) flush();
      stack.length = Math.max(0, b.level - 1);
      stack[b.level - 1] = b.text;
      bufCrumb = breadcrumb(opts.title, stack.filter(Boolean));
      const line = `${"#".repeat(Math.min(6, b.level))} ${b.text}`;
      // **相邻重复的标题只留一个**。MinerU 会把页眉和章标题都识别成标题，
      // 于是 `## 引言` 连着出现两次。留着不只是难看：两行标题挤在一个单元里
      // 会把它撑到 minTokens 之上，于是这个"只有标题没有内容"的单元反而
      // 被当成攒够了内容而独立成块。
      if (buf[buf.length - 1] !== line) {
        buf.push(line);
        bufTokens += b.tokens;
      }
      continue;
    }

    // 表格：整块不切。**放不下就自己单独成块**，而不是被拦腰截断。
    if (b.kind === "table") {
      if (bufTokens > 0 && bufTokens + b.tokens > target) flush();
      buf.push(b.text);
      bufTokens += b.tokens;
      if (bufTokens >= target) flush();
      continue;
    }

    if (b.tokens > target) {
      flush();
      for (const piece of splitLongText(b.text, target, overlap)) {
        units.push(`${bufCrumb}\n\n${piece}`);
      }
      continue;
    }

    if (bufTokens + b.tokens > target) flush();
    buf.push(b.text);
    bufTokens += b.tokens;
  }
  flush();

  return units.join("\n\n");
}
