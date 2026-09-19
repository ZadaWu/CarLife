/**
 * `destination_highlights` —— 到了那儿吃什么、拍哪儿（施工单 M32-01）。
 *
 * # 它替掉的不是一段代码，是"模型凭记忆答"
 *
 * 美食榜与网红打卡点有两个特点决定了它**必须联网**：时效性强（网红点半年一换）、
 * 长尾（模型对小城市的记忆基本是空的）。让模型凭记忆答，产出的是"看起来很像那么回事"
 * 的假推荐——本仓对这类输出有明确红线（`external.ts` 的来源标注、
 * `weather.ts`/`pretrip-items.ts` 的"取不到就说取不到"）。
 *
 * # 联网靠 DeepSeek 自己的内置工具，我们不接搜索引擎
 *
 * 走 DeepSeek 的 **Anthropic 兼容端点**（`/anthropic/v1/messages`）声明服务端工具
 * `{"type":"web_search_20250305","name":"web_search"}`。搜索由 DeepSeek 那侧执行，
 * 回包里带 `server_tool_use` 与 `web_search_tool_result`。
 * 用 `fetch` 直连而不是 `@anthropic-ai/sdk`：只用到一个端点、一个工具类型，
 * 为它加一条依赖要走 `/arch-revision` 变更单，代价与收益不成比例。
 * **调用层已抽到 `web-search.ts`**（施工单 M36-01，给导游采集子代理复用），
 * 本文件只剩本场景的 prompt / 解析 / 出处校验 / 缓存——行为与 M32-01 交付时逐字一致。
 *
 * # 三条实测得来的约定（2026-08-28 实测，别按 Claude 的文档想当然）
 *
 * 1. **`citations` 恒为 `null`**——DeepSeek 不返回 Claude 那套 `web_search_result_location`
 *    引用块。出处的唯一来源是 `web_search_tool_result.content[].url` 这份清单。
 * 2. **模型写的 URL 会被改写**：实测它把真实 URL 截断成了一条打不开的短链，
 *    而它带着"这是出处"的可信度。所以 `sourceUrl` 必须与某条搜索结果的 url
 *    **字符串全等**才展示，否则置空——`parseHighlights` 就是干这个的。
 * 3. **`allowed_domains` 被静默忽略**：实测传 `["xiaohongshu.com","douyin.com"]`，
 *    回来的 9 条里 7 条是 trip.com / sm.cn / toutiao。**所以本文件不声明这个字段**——
 *    声明了会让读代码的人以为域收窄生效了。
 *
 * # 规则与网络分开
 *
 * `parseHighlights()` 不碰网络：给它模型那段文本 + 这次回包里的搜索结果清单，
 * 它给出结构化数据与出处校验结论。这样"为什么这条出处被丢了"能被单测钉死，
 * 而不是埋在一次 HTTP 调用后面（与 `pretrip-items.ts` 同一分法）。
 */

import { defineExternalTool, ToolError, type ExternalTool } from "./external";
import { ENV_TTL, envCacheKey, readNegative, withEnvCache, writeNegative } from "./env-cache";
import { getAmapClient, type AmapClient } from "./amap";
import {
  callAnthropicWebSearch,
  getWebSearch,
  readWebSearchTurn,
  setWebSearch,
  type SearchResultRef,
  type WebSearchConfig,
  type WebSearchTurn,
} from "./web-search";

/**
 * 兼容再导出（M36-01 抽调用层）：本文件是 M32 起的公开面，
 * 既有消费方（index.ts 的导出、单测）不因重构改 import。
 */
export { readWebSearchTurn };
export type { SearchResultRef, WebSearchTurn };

export interface DestinationHighlightsArgs {
  /** 目的地名，如「舟山普陀山」。空串直接抛 invalid，不发请求。 */
  destination: string;
  /** 出发日（`2026-09-01` 这种形状）；只进缓存键与提示词（"这个季节"），不做日期运算。 */
  date?: string;
}

/** 出处。**只有能与搜索结果对上的才有值**——对不上就是 undefined，卡上什么都不显示。 */
export interface HighlightSource {
  url: string;
  title?: string;
}

export interface HighlightEntry {
  name: string;
  /** 一行推荐理由，≤ `MAX_NOTE_CHARS`。 */
  note: string;
  source?: HighlightSource;
}

export interface PhotoTip {
  /** 对应哪个点（多数时候是 `spots` 里的某一个，但不强制——模型也可能给一条通用的）。 */
  spot: string;
  tip: string;
}

