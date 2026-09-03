//! iOS 本地网络授权的触发点（施工单 M65-03，真机联调暴露）。
//!
//! # 现象
//!
//! iPhone 13（iOS 17.4）上 Safari 能打开 `http://192.168.50.67:8790/healthz`，App 里同一地址的
//! 登录请求却在 connect 时得到 `No route to host (os error 65)`，网关一个包都没收到。
//! 这是 iOS 14+ 的本地网络隐私闸：App 访问局域网单播地址前必须拿到「本地网络」授权，
//! 没授权时内核直接把 connect 判成 EHOSTUNREACH。而授权框只在系统认为 App「开始访问本地网络」
//! 那一刻弹一次——`carlife-net` 走的是 reqwest/BSD socket 单播，这条路在这台设备上**没有把授权框逼出来**
//! （同一网络下的 iPad 车机端能通，是因为那台早就授权过）。
//!
//! # 做法
//!
//! 启动时向**已配置的网关做一次单播 TCP connect**（连上就立刻丢掉，不发任何字节）。
//! 单播是 Apple 文档里不需要任何 entitlement 的触发路径，也是 App 之后真正要走的那条路。
//!
//! ## 为什么不是 mDNS 多播
//!
//! 曾经这里发的是 `224.0.0.251:5353` 的多播探测，理由是"多播是文档里明确列出的触发条件"。
//! 那半句是对的、结论是错的：iOS 14 起**向多播/广播地址发包本身**就要
//! `com.apple.developer.networking.multicast`，而这个授权要向 Apple 申请、本仓的
//! `gen/apple/mobile_iOS.entitlements` 是空的。没有它，`send_to` 在到达"该不该弹授权框"
//! 之前就以 EHOSTUNREACH 失败了——**触发点从来没有生效过**，而它失败时的 errno
//! 恰好与"本地网络被拒"一模一样，于是这个坏法在日志里长得像它本来要解决的那个问题。
//! 多播那条现在只留在 `commands::netdiag` 里当记录，且在文案上写明它不是判据。
//!
//! 授权一旦给了，之后 `carlife-net` 的单播就都放行；用户拒了，症状还是 `No route to host`，
//! 那时「设置 › 隐私与安全性 › 本地网络」里会有 CarLife 这一项可以打开。
//! **首次触发那一次连接自己也会失败**（授权框还没回答），这是预期，不重试。
//!
//! # 为什么在 Rust 侧而不是 Swift 侧
//!
//! `gen/apple/` 整个目录是 gitignored 的（`tauri ios init` 的产物，与 cockpit 同一决定），
//! 写进那里的 Swift 一次重新 init 就没了。这里的代码随仓库走；`NSLocalNetworkUsageDescription`
//! 与 `NSBonjourServices` 同理落在 `src-tauri/Info.plist`（Tauri 会合并进 iOS 的 Info.plist）。
//!
//! 只在 iOS 编译；macOS 开发机上是空函数——桌面没有这道闸。

/// 一个最小的 mDNS 查询：`_http._tcp.local` 的 PTR。
/// 现在**只被 `commands::netdiag` 用来记录多播的 errno**——它不再是授权触发点，理由见文件头。
pub(crate) fn mdns_probe_packet() -> Vec<u8> {
    let mut p = Vec::with_capacity(48);
    // 头：ID 0、标准查询、QDCOUNT 1
    p.extend_from_slice(&[
        0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    for label in ["_http", "_tcp", "local"] {
        p.push(label.len() as u8);
        p.extend_from_slice(label.as_bytes());
    }
    p.push(0); // 名字结束
    p.extend_from_slice(&[0x00, 0x0c]); // QTYPE PTR
    p.extend_from_slice(&[0x00, 0x01]); // QCLASS IN
    p
}

/// 启动时调一次，立即返回；真正的连接在独立线程里，失败只打日志。
#[cfg(target_os = "ios")]
pub fn prime() {
    std::thread::spawn(|| {
        use std::net::{TcpStream, ToSocketAddrs};
        use std::time::Duration;

        let (base_url, _) = crate::settings::gateway();
        // 只取 host:port；解析不了就不做——猜一个地址去连，弹出来的授权框指向的是别人。
        let Some(hostport) = base_url
            .split("://")
            .nth(1)
            .and_then(|r| r.split('/').next())
        else {
            eprintln!("[local-network] 网关地址解析不了，授权触发点跳过：{base_url}");
            return;
        };
        let Some(addr) = hostport.to_socket_addrs().ok().and_then(|mut a| a.next()) else {
            eprintln!("[local-network] 网关地址解析不到 IP，授权触发点跳过：{hostport}");
            return;
        };
        match TcpStream::connect_timeout(&addr, Duration::from_secs(2)) {
            Ok(_) => eprintln!("[local-network] 已单播连上 {addr}（本地网络授权此前已给）"),
            // EHOSTUNREACH 在这里是**预期之一**：授权框正在弹、或用户已拒。都不重试。
            Err(e) => eprintln!("[local-network] 单播 {addr} 未连上（授权未给时这是正常的）：{e}"),
        }
    });
}

#[cfg(not(target_os = "ios"))]
pub fn prime() {}

#[cfg(test)]
mod tests {
    use super::mdns_probe_packet;

    #[test]
    fn packet_is_a_single_ptr_query_for_http_tcp_local() {
        let p = mdns_probe_packet();
        assert_eq!(
            &p[..12],
            &[0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
            "头：一个问题、无应答"
        );
        assert_eq!(&p[12..], b"\x05_http\x04_tcp\x05local\x00\x00\x0c\x00\x01");
        assert!(p.len() < 64, "探测包要小：它只是一次多播动作，不是发现协议");
    }
}
