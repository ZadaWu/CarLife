use anyhow::{bail, Context, Result};
use bindgen::callbacks::{AttributeInfo, DeriveInfo, ParseCallbacks};
use std::{
    env,
    fs::File,
    io::{BufWriter, Write},
    path::PathBuf,
    process::Command,
};

/// Name and minimum version of the library that we are binding to.
const LIB_NAME: &str = "webrtc-audio-processing-2";
#[cfg(not(feature = "bundled"))]
const LIB_MIN_VERSION: &str = "2.1";

const MACOSX_DEPLOYMENT_TARGET_VAR: &str = "MACOSX_DEPLOYMENT_TARGET";

/// Symbol prefix for the webrtc-audio-processing library to allow multiple versions to coexist.
const SYMBOL_PREFIX: &str = "v2_";

fn out_dir() -> PathBuf {
    std::env::var("OUT_DIR").expect("OUT_DIR environment var not set.").into()
}

/*
 * CarLife 本地补丁（ACR-010 / 施工单 M47-04）——见 clients/shared/rust/vendor/README.md。
 *
 * 上游在 build script 里用 `cfg!(target_os = "macos")` 判断平台。build script 自身
 * 是为**宿主**编译的，所以那个宏求的是宿主而不是目标：在 Mac 上交叉编 iOS 时它为真，
 * 于是把 `-mmacos-version-min=11.0` 塞进了 iOS 的编译命令，clang++ 直接拒绝：
 *
 *     invalid argument '-mmacos-version-min=11.0' not allowed with '-miphoneos-version-min=26.5'
 *
 * 正确的信息源是 cargo 传给 build script 的 `CARGO_CFG_TARGET_OS`。
 * 三处调用点里只有 `-mmacos-version-min` 那处有症状，另两处（CoreFoundation /
 * Foundation 链接）在 iOS 上恰好也成立所以一直没暴露——但它们判断的东西是错的，
 * 一并改掉，免得下一个人再判一次「这处到底有没有问题」。
 */
fn target_os() -> String {
    env::var("CARGO_CFG_TARGET_OS").unwrap_or_default()
}

/// 目标是 Apple 平台（macOS 或 iOS）——CoreFoundation / Foundation 两者都要链。
fn is_apple_target() -> bool {
    matches!(target_os().as_str(), "macos" | "ios")
}

/// 目标是 macOS 本身。`-mmacos-version-min` 只对它有意义，iOS 上是非法参数。
fn is_macos_target() -> bool {
    target_os() == "macos"
}

/// iOS 交叉编译时给 meson 的最低系统版本。可用环境变量覆盖。
const IPHONEOS_DEPLOYMENT_TARGET_VAR: &str = "IPHONEOS_DEPLOYMENT_TARGET";
const DEFAULT_IPHONEOS_DEPLOYMENT_TARGET: &str = "13.0";

/*
 * meson 交叉编译支持（CarLife 本地补丁，ACR-010 / 施工单 M47-04 实测追加）。
 *
 * # 这一段修的不是上面那三行 cfg，是一个更深的洞
 *
 * 上游**从来没给 meson 传过 `--cross-file`**。meson 没有 cross file 时按宿主编，
 * 于是在 Mac 上交叉编 iOS 时，那 47MB 的 WebRTC C++ 库（AEC3 的真正实现全在里面）
 * 被编成了 **macOS 目标码**。
 *
 * # 为什么它能骗过 `cargo build`
 *
 * 三件事凑在一起，让这个错误一路无声：
 *   1. arm64-macOS 与 arm64-iOS 的 CPU 架构相同，`lipo -info` 都报 arm64；
 *   2. `cargo build -p carlife-media` 只编到 rlib，静态库此刻仅被 `rustc-link-lib`
 *      声明，还没真正参与链接；
 *   3. 上游那几十行 wrapper 是 `cc` crate 编的，而 cc **正确处理**交叉编译——
 *      所以只验 `wrapper.o` 会看到 `platform 2 (iOS)`，看起来一切正常。
 *
 * 判据必须落在 meson 编出来的库上，不是 wrapper：
 *
 *     otool -l …/libwebrtc-audio-processing-2.a.p/<任一>.o | grep -A2 LC_BUILD_VERSION
 *     platform 1 = macOS（错）    platform 2 = iOS（对）
 *
 * # 做法
 *
 * 目标是 iOS 且宿主不是 iOS 时，按目标三元组现生成一份 cross file 交给 meson。
 * 工具链与 sysroot 都问 `xcrun` 要，不写死 Xcode 路径——Xcode 装在哪、SDK 什么版本
 * 因机器而异，写死等于换台机器就炸。
 */