export interface DestinationHighlightsData {
  destination: string;
  foods: HighlightEntry[];
  spots: HighlightEntry[];
  photoTips: PhotoTip[];
  /**
   * 这次真的搜了几次。
   * **0 = 模型没调搜索**，也就是它在凭记忆答——那正是本工具要杜绝的东西，
   * 调用方（工具壳）据此当失败处理，不把结果发出去。
   */
  searchCount: number;
  /**
   * 出处能对上白名单的条数 / 模型声称有出处的条数。
   * 排障用，**不上卡**：卡上只显示对得上的那些。
   */
  sourcesVerified: { matched: number; claimed: number };
}

/** 卡上就这么多格。多要一条 = 多花 token 换一条永远不显示的数据。 */
export const MAX_FOODS = 3;
export const MAX_SPOTS = 3;
export const MAX_PHOTO_TIPS = 3;
/** 一行理由的字数上限。提示词里也写了，但模型不守字数是常态，代码侧再截一次。 */
export const MAX_NOTE_CHARS = 18;

/** DeepSeek 侧一次调用最多搜几次。实测 3 次约 8 秒，再多只是更慢更贵。 */
const MAX_SEARCH_USES = 3;

// ────────────────────────────── 供应商接线 ──────────────────────────────

/**
 * 配置本体在 `web-search.ts`（M36-01 抽调用层后，一处注入、两类消费方共用：
 * 本工具 + 通用 `web_search`）。这里保留 M32 起的名字作为别名，装配层不用改。
 */
export type DestinationSearchConfig = WebSearchConfig;

export function setDestinationSearch(c: DestinationSearchConfig | undefined): void {
  setWebSearch(c);
}

export function getDestinationSearch(): DestinationSearchConfig | undefined {
  return getWebSearch();
}

// ────────────────────────────── 纯函数：解析与出处校验 ──────────────────────────────

interface RawEntry {
  name?: unknown;
  note?: unknown;
  sourceUrl?: unknown;
}
interface RawTip {
  spot?: unknown;
  tip?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** 超长就截断并加省略号——截断本身要看得出来，否则读者以为模型就说了这么半句。 */
function clampNote(s: string): string {
  return s.length <= MAX_NOTE_CHARS ? s : `${s.slice(0, MAX_NOTE_CHARS - 1)}…`;
}

/**
 * 从模型的回答里抠出 JSON。
 *
 * 容错到"第一个 `{` 到最后一个 `}`"为止：模型时不时会在 JSON 外面裹一层
 * ```` ```json ```` 围栏，或在前面写一句"好的，以下是…"。再宽松就该怀疑
 * 它根本没在回答这个问题了。
 */
function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new ToolError("destination_highlights", "invalid", "模型的回答里没有 JSON", false);
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ToolError("destination_highlights", "invalid", "模型返回的 JSON 解析失败", false);
  }
}

/**
 * 模型给的 `sourceUrl` → 可展示的出处。
 *
 * **只认全等**。不做"前缀匹配"或"同域名就算"的宽松匹配：实测模型给的是真实 URL 的
 * 截断版，前缀匹配恰好会把那种打不开的短链放行——那正是这层要挡的东西。
 */
function verifySource(
  claimed: unknown,
  whitelist: ReadonlyMap<string, SearchResultRef>,
): { source?: HighlightSource; claimed: boolean } {
  const url = str(claimed);
  if (!url) return { claimed: false };
  const hit = whitelist.get(url);
  if (!hit) return { claimed: true };
  return { claimed: true, source: { url: hit.url, ...(hit.title ? { title: hit.title } : {}) } };
}

function parseEntries(
  raw: unknown,
  limit: number,
  whitelist: ReadonlyMap<string, SearchResultRef>,
  counter: { matched: number; claimed: number },
): HighlightEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: HighlightEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= limit) break; // 截尾不截头：模型已按排名给，前面的更重要
    const e = item as RawEntry;
    const name = str(e.name);
    if (!name || seen.has(name)) continue; // 没名字的格子不上卡；同名去重
    seen.add(name);
    const v = verifySource(e.sourceUrl, whitelist);
    if (v.claimed) counter.claimed += 1;
    if (v.source) counter.matched += 1;
    out.push({ name, note: clampNote(str(e.note)), ...(v.source ? { source: v.source } : {}) });
  }
  return out;
}

