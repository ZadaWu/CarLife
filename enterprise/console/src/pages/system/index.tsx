/**
 * 系统状态 —— 运维大屏。
 *
 * 数据整页只有一个来源：`GET /console/system/status`（网关聚合探活，
 * 清单是 infra/scripts/dev.sh + infra/docker-compose.yml 的投影）。
 * 页面不自己判定任何状态，只如实渲染五种颜色：
 *   ok 绿 / degraded 黄（响应了但自报风险）/ down 红（预期在跑却联不上）/
 *   idle 灰（按需服务未启用，不是故障）/ unknown 灰虚线（没有探测通道，不猜）。
 *
 * 大屏的两条设计纪律：
 *  1. 顶部横幅只认红与黄——idle/unknown 常年存在（客户端窗口永远探不到），
 *     把它们算进"异常数"会让横幅永远不绿，红色从此没人看。
 *  2. 自动刷新 10 秒一次（与演示大屏同一节奏），刷新失败保留上一份数据并
 *     明说"这是几秒前的旧数据"——大屏最怕的是拿旧数据冒充实时。
 *
 * 顶部还有一条「本机网络」坐标带（局域网地址 / 默认网关，来自同一份快照的
 * `network` 字段）。它不参与状态判定：读不到网关不是故障，不许染进横幅。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../../api";

type ServiceState = "ok" | "degraded" | "down" | "idle" | "unknown";

interface ServiceReport {
  id: string;
  label: string;
  group: "core" | "mock" | "frontend" | "client" | "cron" | "infra";
  endpoint?: string;
  /** 点开能看到东西的地址（多数是 /health）。非 HTTP 服务没有这一项。 */
  url?: string;
  state: ServiceState;
  latencyMs?: number;
  detail?: string;
  hint?: string;
}

interface LanAddress {
  iface: string;
  address: string;
  prefix?: number;
  primary?: boolean;
}

interface DefaultRoute {
  address?: string;
  iface?: string;
}

interface NetworkInfo {
  scope: "host" | "container";
  lan: LanAddress[];
  gateway?: DefaultRoute;
  tunnels: DefaultRoute[];
  error?: string;
}

interface Snapshot {
  generatedAt: string;
  summary: Record<ServiceState, number>;
  services: ServiceReport[];
  network?: NetworkInfo;
}

const REFRESH_MS = 10_000;

const GROUP_LABEL: Record<ServiceReport["group"], string> = {
  core: "核心链路",
  infra: "基础设施",
  mock: "模拟外部系统",
  frontend: "前端 dev server",
  client: "客户端窗口",
  cron: "定时任务",
};

/** 分组的展示顺序：出事时最该先看的排前面。 */
const GROUP_ORDER: ServiceReport["group"][] = ["core", "infra", "mock", "frontend", "cron", "client"];

const STATE_LABEL: Record<ServiceState, string> = {
  ok: "正常",
  degraded: "有风险",
  down: "异常",
  idle: "未启用",
  unknown: "不可探测",
};

function Banner({ summary }: { summary: Snapshot["summary"] }): JSX.Element {
  // 只有红与黄算异常：idle/unknown 是常态灰，算进来横幅就永远不绿（见文件头注释）
  if (summary.down > 0) {
    return (
      <div className="sys-banner sys-banner--down">
        {summary.down} 个服务异常{summary.degraded > 0 ? `，另有 ${summary.degraded} 个自报风险` : ""}
      </div>
    );
  }
  if (summary.degraded > 0) {
    return <div className="sys-banner sys-banner--warn">{summary.degraded} 个服务自报风险</div>;
  }
  return <div className="sys-banner sys-banner--ok">全部正常</div>;
}

/**
 * 本机网络。它不是探活结果，所以不做成状态卡（没有绿黄红），
 * 只是一条"这台机器在网络上的坐标"：别人从局域网访问用哪个地址、出网走哪个网关。
 * 读不到时说读不到——猜一个 .1 出来比留空更危险。
 */
