//! 登录相关的 Tauri 命令（施工单 M48-02，F-07-01/03）。
//!
//! # WebView 拿不到 token，这是本模块存在的全部意义
//!
//! 三个命令的返回值里**没有任何一处是 token**：
//!  - `auth_login` 只回"登录成功了，你是谁"；
//!  - `auth_status` 只回"登录了没、是谁"；
//!  - `auth_logout` 什么都不回。
//!
//! 口令是**入参**（用户在 UI 里输的，本来就在 WebView 里），
//! 但它到此为止：Rust 侧发出去之后不留存、不回显。
//! 真正带 `Authorization` 头的请求由 Rust 侧各命令自己发（§2.2 C2）。

use serde::Serialize;

/// 登录后回给界面的身份。**刻意不含 token**（见模块头）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub authenticated: bool,
    pub user_id: Option<String>,
    pub display_name: Option<String>,
}

fn status_now() -> AuthStatus {
    match carlife_core::auth::current_user() {
        Some((user_id, display_name)) => AuthStatus {
            authenticated: true,
            user_id: Some(user_id),
            display_name,
        },
        None => AuthStatus { authenticated: false, user_id: None, display_name: None },
    }
}

#[tauri::command]
pub async fn auth_login(username: String, password: String) -> Result<AuthStatus, String> {
    let (base_url, _) = super::chat::gateway_env();
    carlife_net::login(&base_url, &username, &password, None)
        .await
        // 401 与网络故障要分开说：前者是"账号或口令不对"（用户能自己解决），
        // 后者是"连不上网关"（用户改口令一百遍也没用）。
        .map_err(|e| match e {
            carlife_net::NetError::Unauthorized => "账号或口令不正确".to_string(),
            other => format!("登录失败：{other}"),
        })?;
    Ok(status_now())
}

#[tauri::command]
pub fn auth_status() -> AuthStatus {
    status_now()
}

#[tauri::command]
pub fn auth_logout() {
    carlife_net::logout();
}
