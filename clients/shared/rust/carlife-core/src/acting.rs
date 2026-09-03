//! 这台终端此刻**代表谁在说话**（施工单 M54-13）。
//!
//! # 它解决的问题
//!
//! 车机拿的是车辆级凭证，不代表任何人（设计裁决 R4）。可上车声明之后，
//! 这台车机**确实**在替某个具体的人工作——会话、记忆、偏好都记在那个人名下。
//! 服务端也知道这件事：`Session.userId` 就是声明的那个人，`Session.deviceId`
//! 是哪台车机，两者在建会话时由服务端亲自校验并落库。
//!
//! 缺的只是"把这个会话是谁，告诉后续的每一个请求"。本模块存的就是那条线索：
//! **当前声明会话的 id**。端上不自称是谁（自称等于伪造），只出示会话 id，
//! 由服务端回查 `Session` 行来断定代表谁——权威始终在服务端。
//!
//! 2026-09-01 走查：车机上「人员档案」两块都是 unauthorized，因为这条线索
//! 从来没有被带出去，个人域端点只好按"没有人"拒绝。
//!
//! # 只在内存
//!
//! 会话 id 每次启动都会新建（上车声明或自动续用都会建新会话），
//! 落盘存一个必然过期的 id 没有意义。

use std::sync::{Mutex, OnceLock};

static ACTING: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn cell() -> &'static Mutex<Option<String>> {
    ACTING.get_or_init(|| Mutex::new(None))
}

/// 记下当前声明会话（`create_session_as` 成功后调）。
pub fn set_session(session_id: impl Into<String>) {
    *cell().lock().expect("acting poisoned") = Some(session_id.into());
}

/// 当前声明会话 id。`None` = 还没声明过，个人域数据本来就该取不到。
pub fn session() -> Option<String> {
    cell().lock().expect("acting poisoned").clone()
}

/// 清空（换人、退出车机模式）。
pub fn clear() {
    *cell().lock().expect("acting poisoned") = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 会话线索的存取与清空() {
        clear();
        assert_eq!(session(), None, "没声明过就该是 None——不能给个空串蒙混");
        set_session("sess-1");
        assert_eq!(session().as_deref(), Some("sess-1"));
        clear();
        assert_eq!(session(), None);
    }
}
