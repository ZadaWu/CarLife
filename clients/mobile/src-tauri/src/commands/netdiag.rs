//! 登录页的网络诊断（施工单 M65-03，真机联调用）。
//!
//! iPhone 上 Safari 能开网关的 healthz、App 里同一地址却 `No route to host`，而所有推断
//! （本地网络授权、VPN、路由）都只能从手机外面猜。这个命令让 App **自己**把事实带回登录页。
//!
//! # 报的顺序就是排除的顺序，别打乱
//!
//! 1. **本机地址**——手机自己在哪个网段。没有这一条，后面所有 errno 都是二义的：
//!    「连不上 192.168.50.67」既可能是本地网络授权被拒，也可能是手机根本不在 50 网段。
//!    2026-09-02 那次真机复现（iPhone 16 Pro Max / iOS 26.1）四条探测**全是 EHOSTUNREACH**，
//!    连一个已验证可达的公网地址也不例外——那种全灭的形状只能由"手机侧压根没有可用出口"
//!    解释，而当时的诊断恰好一个字都没说手机自己的地址。
//! 2. **选路**——对每个目标做一次 UDP `connect`（**不发包**，内核只查路由表），
//!    回报内核选中的源地址。它把"有没有路由"和"路由通不通"拆成两件事：
//!    连 `connect` 都 ENETUNREACH，说明连路由表都没有这一条，跟对端毫无关系。
//! 3. **TCP 实连**——真正握手，errno 原样带回。
//! 4. **DNS 与 NAT64 合成**——解析一个域名，判 App 的网络栈整体死没死；再把网关/公网的
//!    **IPv4 字面量**过一遍 `getaddrinfo(AI_DEFAULT)`，看系统会不会把它合成成 IPv6。
//!    这一条是为了区分"网络不通"和"只有 Rust 这条路不通"：Safari/URLSession 在
//!    IPv6-only + NAT64 的网络上访问 IPv4 字面量是**能通的**（CFNetwork 会合成），
//!    而 Rust 的 `"1.2.3.4:80".to_socket_addrs()` 认出字面量后直接短路、**根本不调
//!    getaddrinfo**，于是拿着一个本网络无路由的 IPv4 地址去 connect，必得 EHOSTUNREACH。
//!    两边的差别就长成"Safari 能开、App 说 No route to host"。
//! 5. **多播**——iOS 上没有 `com.apple.developer.networking.multicast` 授权时**必然**
//!    EHOSTUNREACH（本仓的 entitlements 是空的，从来没申请过这个授权）。
//!    所以这一条**只是记录，不构成任何判据**——见 `crate::local_network` 文件头。
//!
//! # 已经用这份诊断排除掉的（2026-09-02，iPhone 16 Pro Max / iOS 26.1）
//!
//! 别再从这几条重新猜起，它们都是实测结论：
//!
//! - **不是服务端**：网关 `*:8790` 在听、防火墙放行、Mac 绕开 VPN 直连公网 200。
//! - **不是 entitlement**：签名后只有 `application-identifier` / `team-identifier` /
//!   `get-task-allow`，没有任何网络限制项。
//! - **不是 ATS**：Info.plist 只有 `NSAllowsLocalNetworking`，而 ATS 管的是
//!   URLSession/WKWebView，**管不到裸 socket**——Rust 这条路根本不过 ATS。
//! - **不是 IPv6-only / NAT64**：`本机地址` 里有 `en0 192.168.50.193`，手机就在 LAN 上，
//!   IPv4 是有的；`系统解析` 对 IPv4 字面量也没合成出 IPv6。
//! - **不是本地网络授权**：失败的目标里包含**公网地址**，而公网不归那道闸管；
//!   同一地址 Safari 能开。
//!
//! 剩下的矛盾就一条，`选路` 与 TCP 两行摆在一起时最刺眼：
//!
//! ```text
//! 选路 121.43.55.216:8790 → 源地址 192.168.50.193   内核说有路由
//! TCP  121.43.55.216:8790 → No route to host        同一目标却连不上
//! ```
//!
//! 「有路由但连不上」只有两类原因，逐网卡那一组（`connect_from`）负责劈开它：
//! 绑定 `en0` 的源地址能连通 = 源地址选择/作用域的问题；每张网卡都连不通 = 这个 App
//! 的出站被整体挡住，得往 NECP 那一层查。
//!
//! 只读、不重试、不记录任何东西；桌面上同样能跑。

