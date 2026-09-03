/**
 * MinerU PDF 版面解析（施工单 M8-01 补，FL-24 F-24-05）。
 *
 * # 为什么需要它：RAGFlow 的解析器解决不了多栏
 *
 * 迈锐宝用户手册是三栏排版。RAGFlow 云端唯一可用的解析器 DeepDOC 会把三栏
 * **按行横着串读**——三列的半句交替出现：
 *
 *   本车集先进技术、安全性、环保及    ← 第 1 列
 *   该信息可能会导致错误的操作。      ← 第 3 列
 *   ·方向性数据，如左右前后，均以     ← 第 2 列
 *   经济性于一体。                   ← 第 1 列（接第一行那句）
 *
 * **每一行本身都通顺、关键词也在**，所以检索照样命中、照样给出处，
 * 只是拼起来讲的不是一件事。这是本项目最要防的形态：它不以错误的形式出现，
 * 只以一个自信的错误答案出现。
 *
 * RAGFlow 的下拉框里有 MinerU 与 Docling，但**云端并未部署**
 * （实测报 `MinerU not found` / `Docling not found`），所以走官方 API。
 *
 * # 它不在检索链路上
 *
 * 只在"把 PDF 变成 markdown"这一步用一次，产物进 RAGFlow。
 * 所以它挂了不影响线上问答，只影响"能不能加新文档"——
 * 这条边界决定了它的失败处理可以简单粗暴（报错让人重试），不需要降级路径。
 */

const API = "https://mineru.net/api/v4";

export interface MineruConfig {
  token: string;
  /** 文档语言，影响 OCR 与断句。中文手册用 `ch`。 */
  language?: string;
  timeoutMs?: number;
}

export interface MineruJob {
  /** 传给 MinerU 的文件名——回执按它匹配，必须唯一。 */
  name: string;
  bytes: Uint8Array;
}

export interface MineruResult {
  name: string;
  state: string;
  /** 成功时的 markdown；失败为 undefined。 */
  markdown?: string;
  error?: string;
}

async function call<T>(cfg: MineruConfig, path: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 60_000);
  try {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${cfg.token}`, ...(init?.headers ?? {}) },
      signal: ctrl.signal,
    });
    const body = (await res.json()) as { code?: number; msg?: string };
    // **与 RAGFlow 同一个坑**：HTTP 200 不代表成功，业务码在 body 里。
    // 只看 res.ok 会把"配额用尽""token 失效"变成"结果是空的"。
    if (!res.ok || (body.code !== undefined && body.code !== 0)) {
      throw new Error(`MinerU ${path} 失败（code=${body.code ?? res.status}）：${body.msg ?? ""}`);
    }
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 清掉 MinerU 产物里的排版噪声。
 *
 * 它把小字号标点识别成上下标：`本车集先进技术<sub>、</sub>安全性`。
 * 这些标记进了 embedding 就是噪声，出现在引用原文里更难看——
 * **但它们不是错误内容**，所以是清洗不是修复，剥掉标签保留文字。
 *
 * 图片引用一并去掉：我们只把文本喂给 RAGFlow，
 * 留着 `![](images/xxx.jpg)` 只会变成检索结果里的死链。
 */
/**
 * 中日韩字符类：**必须含标点**（《》、。），不能只写 `[一-鿿]`。
 * 只覆盖汉字时，"本 《用户手册》" 里 `本` 与 `《` 之间的空格去不掉——
 * 而那正是 MinerU 最常插空格的位置。
 */
const CJK = "\\u3000-\\u303F\\u4E00-\\u9FFF\\uFF00-\\uFFEF";

export function cleanMineruMarkdown(md: string): string {
  return md
    .replace(/<\/?(sub|sup)>/g, "")
    // 图片换成**换行**而不是删空：图片原本把上下文分开，
    // 直接删掉会让"看图"和"说明"粘成"看图说明"——凭空造出一个原文没有的词。
    // 连带吃掉图片两侧的横向空白，否则会留下 "看图\n 说明" 这样的行首空格。
    .replace(/[ \t]*!\[[^\]]*\]\([^)]*\)[ \t]*/g, "\n")
    // MinerU 会在词内插空格（"用 户手册"）。**只压缩中日韩字符之间的空格**——
    // 英文与数字之间的空格有意义，一律去掉会把 "Model 3" 变成 "Model3"，
    // 而车型名正好是车型限定检索要匹配的东西。
    .replace(new RegExp(`(?<=[${CJK}])[ \\t]+(?=[${CJK}])`, "g"), "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 批量转换。一次调用走完：申请上传地址 → 上传 → 轮询 → 取 markdown。
 *
 * `onProgress` 让调用方能显示进度——一本 192 页的手册要几分钟，
 * 没有进度的等待与卡死无法区分。
 */
export async function convertPdfs(
  cfg: MineruConfig,
  jobs: readonly MineruJob[],
  opts: {
    pollMs?: number;
    deadlineMs?: number;
    onProgress?: (done: number, total: number, states: string) => void;
  } = {},
): Promise<MineruResult[]> {
  if (jobs.length === 0) return [];

  const batch = await call<{ data: { batch_id: string; file_urls: string[] } }>(
    cfg,
    "/file-urls/batch",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        language: cfg.language ?? "ch",
        files: jobs.map((j) => ({ name: j.name, is_ocr: false })),
      }),
    },
  );

  const { batch_id: batchId, file_urls: urls } = batch.data;
  if (urls.length !== jobs.length) {
    throw new Error(`MinerU 返回 ${urls.length} 个上传地址，与 ${jobs.length} 个文件不符`);
  }

  // 预签名地址是**逐个对应**的：顺序错了会把 A 的内容传到 B 的位置，
  // 而回执按文件名匹配——结果是"名字对、内容是别人的"，无声无息。
  for (let i = 0; i < jobs.length; i += 1) {
    const put = await fetch(urls[i], { method: "PUT", body: jobs[i].bytes as BodyInit });
    if (!put.ok) throw new Error(`上传 ${jobs[i].name} 失败：HTTP ${put.status}`);
  }

  const deadline = Date.now() + (opts.deadlineMs ?? 30 * 60_000);
  const pollMs = opts.pollMs ?? 10_000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const res = await call<{
      data: { extract_result: Array<{ file_name: string; state: string; err_msg?: string; full_zip_url?: string }> };
    }>(cfg, `/extract-results/batch/${batchId}`);

    const items = res.data.extract_result;
    const settled = items.filter((r) => r.state === "done" || r.state === "failed");
    opts.onProgress?.(settled.length, jobs.length, items.map((r) => `${r.file_name.slice(0, 12)}:${r.state}`).join(" "));
    if (settled.length < jobs.length) continue;

    return Promise.all(
      items.map(async (r) => {
        if (r.state !== "done" || !r.full_zip_url) {
          return { name: r.file_name, state: r.state, error: r.err_msg || "未提供原因" };
        }
        return { name: r.file_name, state: r.state, zipUrl: r.full_zip_url } as MineruResult & { zipUrl: string };
      }),
    );
  }

  throw new Error("MinerU 超时未全部完成。**不要当成失败**——任务可能仍在跑，稍后用同一个 batch 再查");
}

/** 单独暴露：调用方拿到 zipUrl 后自己下载解压（Node 侧用 unzip，浏览器侧不需要）。 */
export type MineruResultWithZip = MineruResult & { zipUrl?: string };