function NetworkStrip({ net }: { net: NetworkInfo }): JSX.Element {
  const primary = net.lan.find((a) => a.primary) ?? net.lan[0];
  const others = net.lan.filter((a) => a !== primary);
  return (
    <section className="sys-net">
      <div className="sys-net-item">
        <span className="sys-net-label">局域网地址</span>
        {primary ? (
          <>
            <span className="sys-net-value mono">
              {primary.address}
              {primary.prefix !== undefined ? <span className="sys-net-unit">/{primary.prefix}</span> : null}
            </span>
            <span className="sys-net-sub mono">{primary.iface}</span>
          </>
        ) : (
          <span className="sys-net-value sys-net-value--none">无（只有回环地址）</span>
        )}
      </div>

      <div className="sys-net-item">
        <span className="sys-net-label">默认网关</span>
        {net.gateway?.address ? (
          <>
            <span className="sys-net-value mono">{net.gateway.address}</span>
            <span className="sys-net-sub mono">经 {net.gateway.iface ?? "未知网卡"}</span>
          </>
        ) : (
          <span className="sys-net-value sys-net-value--none">
            {net.error ? "路由表读取失败" : "无默认路由"}
          </span>
        )}
      </div>

      {others.length > 0 ? (
        <div className="sys-net-item sys-net-item--aside">
          <span className="sys-net-label">其它网卡</span>
          <span className="sys-net-sub mono">
            {others.map((a) => `${a.iface} ${a.address}`).join(" · ")}
          </span>
        </div>
      ) : null}

      {net.tunnels.length > 0 ? (
        <p className="sys-net-note">
          默认路由另有 {net.tunnels.map((t) => t.iface).join("、")} 的点对点路由（VPN 之类），
          上面这个网关是物理网卡上的下一跳。
        </p>
      ) : null}
      {net.scope === "container" ? (
        <p className="sys-net-note sys-net-note--warn">
          Gateway 跑在容器里——这里是容器网络的地址，不是宿主机的局域网地址。
        </p>
      ) : null}
      {net.error ? <p className="sys-net-note sys-net-note--warn">读路由表失败：{net.error}</p> : null}
    </section>
  );
}

/**
 * 服务器给的链接一律写 localhost——那是**网关**的视角。而这一页常常是从局域网
 * 另一台机器打开的（车机、手机、同事的电脑），照搬 localhost 会点进访问者自己的机器。
 * 所以只把回环/容器专用主机名换成"我是怎么访问到这一页的"那个主机名，
 * 端口与路径不动；非回环地址（真外部服务）原样保留。
 */
export function openableHref(url: string, viewerHost: string): string | null {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (["localhost", "127.0.0.1", "::1", "0.0.0.0", "host.docker.internal"].includes(u.hostname)) {
      u.hostname = viewerHost;
    }
    return u.href;
  } catch {
    return null;
  }
}

function Card({ s }: { s: ServiceReport }): JSX.Element {
  const href = s.url ? openableHref(s.url, window.location.hostname) : null;
  return (
    <div className={`sys-card sys-card--${s.state}`}>
      <div className="sys-card-head">
        <span className={`sys-dot sys-dot--${s.state}`} />
        <span className="sys-card-name">{s.label}</span>
      </div>
      {/* 地址整条展示、不截断：这一行是要被人抄走或点开的，截成省略号就白给了 */}
      {s.endpoint ? (
        href ? (
          <a
            className="sys-card-endpoint mono"
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            title={`在新标签页打开 ${href}`}
          >
            {s.endpoint}
            <span className="sys-card-open" aria-hidden="true">
              ↗
            </span>
          </a>
        ) : (
          <span className="sys-card-endpoint mono">{s.endpoint}</span>
        )
      ) : null}
      <div className="sys-card-state">
        {STATE_LABEL[s.state]}
        {s.latencyMs !== undefined ? <span className="sys-latency mono">{s.latencyMs}ms</span> : null}
      </div>
      {s.detail ? <p className="sys-card-detail">{s.detail}</p> : null}
      {s.hint ? <p className="sys-card-hint mono">{s.hint}</p> : null}
    </div>
  );
}

export function SystemPage(): JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setSnapshot(await api.get<Snapshot>("/console/system/status"));
      setError(null);
    } catch (err) {
      // 保留上一份快照，但把"拉取失败"亮出来——旧数据冒充实时是大屏最危险的状态
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const fullscreen = useCallback(() => {
    void rootRef.current?.requestFullscreen?.();
  }, []);

  if (!snapshot && !error) return <div className="boot">探活中…</div>;

  return (
    <div className="sys" ref={rootRef}>
      <header className="sys-top">
        <h1>系统状态</h1>
        {snapshot ? <Banner summary={snapshot.summary} /> : null}
        <span className="spacer" />
        {snapshot ? (
          <span className="sys-meta muted">
            {new Date(snapshot.generatedAt).toLocaleTimeString()} 采集 · {REFRESH_MS / 1000}s 自动刷新
          </span>
        ) : null}
        <button type="button" className="btn-link" onClick={fullscreen}>
          全屏
        </button>
      </header>

      {error ? (
        <div className="sys-banner sys-banner--down">
          状态拉取失败：{error}
          {snapshot ? "（下面显示的是上一次成功的数据）" : "——连网关都联不上时，先看 gateway 本身"}
        </div>
      ) : null}

      {snapshot?.network ? <NetworkStrip net={snapshot.network} /> : null}

      {snapshot
        ? GROUP_ORDER.map((group) => {
            const inGroup = snapshot.services.filter((s) => s.group === group);
            if (inGroup.length === 0) return null;
            return (
              <section key={group} className="sys-group">
                <h2>{GROUP_LABEL[group]}</h2>
                <div className="sys-grid">
                  {inGroup.map((s) => (
                    <Card key={s.id} s={s} />
                  ))}
                </div>
              </section>
            );
          })
        : null}
    </div>
  );
}