fn write_meson_cross_file() -> Result<Option<PathBuf>> {
    if target_os() != "ios" {
        return Ok(None);
    }

    let target = env::var("TARGET").unwrap_or_default();
    // 真机与模拟器是两个不同的 SDK；装到 iPad 上的是前者。
    let (sdk, simulator) = if target.ends_with("-sim") || target.starts_with("x86_64") {
        ("iphonesimulator", true)
    } else {
        ("iphoneos", false)
    };

    let sdk_path = xcrun(&["--sdk", sdk, "--show-sdk-path"])?;
    let clang = xcrun(&["--sdk", sdk, "-f", "clang"])?;
    let clangxx = xcrun(&["--sdk", sdk, "-f", "clang++"])?;
    let ar = xcrun(&["--sdk", sdk, "-f", "ar"])?;
    let strip = xcrun(&["--sdk", sdk, "-f", "strip"])?;

    let arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_else(|_| "aarch64".into());
    // LLVM 用 `arm64`，cargo 的 target_arch 叫 `aarch64`——同一个东西两个名字。
    let llvm_arch = if arch == "aarch64" { "arm64" } else { arch.as_str() };
    let deployment = env::var(IPHONEOS_DEPLOYMENT_TARGET_VAR)
        .unwrap_or_else(|_| DEFAULT_IPHONEOS_DEPLOYMENT_TARGET.to_string());
    /*
     * LLVM 三元组的模拟器写法是 `arm64-apple-ios14.0-simulator`：
     * **版本跟在 OS 后面，`-simulator` 是第四段 environment**，不是 OS 名的一部分。
     *
     * 这里原来拼的是 `{arch}-apple-{ios|ios-simulator}{版本}`，真机那支
     * （`arm64-apple-ios14.0`）恰好合法，所以一直没人发现模拟器那支拼成了
     * `arm64-apple-ios-simulator14.0`——clang 把 OS 读成 `ios-simulator14.0`，
     * 认不出来就退回一个没有 TLS 的默认目标，报出来的是
     * `error: thread-local storage is not supported for the current target`
     * （由 abseil 的 thread_identity 触发）。离根因隔着两层，全程不提三元组。
     */
    let triple = format!(
        "{}-apple-ios{}{}",
        llvm_arch,
        deployment,
        if simulator { "-simulator" } else { "" }
    );

    let args = format!("['-target', '{}', '-isysroot', '{}']", triple, sdk_path);
    // meson 认 'darwin'：iOS 与 macOS 同属 Darwin 系，区别由上面的 -target 表达。
    let contents = format!(
        "[binaries]\n\
         c = '{clang}'\n\
         cpp = '{clangxx}'\n\
         ar = '{ar}'\n\
         strip = '{strip}'\n\
         \n\
         [host_machine]\n\
         system = 'darwin'\n\
         cpu_family = '{arch}'\n\
         cpu = '{llvm_arch}'\n\
         endian = 'little'\n\
         \n\
         [built-in options]\n\
         c_args = {args}\n\
         cpp_args = {args}\n\
         objc_args = {args}\n\
         objcpp_args = {args}\n\
         c_link_args = {args}\n\
         cpp_link_args = {args}\n",
        clang = clang,
        clangxx = clangxx,
        ar = ar,
        strip = strip,
        arch = arch,
        llvm_arch = llvm_arch,
        args = args,
    );

    let path = out_dir().join("carlife-ios-cross.ini");
    std::fs::write(&path, contents).context("writing meson cross file")?;
    eprintln!("[carlife patch] meson cross file → {} (target {})", path.display(), triple);
    Ok(Some(path))
}

