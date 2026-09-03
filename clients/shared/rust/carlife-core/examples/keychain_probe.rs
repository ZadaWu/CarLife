//! 一次性证据脚本（M49-02）：凭证真的进了系统钥匙串，不是悄悄降级成内存。
//! 用法：`cargo run -p carlife-core --example keychain_probe -- [write|read|delete]`
//!
//! 只在 macOS 上有意义：`apple-native-keyring-store` 也只在 Apple 平台声明为依赖（见 Cargo.toml）。
//! `cargo test --workspace` 会顺带编译 examples，所以其它平台必须给一个空的 main，
//! 否则 Linux CI 在这里报 `cannot find crate apple_native_keyring_store`（2026-09-03）。
#[cfg(target_os = "macos")]
fn main() {
    let store = apple_native_keyring_store::keychain::Store::new().expect("keychain store");
    keyring_core::set_default_store(store);
    let e = keyring_core::Entry::new("carlife", "credentials.probe").expect("entry");
    match std::env::args().nth(1).unwrap_or_else(|| "read".into()).as_str() {
        "write" => { e.set_password("{\"probe\":true}").expect("set"); println!("written"); }
        "delete" => { let _ = e.delete_credential(); println!("deleted"); }
        _ => println!("read = {:?}", e.get_password()),
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("keychain_probe 只在 macOS 上可用：它探的是系统钥匙串");
    std::process::exit(2);
}