function parseTips(raw: unknown): PhotoTip[] {
  if (!Array.isArray(raw)) return [];
  const out: PhotoTip[] = [];
  for (const item of raw) {
    if (out.length >= MAX_PHOTO_TIPS) break;
    const t = item as RawTip;
    const tip = str(t.tip);
    if (!tip) continue; // 没有建议正文的条目上卡就是一个空格子
    out.push({ spot: str(t.spot), tip: clampNote(tip) });
  }
  return out;
}

/**
 * 模型文本 + 这次的搜索结果清单 → 结构化推荐。**不碰网络，单测全打在它身上。**
 *
 * `searchCount === 0` 在这里**不抛错**：判"这次数据可不可信"是工具壳的事，
 * 本函数只负责如实把它算出来（这样单测能断言解析结果，而不是断言一个异常）。
 */
export function parseHighlights(
  destination: string,
  rawText: string,
  results: readonly SearchResultRef[],
  searchCount: number,
): DestinationHighlightsData {
  const parsed = extractJson(rawText) as {
    foods?: unknown;
    spots?: unknown;
    photoTips?: unknown;
  };
  // 白名单按 url 建索引：同一条 url 可能被多条推荐引用。
  const whitelist = new Map<string, SearchResultRef>();
  for (const r of results) if (r.url) whitelist.set(r.url, r);

  const counter = { matched: 0, claimed: 0 };
  const foods = parseEntries(parsed.foods, MAX_FOODS, whitelist, counter);
  const spots = parseEntries(parsed.spots, MAX_SPOTS, whitelist, counter);

  return {
    destination,
    foods,
    spots,
    photoTips: parseTips(parsed.photoTips),
    searchCount,
    sourcesVerified: counter,
  };
}

// ────────────────────────────── 网络：一次 messages 调用 ──────────────────────────────
// 调用层（端点拼接 / max_tokens 预算 / 截断判定 / readWebSearchTurn）在 `web-search.ts`。

/** 提示词。JSON 骨架给死——`tool_choice` 在混了服务端工具之后语义会变，不用它。 */
export function buildPrompt(destination: string, date?: string): string {
  return [
    `目的地：${destination}${date ? `，出发日期：${date}` : ""}。`,
    "请联网搜索这个目的地当下的美食排行榜、网红打卡点，以及在这些打卡点的拍照建议。",
    "",
    "只输出下面这个 JSON，不要任何其它文字：",
    '{"foods":[{"name":"","note":"","sourceUrl":""}],' +
      '"spots":[{"name":"","note":"","sourceUrl":""}],' +
      '"photoTips":[{"spot":"","tip":""}]}',
    "",
    `要求：foods ${MAX_FOODS} 条、spots ${MAX_SPOTS} 条、photoTips ${MAX_PHOTO_TIPS} 条；`,
    /*
     * 只说"短"，**不给具体字数**。给了字数（原来写的是"不超过 18 个字"）之后，
     * 实测模型会在思考里逐条数汉字——一次真跑烧掉 2462 字的思考、把
     * 输出预算撑爆，最后 JSON 截断。截断的代价远大于多出来的两三个字，
     * 而多出来的字这边本来就会硬截（`clampNote`）。
     */
    "每条 note / tip 写成一句短语，十几个字，不要成段；",
    "photoTips 的 spot 尽量对应上面 spots 里的名字；",
    "sourceUrl 必须逐字复制自你这次搜索结果里的链接，不要改写、不要截断、不要自己拼。",
  ].join("\n");
}

/**
 * 薄壳：本场景只定 prompt 与搜索次数上限，网络细节（`max_tokens: 4000` 的教训、
 * 截断判定、`allowed_domains` 刻意不带）全在 `callAnthropicWebSearch`。
 * 错误仍以 `destination_highlights` 归属——同一条通路服务多个工具，账要各记各的。
 */
function callWebSearch(
  destination: string,
  date: string | undefined,
  signal: AbortSignal | undefined,
): Promise<WebSearchTurn> {
  if (!getWebSearch()?.apiKey) {
    // 文案保持 M32 原话（"目的地推荐"）——它会进模型的工具结果，措辞就是行为。
    throw new ToolError(
      "destination_highlights",
      "unconfigured",
      "联网搜索未接入（缺 DeepSeek 密钥），本次不提供目的地推荐",
      false,
    );
  }
  return callAnthropicWebSearch("destination_highlights", buildPrompt(destination, date), {
    maxUses: MAX_SEARCH_USES,
    ...(signal ? { signal } : {}),
  });
}

// ────────────────────────────── 工具壳 ──────────────────────────────

/** 目的地字符串里的分隔符——模型会拼「南通 张家港」「张家港（经南通）」「南通如东—张家港」。 */
const PLACE_SPLIT = /[\s、，,／/（）()]|经|→|至|到|—|--/;