/*
 * 交叉编译到 iOS 时把上游的 `examples/` 从构建图里摘掉（CarLife 本地补丁）。
 *
 * `examples/run-offline` 是个命令行可执行文件，在 iOS 目标下链接必然失败：
 *
 *     FAILED: examples/run-offline
 *     clang++: error: linker command failed with exit code 1
 *
 * 而上游的 `meson.build` 无条件 `subdir('examples')`，也没给关掉它的 option。
 * 库本身此时已经编好了，倒在一个我们根本不要的示例程序上。
 *
 * 改的是 **OUT_DIR 里的源码副本**——上游在上面几行刚把源码 cp 过去，注释写明
 * 就是为了"patch it without consequences"，vendor 进 clients/shared/rust/vendor/ 的原始源码不动。
 * 只在 iOS 上做：host 的 examples 编得过，且那条路径已经验证通过，不去动它。
 */
fn strip_examples_subdir(webrtc_source_dir: &std::path::Path) -> Result<()> {
    let meson_build = webrtc_source_dir.join("meson.build");
    let contents = std::fs::read_to_string(&meson_build)
        .with_context(|| format!("reading {}", meson_build.display()))?;
    let patched = contents.replace(
        "subdir('examples')",
        "# subdir('examples')  # CarLife: iOS 上链接不了命令行示例，见 build.rs",
    );
    if patched != contents {
        std::fs::write(&meson_build, patched)
            .with_context(|| format!("writing {}", meson_build.display()))?;
        eprintln!("[carlife patch] iOS 目标：已跳过 examples/ 子目录");
    }
    Ok(())
}