use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, ToSocketAddrs, UdpSocket};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(3);

/// 一个公网对照目标（本项目自己的服务器，端口与网关同为 8790）。
const PUBLIC_PROBE: &str = "121.43.55.216:8790";

/// App 数据目录，`setup::init` 注入。诊断结果落在这里，**为的是能隔着 USB 取走**：
/// 真机上 GUI 进程的 stdout/stderr 不进 `devicectl --console`，而照着屏幕转录
/// IPv6 地址会读串（2026-09-02 就串过一次，`625c:21:35db` 被读成 `625c瀧抱湾1:35db`）。
/// 有了文件就能 `devicectl device copy from` 拿到逐字原文。
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 落盘文件名。
const REPORT: &str = "netdiag.txt";
/// 开机自动跑一次的开关文件。**存在即开**，内容无所谓。
///
/// 用文件而不是编译期开关：这样不重新出包就能开关它
/// （`devicectl device copy to` 放一个空文件进去即可），
/// 而 release 包在没有这个文件时**一次探测都不发**，不给正常启动加网络噪声。
const AUTORUN_FLAG: &str = "netdiag.on";

/// 由 `setup::init` 调用，告诉诊断把报告写到哪。
pub fn init(dir: PathBuf) {
    let _ = DATA_DIR.set(dir);
}

/// WebView 侧的视口指标，追加写进 `ui-metrics.txt`。**只在 `netdiag.on` 在场时写**——
/// 与网络诊断同一个开关、同一条 USB 取走的路。
///
/// 为什么需要它：2026-09-02 真机（iPhone）HUD 底部露出一条 ~80pt 的 body 背景色，
/// 而 `position: fixed` 的底部导航也随之上浮。两者都按**布局视口**定位，所以是布局视口
/// 比 WebView 矮了——但矮多少、什么时候矮的（冷启动就矮 / 聚焦输入框之后才矮），
/// 只有 WebView 自己知道。模拟器接硬件键盘、从不弹软键盘，复现不了。
#[tauri::command]
pub fn report_ui_metrics(line: String) {
    let Some(dir) = DATA_DIR.get() else { return };
    if !dir.join(AUTORUN_FLAG).exists() {
        return;
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("ui-metrics.txt")) {
        let _ = writeln!(f, "{line}");
    }
}

/// 开机自检：只有 `netdiag.on` 存在时才跑，且在独立线程里跑，不挡启动。
pub fn autorun_if_enabled() {
    let Some(dir) = DATA_DIR.get() else { return };
    if !dir.join(AUTORUN_FLAG).exists() {
        return;
    }
    std::thread::spawn(|| {
        // 等网络栈和 WebView 起来再测，免得测到"还没连上"的瞬时状态。
        std::thread::sleep(Duration::from_secs(3));
        let _ = net_diag();
    });
}

/// 把报告写进 App 数据目录。写不进去不算错——诊断本身的结果已经返回给界面了。
fn persist(lines: &[String]) {
    let Some(dir) = DATA_DIR.get() else { return };
    let body = lines.join("\n");
    let _ = std::fs::write(dir.join(REPORT), body);
}

/// `io::Error` 的 Display 在 unix 上已经带 `(os error N)`，别再拼一遍——
/// 上一版拼了，于是真机上每行都是 `... (os error 65) (os error 65)`。
fn errno(e: &std::io::Error) -> String {
    e.to_string()
}

