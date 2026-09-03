//! 启动装配（施工单 A3）。
//!
//! 只做"没有它 App 跑不起来"的事：消息缓存目录与 SQLite 打开。
//! 其余（会话引导、流启动）由 WebView 侧按需 invoke ——
//! 放在这里会让启动阻塞在网络上，而手机端冷启动时网络往往还没就绪。

use std::sync::Arc;

use carlife_core::cache::MessageCache;
use carlife_core::location::LocationStore;
use tauri::{App, Manager};

use crate::events::StreamState;

pub fn init(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    // 端上消息缓存（§2.2 C5）：app 数据目录，**非权威源**，可安全清空。
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    let cache = MessageCache::open(&dir.join("messages.sqlite"))?;
    app.manage(Arc::new(StreamState::new(cache)));
    // 网关连接设置：iOS 没有环境变量，地址从这里来（见 `crate::settings` 文件头）。
    // **必须先于一切网关调用初始化**——晚了的话首批请求会打默认 localhost，
    // 而手机上的 localhost 是手机自己，症状是"登录不上"而不是"地址没配"。
    crate::settings::init(dir.join("gateway-settings.json"));
    /*
     * iOS 本地网络授权的触发点（M65-03）。放在网关地址初始化之后、任何网关请求之前：
     * 授权框要在第一条局域网请求前弹出来，否则那条请求会静默拿到 EHOSTUNREACH。
     * 立即返回，发送在独立线程；桌面上是空函数。
     */
    crate::local_network::prime();
    /*
     * 网络诊断的落盘位置（M65-03 真机联调）。放在这里而不是命令内部：
     * `net_diag` 是个 `#[tauri::command]` 纯函数，拿不到 `App`。
     * `autorun_if_enabled` 只在容器里存在 `netdiag.on` 时才真的去探测——
     * 正常启动一个包都不发。
     */
    crate::commands::netdiag::init(dir.clone());
    crate::commands::netdiag::autorun_if_enabled();

    /*
     * 播报开关的初值（M65-04）：偏好文件的 `broadcastEnabled`，缺省 false = 静音。
     * 手机默认不出声（F-02-12「车机播报 / 手机静默」）——静默是默认策略，不是禁止出声。
     * 之后设置页改的是托管状态里的原子量，文件只在这里读一次（与哨兵开关同一形态）。
     */
    {
        let handle = app.handle().clone();
        let enabled = crate::commands::profile::broadcast_enabled_pref(&handle);
        app.state::<Arc<carlife_tts::TtsState>>().set_muted(!enabled);
    }
    /*
     * iOS 音频会话类别设成 `playback`（M65-04）。默认 `soloAmbient` 受静音键管，
     * 静音键一拨暖暖就哑，而日志里一行异常都没有。共享层这个函数幂等且非 iOS 上是 no-op；
     * 哨兵切 `playAndRecord` 后归还时也是切回它，两者不打架。
     */
    if let Err(e) = carlife_media::release_recording_session() {
        eprintln!("[tts] 设置音频会话为 playback 失败（静音键下可能无声）：{e}");
    }

    /*
     * 让 WebView 铺满整块屏，而不是只铺安全区之内（2026-09-02 真机联调）。
     *
     * 现象：iPhone 16 Pro Max 上 HUD 底部露出一条 ~90pt 的 body 背景色，`position: fixed`
     * 的底部导航也跟着上浮。取回的视口指标是 `inner=440x860 screen=440x956 safe=62/34`——
     * 布局视口比屏幕矮的 96pt **恰好等于上下安全区之和**，而且冷启动第一帧就是这样，
     * 与键盘无关。`env()` 又能读到 62/34，说明 `viewport-fit=cover` 是生效的。
     *
     * "能读到安全区、却不铺满"这个组合，是 WKWebView 的
     * `scrollView.contentInsetAdjustmentBehavior` 留在默认 `.automatic` 的典型表现：
     * UIKit 把安全区当作 scrollView 的 adjustedContentInset，WebKit 于是只在剩下的 860pt
     * 里排版。wry 0.55 建 WebView 时没有动这个值（只设了 bounces=false）。
     *
     * 设成 `.never`（枚举值 2）之后 WebKit 按整块视图排版，安全区仍由页面自己用
     * `env(safe-area-inset-*)` 让——那才是我们一直在写的那套避让。
     * 走 `with_webview` 拿裸指针发一条 objc 消息，不 patch wry；桌面端没有这个问题，
     * 只在 iOS 编译。
     */
    #[cfg(target_os = "ios")]
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.with_webview(|pw| unsafe {
            use objc2::msg_send;
            use objc2::runtime::AnyObject;
            let wk = pw.inner() as *mut AnyObject;
            if wk.is_null() {
                return;
            }
            let scroll: *mut AnyObject = msg_send![wk, scrollView];
            if scroll.is_null() {
                return;
            }
            // UIScrollViewContentInsetAdjustmentBehavior.never
            let _: () = msg_send![scroll, setContentInsetAdjustmentBehavior: 2isize];
        });
    }
    // 定位授权与地图视图。**与消息缓存分开一个文件**：清缓存是安全动作
    // （非权威源可随时删），而清掉它会把用户的授权选择和地图视图一起抹掉。
    app.manage(Arc::new(LocationStore::open(dir.join("location.json"))));
    // 设备注册实例 id（M48-04）。落普通文件而不是安全存储：它是标识符不是凭证，
    // 泄露它换不到任何东西，但它必须**跨重启稳定**——不稳定等于每次启动都是新设备。
    carlife_core::device::init(dir.clone());
    /*
     * 哨兵监听总开关（M60-01）：跨重启保持，**默认关**。
     *
     * 必须在 `sentinel_start` 之前载入——那条命令由 WebView 引导时调，
     * 而循环的 `switch_on` 初值就是这个静态量。晚一步的表现是
     * "设置里明明是关的，开机头几秒麦克风还是开着"。
     */
    crate::commands::profile::load_sentinel_pref(app.handle());
    /*
     * 凭证保鲜（M54-09，对齐车机端 M54-03）。
     *
     * access token 只活 15 分钟，而手机端此前**没有任何刷新机制**——
     * 隔夜再开，凭证从钥匙串读回来了，却是过期的那枚：所有请求 401，
     * SSE 流风暴式重连。冷启动先刷一次，此后每 10 分钟一次。
     *
     * 用 std 线程 + `block_on` 而不是 tokio：本 crate 没有 tokio 依赖，
     * 为一个定时器加依赖要立 ACR（车机端有 tokio 是既有事实）。
     * 没登录过时 keep_fresh 返回 false 且不做任何事，不是错误。
     */
    // 退避与车机端同一形状（M54-12）：失败 15 秒起翻倍，成功回到 10 分钟。
    // 手机上"点开 app 时还在切网"比开发机更常见。
    std::thread::spawn(|| {
        const OK_GAP: u64 = 600;
        let mut gap = OK_GAP;
        loop {
            let (base_url, _) = crate::settings::gateway();
            let ok = tauri::async_runtime::block_on(carlife_net::keep_fresh(&base_url));
            gap = if ok { OK_GAP } else { (if gap >= OK_GAP { 15 } else { gap * 2 }).min(OK_GAP) };
            std::thread::sleep(std::time::Duration::from_secs(gap));
        }
    });
    Ok(())
}
