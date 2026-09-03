//! 设备注册实例 id（施工单 M48-04，FL-56 F-56-01）。
//!
//! # 它是标识符，不是凭证——所以可以落普通文件
//!
//! 凭证（token）在 [`crate::auth`] 里，只活在内存、不落盘（要落盘得先立 ACR 引 keyring）。
//! `deviceId` 不同：它是**这台设备在本系统里的注册编号**，泄露它换不到任何东西
//! （拿别人的 deviceId 发请求仍然要过 JWT）。它必须跨重启稳定——
//! 不稳定的设备身份等于没有设备身份：每次启动都是一台"新设备"，
//! 设备列表会长满，撤销也永远撤不到正在用的那台。
//!
//! 所以它落应用数据目录下的一个文件。这不是"降级方案"，是与它的性质匹配的存储。
//!
//! # 两个角色两个文件
//!
//! 同一台物理 pad 可以既是某人的私人终端、又是某辆车的车机（设计裁决 R12）。
//! 两种身份各有各的 id 与各自的凭证，互不覆盖——所以是**两个文件**，
//! 而不是一个文件里的两个字段：一个字段的话，"当前是哪个角色"就成了状态，
//! 而切换状态的那一刻另一个身份就没了。
//!
//! # 重装 app = 新设备
//!
//! 文件跟着 app 数据一起被删。这是 POC 的已知简化（设计 §7、架构 §13-23）：
//! 被撤销的设备可以经重装换一个新 id 重新注册——但仍然要过账号鉴权，
//! 不是匿名绕过。真正的防绕过要设备指纹，那是另一个需求。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// 设备角色。决定用哪个 id 文件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceRole {
    /// 私人终端（手机 / 个人 pad）：绑人。
    Personal,
    /// 车机终端（车机 / 充当车机的 pad）：绑车。
    Cockpit,
}

impl DeviceRole {
    fn file_name(self) -> &'static str {
        match self {
            DeviceRole::Personal => "device-id.txt",
            DeviceRole::Cockpit => "device-id.cockpit.txt",
        }
    }
}

struct Inner {
    dir: Option<PathBuf>,
    role: DeviceRole,
}

static STATE: OnceLock<Mutex<Inner>> = OnceLock::new();

fn state() -> &'static Mutex<Inner> {
    STATE.get_or_init(|| {
        Mutex::new(Inner {
            dir: None,
            role: DeviceRole::Personal,
        })
    })
}

/// 当前角色落在哪（M54-11）。**与两个 id 文件是两回事**：
/// id 文件是"这个角色的编号"，本文件是"此刻用哪个角色"。
const ROLE_FILE: &str = "device-role.txt";

/// 启动时绑定数据目录并**读回上次的角色**（与 `settings::init` 同一时机）。
pub fn init(dir: PathBuf) {
    /*
     * 角色必须跨重启（M54-11，2026-09-01 走查）。
     *
     * 此前 `set_role` 只改内存，注释还写着"切换不动任何文件"——那句话说的是
     * **id 文件**不该被覆盖（R12 的两身份互不干扰），但被理解成了"角色本身也不存"。
     * 后果：每次重启都退回 Personal。一台早就绑好车的车机，重启后被当成
     * 未登录的私人终端，弹出账号口令屏——用户的原话是"这是不合理的"。
     *
     * 读不出/没有文件都按 Personal（首启的正确默认），不为此报错。
     */
    let role = std::fs::read_to_string(dir.join(ROLE_FILE))
        .ok()
        .map(|s| if s.trim() == "cockpit" { DeviceRole::Cockpit } else { DeviceRole::Personal })
        .unwrap_or(DeviceRole::Personal);
    let mut guard = state().lock().expect("device state poisoned");
    guard.dir = Some(dir);
    guard.role = role;
}

/// 当前角色。默认私人终端；车机模式由 `set_role` 切换。
pub fn role() -> DeviceRole {
    state().lock().expect("device state poisoned").role
}

/// 切换角色（"用作车机" / "退出车机模式"）。
///
/// **不动两个 id 文件**：两个身份的 id 各自躺在各自的文件里，换回来时原样还在
/// ——这正是"退出车机模式不用重新登录"的实现基础。
/// 但**当前角色本身要落盘**（M54-11），否则重启就回到 Personal，
/// 一台绑好的车机会被当成未登录的私人终端。
pub fn set_role(next: DeviceRole) {
    let mut guard = state().lock().expect("device state poisoned");
    guard.role = next;
    let Some(dir) = guard.dir.clone() else { return };
    let value = match next {
        DeviceRole::Cockpit => "cockpit",
        DeviceRole::Personal => "personal",
    };
    if let Err(e) = std::fs::write(dir.join(ROLE_FILE), value) {
        eprintln!("[device] 角色落盘失败（{e}）——重启后会退回私人终端");
    }
}

