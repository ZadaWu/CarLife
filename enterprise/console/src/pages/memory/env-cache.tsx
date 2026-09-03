/**
 * ⑤环境缓存的分页浏览（M-mem-cache）。
 *
 * # 这一类为什么单独写一块
 *
 * 另外五类的明细都走 `/console/memory/items/:userId`——按**用户**取，一次给二十条
 * 就够看。⑤不是：它按**地点**存（键上刻意不含 userId，同一个地方的天气对所有人
 * 是同一份），所以它的量级跟用户数无关而跟去过的地方有关，且天然要按命名空间分
 * 类看（`regeo` 是逆地理编码、`amap-forecast` 是天气预报、`route` 是路线）。
 *
 * # 翻页用 offset 而不是游标
 *
 * Redis 的 SCAN 游标是单向的：翻不回上一页，而且顺序跨调用不稳定。真按游标做，
 * "第 2 页"可能重复第 1 页的条目、也可能整条跳过，**而分页器看起来一切正常**。
 * 所以服务端是"扫全量键 → 排序 → 切片"，这一层只管 offset。
 *
 * # 三种"没有"要分开说
 *
 * 未接入 Redis（`wired:false`）／这一页是空的／读不到（502）——它们看起来都是
 * 一张空列表，但含义完全不同。这一页存在的意义有一半就是别再把它们混成一句话。
 */

import { useCallback, useEffect, useState } from "react";

import { api } from "../../api";
import { EnvCacheDetailModal } from "./env-cache-detail";
import { NS_LABEL } from "./env-cache-format";

export interface EnvCacheEntry {
  key: string;
  namespace: string;
  ttlSeconds: number;
  sizeBytes: number;
  preview: string;
  /** 服务端算好的人话标题与摘要；老版本运行时没有这两个字段时回落到键名与预览。 */
  title?: string;
  summary?: string;
}

interface Listing {
  wired: boolean;
  entries?: EnvCacheEntry[];
  total?: number;
  totalAll?: number;
  truncated?: boolean;
  namespaces?: Array<{ namespace: string; count: number }>;
}

const PAGE_SIZE = 20;

// 命名空间 → 人话的表在 `env-cache-format.ts`（详情弹窗也用同一份）。

/**
 * 剩余存活时间。
 *
 * `-1` 单独说：那是**没有 TTL 的键**，意味着有人绕过 `withEnvCache` 直接写了
 * Redis，那种键永远不过期、会一直拿过期数据回答。把它显示成"很久"就把问题藏了。
 */
export function ttlText(sec: number): string {
  if (sec === -1) return "⚠️ 无 TTL（永不过期，不该出现）";
  if (sec === -2) return "已过期";
  if (sec < 60) return `${sec} 秒后过期`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟后过期`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分后过期`;
  // 目的地推荐与导览简报按周缓存，"335 小时后过期"没人读得出是两周
  return `${Math.floor(sec / 86_400)} 天 ${Math.floor((sec % 86_400) / 3600)} 小时后过期`;
}

export function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export interface EnvCacheBrowserProps {
  /**
   * 把这次扫出来的**库存总数**抛给卡片。
   *
   * 卡片顶上那个大数字来自 runtime 的健康视图，那边是 60 秒刷新一次的
   * （健康端点被大屏 10 秒轮一次，每次都 SCAN 是拿观测去压被观测的东西）。
   * 展开明细时我们刚刚真扫过一遍，不用那份旧的——否则同一张卡上会同时出现
   * "71 条在库"和"共 75 条"，看起来就是个 bug。
   */
  onTotal?: (total: number) => void;
}

