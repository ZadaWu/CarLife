/**
 * 片子的进程内缓存：每段视频**一次进程只取一次**，之后 `<video>` 吃 `blob:` URL。
 *
 * # 为什么要这一层——片子明明已经打进包里了
 *
 * 四段出发片子是 vite 静态 import，`bundle:cockpit` / `tauri ios build` 的产物里确实
 * 内嵌着它们（`strings target/release/cockpit | grep departure-1-arrive` 能看到）。
 * 但"在包里"不等于"不再请求"：
 *
 *   - **开发形态**（`tauri dev` / `target/debug/cockpit` / `tauri ios dev`）走 devUrl，
 *     `<video src>` 指向 vite。iPhone 上 devUrl 被换成 Mac 的局域网 IP，
 *     每次按下「开始行程」都把 1.4 MB 片子从 Mac 拉一遍——用户看见的就是这个
 *     "每次都向后台请求一次"。
 *   - **发布形态**下 `tauri://` 协议每次 mount 也会重新从内嵌资源读一遍解压；
 *     WKWebView 对媒体请求不走 HTTP 缓存，重播就是再读一遍。
 *
 * 把字节取进内存、换成 `blob:` URL 之后，这两种形态的行为就一致了：
 * 进程里第一次（HUD 露面时预热）取，之后每一次「开始行程」/「重播」零请求，
 * 第一帧也不用等下载。1.4 MB 常驻内存对车机不是负担；片子在播时本来就要解码进内存。
 *
 * # 失败就当没有缓存
 *
 * 取不到（离线、404、`fetch` 不存在）时 `resolve` 原样返回源 URL——`<video>` 自己去取，
 * 与没有这一层时逐字节一样。缓存**绝不能**成为动画放不出来的原因；失败的那一条下次
 * `warm` 会再试。
 *
 * 这个文件只有纯逻辑、不 import 任何 mp4，所以 `node --test` 起得来；
 * 与四段片子的绑定在 `departure-clips.ts`（那个文件 import 了 mp4，node 下 import 不了）。
 */

export interface ClipCacheIo {
  /** 取字节。缺省用全局 `fetch`；测试注入假的。 */
  fetch: (url: string) => Promise<{ ok: boolean; status: number; blob(): Promise<Blob> }>;
  /** `Blob` → `blob:` URL。缺省用 `URL.createObjectURL`。 */
  createObjectURL: (blob: Blob) => string;
}

export interface ClipCache {
  /**
   * 把这些 URL 各取一次进内存。已缓存的、在途的都跳过；失败的留给下次。
   * **永不 reject**——调用方是 `useEffect`，没人接它的错。
   */
  warm(srcs: readonly string[]): Promise<void>;
  /**
   * 同步取：已缓存 → `blob:` URL；否则原 URL。
   * 同步是刻意的：JSX 里 `src={resolve(x)}` 直接用，没有第二种渲染路径。
   */
  resolve(src: string): string;
  /** 已缓存的条目数（测试与自检）。 */
  readonly size: number;
}

const defaultIo: ClipCacheIo = {
  // 调用时才碰全局对象：模块顶层不能假设有 DOM（node:test 会 import 它）。
  fetch: (url) => fetch(url),
  createObjectURL: (blob) => URL.createObjectURL(blob),
};

export function createClipCache(io: Partial<ClipCacheIo> = {}): ClipCache {
  const fetchClip = io.fetch ?? defaultIo.fetch;
  const toObjectURL = io.createObjectURL ?? defaultIo.createObjectURL;
  /** 源 URL → blob: URL。 */
  const ready = new Map<string, string>();
  /** 在途的取用，按源 URL 去重：并发两次 warm 不会取两遍。 */
  const inflight = new Map<string, Promise<void>>();

  const take = async (src: string): Promise<void> => {
    try {
      const res = await fetchClip(src);
      if (!res.ok) return;
      ready.set(src, toObjectURL(await res.blob()));
    } catch {
      // 取不到 = 没有缓存，见文件头。不打日志：离线是常态不是故障。
    }
  };

  return {
    async warm(srcs) {
      const jobs: Promise<void>[] = [];
      for (const src of srcs) {
        if (ready.has(src)) continue;
        let job = inflight.get(src);
        if (!job) {
          job = take(src).finally(() => inflight.delete(src));
          inflight.set(src, job);
        }
        jobs.push(job);
      }
      await Promise.all(jobs);
    },
    resolve(src) {
      return ready.get(src) ?? src;
    },
    get size() {
      return ready.size;
    },
  };
}
