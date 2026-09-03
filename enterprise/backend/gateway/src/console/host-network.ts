/**
 * 本机网络 —— 运维大屏顶部那条「局域网地址 / 默认网关」。
 *
 * 为什么要它：车机、手机端、同事的浏览器都是从局域网访问这台机器的
 * （`http://<局域网地址>:5173/system` 就是这么打开的）。地址靠 `ifconfig`
 * 现查、网关靠猜 `.1`，都是"每次要用的时候现找一遍"的事。
 *
 * 两条与本页同源的纪律：
 *  1. **不猜**。默认网关只从路由表读；读不到就写"读不到"和读失败的原因，
 *     绝不拿"局域网地址换成 .1"顶上——家里恰好是 .1 不等于机房也是。
 *  2. **说清是谁的网络**。Gateway 跑在容器里时，这里看到的是容器命名空间的
 *     地址（172.x + 网关 172.x.0.1），与宿主机的局域网地址是两回事。
 *     容器内不静默展示成"本机地址"，而是标出来。
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 路由表命令的限时。本地命令，慢过这个数就是环境有问题，不值得拖住整页。 */
const ROUTE_TIMEOUT_MS = 1_500;

export interface LanAddress {
  /** 网卡名，如 en1 / eth0。同一台机器多张网卡时它才是区分依据。 */
  iface: string;
  address: string;
  /** 掩码位数，如 24。取不到时不写。 */
  prefix?: number;
  /** 带默认路由的那张网卡上的地址——别人访问这台机器多半用它。 */
  primary?: boolean;
}

export interface DefaultRoute {
  /** 下一跳地址。VPN/点对点网卡的默认路由没有下一跳，此处为空。 */
  address?: string;
  iface?: string;
}

export interface HostNetworkInfo {
  /** 这些地址属于谁的网络命名空间：宿主机，还是 Gateway 所在的容器。 */
  scope: "host" | "container";
  lan: LanAddress[];
  /** 有下一跳地址的默认路由（家用网络里就是路由器）。 */
  gateway?: DefaultRoute;
  /** 没有下一跳的默认路由（VPN 之类），有就如实说——否则"网关读不到"会很费解。 */
  tunnels: DefaultRoute[];
  /** 读路由表失败时的原因；成功时不写。 */
  error?: string;
}

/** 取一台机器上"别人能连到"的 IPv4：排除回环、排除 169.254 自动私有地址。 */
export function pickLanAddresses(
  ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [iface, infos] of Object.entries(ifaces)) {
    for (const info of infos ?? []) {
      // Node 18 起 family 是 "IPv4"，更早是数字 4——两种都认，省得升级时静默变空
      const v4 = info.family === "IPv4" || (info.family as unknown as number) === 4;
      if (!v4 || info.internal) continue;
      if (info.address.startsWith("169.254.")) continue;
      const prefix = info.cidr?.includes("/") ? Number(info.cidr.split("/")[1]) : undefined;
      out.push({
        iface,
        address: info.address,
        ...(Number.isFinite(prefix) ? { prefix } : {}),
      });
    }
  }
  return out;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * 解析默认路由。三种输出形态都认，因为三种都可能出现在我们跑 Gateway 的地方：
 *   iproute2 （Linux 容器）  `default via 172.17.0.1 dev eth0 proto dhcp`
 *   BSD netstat（macOS）     `default   192.168.50.1   UGScIg   en1`
 *   GNU netstat（老镜像）    `0.0.0.0   192.168.1.1   0.0.0.0   UG   0 0 0 eth0`
 *
 * macOS 上开着 VPN 时会有**两行 default**：一行是 utun 的点对点路由（Gateway
 * 列写着 `link#34` 不是地址），另一行才是物理网卡上的路由器。两行都收，
 * 由调用方按"有没有下一跳"分开——只认第一行的话，开 VPN 就永远读不到路由器。
 */