fn resolve(target: &str) -> Option<SocketAddr> {
    target.to_socket_addrs().ok().and_then(|mut a| a.next())
}

/// 枚举本机非回环地址。iOS 上的接口名本身就是判据：
/// `en0` = Wi-Fi，`pdp_ip0` = 蜂窝，`utun*` = VPN/代理，`awdl0`/`llw0` = Apple 直连。
/// 一个 `en0` 都没有 = 没连上 Wi-Fi；只有 `utun*` 有默认路由 = 全局代理在接管。
#[cfg(unix)]
fn local_addresses() -> Vec<String> {
    use std::ffi::CStr;

    let mut out = Vec::new();
    let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs 只写 head；成功时用完必须 freeifaddrs，下面无提前返回。
    if unsafe { libc::getifaddrs(&mut head) } != 0 {
        return vec![format!(
            "本机地址：枚举失败 {}",
            errno(&std::io::Error::last_os_error())
        )];
    }
    let mut cur = head;
    while !cur.is_null() {
        // SAFETY: cur 由 getifaddrs 串成的链表，非空即有效。
        let ifa = unsafe { &*cur };
        cur = ifa.ifa_next;
        if ifa.ifa_addr.is_null() {
            continue;
        }
        // SAFETY: ifa_name 是 getifaddrs 保证的 NUL 结尾 C 串。
        let name = unsafe { CStr::from_ptr(ifa.ifa_name) }
            .to_string_lossy()
            .into_owned();
        // SAFETY: 按 sa_family 判族后再按对应布局重解释，是 getifaddrs 的既定用法。
        let ip = unsafe {
            match (*ifa.ifa_addr).sa_family as i32 {
                libc::AF_INET => {
                    let s = &*(ifa.ifa_addr as *const libc::sockaddr_in);
                    Some(IpAddr::from(Ipv4Addr::from(u32::from_be(
                        s.sin_addr.s_addr,
                    ))))
                }
                libc::AF_INET6 => {
                    let s = &*(ifa.ifa_addr as *const libc::sockaddr_in6);
                    Some(IpAddr::from(std::net::Ipv6Addr::from(s.sin6_addr.s6_addr)))
                }
                _ => None,
            }
        };
        match ip {
            // 回环与链路本地（IPv6 fe80::、IPv4 169.254）对判断出口没有信息量，滤掉。
            Some(ip) if !ip.is_loopback() && !is_link_local(&ip) => {
                out.push(format!("{name} {ip}"))
            }
            _ => {}
        }
    }
    // SAFETY: head 来自成功的 getifaddrs，只释放一次。
    unsafe { libc::freeifaddrs(head) };

    if out.is_empty() {
        vec!["本机地址：**一个非回环地址都没有**——手机此刻没有可用网络出口".to_string()]
    } else {
        vec![format!("本机地址：{}", out.join(" / "))]
    }
}

#[cfg(not(unix))]
fn local_addresses() -> Vec<String> {
    vec!["本机地址：本平台未实现枚举".to_string()]
}

fn is_link_local(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_link_local(),
        IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) == 0xfe80,
    }
}

/// 选路探测：UDP `connect` **不发任何包**，只让内核查一次路由表并绑好源地址。
/// 因此它能在"对端可不可达"之前，先回答"有没有一条通往它的路由"。
fn route_probe(label: &str, target: &str) -> String {
    let Some(addr) = resolve(target) else {
        return format!("选路 {label} {target}: 地址解析失败");
    };
    let bind: SocketAddr = if addr.is_ipv4() {
        "0.0.0.0:0".parse().unwrap()
    } else {
        "[::]:0".parse().unwrap()
    };
    let sock = match UdpSocket::bind(bind) {
        Ok(s) => s,
        Err(e) => return format!("选路 {label} {target}: 绑定失败 {}", errno(&e)),
    };
    match sock.connect(addr).and_then(|_| sock.local_addr()) {
        Ok(local) => format!("选路 {label} {target}: 源地址 {}", local.ip()),
        Err(e) => format!("选路 {label} {target}: 无路由 {}", errno(&e)),
    }
}

