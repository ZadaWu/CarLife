//! 一次性证据脚本（M49-02）：凭证真的进了系统钥匙串，不是悄悄降级成内存。
//! 用法：`cargo run -p carlife-core --example keychain_probe -- [write|read|delete]`
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
