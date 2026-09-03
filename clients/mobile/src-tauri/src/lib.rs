// mobile src-tauri — 手机端装配（HUD + 卡通助手，对话层经底部导航进入）
//
// # 为什么是 lib.rs 而不是全在 main.rs
//
// Tauri 的 iOS/Android 目标**不经过 main**：移动端入口是本文件的 `run()`
// （`#[cfg_attr(mobile, tauri::mobile_entry_point)]` 生成 FFI 符号，由
// gen/apple 的 Swift 壳调起）。桌面端的 main.rs 只剩三行，调的也是它——
// 两个平台共用同一份装配，谁也不是谁的复制品。车机端 ACR-004 已经这么做过，
// 这里是同一形态（`clients/cockpit/src-tauri/src/lib.rs`）。
//
// capability 白名单见 capabilities/ —— 不暴露任何车辆控制能力（§8.5）。
// 端侧兜底：即使前三层安全边界失效，这里物理上也下发不了控制指令。

mod commands;
mod dev_env;
mod events;
mod settings;
// iOS 本地网络授权触发点（M65-03，真机联调暴露的 EHOSTUNREACH）。
mod local_network;
mod setup;
// 哨兵监听（常驻 VAD + 唤醒词，M60-01）。判据与车机端共用 `carlife-voice`，
// 循环各留一份，理由见 voice/sentinel.rs 文件头。
mod voice;

use std::sync::Arc;

use carlife_telemetry::TelemetryBuffer;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 桌面开发机把仓库根 .env 读进进程环境；iOS 上找不到文件，静默跳过，
    // 网关地址改由 `settings` 从端上持久化里取（见该模块文件头）。
    dev_env::load_repo_env();

    // 崩溃捕获先于一切装配：setup 里的 SQLite 打开也可能 panic，
    // 装晚了那种崩溃正好落在覆盖范围外（§2.2 C7）。
    let telemetry = carlife_telemetry::install_panic_hook(Arc::new(
        TelemetryBuffer::with_default_capacity(),
    ));

    let builder = tauri::Builder::default()
        .manage(commands::media::VoiceState::default())
        // 哨兵状态（M60-01）：长按说话要靠它让出麦克风，所以必须与 `VoiceState`
        // 同层 manage，而不是等第一次 `sentinel_start` 才存在。
        .manage(commands::voice::SentinelState::default())
        // 播报状态（M65-04）。这里先按共享核的默认（静音）托管，setup 里再用偏好文件的
        // `broadcastEnabled` 覆盖——builder 阶段拿不到 AppHandle 读不了偏好。
        .manage(Arc::new(carlife_tts::TtsState::default()))
        .manage(Arc::clone(&telemetry));

    // 系统定位（iOS / Android）。**WebView 的 navigator.geolocation 在这里是死路**：
    // wry 的 WKUIDelegate 只实现了摄像头/麦克风那一条，没有 geolocation 授权回调，
    // WebKit 于是直接 deny，前端拿到的字面量就是 "User denied Geolocation"——
    // 看起来像用户拒绝过，实际上系统授权框一次都没弹过。这个插件绕开 WebView
    // 直接调 CoreLocation / FusedLocationProvider，那才是真的会弹框的那条路。
    // 桌面端没有它（上游只支持移动端），桌面仍走 acquire.ts 里的高德/浏览器两条路。
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_geolocation::init());

    builder
        .setup(|app| {
            setup::init(app)?;
            Ok(())
        })
        // opener（出发卡「开始导航」，与车机 0830 同一解法）：WebView 里 target=_blank 各平台被吞。
        // iOS 走 UIApplication openURL（能唤起 iosamap:// 的高德 App），桌面开默认浏览器。
        // 能开哪些 URL 由 capabilities/default.json 的 opener 权限白名单钉死——仍然不暴露任何车辆控制能力。
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            // 鉴权（M48-02）：返回值里没有 token，WebView 只知道"登录了没、是谁"。
            commands::auth::auth_login,
            commands::auth::auth_status,
            commands::auth::auth_logout,
            // 登录页网络诊断（M65-03 真机联调）：App 自己连几个目标把 errno 带回来。
            commands::netdiag::net_diag,
            commands::netdiag::report_ui_metrics,
            commands::chat::create_session,
            commands::chat::send_text_message,
            commands::chat::start_session_stream,
            commands::chat::start_mock_stream,
            commands::chat::refresh_history,
            commands::chat::read_cached_messages,
            // HITL resume 上行（M65-02，F-04-08）：此前手机端确认按下去只打一行 warn，是假成功。
            commands::chat::resume_interrupt,
            // 会话历史与软关闭（M65-02）：车机 M28-01 / M22-01 就有，手机端此前没有列表也没有退出口。
            commands::chat::list_sessions,
            commands::chat::close_session,
            commands::media::start_push_to_talk,
            commands::media::stop_push_to_talk,
            commands::media::mic_permission_status,
            // 哨兵监听（语音唤醒，M60-01）。
            commands::voice::sentinel_start,
            commands::voice::sentinel_stop,
            commands::voice::sentinel_set_switch,
            commands::voice::sentinel_bind_session,
            commands::location::get_location_state,
            commands::location::set_location_enabled,
            commands::location::set_location_precision,
            commands::location::record_location_fix,
            commands::location::get_map_viewport,
            commands::location::set_map_viewport,
            commands::profile::get_broadcast_enabled,
            commands::profile::set_broadcast_enabled,
            // 哨兵监听总开关（M60-01）：设置页的「语音唤醒」。
            commands::profile::get_sentinel_enabled,
            commands::profile::set_sentinel_enabled,
            commands::profile::list_vehicles,
            // HUD 真实数据源与实时能量（M65-01）：此前手机主页是一份写死的 mock。
            commands::profile::fetch_trip_plan,
            commands::profile::fetch_vehicle_energy,
            commands::profile::fetch_vehicle_catalog,
            commands::profile::fetch_vehicle_usage,
            commands::profile::fetch_member_usage,
            commands::profile::fetch_preferences,
            commands::profile::fetch_buying,
            commands::profile::create_vehicle,
            commands::profile::set_default_vehicle,
            commands::profile::list_members,
            // 成员授权（M48-03）：与 list_members 的影子档案是两条路。
            commands::profile::list_vehicle_grants,
            commands::profile::add_vehicle_grant,
            commands::profile::remove_vehicle_grant,
            // 设备与车机绑定（M48-04）。
            commands::profile::device_id,
            commands::profile::register_device,
            commands::profile::request_pairing_code,
            commands::profile::fetch_cabin,
            commands::profile::save_member_preference,
            commands::profile::list_combinations,
            commands::profile::save_combination,
            commands::profile::delete_combination,
            commands::profile::bind_cabin,
            commands::profile::save_member,
            commands::profile::delete_member,
            commands::profile::get_guide_brief,
            commands::profile::get_guide_jobs,
            commands::profile::trigger_guide_job,
            // 出发卡的导航规划（2026-09-02，手机端接上车机 M66 的出发卡）。
            commands::profile::plan_departure_nav,
            // 网关地址（iOS 没有环境变量，装到手机上只能从设置页填）。
            settings::get_gateway_settings,
            settings::set_gateway_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running mobile app");
}