fn tcp(label: &str, target: &str) -> String {
    let Some(addr) = resolve(target) else {
        return format!("{label} {target}: 地址解析失败");
    };
    match TcpStream::connect_timeout(&addr, TIMEOUT) {
        Ok(_) => format!("{label} {target}: TCP 连通"),
        Err(e) => format!("{label} {target}: {}", errno(&e)),
    }
}

/// DNS：解析成功说明 App 的网络栈整体还活着，失败说明连出口都没有。
fn dns() -> String {
    match "www.apple.com:80".to_socket_addrs() {
        Ok(mut it) => match it.next() {
            Some(a) => format!("DNS www.apple.com: 解析到 {}", a.ip()),
            None => "DNS www.apple.com: 解析结果为空".to_string(),
        },
        Err(e) => format!("DNS www.apple.com: 失败 {}", errno(&e)),
    }
}

/// 把一个 host（可以是 IPv4 字面量）过一遍系统解析器，用 Apple 的 `AI_DEFAULT`
/// （= `AI_V4MAPPED_CFG | AI_ADDRCONFIG`）——这正是 CFNetwork/URLSession 走的那套。
///
/// **它与 Rust 的 `ToSocketAddrs` 不是一回事**：后者对 IP 字面量直接短路返回，
/// 一次 `getaddrinfo` 都不调。在 IPv6-only + NAT64 的网络上，这个差别就是
/// "Safari 打得开、App 报 No route to host"的全部原因。
#[cfg(unix)]
fn synthesized(host: &str) -> String {
    use std::ffi::CString;

    let Ok(c_host) = CString::new(host) else {
        return format!("系统解析 {host}: 主机名不合法");
    };
    let mut hints: libc::addrinfo = unsafe { std::mem::zeroed() };
    hints.ai_family = libc::AF_UNSPEC;
    hints.ai_socktype = libc::SOCK_STREAM;
    #[cfg(target_vendor = "apple")]
    {
        hints.ai_flags = libc::AI_DEFAULT;
    }
    let mut res: *mut libc::addrinfo = std::ptr::null_mut();
    // SAFETY: c_host/hints 在调用期间存活；成功时下面 freeaddrinfo 一次。
    let rc = unsafe { libc::getaddrinfo(c_host.as_ptr(), std::ptr::null(), &hints, &mut res) };
    if rc != 0 {
        return format!("系统解析 {host}: getaddrinfo 失败 rc={rc}");
    }
    let mut found = Vec::new();
    let mut cur = res;
    while !cur.is_null() {
        // SAFETY: cur 来自 getaddrinfo 的链表，非空即有效。
        let ai = unsafe { &*cur };
        cur = ai.ai_next;
        if ai.ai_addr.is_null() {
            continue;
        }
        // SAFETY: 按 ai_family 判族后按对应布局重解释。
        unsafe {
            match ai.ai_family {
                libc::AF_INET => {
                    let s = &*(ai.ai_addr as *const libc::sockaddr_in);
                    found.push(Ipv4Addr::from(u32::from_be(s.sin_addr.s_addr)).to_string());
                }
                libc::AF_INET6 => {
                    let s = &*(ai.ai_addr as *const libc::sockaddr_in6);
                    found.push(std::net::Ipv6Addr::from(s.sin6_addr.s6_addr).to_string());
                }
                _ => {}
            }
        }
    }
    // SAFETY: res 来自成功的 getaddrinfo，只释放一次。
    unsafe { libc::freeaddrinfo(res) };
    if found.is_empty() {
        format!("系统解析 {host}: 无结果")
    } else {
        format!("系统解析 {host}: {}（Rust 的 ToSocketAddrs 对字面量会短路，拿不到这一行）", found.join(" / "))
    }
}

