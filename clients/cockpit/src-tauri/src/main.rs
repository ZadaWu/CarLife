// cockpit src-tauri — 桌面端入口。装配全在 lib.rs 的 `run()`：
// iOS/Android 不经过 main（mobile_entry_point 直接调 run），两个平台共用同一份装配。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    cockpit_lib::run();
}