export function parseDefaultRoutes(stdout: string): DefaultRoute[] {
  const routes: DefaultRoute[] = [];
  for (const raw of stdout.split("\n")) {
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 2) continue;
    if (tokens[0] !== "default" && tokens[0] !== "0.0.0.0") continue;

    const via = tokens.indexOf("via");
    const dev = tokens.indexOf("dev");
    if (via >= 0 || dev >= 0) {
      // iproute2
      const address = via >= 0 && IPV4.test(tokens[via + 1] ?? "") ? tokens[via + 1] : undefined;
      const iface = dev >= 0 ? tokens[dev + 1] : undefined;
      routes.push({ ...(address ? { address } : {}), ...(iface ? { iface } : {}) });
      continue;
    }

    // netstat：第二列是下一跳（BSD 上 VPN 写作 link#34，不是地址）
    const address = IPV4.test(tokens[1]) ? tokens[1] : undefined;
    // 网卡名：BSD 在第 4 列，GNU netstat 在最后一列。两者都不是纯数字与纯大写旗标。
    const iface = tokens.length >= 8 ? tokens[tokens.length - 1] : tokens[3];
    const named = iface && /^[A-Za-z][A-Za-z0-9._:-]*$/.test(iface) && !/^[A-Z]+$/.test(iface);
    routes.push({ ...(address ? { address } : {}), ...(named ? { iface } : {}) });
  }
  return routes;
}

/** `/proc/net/route` 兜底（容器里常常既没有 ip 也没有 netstat）。小端十六进制。 */
export function parseProcNetRoute(content: string): DefaultRoute[] {
  const routes: DefaultRoute[] = [];
  for (const line of content.split("\n").slice(1)) {
    const t = line.trim().split(/\s+/);
    if (t.length < 3 || t[1] !== "00000000") continue;
    const hex = t[2];
    if (!/^[0-9A-Fa-f]{8}$/.test(hex)) continue;
    const octets = [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16));
    routes.push({ address: octets.join("."), iface: t[0] });
  }
  return routes;
}

type Exec = (cmd: string, args: string[]) => Promise<string>;

const defaultExec: Exec = async (cmd, args) => {
  const { stdout } = await execFileAsync(cmd, args, { timeout: ROUTE_TIMEOUT_MS });
  return stdout;
};

/** 按平台依次尝试路由表来源，第一个给出结果的算数。全失败时抛最后一个错。 */
async function readDefaultRoutes(
  exec: Exec,
  platform: string,
  readProcRoute: () => string,
): Promise<DefaultRoute[]> {
  const attempts: Array<() => Promise<DefaultRoute[]>> =
    platform === "darwin"
      ? [async () => parseDefaultRoutes(await exec("netstat", ["-rn", "-f", "inet"]))]
      : [
          async () => parseDefaultRoutes(await exec("ip", ["-4", "route", "show", "default"])),
          async () => parseProcNetRoute(readProcRoute()),
          async () => parseDefaultRoutes(await exec("netstat", ["-rn"])),
        ];

  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      const routes = await attempt();
      if (routes.length > 0) return routes;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) throw lastError;
  return [];
}

export interface HostNetworkDeps {
  exec?: Exec;
  platform?: string;
  ifaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** 是否跑在容器里。默认按 `/.dockerenv` 判定。 */
  containerized?: boolean;
  /** Linux 兜底路由表。默认读 `/proc/net/route`；测试注入假的（否则跑在 Linux 上就读到真机器）。 */
  readProcRoute?: () => string;
}

export async function readHostNetwork(deps: HostNetworkDeps = {}): Promise<HostNetworkInfo> {
  const exec = deps.exec ?? defaultExec;
  const platform = deps.platform ?? process.platform;
  const lan = pickLanAddresses(deps.ifaces ?? networkInterfaces());
  const scope: HostNetworkInfo["scope"] =
    (deps.containerized ?? existsSync("/.dockerenv")) ? "container" : "host";

  let routes: DefaultRoute[] = [];
  let error: string | undefined;
  try {
    routes = await readDefaultRoutes(
      exec,
      platform,
      deps.readProcRoute ?? (() => readFileSync("/proc/net/route", "utf8")),
    );
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const gateway = routes.find((r) => r.address);
  const tunnels = routes.filter((r) => !r.address && r.iface);

  // 主用网卡 = 默认路由出去的那张。它上面的地址才是别人访问这台机器该用的。
  const primaryIface = gateway?.iface;
  const marked = lan.map((a) => (a.iface === primaryIface ? { ...a, primary: true } : a));
  if (primaryIface === undefined && marked.length === 1) marked[0] = { ...marked[0], primary: true };
  // 主用排前面，其余按网卡名稳定排序——大屏上位置跳来跳去比信息少更糟
  marked.sort((a, b) =>
    a.primary === b.primary ? a.iface.localeCompare(b.iface) : a.primary ? -1 : 1,
  );

  return {
    scope,
    lan: marked,
    ...(gateway ? { gateway } : {}),
    tunnels,
    ...(error ? { error } : {}),
  };
}