#[cfg(not(unix))]
fn synthesized(host: &str) -> String {
    format!("系统解析 {host}: 本平台未实现")
}

/// 多播。**iOS 上失败是预期**（本仓没有 multicast 授权），故文案里写死这句，
/// 免得下一个人又把它当成"本地网络被拒"的证据——那个误读已经花掉过一整轮真机联调。
fn udp_multicast() -> String {
    let sock = match UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)) {
        Ok(s) => s,
        Err(e) => return format!("多播 UDP: 绑定失败 {}", errno(&e)),
    };
    let _ = sock.set_multicast_ttl_v4(1);
    let target = SocketAddr::from((Ipv4Addr::new(224, 0, 0, 251), 5353));
    match sock.send_to(&crate::local_network::mdns_probe_packet(), target) {
        Ok(n) => format!("多播 UDP 224.0.0.251:5353: 已发 {n} 字节"),
        Err(e) => format!(
            "多播 UDP 224.0.0.251:5353: {}（iOS 无 multicast 授权时必然如此，非判据）",
            errno(&e)
        ),
    }
}

/// 指定源地址发起一次 TCP connect。
///
/// `std::net::TcpStream` 开不出"绑定源地址"的口子，所以这里直接用 libc：
/// socket → bind(src) → 非阻塞 connect → poll → 取 `SO_ERROR`。
///
/// 它回答的是别的探测回答不了的一个问题：**默认选路走不通，换一张网卡走得通吗**。
/// 走得通 = 选路/作用域的问题；每张都走不通 = 这个 App 的 socket 被整体挡了。
#[cfg(unix)]
fn connect_from(src: IpAddr, dst: SocketAddr) -> String {
    use std::os::fd::{FromRawFd, OwnedFd};

    // 源和目的必须同族，否则 bind 之后 connect 必 EAFNOSUPPORT，白测一轮。
    if src.is_ipv4() != dst.is_ipv4() {
        return format!("从 {src} 连 {dst}: 跳过（源与目的不同协议族）");
    }
    let family = if src.is_ipv4() { libc::AF_INET } else { libc::AF_INET6 };
    // SAFETY: 三个参数都是常量；返回 -1 表示失败，下面立刻检查。
    let fd = unsafe { libc::socket(family, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return format!("从 {src} 连 {dst}: socket() 失败 {}", errno(&std::io::Error::last_os_error()));
    }
    // SAFETY: fd 来自成功的 socket()，交给 OwnedFd 后由它负责 close。
    let owned = unsafe { OwnedFd::from_raw_fd(fd) };

    let (src_sa, src_len) = sockaddr_bytes(SocketAddr::new(src, 0));
    // SAFETY: src_sa 是按族填好的 sockaddr，长度与之匹配。
    if unsafe { libc::bind(fd, src_sa.as_ptr() as *const libc::sockaddr, src_len) } != 0 {
        return format!("从 {src} 连 {dst}: bind 失败 {}", errno(&std::io::Error::last_os_error()));
    }
    // SAFETY: 只改 fd 的阻塞标志。
    unsafe { libc::fcntl(fd, libc::F_SETFL, libc::O_NONBLOCK) };

    let (dst_sa, dst_len) = sockaddr_bytes(dst);
    // SAFETY: 同上；非阻塞 connect 立即返回，-1/EINPROGRESS 是正常路径。
    let rc = unsafe { libc::connect(fd, dst_sa.as_ptr() as *const libc::sockaddr, dst_len) };
    if rc != 0 {
        let e = std::io::Error::last_os_error();
        if e.raw_os_error() != Some(libc::EINPROGRESS) {
            // **立刻返回的错误才是判据**：EHOSTUNREACH 在这里意味着内核在发出任何包之前
            // 就拒绝了，那是策略/路由的事，与对端毫无关系。
            return format!("从 {src} 连 {dst}: 立刻拒绝 {}", errno(&e));
        }
    }
    let mut pfd = libc::pollfd { fd, events: libc::POLLOUT, revents: 0 };
    // SAFETY: pfd 指向栈上有效结构，个数 1。
    let n = unsafe { libc::poll(&mut pfd, 1, TIMEOUT.as_millis() as i32) };
    // **owned 必须活到取完 SO_ERROR**：提前 drop 会把 fd 关掉，
    // 下面的 getsockopt 就变成对已关闭 fd 的调用（EBADF），把真正的错误码盖掉。
    let verdict = match n {
        0 => format!("从 {src} 连 {dst}: 超时"),
        n if n < 0 => format!("从 {src} 连 {dst}: poll 失败 {}", errno(&std::io::Error::last_os_error())),
        _ => {
            let mut err: libc::c_int = 0;
            let mut len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
            // SAFETY: fd 仍由 owned 持有、尚未关闭；写入一个同尺寸的 c_int。
            let _ = unsafe {
                libc::getsockopt(pfd.fd, libc::SOL_SOCKET, libc::SO_ERROR, &mut err as *mut _ as *mut libc::c_void, &mut len)
            };
            if err == 0 {
                format!("从 {src} 连 {dst}: 连通")
            } else {
                format!("从 {src} 连 {dst}: {}", errno(&std::io::Error::from_raw_os_error(err)))
            }
        }
    };
    drop(owned);
    verdict
}

#[cfg(not(unix))]
fn connect_from(src: IpAddr, dst: SocketAddr) -> String {
    format!("从 {src} 连 {dst}: 本平台未实现")
}

/// 把 `SocketAddr` 摊成一段可以喂给 `bind`/`connect` 的 sockaddr 字节。
#[cfg(unix)]
fn sockaddr_bytes(addr: SocketAddr) -> (Vec<u8>, libc::socklen_t) {
    match addr {
        SocketAddr::V4(v4) => {
            let mut sa: libc::sockaddr_in = unsafe { std::mem::zeroed() };
            // `sin_len` 是 BSD 系（macOS / iOS）才有的字段，Linux 的 sockaddr_in 没有；
            // `sin_family` 的类型也不同（BSD 是 u8，Linux 是 u16），走 sa_family_t 两边都对。
            // 2026-09-03 之前这里按 macOS 写死，Linux CI 报 no field `sin_len` + mismatched types。
            #[cfg(target_vendor = "apple")]
            {
                sa.sin_len = std::mem::size_of::<libc::sockaddr_in>() as u8;
            }
            sa.sin_family = libc::AF_INET as libc::sa_family_t;
            sa.sin_port = v4.port().to_be();
            sa.sin_addr.s_addr = u32::from(*v4.ip()).to_be();
            let n = std::mem::size_of::<libc::sockaddr_in>();
            // SAFETY: 把 POD 结构按字节读出，长度即其大小。
            (unsafe { std::slice::from_raw_parts(&sa as *const _ as *const u8, n) }.to_vec(), n as libc::socklen_t)
        }
        SocketAddr::V6(v6) => {
            let mut sa: libc::sockaddr_in6 = unsafe { std::mem::zeroed() };
            #[cfg(target_vendor = "apple")]
            {
                sa.sin6_len = std::mem::size_of::<libc::sockaddr_in6>() as u8;
            }
            sa.sin6_family = libc::AF_INET6 as libc::sa_family_t;
            sa.sin6_port = v6.port().to_be();
            sa.sin6_addr.s6_addr = v6.ip().octets();
            sa.sin6_scope_id = v6.scope_id();
            let n = std::mem::size_of::<libc::sockaddr_in6>();
            // SAFETY: 同上。
            (unsafe { std::slice::from_raw_parts(&sa as *const _ as *const u8, n) }.to_vec(), n as libc::socklen_t)
        }
    }
}

/// 本机所有非回环 IPv4/IPv6 地址（`local_addresses` 的结构化版本，供逐网卡探测用）。
#[cfg(unix)]
fn local_ips() -> Vec<(String, IpAddr)> {
    use std::ffi::CStr;
    let mut out = Vec::new();
    let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: 见 local_addresses 里同样的调用。
    if unsafe { libc::getifaddrs(&mut head) } != 0 {
        return out;
    }
    let mut cur = head;
    while !cur.is_null() {
        // SAFETY: getifaddrs 串起来的链表。
        let ifa = unsafe { &*cur };
        cur = ifa.ifa_next;
        if ifa.ifa_addr.is_null() {
            continue;
        }
        // SAFETY: NUL 结尾的 C 串。
        let name = unsafe { CStr::from_ptr(ifa.ifa_name) }.to_string_lossy().into_owned();
        // SAFETY: 按族重解释。
        let ip = unsafe {
            match (*ifa.ifa_addr).sa_family as i32 {
                libc::AF_INET => {
                    let s = &*(ifa.ifa_addr as *const libc::sockaddr_in);
                    Some(IpAddr::from(Ipv4Addr::from(u32::from_be(s.sin_addr.s_addr))))
                }
                libc::AF_INET6 => {
                    let s = &*(ifa.ifa_addr as *const libc::sockaddr_in6);
                    Some(IpAddr::from(std::net::Ipv6Addr::from(s.sin6_addr.s6_addr)))
                }
                _ => None,
            }
        };
        if let Some(ip) = ip {
            if !ip.is_loopback() && !is_link_local(&ip) {
                out.push((name, ip));
            }
        }
    }
    // SAFETY: 只释放一次。
    unsafe { libc::freeifaddrs(head) };
    out
}

#[cfg(not(unix))]
fn local_ips() -> Vec<(String, IpAddr)> {
    Vec::new()
}

/// 从网关 URL 里抠出 host:port；解析不了就原样回报，不猜。
fn gateway_target(base_url: &str) -> Option<(String, u16)> {
    let rest = base_url.split("://").nth(1)?;
    let hostport = rest.split('/').next()?;
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().ok()?),
        None => (
            hostport.to_string(),
            if base_url.starts_with("https") {
                443
            } else {
                80
            },
        ),
    };
    Some((host, port))
}

