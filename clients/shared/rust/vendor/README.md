# vendor —— vendor 进来的上游源码（原顶层 third_party/，ACR-020 批①搬入 clients/shared/rust/）

这里放**打了本地补丁的第三方源码**。每一份都必须回答三个问题：为什么要 patch、
怎么验证 patch 生效、什么时候能删掉。删不掉的补丁会变成没人记得为什么存在的永久债。

| 目录 | 上游 | 版本 | 为什么在这儿 | 删除条件 |
|---|---|---|---|---|
| `webrtc-audio-processing-sys-2.1.0/` | [crates.io](https://crates.io/crates/webrtc-audio-processing-sys) · [GitLab](https://gitlab.freedesktop.org/pulseaudio/webrtc-audio-processing) | 2.1.0 | build script 三处宿主/目标混用 + 缺 meson cross file（两个 iOS 目标都编不出可用产物）| 上游合入等价修复并发版后，删本目录与根 `Cargo.toml` 的 `[patch.crates-io]` 段 |

挂接方式是根 `Cargo.toml` 的 `[patch.crates-io]`（path patch），不是 workspace 成员——
根 `[workspace] exclude` 里排除了它，否则 cargo 会把上游源码当我们自己的包去编。

---

## webrtc-audio-processing-sys 2.1.0

引入依据 ACR-010，
施工单 M47-04。
**只改 `build.rs` 一个文件**，C++ 源码与 crate 的 Rust 代码一行未动——
这样上游发新版时，把新版解压进来重打这一个文件的补丁即可。

### 为什么 vendor 而不是指向 GitHub fork

判据是 M47-04 写死的那条：「新克隆 + CI 能不能无额外步骤编过」。vendor 自包含、
离线可编、CI 不需要额外拉取；代价是 5.2MB 上游源码入库，一次性。
指向 fork 分支则要多维护一个公开仓库，且 CI 每次都得拉。

### 补丁一：三处 `cfg!(target_os = ...)` 求的是宿主

build script 自身是为**宿主**编译的，所以 `cfg!(target_os = "macos")` 在里面求的是
"我正跑在 macOS 上"，而不是"我正在为 macOS 编译"。Mac 上交叉编 iOS 时三处全部误判：

| 上游行号 | 原判断 | 症状 | 改成 |
|---|---|---|---|
| 215 | meson 的 `-Dc_link_args` / `-Dcpp_link_args` 加 CoreFoundation + Foundation | 无（iOS 上这两个 framework 也在，恰好也对） | `is_apple_target()` |
| 365 | `cargo:rustc-link-lib=framework=CoreFoundation` | 无（同上） | `is_apple_target()` |
| 376 | 给 `cc` 加 `-mmacos-version-min=<ver>` | **有**：`clang++: error: invalid argument '-mmacos-version-min=11.0' not allowed with '-miphoneos-version-min=26.5'` | `is_macos_target()` |

两处无症状的也一并改了——留着的话，下一个人还得把"这处到底有没有问题"重新判一次。
正确的信息源是 cargo 传给 build script 的 `CARGO_CFG_TARGET_OS`。

### 补丁二：从来没给 meson 传 `--cross-file`（这条更严重）

**这是 ACR-010 立项实测漏掉的**，比补丁一严重得多，因为它会静默产出错误的产物。

上游只调 `meson setup`，没有 cross file。meson 没有 cross file 时按宿主编，于是那
47MB 的 WebRTC C++ 库——**AEC3 的真正实现全在里面**——被编成了 macOS 目标码。

它能一路骗过 `cargo build`，是三件事凑在一起：

1. arm64-macOS 与 arm64-iOS 的 CPU 架构相同，`lipo -info` 两者都报 `arm64`；
2. `cargo build -p carlife-media` 只编到 rlib，静态库此刻仅被 `rustc-link-lib` 声明，
   还没真正参与链接，所以不匹配也不会在这一步暴露；
3. 上游那几十行 wrapper 是 `cc` crate 编的，而 **cc 正确处理交叉编译**——
   所以只验 `wrapper.o` 会看到 `platform 2 (iOS)`，看起来一切正常。

ACR-010 当时的证据正是 `wrapper.o` 的 `LC_BUILD_VERSION platform=2`，
而那是整个构建里唯一编对了的那部分。

补丁按目标三元组现生成一份 cross file 交给 meson，工具链与 sysroot 都问 `xcrun` 要
（不写死 Xcode 路径——装在哪、SDK 什么版本因机器而异）。

### 补丁三：iOS 上跳过 `examples/`

`examples/run-offline` 是命令行可执行文件，iOS 目标下链接必然失败
（`FAILED: examples/run-offline`），而上游 `meson.build` 无条件 `subdir('examples')`，
也没给关掉它的 option。库本身此时已经编好，倒在一个我们根本不要的示例上。

改的是 **OUT_DIR 里的源码副本**（上游 build.rs 把源码 cp 过去，注释写明就是为了
"patch it without consequences"），vendor 在这里的原始源码不动。只在 iOS 上做——
host 的 examples 编得过，那条路径已验证通过，不去动它。

### 补丁四：模拟器的 LLVM 三元组拼错了段序

补丁二生成 cross file 时按 `{arch}-apple-{ios|ios-simulator}{版本}` 拼 `-target`。
真机那支拼出 `arm64-apple-ios14.0`，**恰好合法**，所以一直没人发现模拟器那支拼成了
`arm64-apple-ios-simulator14.0`——正确写法是 `arm64-apple-ios14.0-simulator`：
**版本跟在 OS 后面，`-simulator` 是第四段 environment，不是 OS 名的一部分。**

clang 把 OS 读成 `ios-simulator14.0`、认不出来，就退回一个没有 TLS 的默认目标，
于是报出来的是 abseil 里的：

```
absl/base/internal/thread_identity.h:238:24: error: thread-local storage is not supported for the current target
```

离根因隔着两层，全程不提三元组。后果是**整个 App 编不了模拟器**（`tauri ios build
--target aarch64-sim` 死在这里），因此真机之外没有任何可看界面的途径——
2026-09-02 要给 iPhone 16 Pro Max 调 UI 时才撞上。

判据同样在产物里，只是平台号不同：`platform 7` 是 iOS 模拟器。

### 怎么验证补丁生效

`cargo build` 说 `Finished` **不是判据**（见补丁二）。判据在产物里：

```bash
cargo build -p carlife-media --target aarch64-apple-ios
otool -l "$(find target/aarch64-apple-ios/debug/build/webrtc-audio-processing-sys-*/out/webrtc-audio-processing-build -name '*.cc.o' | head -1)" | grep -A2 LC_BUILD_VERSION
# platform 2 = iOS（对）    platform 1 = macOS（补丁没生效）
```

模拟器目标同理，期望 `platform 7`（补丁四）：

```bash
cargo build -p carlife-media --target aarch64-apple-ios-sim
otool -l "$(find target/aarch64-apple-ios-sim/debug/build/webrtc-audio-processing-sys-*/out/webrtc-audio-processing-build -name '*.cc.o' | head -1)" | grep -A2 LC_BUILD_VERSION
# platform 7 = iOS 模拟器（对）    platform 1 = macOS（补丁没生效）
```

host 侧同一条命令去掉 `--target`，期望 `platform 1`——三个目标各自编对才算通过。

⚠️ **改完补丁要真正 clean 再验**：meson 不允许 `--reconfigure` 改变 cross file，
build 目录还在时 ninja 会复用旧 `.o`，看起来编过了其实平台还是错的。

```bash
cargo clean --target aarch64-apple-ios -p webrtc-audio-processing-sys
```

### 上游 PR：待提（M47-04 遗留项）

M47-04 要求"必须同时向上游提 PR，并把链接写进本文"。补丁内容已就绪且三条都通用
（不含任何 CarLife 特有假设），但 **PR 尚未提交**——提 PR 要以仓库所有者身份 fork
上游并对外发布内容，需本人操作。上游仓库：
`https://gitlab.freedesktop.org/pulseaudio/webrtc-audio-processing`（Rust 绑定在
[GitHub tonarino/webrtc-audio-processing](https://github.com/tonarino/webrtc-audio-processing)）。

PR 正文可直接用本文「补丁一/二/三/四」四节：症状、根因、为什么 `cargo build` 骗得过人、
以及 `otool -l` 的验证方法。三处 `cfg!` 与 cross file 建议拆成两个 PR——
前者是明确的 bug fix，后者是新增交叉编译支持，评审关注点不同。
