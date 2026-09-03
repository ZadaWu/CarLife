fn main() {
    // tauri_build 只声明 tauri.conf.json 与 capabilities 为重编触发条件，**不声明
    // frontendDist**。而 `generate_context!` 是在编译期把 ../dist 整个嵌进二进制的。
    // 两者一凑，就是：前端改完、vite build 也跑了，cargo 却认为这个 crate 没变化，
    // 于是二进制里留着上一次的界面——全程零报错、零警告，只是客户端"看起来没更新"。
    // 车机端曾因此整整停在旧档案页上，而 Rust 侧每天都在重编。
    println!("cargo:rerun-if-changed=../dist");
    tauri_build::build()
}