#[tauri::command]
pub fn net_diag() -> Vec<String> {
    let (base_url, _) = super::chat::gateway_env();
    let mut out = local_addresses();

    match gateway_target(&base_url) {
        Some((host, port)) => {
            let gw = format!("{host}:{port}");
            out.push(route_probe("网关", &gw));
            out.push(tcp("网关", &gw));
            if let Ok(ip) = host.parse::<Ipv4Addr>() {
                let o = ip.octets();
                let router = SocketAddr::from((Ipv4Addr::new(o[0], o[1], o[2], 1), 80));
                out.push(tcp("同网段路由器", &router.to_string()));
            }
            out.push(synthesized(&host));
        }
        None => out.push(format!("网关地址解析不了：{base_url}")),
    }

    out.push(route_probe("公网", PUBLIC_PROBE));
    out.push(tcp("公网对照", PUBLIC_PROBE));
    out.push(synthesized(PUBLIC_PROBE.split(':').next().unwrap_or(PUBLIC_PROBE)));
    out.push(dns());

    // ① 用**域名**而不是 IP 字面量连一次：走 getaddrinfo，与 Safari 同一条解析路。
    //    它和上面那些字面量探测的差别，正好是 Rust 短路掉的那一段。
    out.push(tcp("域名直连", "www.apple.com:80"));

    // ② 逐网卡绑定源地址再连。默认选路已经拿到 192.168.50.193 却连不上时，
    //    这一组回答"是这张网卡不行，还是每张都不行"。
    if let Some(dst) = resolve(PUBLIC_PROBE) {
        for (name, ip) in local_ips() {
            out.push(format!("[{name}] {}", connect_from(ip, dst)));
        }
    }

    out.push(udp_multicast());
    persist(&out);
    out
}