/// 问 `xcrun` 要工具链路径 / SDK 路径。失败时带上下文，别让调用方看到一个空字符串。
fn xcrun(args: &[&str]) -> Result<String> {
    let out = Command::new("xcrun")
        .args(args)
        .output()
        .with_context(|| format!("executing xcrun {:?}", args))?;
    if !out.status.success() {
        bail!("xcrun {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
    }
    Ok(String::from_utf8(out.stdout).context("xcrun output is not utf-8")?.trim().to_string())
}

/// Prefix specified symbols in a static library using objcopy --redefine-sym.
fn prefix_archive_symbols(
    archive_path: &std::path::Path,
    symbols: &[String],
    prefix: &str,
) -> Result<()> {
    if symbols.is_empty() {
        return Ok(());
    }

    eprintln!(
        "Prefixing {} symbols in {} with '{}'",
        symbols.len(),
        archive_path.display(),
        prefix
    );

    let temp_path = archive_path.with_extension("prefixed.a");

    let objcopy = determine_objcopy_path()?;

    // Write arguments to a temp file to avoid "Argument list too long" errors.
    let args_path = archive_path.with_extension("args");
    let mut writer = BufWriter::new(File::create(&args_path)?);
    for symbol in symbols {
        writeln!(writer, "--redefine-sym={}={}{}", symbol, prefix, symbol)?;
    }
    writer.flush()?;
    drop(writer);

    let mut cmd = Command::new(&objcopy);
    cmd.arg(format!("@{}", args_path.display()));
    cmd.arg(archive_path);
    cmd.arg(&temp_path);

    eprintln!("Running {cmd:?}");
    let status = cmd.status().context(format!("Failed to execute {:?}", objcopy))?;

    if !status.success() {
        anyhow::bail!("{:?} failed with status: {}", objcopy, status);
    }

    std::fs::rename(&temp_path, archive_path).with_context(|| {
        format!("Failed to rename {} to {}", temp_path.display(), archive_path.display())
    })?;

    Ok(())
}

#[cfg(not(feature = "bundled"))]
mod webrtc {
    use super::*;

    pub(super) fn get_build_paths() -> Result<(Vec<PathBuf>, Vec<PathBuf>)> {
        let (pkgconfig_include_path, pkgconfig_lib_path) = find_pkgconfig_paths()?;

        let include_path = std::env::var("WEBRTC_AUDIO_PROCESSING_INCLUDE")
            .ok()
            .map(PathBuf::from)
            .or(pkgconfig_include_path);
        let lib_path = std::env::var("WEBRTC_AUDIO_PROCESSING_LIB")
            .ok()
            .map(PathBuf::from)
            .or(pkgconfig_lib_path);

        if include_path.is_none() || lib_path.is_none() {
            bail!(
                "Couldn't find {}. Please install it or set WEBRTC_AUDIO_PROCESSING_INCLUDE and WEBRTC_AUDIO_PROCESSING_LIB environment variables.",
                LIB_NAME
            );
        }

        Ok((vec![include_path.unwrap()], vec![lib_path.unwrap()]))
    }

    pub(super) fn build_if_necessary() -> Result<()> {
        Ok(())
    }

    fn find_pkgconfig_paths() -> Result<(Option<PathBuf>, Option<PathBuf>)> {
        let lib = match pkg_config::Config::new()
            .atleast_version(LIB_MIN_VERSION)
            .statik(false)
            .probe(LIB_NAME)
        {
            Ok(lib) => lib,
            Err(e) => {
                eprintln!("Couldn't find {LIB_NAME} with pkg-config:");
                eprintln!("{e}");
                return Ok((None, None));
            },
        };

        Ok((lib.include_paths.first().cloned(), lib.link_paths.first().cloned()))
    }

    pub(super) fn prefix_library_symbols(
        _lib_dirs: &[PathBuf],
        _prefix: &str,
    ) -> Result<Vec<String>> {
        // For non-bundled builds, we can't prefix symbols in the system library.
        // Users would need to build with bundled feature for multi-version support.
        println!(
            "cargo:warning=Symbol prefixing is only supported with the 'bundled' feature. \
            Without it, linking multiple versions of this crate may cause symbol conflicts."
        );

        Ok(vec![])
    }
}

#[cfg(feature = "bundled")]
mod webrtc {
    use super::*;
    use std::{collections::HashSet, path::Path};

    const BUNDLED_SOURCE_PATH: &str = "./webrtc-audio-processing";

    pub(super) fn get_build_paths() -> Result<(Vec<PathBuf>, Vec<PathBuf>)> {
        let mut include_paths = vec![
            out_dir().join("include"),
            out_dir().join("include").join(LIB_NAME),
            webrtc_source_dir(),
            webrtc_source_dir().join("webrtc"),
        ];
        // TODO(strohel): instead of hardcoding the paths, we should consult the pkgconfig file that
        // the bundled webrtc-audio-processing build produces.
        let mut lib_paths = vec![
            // MacOS, Arch Linux, baseline default
            out_dir().join("lib"),
            // Ubuntu Linux (our CI)
            out_dir().join("lib").join("x86_64-linux-gnu"),
            // Ubuntu Linux (Arm 64bit)
            out_dir().join("lib").join("aarch64-linux-gnu"),
            // Gentoo Linux (x86_64 multilib)
            out_dir().join("lib64"),
        ];

        // Notes: c8896801 added support for 20250814, but the meson.build is still expecting
        // >=20240722 and the subproject will fetch 20240722. If the build environment has 20250814
        // installed, it should still pick it up and build successfully, though.
        if let Ok(mut lib) =
            pkg_config::Config::new().atleast_version("20240722").probe("absl_base")
        {
            // If abseil package is installed locally, meson would have linked it for
            // webrtc-audio-processing-2. Use the same library for our wrapper, too.
            include_paths.append(&mut lib.include_paths);
            lib_paths.append(&mut lib.link_paths);
        } else {
            // Otherwise use the local build fetched and built by meson.
            include_paths
                .push(webrtc_source_dir().join("subprojects").join("abseil-cpp-20240722.0"));
            lib_paths.push(webrtc_build_dir().join("subprojects").join("abseil-cpp-20240722.0"));
        }

        Ok((include_paths, lib_paths))
    }

    pub(super) fn build_if_necessary() -> Result<()> {
        let bundled_source_path = Path::new(BUNDLED_SOURCE_PATH);
        if bundled_source_path.read_dir()?.next().is_none() {
            eprintln!("The webrtc-audio-processing source directory is empty.");
            eprintln!("See the crate README for installation instructions.");
            eprintln!("Remember to clone the repo recursively if building from source.");
            bail!("Aborting compilation because bundled source directory is empty.");
        }

        let webrtc_source_dir = webrtc_source_dir();
        let webrtc_build_dir = webrtc_build_dir();
        eprintln!(
            "Copying webrtc-audio-processing to {} and building it in {}",
            webrtc_source_dir.display(),
            webrtc_build_dir.display()
        );

        // Copy the sources to under out directory so that we can patch it without consequences.
        let mut cp = Command::new("cp");
        // Copy recursively, preserve attributes. Use trailing dot trick to prevent creating
        // `webrtc-audio-processing/webrtc-audio-processing` nesting on a 2nd invocation.
        cp.arg("-a").arg(bundled_source_path.join(".")).arg(&webrtc_source_dir);
        let status = cp.status().context("executing cp")?;
        assert!(status.success(), "Command failed: {:?}", &cp);

        #[cfg(feature = "experimental-unlink-ns")]
        apply_patch("unlink-multichannel-noise-suppression-filters.patch")?;

        let mut meson = Command::new("meson");
        meson.arg("setup").arg("--prefix").arg(out_dir().as_os_str());
        meson.arg("--reconfigure");

        // 交叉编译到 iOS 时必须给 cross file，否则 meson 按宿主编出 macOS 目标码
        // 而全程不报错（见 write_meson_cross_file 的说明）。
        if let Some(cross_file) = write_meson_cross_file()? {
            meson.arg("--cross-file").arg(cross_file.as_os_str());
            // examples 是命令行程序，iOS 目标下链接必失败——库编好了却倒在它上面。
            strip_examples_subdir(&webrtc_source_dir)?;
        }

        if is_apple_target() {
            let link_args = "['-framework', 'CoreFoundation', '-framework', 'Foundation']";
            meson.arg(format!("-Dc_link_args={}", link_args));
            meson.arg(format!("-Dcpp_link_args={}", link_args));
        }

        let status = meson
            .arg("-Ddefault_library=static")
            .arg(webrtc_build_dir.as_os_str())
            .arg(webrtc_source_dir.as_os_str())
            .status()
            .context("Failed to execute meson. Do you have it installed?")?;
        assert!(status.success(), "Command failed: {:?}", &meson);

        let mut ninja = Command::new("ninja");
        let status = ninja
            .current_dir(&webrtc_build_dir)
            .status()
            .context("Failed to execute ninja. Do you have it installed?")?;
        assert!(status.success(), "Command failed: {:?}", &ninja);

        let mut install = Command::new("ninja");
        let status = install
            .current_dir(&webrtc_build_dir)
            .arg("install")
            .status()
            .context("Failed to execute ninja install")?;
        assert!(status.success(), "Command failed: {:?}", &install);

        Ok(())
    }

    // Patch with `patch`.
    #[cfg(feature = "experimental-unlink-ns")]
    fn apply_patch(patch_name: &str) -> Result<()> {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let patch = manifest.join("patches").join(patch_name);

        let status = Command::new("patch")
            .args(["-p1", "--forward"])
            .arg("-i")
            .arg(&patch)
            .current_dir(webrtc_source_dir())
            .status()
            .context("Failed to execute patch")?;

        anyhow::ensure!(status.success(), "Patch '{}' failed with status: {}", patch_name, status);
        Ok(())
    }

    /// Prefix symbols in the built webrtc-audio-processing static library.
    /// Returns the list of symbols that were renamed.
    pub(super) fn prefix_library_symbols(
        lib_dirs: &[PathBuf],
        prefix: &str,
    ) -> Result<Vec<String>> {
        let static_lib_filename = format!("lib{LIB_NAME}.a");

        for lib_dir in lib_dirs {
            let lib_path = lib_dir.join(&static_lib_filename);
            if lib_path.exists() {
                let symbols = get_defined_symbols(&lib_path)?;
                prefix_archive_symbols(&lib_path, &symbols, prefix)?;
                return Ok(symbols);
            }
        }

        bail!("Cannot find {static_lib_filename} in {lib_dirs:?} to prefix its symbols.");
    }

    fn webrtc_source_dir() -> PathBuf {
        out_dir().join("webrtc-audio-processing")
    }

    fn webrtc_build_dir() -> PathBuf {
        out_dir().join("webrtc-audio-processing-build")
    }

    /// Extract defined (non-external) symbols from a static library using nm.
    fn get_defined_symbols(archive_path: &std::path::Path) -> Result<Vec<String>> {
        let output = Command::new("nm")
            .arg("--defined-only")
            .arg("--format=posix")
            .arg(archive_path)
            .output()
            .context("Failed to execute nm")?;

        if !output.status.success() {
            anyhow::bail!("nm failed: {}", String::from_utf8_lossy(&output.stderr));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut symbols = HashSet::new();

        for line in stdout.lines() {
            // POSIX format: "symbol_name type value size"
            // We just need the first field (symbol name)
            if let Some(symbol) = line.split_whitespace().next() {
                symbols.insert(symbol.to_string());
            }
        }

        Ok(symbols.into_iter().collect())
    }
}

#[derive(Debug)]
struct CustomDeriveCallbacks;

impl ParseCallbacks for CustomDeriveCallbacks {
    fn add_derives(&self, info: &DeriveInfo) -> Vec<String> {
        // Matches EchoCanceller3Config, EchoCanceller3Config_Suppressor etc
        if info.name.starts_with("EchoCanceller3Config") && cfg!(feature = "serde") {
            vec!["serde::Deserialize".into(), "serde::Serialize".into()]
        // Matches AudioProcessing_Config, AudioProcessing_Config_EchoCanceller etc
        } else if info.name.starts_with("AudioProcessing_Config") {
            // Only derive Default for AudioProcessing_Config and its inner structs. bindgen Default
            // implementation ignores C/C++ struct default values and thus misleading to enable
            // globally. Note that we don't expose these defaults on `webrtc-audio-processing`
            // level: they are needed only by the code that converts from prettified Rust config
            // structs into their FFI variants to construct disabled/dummy values.
            vec!["Default".into()]
        } else {
            vec![]
        }
    }

    fn add_attributes(&self, info: &AttributeInfo<'_>) -> Vec<String> {
        if info.name.starts_with("EchoCanceller3Config") {
            // Prohibit construction of ffi EchoCanceller3Config and its children structs.
            // The only allowed API is through the wrapper struct in the webrtc_audio_processing crate.
            vec!["#[non_exhaustive]".into()]
        } else {
            vec![]
        }
    }
}

fn main() -> Result<()> {
    webrtc::build_if_necessary()?;
    let (include_dirs, lib_dirs) = webrtc::get_build_paths()?;

    // Prefix defined symbols in the webrtc library (bundled builds only)
    // Returns the list of renamed symbols to update wrapper references later
    let renamed_symbols = webrtc::prefix_library_symbols(&lib_dirs, SYMBOL_PREFIX)?;

    for dir in &lib_dirs {
        println!("cargo:rustc-link-search=native={}", dir.display());
    }

    if is_apple_target() {
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
    }

    let mut cc_build = cc::Build::new();

    if cfg!(feature = "experimental-aec3-config") {
        cc_build.define("WEBRTC_AEC3_CONFIG", None);
    }

    // Set macos minimum version
    if is_macos_target() {
        let min_version = match env::var(MACOSX_DEPLOYMENT_TARGET_VAR) {
            Ok(ver) => ver,
            Err(_) => {
                String::from(match std::env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
                    "x86_64" => "10.10", // Using what I found here https://github.com/webrtc-uwp/chromium-build/blob/master/config/mac/mac_sdk.gni#L17
                    "aarch64" => "11.0", // Apple silicon started here.
                    arch => panic!("unknown arch: {}", arch),
                })
            },
        };

        // `cc` doesn't try to pick up on this automatically, but `clang` needs it to
        // generate a "correct" Objective-C symbol table which better matches XCode.
        // See https://github.com/h4llow3En/mac-notification-sys/issues/45.
        cc_build.flag(format!("-mmacos-version-min={}", min_version));
    }

    // This automatically emits "cargo:rustc-link-lib=static=webrtc_audio_processing_wrapper".
    // The wrapper library should be linked before webrtc-audio-processing-2, otherwise strict
    // linkers (like when passing -Wl,--as-needed) may discard the c++ library (automatically
    // added by cc) from the linking list, resulting in build failure.
    // The linking order should respect the dependency graph, i.e. wrapper -> webrtc-2.
    cc_build
        .cpp(true)
        .file("src/wrapper.cpp")
        .includes(&include_dirs)
        .flag("-std=c++17")
        .flag("-Wno-unused-parameter")
        .out_dir(out_dir());

    // Inform wrapper code that headers for internal classes (ResidualEchoDetector) are available.
    #[cfg(feature = "bundled")]
    cc_build.define("WEBRTC_HAS_INTERNAL_HEADERS", None);

    cc_build.compile("webrtc_audio_processing_wrapper");

    // The the cc and bindgen commands emit `cargo:rerun-if-env-changed=...`, and these deactivate
    // the default behavior to rerun if _any_ source file changes. So state these explicitly.
    // build.rs is always included and doesn't have to be specified.
    println!("cargo:rerun-if-changed=src/wrapper.hpp");
    println!("cargo:rerun-if-changed=src/wrapper.cpp");

    // Prefix the wrapper library's references to webrtc symbols to match the renamed webrtc library.
    let wrapper_lib = out_dir().join("libwebrtc_audio_processing_wrapper.a");
    if wrapper_lib.exists() {
        prefix_archive_symbols(&wrapper_lib, &renamed_symbols, SYMBOL_PREFIX)?;
    }

    if cfg!(feature = "bundled") {
        println!("cargo:rustc-link-lib=static={LIB_NAME}");
        println!("cargo:rustc-link-lib=absl_strings");
    } else {
        println!("cargo:rustc-link-lib=dylib={LIB_NAME}");
    }

    let binding_file = out_dir().join("bindings.rs");
    let mut builder = bindgen::Builder::default()
        .header("src/wrapper.hpp")
        .clang_args(&["-x", "c++", "-std=c++17", "-fparse-all-comments"])
        .generate_comments(true)
        .enable_cxx_namespaces();

    builder = builder
        // Transitive dependencies are automatically included.
        .allowlist_function("webrtc_audio_processing_wrapper::.*")
        .opaque_type("std::.*")
        .parse_callbacks(Box::new(CustomDeriveCallbacks))
        .derive_debug(true)
        // The default implementation ignores C++11's brace-or-equal-initializers,
        // and thus misleading to enable. See also CustomDeriveCallbacks.
        .derive_default(false)
        .derive_partialeq(true);
    for dir in &include_dirs {
        builder = builder.clang_arg(format!("-I{}", dir.display()));
    }
    builder
        .generate()
        .expect("Unable to generate bindings")
        .write_to_file(&binding_file)
        .expect("Couldn't write bindings!");

    Ok(())
}

/// Reliably determine a path to objcopy binary bundled with the active Rust toolchain (rust-objcopy)
fn determine_objcopy_path() -> Result<PathBuf> {
    // 1. Get the rustc command (this might be a path or just "rustc")
    let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());

    // 2. Ask rustc for the sysroot. This works even if RUSTC="rustc"
    let output = Command::new(&rustc)
        .arg("--print")
        .arg("sysroot")
        .output()
        .context("Failed to execute rustc to find sysroot")?;

    if !output.status.success() {
        bail!("Failed to get sysroot from rustc: {:?}", output);
    }

    let sysroot_str = String::from_utf8(output.stdout).context("Invalid UTF-8 in sysroot")?;
    let sysroot = PathBuf::from(sysroot_str.trim());

    // 3. Construct the path: <sysroot>/lib/rustlib/<HOST_TRIPLE>/bin/rust-objcopy
    // We use HOST because that is where the compiler (and tools) are running.
    let host = env::var("HOST").context("HOST env var not found")?;

    let objcopy = sysroot.join("lib").join("rustlib").join(host).join("bin").join("rust-objcopy");

    // Optional: verification
    if !objcopy.exists() {
        println!("cargo:warning=rust-objcopy not found at {:?}", objcopy);
        println!("cargo:warning=Ensure the 'llvm-tools' component is installed: 'rustup component add llvm-tools'");
    }

    Ok(objcopy)
}