/// 生成一个新的注册实例 id。
///
/// 不用硬件标识（IMEI / 序列号）：一是拿不到（iOS 早就不给），
/// 二是**不需要**——两台同型号 iPad 各有各的数据目录，各自生成一个随机 id
/// 就天然可区分（REQ-0002 约束 5）。
fn new_id() -> String {
    // 不引 uuid 依赖：128 位随机 hex 与 UUIDv4 的碰撞概率同量级，
    // 而这个值只在本系统内当主键用，不需要符合 UUID 规范。
    let mut bytes = [0u8; 16];
    getrandom(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 随机字节。用 `std` 能拿到的熵源，不引 rand 依赖。
fn getrandom(buf: &mut [u8]) {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    // RandomState 每次构造都从系统熵源取种（std 的 HashMap 抗碰撞攻击就靠它）。
    let mut i = 0;
    while i < buf.len() {
        let v = RandomState::new().build_hasher().finish().to_le_bytes();
        let n = v.len().min(buf.len() - i);
        buf[i..i + n].copy_from_slice(&v[..n]);
        i += n;
    }
}

fn read_or_create(path: &Path) -> Result<String, String> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        let trimmed = existing.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }
    let id = new_id();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败: {e}"))?;
    }
    std::fs::write(path, &id).map_err(|e| format!("写设备 id 失败: {e}"))?;
    Ok(id)
}

/// 取当前角色的设备 id；没有就生成并落盘。
///
/// 未 `init` 时返回错误而不是编一个内存 id：一个不落盘的 id 会在每次重启后变，
/// 而"设备列表里每天多出一台"这种现象，没人会往"忘了 init"上查。
pub fn current_id() -> Result<String, String> {
    let (dir, role) = {
        let guard = state().lock().expect("device state poisoned");
        (guard.dir.clone(), guard.role)
    };
    let dir = dir.ok_or_else(|| "设备标识未初始化（缺数据目录）".to_string())?;
    read_or_create(&dir.join(role.file_name()))
}

/// 取指定角色的设备 id（绑定流程要先拿到车机身份的 id，而当前角色可能还是私人）。
pub fn id_for(role: DeviceRole) -> Result<String, String> {
    let dir = {
        let guard = state().lock().expect("device state poisoned");
        guard.dir.clone()
    };
    let dir = dir.ok_or_else(|| "设备标识未初始化（缺数据目录）".to_string())?;
    read_or_create(&dir.join(role.file_name()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 与 `auth` 同样的理由：状态是进程级单例，全部断言合成一条按顺序跑。
    #[test]
    fn device_id_lifecycle() {
        let dir = std::env::temp_dir().join(format!("carlife-device-test-{}", new_id()));
        init(dir.clone());

        let a = current_id().expect("应能生成");
        assert_eq!(a.len(), 32, "128 位 hex");
        let again = current_id().expect("应能读回");
        assert_eq!(a, again, "**跨调用稳定**——不稳定等于没有设备身份");

        /*
         * **角色跨重启**（M54-11）。此前 set_role 只改内存，重启回到 Personal
         * ——一台绑好车的车机被当成未登录的私人终端，弹账号口令屏。
         * 用重新 init 同一目录模拟重启：这是本仓能表达"进程重启"的最小形式。
         */
        assert_eq!(role(), DeviceRole::Personal, "首启默认私人终端");
        set_role(DeviceRole::Cockpit);
        state().lock().unwrap().role = DeviceRole::Personal; // 抹掉内存态
        init(dir.clone());
        assert_eq!(role(), DeviceRole::Cockpit, "重启后角色丢了——就是走查那张登录屏");
        set_role(DeviceRole::Personal);
        state().lock().unwrap().role = DeviceRole::Cockpit;
        init(dir.clone());
        assert_eq!(role(), DeviceRole::Personal, "退出车机模式也要落盘，否则重启又变回车机");
        set_role(DeviceRole::Cockpit);

        // 两个角色两个 id：同一台物理设备的两种身份互不覆盖（R12）。
        let cockpit = id_for(DeviceRole::Cockpit).expect("车机身份");
        assert_ne!(a, cockpit);
        assert_eq!(
            id_for(DeviceRole::Personal).expect("私人身份"),
            a,
            "取车机 id 不该动私人 id"
        );

        // 切角色只换读哪个文件，不动文件本身。
        set_role(DeviceRole::Cockpit);
        assert_eq!(current_id().unwrap(), cockpit);
        set_role(DeviceRole::Personal);
        assert_eq!(current_id().unwrap(), a, "切回来原样还在（退出车机模式不用重登）");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 两台"设备"（两个数据目录）拿到的 id 必须不同——同型号可区分的根据。
    #[test]
    fn two_devices_get_distinct_ids() {
        let base = std::env::temp_dir();
        let d1 = base.join(format!("carlife-dev-a-{}", new_id()));
        let d2 = base.join(format!("carlife-dev-b-{}", new_id()));
        let id1 = read_or_create(&d1.join("device-id.txt")).unwrap();
        let id2 = read_or_create(&d2.join("device-id.txt")).unwrap();
        assert_ne!(id1, id2);
        let _ = std::fs::remove_dir_all(&d1);
        let _ = std::fs::remove_dir_all(&d2);
    }
}