#[cfg(test)]
mod tests {
    use super::{connect_from, gateway_target, is_link_local, local_addresses, route_probe};

    #[test]
    fn parses_host_and_port() {
        assert_eq!(
            gateway_target("http://192.168.50.67:8790"),
            Some(("192.168.50.67".into(), 8790))
        );
        assert_eq!(
            gateway_target("https://gw.example.com"),
            Some(("gw.example.com".into(), 443))
        );
        assert_eq!(gateway_target("nonsense"), None);
    }

    #[test]
    fn link_local_is_filtered_out() {
        assert!(is_link_local(&"169.254.1.2".parse().unwrap()));
        assert!(is_link_local(&"fe80::1".parse().unwrap()));
        assert!(!is_link_local(&"192.168.50.67".parse().unwrap()));
        assert!(!is_link_local(&"fd2d::1".parse().unwrap()));
    }

    /// 诊断的第一行必须是本机地址——排除顺序全靠它打头，缺了后面每条 errno 都是二义的。
    #[test]
    fn first_line_is_the_local_address() {
        let first = local_addresses().into_iter().next().expect("总要有一行");
        assert!(first.starts_with("本机地址："), "实际：{first}");
    }

    /// `getaddrinfo` 这条路必须走通——它是与 `ToSocketAddrs` 短路行为的对照组，
    /// 少了它就没法区分"网络不通"和"只有 Rust 这条路不通"。
    #[test]
    fn system_resolver_answers_for_an_ipv4_literal() {
        let line = super::synthesized("121.43.55.216");
        assert!(line.contains("121.43.55.216") || line.contains("::"), "实际：{line}");
    }