/**
 * 把模型随手拼的目的地拆成候选地名（M77 走查追修）。
 *
 * 无分隔符的连写（「南通如东」= 市名 + 区名）单独处理：整串认不出来时，
 * 从前面切 2~3 个字再试一次，剩下的部分当第二个地名。只试这两刀，
 * 再多就是在猜——认不出来的退回原串当键，那是现在的行为，不会更糟。
 */
export function splitPlaces(raw: string): string[] {
  const parts = raw
    .split(PLACE_SPLIT)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2);
  return parts.length > 0 ? [...new Set(parts)] : [];
}

/**
 * 目的地 → 城市级缓存键的组成部分（M77 走查追修）。
 *
 * # 为什么非归一不可
 *
 * 缓存键原来直接用模型传的字符串。而同一趟「上海 → 南通 → 张家港」的行程里，
 * 它一天之内传过六种写法：`南通`、`南通如东`、`南通 张家港`、`张家港（经南通）`、
 * `南通如东—张家港`、`张家港`。六个键、六次真搜，每次 4~7 秒，
 * 唯一一次 13 毫秒的命中是它碰巧把上一次的字符串一字不差又传了一遍。
 * 机制没坏，是键太细。
 *
 * # 归到 adcode，不归到字符串
 *
 * 用高德的行政区编码当键：`resolveRegion` 认得出「南通」与「如东」是 320600 与 320623。
 * **不做前缀 / 模糊匹配**——那会把「张家港（经南通）」错命中成南通那一份，
 * 而一个错的命中比一次 miss 糟得多，它不报错（ADR-008 的同一条取向）。
 *
 * # 不归到地级市
 *
 * 张家港属苏州，归到苏州就会拿苏州市区的吃喝去答张家港。行政区认到哪一级就用哪一级，
 * 只求把不同**写法**归一，不求把不同**地方**合并。
 *
 * 认不出来就返回空数组，调用方退回用原串当键。
 *
 * # 它治得了什么，治不了什么（2026-09-13 真跑两轮的实测）
 *
 * **治得了写法差异**：`张家港（经南通）` 与 `南通 张家港` 归一后是同一个键。
 * 配合日期归周，三天行程里为不同日期查同一批城市也只搜一次。
 *
 * **治不了范围差异**：实测第一轮模型传 `张家港`、第二轮传 `南通 张家港 如东`，
 * 归一后一个是 `320582`、另一个是三个码，仍然是两个键——而这是对的，
 * 搜一个城市和搜三个城市本来就该拿到不同的内容，共享缓存才是错的。
 * 要让跨轮稳定命中，得由编排层按**单个城市**逐个预取（每城一个键），
 * 而不是让模型每轮自由拼一个组合串。那是下一步，不在这一刀里。
 */
export async function destinationCacheParts(
  destination: string,
  amap: AmapClient | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!amap) return [];
  const codes = new Set<string>();
  for (const part of splitPlaces(destination)) {
    let hit = await amap.resolveRegion(part, signal).catch(() => undefined);
    if (hit) {
      codes.add(hit.adcode);
      continue;
    }
    // 连写：「南通如东」→ 前 2 字是市、余下是区。只切这两刀。
    for (const cut of [2, 3]) {
      if (part.length <= cut + 1) continue;
      const head = await amap.resolveRegion(part.slice(0, cut), signal).catch(() => undefined);
      if (!head) continue;
      codes.add(head.adcode);
      const tail = await amap.resolveRegion(part.slice(cut), signal).catch(() => undefined);
      if (tail) codes.add(tail.adcode);
      hit = head;
      break;
    }
  }
  // 排序：`南通 张家港` 与 `张家港（经南通）` 必须落到同一个键。
  return [...codes].sort();
}

/**
 * 出发日 → ISO 周键（M77 走查追修）。
 *
 * TTL 是两周，理由写着"网红点与老字号是**周级**变化的内容"。而键原来精确到天，
 * 于是三天行程的三天各是一个键——用周级的理由设 TTL，却用天级的键去查，TTL 等于没生效。
 * 精确日期仍然进提示词（"这个季节"那句），只是不进键。
 */
export function weekKeyOf(date?: string): string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "-";
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "-";
  // ISO 周：把日期挪到本周四，再数它是当年第几周。
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fd = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fd + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}


export const destinationHighlightsTool: ExternalTool<
  DestinationHighlightsArgs,
  DestinationHighlightsData