export function EnvCacheBrowser({ onTotal }: EnvCacheBrowserProps = {}): JSX.Element {
  const [page, setPage] = useState(0);
  const [namespace, setNamespace] = useState<string>("");
  const [data, setData] = useState<Listing | "loading" | "error">("loading");
  /** 点开看详情的那一条（M-mem-cache-detail）；null 即关闭。 */
  const [open, setOpen] = useState<EnvCacheEntry | null>(null);

  const load = useCallback(async () => {
    setData("loading");
    const q = new URLSearchParams({ offset: String(page * PAGE_SIZE), limit: String(PAGE_SIZE) });
    if (namespace) q.set("namespace", namespace);
    try {
      const r = await api.get<Listing>(`/console/memory/cache?${q.toString()}`);
      setData(r);
      if (r.wired && r.totalAll !== undefined) onTotal?.(r.totalAll);
    } catch {
      setData("error");
    }
  }, [page, namespace, onTotal]);

  useEffect(() => {
    void load();
  }, [load]);

  if (data === "loading") return <p className="muted tiny">正在读取…</p>;
  if (data === "error") {
    return (
      <p className="error tiny">
        读不到明细（运行时不可达）。<b>这不代表缓存是空的</b>——Redis 的连接握在
        agent-runtime 手上，它不在时我们既数不到也读不到。
      </p>
    );
  }
  if (!data.wired) {
    return (
      <p className="muted tiny">
        ⑤<b>未接入 Redis</b>（`REDIS_URL` 未配或连不上）。外部调用会全部直连上游——
        功能不受影响，只是慢且费配额。这与"缓存里没东西"不是一回事。
      </p>
    );
  }

  const entries = data.entries ?? [];
  const total = data.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="cache-browser">
      {/* 命名空间筛选：它同时回答了"缓存里都是些什么"——比一个总数有用得多 */}
      <div className="cache-ns">
        <button
          type="button"
          className={namespace === "" ? "cache-ns-chip is-on" : "cache-ns-chip"}
          onClick={() => {
            setNamespace("");
            setPage(0);
          }}
        >
          全部 {data.totalAll ?? 0}
        </button>
        {(data.namespaces ?? []).map((n) => (
          <button
            key={n.namespace}
            type="button"
            title={NS_LABEL[n.namespace] ?? n.namespace}
            className={namespace === n.namespace ? "cache-ns-chip is-on" : "cache-ns-chip"}
            onClick={() => {
              setNamespace(n.namespace);
              setPage(0);
            }}
          >
            {NS_LABEL[n.namespace] ?? n.namespace} {n.count}
          </button>
        ))}
      </div>

      {/*
        扫描撞上限必须说出来：截断之后的总数不是"全部有多少"，
        而静默截断读起来和"全都在这儿了"一模一样。
      */}
      {data.truncated ? (
        <p className="error tiny">⚠️ 键太多，扫描已被上限截断——下面的总数是截断后的，不是全部。</p>
      ) : null}

      {entries.length === 0 ? (
        <p className="muted tiny">
          这一{namespace ? "类" : "库"}当前没有条目。⑤是带 TTL 的缓存，
          <b>空是正常状态</b>——过一会儿没人查这些地方，它本来就会空。
        </p>
      ) : (
        <ul className="cache-list">
          {/* 每条都能点开：列表只有 200 字符预览，看得出"存了东西"，看不出存的对不对 */}
          {entries.map((e) => (
            <li key={e.key}>
              <button
                type="button"
                className="cache-row"
                onClick={() => setOpen(e)}
                aria-label={`查看 ${e.key} 的详情`}
              >
                {/* 人话在前：标题 + 一句摘要；原始键降成小字，排障时才用得着 */}
                <div className="cache-title">{e.title ?? e.key}</div>
                <div className="cache-summary">{e.summary ?? e.preview}</div>
                <div className="cache-meta">
                  <span className={e.ttlSeconds === -1 ? "cache-ttl-bad" : ""}>{ttlText(e.ttlSeconds)}</span>
                  <span>· {sizeText(e.sizeBytes)}</span>
                  <span className="cache-key mono">· {e.key}</span>
                  <span className="cache-open">查看详情 →</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && <EnvCacheDetailModal entry={open} onClose={() => setOpen(null)} />}

      <div className="cache-pager">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={page === 0}
        >
          上一页
        </button>
        <span className="tiny muted">
          第 {page + 1} / {pages} 页 · 共 {total} 条
          {namespace ? `（已筛 ${NS_LABEL[namespace] ?? namespace}）` : ""}
        </span>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setPage((p) => p + 1)}
          disabled={page + 1 >= pages}
        >
          下一页
        </button>
        <button type="button" className="mem-items-toggle" onClick={() => void load()}>
          刷新
        </button>
      </div>
      <p className="tiny muted">
        ⑤存的是<b>外部世界的事实</b>（天气/路况/充电价），键上不含 userId ——
        同一个地点的天气对所有人是同一份。它不进 Mem0、不参与衰减，靠 TTL 自己过期。
      </p>
    </div>
  );
}