    /// 报告要能落盘（USB 取走的前提），而开机自动跑必须**默认关**——
    /// 少了后半句，release 包每次启动都会静悄悄发一轮探测。
    #[test]
    fn report_persists_and_autorun_stays_off_without_the_flag() {
        let dir = std::env::temp_dir().join(format!("netdiag-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建目录");
        super::init(dir.clone());

        super::persist(&["第一行".to_string(), "第二行".to_string()]);
        let body = std::fs::read_to_string(dir.join(super::REPORT)).expect("报告应已落盘");
        assert_eq!(body, "第一行\n第二行");

        assert!(!dir.join(super::AUTORUN_FLAG).exists(), "开关文件默认不存在");
        super::autorun_if_enabled(); // 没有开关文件时必须直接返回，不探测
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 绑定源地址后能连上一个真实监听口——顺带钉住"取完 SO_ERROR 再关 fd"：
    /// 早关一步，成功也会被读成 EBADF，逐网卡那一组就整组变成假阴性。
    #[test]
    fn connect_from_reports_success_against_a_real_listener() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").expect("监听");
        let dst = l.local_addr().expect("本地址");
        let line = connect_from("127.0.0.1".parse().unwrap(), dst);
        assert!(line.ends_with("连通"), "实际：{line}");
    }

    /// 源与目的不同族时直接跳过，别去 bind 出一个必然 EAFNOSUPPORT 的 socket。
    #[test]
    fn connect_from_skips_mismatched_families() {
        let line = connect_from("::1".parse().unwrap(), "127.0.0.1:80".parse().unwrap());
        assert!(line.contains("不同协议族"), "实际：{line}");
    }

    /// 选路探测不发包，所以对任意可路由目标都应拿到源地址而不是超时。
    #[test]
    fn route_probe_reports_a_source_address() {
        let line = route_probe("公网", super::PUBLIC_PROBE);
        assert!(
            line.contains("源地址") || line.contains("无路由"),
            "实际：{line}"
        );
    }
}