> = defineExternalTool<DestinationHighlightsArgs, DestinationHighlightsData>({
  name: "destination_highlights",
  provider: "deepseek-web-search",
  sensitive: false,
  /*
   * 只读幂等，但**每次重试都是真金白银的一次搜索**（按次计费 + 约 19k input tokens），
   * 所以只给 1 次，不是四件套默认的 2 次。
   */
  retries: 1,
  /*
   * 30 秒，不是默认的 5 秒。三次真跑分别是 **11.7 / 12.4 / 14.0 秒**
   * （2026-08-28，`max_tokens: 4000`；更早那组 7.4~8.0 秒是 1600 时测的，
   * 而 1600 会让 JSON 被截断，见上面 `max_tokens` 那段）。
   * 5 秒必然全部超时，20 秒对 14 秒的实测只留 6 秒余量——都太紧。
   *
   * 慢在这里是可接受的：它有 2 周缓存（`ENV_TTL.destinationHighlights`），慢只发生在冷启那一次，
   * 而且**不阻塞任何用户动作**（走的是读时补齐，不进行程确认那一跳）。
   */
  timeoutMs: 30_000,

  real: async (args, ctx) => {
    const destination = args.destination?.trim();
    if (!destination) {
      throw new ToolError("destination_highlights", "invalid", "没有目的地，无从搜起", false);
    }

    /*
     * ⑤环境缓存：**按行政区编码 + ISO 周**，不按会话，也不按模型传的原字符串。
     *
     * 原来直接拿 `destination` 当键，而模型一天之内为同一趟行程传过六种写法
     * （南通 / 南通如东 / 南通 张家港 / 张家港（经南通） / 南通如东—张家港 / 张家港），
     * 六个键六次真搜，每次 4~7 秒。归一到 adcode 之后写法就不再影响命中。
     * 认不出来时退回原串——那是从前的行为，不会更糟。
     */
    const parts = await destinationCacheParts(destination, getAmapClient(), ctx.signal);
    const keyParts = parts.length > 0 ? parts : [destination];
    const key = envCacheKey("dest-highlights", [...keyParts, weekKeyOf(args.date)]);
    /*
     * 「模型没搜就答」的失败有短负缓存（10 分钟）：它此前不缓存，于是同一轮里
     * 连错三次、每次白花 5~7 秒。10 分钟只挡住同一轮的重试，不会让两周都拿不到结果。
     */
    const missKey = `${key}:no-search`;
    if (await readNegative(missKey)) {
      throw new ToolError(
        "destination_highlights",
        "upstream",
        "刚才这个目的地搜过一次没搜成（模型未联网），本轮不再重试",
        false,
      );
    }
    const { value } = await withEnvCache(key, ENV_TTL.destinationHighlights, async () => {
      const turn = await callWebSearch(destination, args.date, ctx.signal);
      /*
       * 模型没搜就是在凭记忆答——**当失败处理，不把结果发出去**。
       * 放在缓存的 fetch 里抛：失败的结果不该被缓存 2 周。
       */
      if (turn.searchCount === 0) {
        // 记一条短负缓存再抛：不记的话同一轮会连着白花三次（真跑 turn-6fafa7d9）。
        await writeNegative(missKey);
        throw new ToolError(
          "destination_highlights",
          "upstream",
          "模型没有联网搜索（凭记忆的推荐不可信），本次不提供目的地推荐",
          true,
        );
      }
      return parseHighlights(destination, turn.text, turn.results, turn.searchCount);
    });
    return value;
  },

  /*
   * Mock 三态的 `mock`：四件套会把 `source.kind` 标成 `mock`，所以这里给固定数据是安全的。
   * 出处刻意留空——**模拟数据不该带一个看起来像真的的链接**。
   */
  mock: (args) => ({
    destination: args.destination || "示例目的地",
    foods: [
      { name: "海鲜面", note: "码头边的老店" },
      { name: "素斋", note: "寺院斋堂，清淡" },
      { name: "观音饼", note: "常见伴手礼" },
    ],
    spots: [
      { name: "南海观音", note: "地标，面朝大海" },
      { name: "千步沙", note: "金色沙滩" },
      { name: "普济寺", note: "香火最旺" },
    ],
    photoTips: [
      { spot: "南海观音", tip: "傍晚斜阳给金身镀边" },
      { spot: "千步沙", tip: "低机位拍浪花与脚印" },
      { spot: "普济寺", tip: "广场仰拍才装得下" },
    ],
    searchCount: 0,
    sourcesVerified: { matched: 0, claimed: 0 },
  }),
});
