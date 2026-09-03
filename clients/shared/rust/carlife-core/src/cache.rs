//! 端上消息缓存（施工单 M2-04，F-03-02）。
//!
//! 职责严格限定为 §2.2 C5 的"本地缓存·离线兜底"：加速首屏、离线可看最近历史。
//! **权威源是服务端 PostgreSQL**（FL-03"存储分层对齐"）——缓存与权威源不一致时
//! 以回源（`replace_session`）为准；本缓存不参与任何记忆/上下文机制（§7① 在服务端）。
//!
//! mobile 与 cockpit 复用本模块（§10 要点 5）。

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use thiserror::Error;

use crate::contract::{ChatMessage, ChatRole, MessageSource};

/// 环形保留的默认轮次数（一轮 = user + assistant 两条）。
pub const DEFAULT_MAX_TURNS: usize = 50;

#[derive(Debug, Error)]
pub enum CacheError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("cache poisoned")]
    Poisoned,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id    TEXT NOT NULL,
  role       TEXT NOT NULL,
  source     TEXT NOT NULL,
  content    TEXT NOT NULL,
  ts         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session_ts ON messages(session_id, ts);
";

pub struct MessageCache {
    conn: Mutex<Connection>,
    max_turns: usize,
}

fn row_to_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatMessage> {
    let role: String = row.get(3)?;
    let source: String = row.get(4)?;
    Ok(ChatMessage {
        message_id: row.get(0)?,
        session_id: row.get(1)?,
        turn_id: row.get(2)?,
        role: if role == "assistant" {
            ChatRole::Assistant
        } else {
            ChatRole::User
        },
        source: if source == "voice" {
            MessageSource::Voice
        } else {
            MessageSource::Text
        },
        content: row.get(5)?,
        ts: row.get(6)?,
        /*
         * 端上离线缓存**不存**这一列（M33-01）。
         *
         * 表是 `CREATE TABLE IF NOT EXISTS` 建的：加一列要配一次真正的迁移，
         * 而已装在车上的那些库不会自己长出新列。为一个"标注"付一次端上迁移
         * 不划算——被打断的那半句在**回源读历史**时带着标记（网关那份是权威的），
         * 纯离线时它只是一条普通的助手消息。已知限制，去向 M33-02。
         */
        cancelled: None,
    })
}

fn role_str(r: ChatRole) -> &'static str {
    match r {
        ChatRole::User => "user",
        ChatRole::Assistant => "assistant",
    }
}

fn source_str(s: MessageSource) -> &'static str {
    match s {
        MessageSource::Text => "text",
        MessageSource::Voice => "voice",
    }
}

impl MessageCache {
    pub fn open(path: &Path) -> Result<Self, CacheError> {
        Self::from_conn(Connection::open(path)?)
    }

    /// 测试与临时场景用。
    pub fn open_in_memory() -> Result<Self, CacheError> {
        Self::from_conn(Connection::open_in_memory()?)
    }

