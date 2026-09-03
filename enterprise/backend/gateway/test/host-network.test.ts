/**
 * 本机网络（大屏顶部的「局域网地址 / 默认网关」）。
 *
 * 盯得最紧的三条：
 *  1. **开着 VPN 也要读到物理网卡的路由器**——macOS 上 `netstat -rn` 会有两行
 *     default，第一行是 utun 的点对点路由（Gateway 列是 `link#34` 不是地址）。
 *     只认第一行的写法，在开 VPN 的开发机上永远显示"读不到网关"。
 *  2. **读不到就说读不到**，不拿局域网地址换 .1 顶上。
 *  3. **不猜是谁的网络**：容器里跑的 Gateway 看到的是容器地址，得标出来。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NetworkInterfaceInfo } from "node:os";

import {
  parseDefaultRoutes,
  parseProcNetRoute,
  pickLanAddresses,
  readHostNetwork,
} from "../src/console/host-network";

/** macOS 开着 VPN 时的真实输出（截取）。两行 default 是重点。 */
const BSD_NETSTAT = `Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
default            link#34            UCSg                utun6
default            192.168.50.1       UGScIg                en1
10                 192.168.50.1       UGSc                  en1
127                127.0.0.1          UCS                   lo0
`;

const IPROUTE2 = "default via 172.18.0.1 dev eth0 proto dhcp src 172.18.0.5 metric 100\n";

const GNU_NETSTAT = `Kernel IP routing table
Destination     Gateway         Genmask         Flags   MSS Window  irtt Iface
0.0.0.0         192.168.1.1     0.0.0.0         UG        0 0          0 eth0
192.168.1.0     0.0.0.0         255.255.255.0   U         0 0          0 eth0
`;

const iface = (over: Partial<NetworkInterfaceInfo>): NetworkInterfaceInfo =>
  ({
    address: "192.168.50.67",
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "aa:bb:cc:dd:ee:ff",
    internal: false,
    cidr: "192.168.50.67/24",
    ...over,
  }) as NetworkInterfaceInfo;

describe("parseDefaultRoutes", () => {
  it("BSD netstat：两行 default 都收，VPN 那行没有下一跳", () => {
    const routes = parseDefaultRoutes(BSD_NETSTAT);
    assert.deepEqual(routes, [
      { iface: "utun6" },
      { address: "192.168.50.1", iface: "en1" },
    ]);
  });

  it("iproute2：via / dev", () => {
    assert.deepEqual(parseDefaultRoutes(IPROUTE2), [{ address: "172.18.0.1", iface: "eth0" }]);
  });

  it("GNU netstat：目的地写作 0.0.0.0，网卡在最后一列", () => {
    assert.deepEqual(parseDefaultRoutes(GNU_NETSTAT), [{ address: "192.168.1.1", iface: "eth0" }]);
  });

  it("没有默认路由时返回空数组，不抛", () => {
    assert.deepEqual(parseDefaultRoutes("Destination Gateway\n127 127.0.0.1 UCS lo0\n"), []);
  });
});

describe("parseProcNetRoute", () => {
  it("小端十六进制按字节倒着读", () => {
    const content =
      "Iface\tDestination\tGateway\tFlags\n" + "eth0\t00000000\t0112A8C0\t0003\n" + "eth0\t0012A8C0\t00000000\t0001\n";
    assert.deepEqual(parseProcNetRoute(content), [{ address: "192.168.18.1", iface: "eth0" }]);
  });
});

describe("pickLanAddresses", () => {
  it("回环与 169.254 自动私有地址都不算局域网地址", () => {
    const got = pickLanAddresses({
      lo0: [iface({ address: "127.0.0.1", internal: true, cidr: "127.0.0.1/8" })],
      en1: [iface({})],
      en2: [iface({ address: "169.254.3.4", cidr: "169.254.3.4/16" })],
    });
    assert.deepEqual(got, [{ iface: "en1", address: "192.168.50.67", prefix: 24 }]);
  });

  it("family 是数字 4 的老形态也认（Node 版本差异不该让这栏静默变空）", () => {
    const got = pickLanAddresses({
      en0: [iface({ family: 4 as unknown as "IPv4", address: "10.0.0.9", cidr: "10.0.0.9/8" })],
    });
    assert.equal(got.length, 1);
    assert.equal(got[0].address, "10.0.0.9");
  });
});

describe("readHostNetwork", () => {
  const ifaces = {
    lo0: [iface({ address: "127.0.0.1", internal: true, cidr: "127.0.0.1/8" })],
    en1: [iface({})],
    utun6: [iface({ address: "198.18.0.1", cidr: "198.18.0.1/24", mac: "00:00:00:00:00:00" })],
  };

  it("开着 VPN 时给出物理网卡的路由器，并把 VPN 的点对点路由如实列出", async () => {
    const net = await readHostNetwork({
      platform: "darwin",
      ifaces,
      containerized: false,
      exec: async (cmd, args) => {
        assert.equal(cmd, "netstat");
        assert.deepEqual(args, ["-rn", "-f", "inet"]);
        return BSD_NETSTAT;
      },
    });
    assert.deepEqual(net.gateway, { address: "192.168.50.1", iface: "en1" });
    assert.deepEqual(net.tunnels, [{ iface: "utun6" }]);
    // 主用地址 = 默认路由那张网卡上的，且排在最前
    assert.equal(net.lan[0].address, "192.168.50.67");
    assert.equal(net.lan[0].primary, true);
    assert.equal(net.lan[1].primary, undefined);
    assert.equal(net.scope, "host");
    assert.equal(net.error, undefined);
  });

  it("路由表读不到：不猜网关，只把失败原因带出来", async () => {
    const net = await readHostNetwork({
      platform: "darwin",
      ifaces,
      containerized: false,
      exec: async () => {
        throw new Error("spawn netstat ENOENT");
      },
    });
    assert.equal(net.gateway, undefined);
    assert.match(net.error ?? "", /ENOENT/);
    // 地址还在——网关读不到不影响"这台机器的局域网地址是多少"
    assert.equal(net.lan.length, 2);
  });

  it("Linux 上 ip 不存在时退到 /proc/net/route 之后的 netstat", async () => {
    const tried: string[] = [];
    const net = await readHostNetwork({
      platform: "linux",
      ifaces: { eth0: [iface({ address: "172.18.0.5", cidr: "172.18.0.5/16" })] },
      containerized: true,
      readProcRoute: () => {
        throw new Error("ENOENT /proc/net/route");
      },
      exec: async (cmd) => {
        tried.push(cmd);
        if (cmd === "ip") throw new Error("spawn ip ENOENT");
        return GNU_NETSTAT;
      },
    });
    assert.deepEqual(tried, ["ip", "netstat"]);
    assert.equal(net.gateway?.address, "192.168.1.1");
    // 容器里的地址不能冒充宿主机的局域网地址
    assert.equal(net.scope, "container");
  });
});
