fn main() {
    // 麦克风权限走 AVCaptureDevice（src/permission.rs）：类要能被 objc runtime
    // 查到，AVFoundation 必须链接进最终二进制。cpal 只链 CoreAudio，不带它。
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "macos" || target_os == "ios" {
        println!("cargo:rustc-link-lib=framework=AVFoundation");
    }
}