    fn from_conn(conn: Connection) -> Result<Self, CacheError> {
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
            max_turns: DEFAULT_MAX_TURNS,
        })
    }

    pub fn with_max_turns(mut self, max_turns: usize) -> Self {
        self.max_turns = max_turns.max(1);
        self
    }

    /// 幂等写入（同 message_id 重复写不产生第二条、不报错）；随后环形修剪。
    pub fn upsert_message(&self, msg: &ChatMessage) -> Result<(), CacheError> {
        let conn = self.conn.lock().map_err(|_| CacheError::Poisoned)?;
        conn.execute(
            "INSERT INTO messages (message_id, session_id, turn_id, role, source, content, ts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(message_id) DO NOTHING",
            params![
                msg.message_id,
                msg.session_id,
                msg.turn_id,
                role_str(msg.role),
                source_str(msg.source),
                msg.content,
                msg.ts
            ],
        )?;
        // 环形保留：只留最近 max_turns 个 turn 的消息
        conn.execute(
            "DELETE FROM messages WHERE session_id = ?1 AND turn_id NOT IN (
               SELECT turn_id FROM (
                 SELECT turn_id, MAX(ts) AS mts FROM messages WHERE session_id = ?1
                 GROUP BY turn_id ORDER BY mts DESC LIMIT ?2
               )
             )",
            params![msg.session_id, self.max_turns as i64],
        )?;
        Ok(())
    }

    /// 最近消息分页（ts 正序返回，`before` 为向前翻页游标 message_id）。
    pub fn recent_page(
        &self,
        session_id: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ChatMessage>, CacheError> {
        let conn = self.conn.lock().map_err(|_| CacheError::Poisoned)?;
        let before_ts: Option<i64> = match before {
            Some(id) => conn
                .query_row(
                    "SELECT ts FROM messages WHERE message_id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .ok(),
            None => None,
        };
        let mut rows: Vec<ChatMessage> = match before_ts {
            Some(ts) => {
                let mut stmt = conn.prepare(
                    "SELECT message_id, session_id, turn_id, role, source, content, ts
                     FROM messages WHERE session_id = ?1 AND ts < ?2
                     ORDER BY ts DESC LIMIT ?3",
                )?;
                let it = stmt.query_map(params![session_id, ts, limit as i64], row_to_message)?;
                it.collect::<Result<_, _>>()?
            }
            None => {
                let mut stmt = conn.prepare(
                    "SELECT message_id, session_id, turn_id, role, source, content, ts
                     FROM messages WHERE session_id = ?1
                     ORDER BY ts DESC LIMIT ?2",
                )?;
                let it = stmt.query_map(params![session_id, limit as i64], row_to_message)?;
                it.collect::<Result<_, _>>()?
            }
        };
        rows.reverse();
        Ok(rows)
    }

    /// 回源校正：以服务端权威历史整体替换本会话缓存（事务）。
    pub fn replace_session(
        &self,
        session_id: &str,
        messages: &[ChatMessage],
    ) -> Result<(), CacheError> {
        let mut conn = self.conn.lock().map_err(|_| CacheError::Poisoned)?;
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM messages WHERE session_id = ?1",
            params![session_id],
        )?;
        for msg in messages {
            tx.execute(
                "INSERT INTO messages (message_id, session_id, turn_id, role, source, content, ts)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(message_id) DO NOTHING",
                params![
                    msg.message_id,
                    msg.session_id,
                    msg.turn_id,
                    role_str(msg.role),
                    source_str(msg.source),
                    msg.content,
                    msg.ts
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// 清空会话缓存（开发/测试；清后在线状态可完整回源）。
    pub fn clear_session(&self, session_id: &str) -> Result<(), CacheError> {
        let conn = self.conn.lock().map_err(|_| CacheError::Poisoned)?;
        conn.execute(
            "DELETE FROM messages WHERE session_id = ?1",
            params![session_id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
impl MessageCache {
    /// 测试专用：破坏底层表结构，制造后续写入失败（fan-out 故障注入用例）。
    pub(crate) fn __test_break(&self) {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("DROP TABLE messages").unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(id: &str, turn: &str, role: ChatRole, ts: i64) -> ChatMessage {
        ChatMessage {
            message_id: id.into(),
            session_id: "s1".into(),
            turn_id: turn.into(),
            role,
            source: MessageSource::Text,
            content: format!("content-{id}"),
            ts,
            cancelled: None,
        }
    }

    #[test]
    fn upsert_is_idempotent() {
        let cache = MessageCache::open_in_memory().unwrap();
        let m = msg("m1", "t1", ChatRole::User, 100);
        cache.upsert_message(&m).unwrap();
        cache.upsert_message(&m).unwrap();
        assert_eq!(cache.recent_page("s1", None, 10).unwrap().len(), 1);
    }

    #[test]
    fn ring_keeps_recent_turns_only() {
        let cache = MessageCache::open_in_memory().unwrap().with_max_turns(2);
        for i in 0..4 {
            let turn = format!("t{i}");
            cache
                .upsert_message(&msg(&format!("m{i}-u"), &turn, ChatRole::User, i * 10))
                .unwrap();
            cache
                .upsert_message(&msg(
                    &format!("m{i}-a"),
                    &turn,
                    ChatRole::Assistant,
                    i * 10 + 1,
                ))
                .unwrap();
        }
        let page = cache.recent_page("s1", None, 100).unwrap();
        assert_eq!(page.len(), 4, "只留最近 2 轮 × 2 条");
        assert!(page.iter().all(|m| m.turn_id == "t2" || m.turn_id == "t3"));
    }

    #[test]
    fn page_orders_ascending_and_paginates() {
        let cache = MessageCache::open_in_memory().unwrap();
        for i in 0..6 {
            cache
                .upsert_message(&msg(
                    &format!("m{i}"),
                    &format!("t{i}"),
                    ChatRole::User,
                    i * 10,
                ))
                .unwrap();
        }
        let latest = cache.recent_page("s1", None, 2).unwrap();
        assert_eq!(
            latest.iter().map(|m| m.ts).collect::<Vec<_>>(),
            vec![40, 50],
            "正序返回最近两条"
        );
        let earlier = cache.recent_page("s1", Some("m4"), 2).unwrap();
        assert_eq!(
            earlier.iter().map(|m| m.ts).collect::<Vec<_>>(),
            vec![20, 30]
        );
    }

    #[test]
    fn replace_session_overwrites_local_divergence() {
        let cache = MessageCache::open_in_memory().unwrap();
        cache
            .upsert_message(&msg("local-only", "t1", ChatRole::User, 5))
            .unwrap();
        let authoritative = vec![
            msg("srv-1", "t1", ChatRole::User, 10),
            msg("srv-2", "t1", ChatRole::Assistant, 11),
        ];
        cache.replace_session("s1", &authoritative).unwrap();
        let page = cache.recent_page("s1", None, 10).unwrap();
        assert_eq!(
            page.iter()
                .map(|m| m.message_id.as_str())
                .collect::<Vec<_>>(),
            vec!["srv-1", "srv-2"],
            "回源以权威源为准"
        );
    }

    #[test]
    fn clear_then_backfill_restores() {
        let cache = MessageCache::open_in_memory().unwrap();
        cache
            .upsert_message(&msg("m1", "t1", ChatRole::User, 1))
            .unwrap();
        cache.clear_session("s1").unwrap();
        assert!(cache.recent_page("s1", None, 10).unwrap().is_empty());
        cache
            .replace_session("s1", &[msg("m1", "t1", ChatRole::User, 1)])
            .unwrap();
        assert_eq!(cache.recent_page("s1", None, 10).unwrap().len(), 1);
    }
}
