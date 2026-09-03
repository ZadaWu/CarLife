fn main() {
    // 同 cockpit：tauri_build 不把 frontendDist 声明成重编触发条件，而 `generate_context!`
    // 在编译期就把 ../dist 嵌死了。不补这一行，前端改动不会让 cargo 重编，
    // 客户端界面会静默停在上一次 vite build 的版本。
    println!("cargo:rerun-if-changed=../dist");
    tauri_build::build()
}
